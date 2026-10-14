/**
 * 翻译缓存：优先 SQLite（Node 内置 node:sqlite，零依赖），不可用时自动回落 JSON 文件。
 *
 * 需求对齐：
 *  - 缓存 key = 命令哈希 + 引擎标识 + 模型标识（切换引擎后不命中旧缓存）
 *  - 有效期默认 7 天，可在设置里修改
 *  - 缓存要记录「翻译引擎来源」
 * @module dsh-plain-approval/cache
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { sha256, safeParse } from './util.js'

const require = createRequire(import.meta.url)

export const CACHE_VERSION = 2

/**
 * 缓存 key：命令 + 引擎通道 + 模型身份 + **上下文指纹**，四者任一变化都不命中。
 *
 * v0.5.4 修：以前 key 里没有上下文，但「背景」段恰恰是从上下文生成的。
 * 结果就是同一条命令在「读不到会话上下文」时算出的那份被缓存下来，
 * 之后用户带着完整指令再跑同一条命令，缓存命中 → 背景永远停在
 * 「未读取到会话上下文，仅翻译命令本身」。
 * 真实案例：`96bbe7c776d1ea0b`（write 工具，context=yes）连续命中一份旧快照。
 *
 * 指纹用**哈希而不是原文**：上下文可能很长，且不��在缓存文件名/日志里露出来。
 * 「可用/不可用」也算进指纹 —— 无上下文和有上下文本来就是两个不同的结果。
 */
export function contextFingerprint(context) {
  if (!context || typeof context !== 'object' || context.available !== true) return 'ctx:none'
  const lines = Array.isArray(context.lines) ? context.lines.map((l) => String(l)) : []
  const step = context.step ? `${context.step.index}/${context.step.total}` : '-'
  return sha256(`ctx:1\u0000${step}\u0000${lines.join('\u0001')}`)
}

/** 缓存 key。context 可选；不传时退化成旧的「无上下文」语义。 */
export function cacheKey({ command, engineMode, engineIdentity, context }) {
  const ctx = context === undefined ? 'ctx:none' : contextFingerprint(context)
  return sha256(`${CACHE_VERSION}\u0000${engineMode}\u0000${engineIdentity}\u0000${ctx}\u0000${command}`)
}

/**
 * @param {object} options
 * @param {string} options.dir - 插件数据目录
 * @param {'sqlite'|'json'} [options.driver]
 */
export function createCache({ dir, driver = 'sqlite' } = {}) {
  const sqlitePath = join(dir, 'cache.sqlite')
  const jsonPath = join(dir, 'cache.json')
  let backend = null

  if (driver === 'sqlite') backend = trySqlite(sqlitePath)
  if (!backend) backend = jsonBackend(jsonPath)

  return {
    driver: backend.driver,
    path: backend.path,

    /**
     * @returns {{ hit:true, value:object, storedAt:number } | { hit:false }}
     */
    get(key, ttlDays = 7) {
      try {
        const row = backend.get(key)
        if (!row) return { hit: false }
        const ageMs = Date.now() - Number(row.storedAt)
        const ttlMs = Number(ttlDays) * 24 * 3600 * 1000
        if (!(ttlMs > 0) || ageMs > ttlMs) {
          backend.delete(key)
          return { hit: false, expired: true }
        }
        return { hit: true, value: safeParse(row.value, null), storedAt: Number(row.storedAt), engine: row.engine }
      } catch {
        return { hit: false }
      }
    },

    set(key, value, engine) {
      try {
        backend.set(key, JSON.stringify(value), engine, Date.now())
        return true
      } catch {
        return false
      }
    },

    clear() {
      try {
        backend.clear()
        return true
      } catch {
        return false
      }
    },

    stats() {
      try {
        return backend.stats()
      } catch {
        return { driver: backend.driver, count: 0 }
      }
    },

    close() {
      try {
        backend.close?.()
      } catch {
        /* 忽略 */
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* SQLite 后端                                                          */
/* ------------------------------------------------------------------ */

function trySqlite(path) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch {
    return null
  }
  if (!DatabaseSync) return null
  let db
  try {
    mkdirSync(dirname(path), { recursive: true })
    db = new DatabaseSync(path)
    db.exec(
      'CREATE TABLE IF NOT EXISTS translations (' +
      '  cache_key TEXT PRIMARY KEY,' +
      '  value TEXT NOT NULL,' +
      '  engine TEXT,' +
      '  stored_at INTEGER NOT NULL' +
      ')',
    )
    db.exec('CREATE INDEX IF NOT EXISTS idx_translations_stored ON translations(stored_at)')
  } catch {
    return null
  }
  return {
    driver: 'sqlite',
    path,
    get(key) {
      const row = db.prepare('SELECT value, engine, stored_at FROM translations WHERE cache_key = ?').get(key)
      if (!row) return null
      return { value: row.value, engine: row.engine, storedAt: row.stored_at }
    },
    set(key, value, engine, storedAt) {
      db.prepare(
        'INSERT INTO translations (cache_key, value, engine, stored_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, engine = excluded.engine, stored_at = excluded.stored_at',
      ).run(key, value, engine ?? null, storedAt)
    },
    delete(key) {
      db.prepare('DELETE FROM translations WHERE cache_key = ?').run(key)
    },
    clear() {
      db.exec('DELETE FROM translations')
    },
    stats() {
      const row = db.prepare('SELECT COUNT(*) AS n, MIN(stored_at) AS oldest, MAX(stored_at) AS newest FROM translations').get()
      return { driver: 'sqlite', path, count: Number(row?.n) || 0, oldest: row?.oldest ?? null, newest: row?.newest ?? null }
    },
    close() {
      db.close()
    },
  }
}

/* ------------------------------------------------------------------ */
/* JSON 后端（SQLite 不可用时的兜底）                                     */
/* ------------------------------------------------------------------ */

function jsonBackend(path) {
  let data = {}
  try {
    if (existsSync(path)) data = safeParse(readFileSync(path, 'utf8'), {}) || {}
  } catch {
    data = {}
  }
  const flush = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(data), 'utf8')
    } catch {
      /* 写失败不影响审批 */
    }
  }
  return {
    driver: 'json',
    path,
    get(key) {
      const row = data[key]
      if (!row) return null
      return { value: row.value, engine: row.engine, storedAt: row.storedAt }
    },
    set(key, value, engine, storedAt) {
      data[key] = { value, engine, storedAt }
      // 防止无限增长
      const keys = Object.keys(data)
      if (keys.length > 2000) {
        keys.sort((a, b) => (data[a].storedAt || 0) - (data[b].storedAt || 0))
        for (const k of keys.slice(0, keys.length - 2000)) delete data[k]
      }
      flush()
    },
    delete(key) {
      delete data[key]
      flush()
    },
    clear() {
      data = {}
      flush()
    },
    stats() {
      return { driver: 'json', path, count: Object.keys(data).length }
    },
  }
}
