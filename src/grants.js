/**
 * 长期同意（v0.3）：对「安全」等级的命令，记住「这条命令以后直接放行」。
 *
 * 安全底线（写死在代码里，不靠 UI 约束）：
 *  1. 只有风险等级为「安全」的命令才能被授权 —— 授权接口会**重新跑一遍本地规则**，
 *     不合格直接 403，用户手动构造请求也没用。
 *  2. 匹配是**命令字符串精确一致**（用 SHA-256 相等判定，不做前缀/正则/模糊）。
 *  3. 授权范围限定在**当前工作区**：`scope` 取 DSH 进程的工作目录
 *     （也就是 profile 里 sandbox-policy 的 workspaceRoot）。
 *  4. 只能逐条手动授权：本模块**不读任何配置文件**里的 grants，
 *     也没有批量导入入口；写入只发生在用户点击「长期同意」时。
 *
 * 隐私：授权表存 `<DSH_HOME>/plain-approval/grants.json`，只存
 * 命令哈希 + 前 160 字的预览（给设置页显示用），审计日志里连预览都没有。
 * @module dsh-plain-approval/grants
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256, shortHash, safeParse, oneLine } from './util.js'

export const GRANTS_VERSION = 1
/** 预览最长多少字（给设置页看，不落完整命令）。 */
const PREVIEW_CHARS = 160
/** 授权表最多存多少条，防止无限增长。 */
const MAX_GRANTS = 500

/** 工作区标识：DSH 进程的工作目录就是 profile 的 workspaceRoot。 */
export function workspaceScope(cwd = process.cwd()) {
  try {
    return String(cwd).replace(/[\\/]+$/u, '').toLowerCase()
  } catch {
    return String(cwd)
  }
}

/**
 * @param {object} options
 * @param {string} options.dir - 插件数据目录
 * @param {string} [options.scope] - 工作区标识（默认取 process.cwd()）
 */
export function createGrants({ dir, scope = workspaceScope() } = {}) {
  const file = join(dir, 'grants.json')
  let items = load()

  function load() {
    try {
      if (!existsSync(file)) return []
      const raw = safeParse(readFileSync(file, 'utf8'), null)
      if (!raw || !Array.isArray(raw.items)) return []
      // 只接受结构合法的条目，且必须带 hash
      return raw.items
        .filter((x) => x && typeof x.hash === 'string' && x.hash.length === 64)
        .map((x) => ({
          id: String(x.id ?? x.hash.slice(0, 12)),
          hash: x.hash,
          preview: String(x.preview ?? ''),
          scope: String(x.scope ?? ''),
          createdAt: String(x.createdAt ?? ''),
          risk: String(x.risk ?? '安全'),
          toolName: String(x.toolName ?? ''),
          uses: Number(x.uses) || 0,
          lastUsedAt: x.lastUsedAt ? String(x.lastUsedAt) : null,
        }))
    } catch {
      return []
    }
  }

  function persist() {
    try {
      mkdirSync(dir, { recursive: true })
      const payload = { version: GRANTS_VERSION, workspace: scope, items }
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, file)
      return true
    } catch {
      return false
    }
  }

  return {
    file,
    scope,

    list() {
      return items.map((x) => ({ ...x }))
    },

    size() {
      return items.length
    },

    /**
     * 授权一条「安全」命令。
     * @param {{ command:string, risk:string, toolName?:string }} input
     * @returns {{ ok:true, item:object } | { ok:false, code:string, message:string }}
     */
    add(input) {
      const command = String(input?.command ?? '')
      if (command.trim() === '') return { ok: false, code: 'empty-command', message: '空命令不能授权' }
      // 安全底线 1：非「安全」等级一律拒绝（调用方已经算过规则，这里再挡一次）
      if (String(input?.risk ?? '') !== '安全') {
        return {
          ok: false,
          code: 'not-safe',
          message: `只有「安全」等级的命令才能长期同意；这条的风险等级是「${input?.risk ?? '未知'}」，必须每次手动确认。`,
        }
      }
      const hash = sha256(command)
      const existing = items.find((x) => x.hash === hash && x.scope === scope)
      if (existing) return { ok: true, item: { ...existing }, already: true }

      const item = {
        id: shortHash(command).slice(0, 12),
        hash,
        preview: oneLine(command, PREVIEW_CHARS),
        scope,
        createdAt: new Date().toISOString(),
        risk: '安全',
        toolName: String(input?.toolName ?? ''),
        uses: 0,
        lastUsedAt: null,
      }
      items.push(item)
      while (items.length > MAX_GRANTS) items.shift()
      const persisted = persist()
      if (!persisted) return { ok: false, code: 'persist-failed', message: '授权表写入失败，未授权' }
      return { ok: true, item: { ...item } }
    },

    remove(id) {
      const before = items.length
      const target = String(id ?? '')
      items = items.filter((x) => x.id !== target && x.hash !== target)
      if (items.length === before) return { ok: false, code: 'not-found', message: '没有这条授权' }
      persist()
      return { ok: true, removed: before - items.length }
    },

    clear() {
      const removed = items.length
      items = []
      persist()
      return { ok: true, removed }
    },

    /**
     * 命中判定：命令哈希 + 工作区都一致才算命中。
     * 命令改一个字符 → 哈希变化 → 不命中（需求：授权失效，重新弹窗）。
     * @returns {object|null} 命中的授权条目
     */
    match(command) {
      const hash = sha256(String(command ?? ''))
      return items.find((x) => x.hash === hash && x.scope === scope) ?? null
    },

    /** 记录一次自动放行（更新使用次数）。 */
    markUsed(id) {
      const item = items.find((x) => x.id === id)
      if (!item) return null
      item.uses += 1
      item.lastUsedAt = new Date().toISOString()
      persist()
      return { ...item }
    },

    /** 只读：授权表文件里的 workspace 字段（排查用）。 */
    rawWorkspace() {
      try {
        const raw = safeParse(readFileSync(file, 'utf8'), null)
        return raw?.workspace ?? null
      } catch {
        return null
      }
    },
  }
}
