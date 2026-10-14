/**
 * 用户数据目录内的持久化：设置、当日费用、诊断日志。
 * 所有文件都在 DSH 用户数据目录下（<DSH_HOME>/plain-approval），不散落在工作区。
 * @module dsh-plain-approval/store
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir, normalizeSettings } from './config.js'
import { safeParse, todayKey } from './util.js'

export function createStore({ env = process.env, homedir = undefined } = {}) {
  const dir = resolveDataDir(env, homedir)
  const files = {
    settings: join(dir, 'settings.json'),
    cache: join(dir, 'cache.sqlite'),
    cacheJson: join(dir, 'cache.json'),
    cost: join(dir, 'cost-daily.json'),
    log: join(dir, 'plain-approval.jsonl'),
  }

  function ensure() {
    try {
      mkdirSync(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }
  ensure()

  function readJson(file, fallback) {
    try {
      if (!existsSync(file)) return fallback
      return safeParse(readFileSync(file, 'utf8'), fallback)
    } catch {
      return fallback
    }
  }

  function writeJsonAtomic(file, value) {
    try {
      ensure()
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, file)
      return true
    } catch {
      return false
    }
  }

  return {
    dir,
    files,

    /** 读取设置（行 config + 用户设置文件合并后的结果）。 */
    loadSettings(rowConfig) {
      const userSettings = readJson(files.settings, {})
      // 优先级：内置默认 < 行 config < 用户设置文件（逐层深合并，避免整段覆盖）
      return normalizeSettings(deepMergeRaw(rowConfig || {}, userSettings || {}))
    },

    /** 覆写设置文件的原始内容（设置页保存时使用，只存差异部分亦可）。 */
    readRawSettings() {
      return readJson(files.settings, {})
    },

    saveRawSettings(patch) {
      const current = readJson(files.settings, {})
      const next = deepMergeRaw(current, patch)
      const ok = writeJsonAtomic(files.settings, next)
      return { ok, settings: next }
    },

    /** 当日累计费用（元）。 */
    readDailyCost() {
      const data = readJson(files.cost, {})
      const key = todayKey()
      return { date: key, cny: Number(data[key]?.cny) || 0, calls: Number(data[key]?.calls) || 0, tokens: Number(data[key]?.tokens) || 0, history: data }
    },

    addDailyCost({ cny = 0, tokens = 0, calls = 1 }) {
      const data = readJson(files.cost, {})
      const key = todayKey()
      const slot = data[key] || { cny: 0, calls: 0, tokens: 0 }
      slot.cny = Number((slot.cny + cny).toFixed(8))
      slot.calls = Number(slot.calls) + calls
      slot.tokens = Number(slot.tokens) + tokens
      data[key] = slot
      // 只保留最近 60 天
      const keys = Object.keys(data).sort()
      while (keys.length > 60) delete data[keys.shift()]
      writeJsonAtomic(files.cost, data)
      return slot
    },

    /** 追加一条诊断日志（绝不含命令原文，只有哈希）。 */
    appendLog(entry) {
      try {
        ensure()
        appendFileSync(files.log, JSON.stringify(entry) + '\n', 'utf8')
        // 超过上限时按行裁剪
        return true
      } catch {
        return false
      }
    },

    trimLog(maxLines) {
      try {
        if (!existsSync(files.log)) return
        const text = readFileSync(files.log, 'utf8')
        const lines = text.split('\n').filter((l) => l.trim() !== '')
        if (lines.length <= maxLines) return
        writeFileSync(files.log, lines.slice(-maxLines).join('\n') + '\n', 'utf8')
      } catch {
        /* 裁剪失败不影响主流程 */
      }
    },

    readLog(maxLines = 2000) {
      try {
        if (!existsSync(files.log)) return []
        const lines = readFileSync(files.log, 'utf8').split('\n').filter((l) => l.trim() !== '')
        return lines.slice(-maxLines).map((l) => safeParse(l, { raw: l }))
      } catch {
        return []
      }
    },

    logSummary() {
      try {
        if (!existsSync(files.log)) return { exists: false, bytes: 0, lines: 0 }
        const stat = statSync(files.log)
        const lines = readFileSync(files.log, 'utf8').split('\n').filter((l) => l.trim() !== '').length
        return { exists: true, bytes: stat.size, lines, path: files.log }
      } catch {
        return { exists: false, bytes: 0, lines: 0 }
      }
    },
  }
}

/** 原始深合并（不校验、不补默认值），用于用户设置文件与行 config 的叠加。 */
export function deepMergeRaw(base, patch) {
  if (patch === null || patch === undefined) return base
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...(base && typeof base === 'object' ? base : {}) }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? deepMergeRaw(out[key], value) : value
  }
  return out
}
