/**
 * 审批历史（v0.5.3）：把**每一次**审批（放行 / 拒绝 / 自动放行）记下来，供用户回看。
 *
 * 为什么需要它（v0.6.0 的前置条件）：
 *   本插件的「风险等级」来自本地正则 + 语言模型判断，**从未被验证过准确率**。
 *   v0.6.0 计划做「低风险自动通过」，前提是先积累一段真实历史，
 *   看看「标绿」的到底有多少、绿的里面有没有不该绿的。**没有历史就没有这个答案。**
 *
 * 隐私（与 audit.js 一致，且更严格）：
 *   · 默认**只记 sha256 哈希**，绝不记命令原文；
 *   · 只有用户在设置里显式打开 `ui.history.keepCommands` 才存原文，且原文有长度上限；
 *   · 文件只写 `<DSH_HOME>/plain-approval/history.jsonl`，不写工作区、不联网；
 *   · 导出支持脱敏模式，把哈希也一并去掉。
 *
 * 性能：审批监听器是**同步热路径**，所以写入用 `appendFileSync` 单行 O(1)，
 * 不在这里做任何排序、聚合或全文件扫描。裁剪只发生在「加载时」和「超过上限时」。
 *
 * @module dsh-plain-approval/history
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeParse, oneLine } from './util.js'

export const HISTORY_VERSION = 1

/** 默认保留天数。 */
export const DEFAULT_RETENTION_DAYS = 90
/** 条数上限，防止文件无限长（超了丢最旧的）。 */
export const DEFAULT_MAX_ENTRIES = 5000
/** 原文最多存多少字（用户显式开启保留原文时）。 */
const MAX_COMMAND_CHARS = 4000
/** 导出时默认展示多少条。 */
const DEFAULT_LIMIT = 500

/** 决定类型 → 展示文案。索引即筛选用的 key。 */
export const DECISION_LABELS = {
  'auto-allowed': '自动放行',
  'allowed-once': '手动允许（一次）',
  'allowed-always': '手动允许（长期）',
  rejected: '拒绝',
  other: '其他',
}

/**
 * 把 waterfall 的原始 outcome 归一化成决定类型。
 * 认不出来的统一落到 'other'，绝不猜。
 *
 * ⚠️ 'auto-allowed' 是**插件自己**产出的短路结果（命中长期同意、不弹窗），
 *    它不会从 waterfall 的 outcome 里出现，所以必须在这里显式放行 ——
 *    否则它会被误记成 'other'，统计「自动 vs 手动」时就全错了。
 */
export function normalizeDecision(outcome) {
  const raw = String(outcome ?? '').trim()
  if (raw === 'auto-allowed') return 'auto-allowed'
  if (raw === 'allowed-once') return 'allowed-once'
  if (raw === 'allowed-always') return 'allowed-always'
  if (raw === 'rejected' || raw === 'denied' || raw === 'declined') return 'rejected'
  return 'other'
}

/** 时间范围 key → 天数。 */
export const RANGE_DAYS = { today: 1, week: 7, month: 30, all: null }

function cutoffFor(range, now) {
  const days = RANGE_DAYS[String(range ?? 'all')]
  if (days === null || days === undefined) return null
  return new Date(now - days * 86400000).toISOString()
}

/**
 * @param {object} options
 * @param {string} options.dir - 插件数据目录
 * @param {Function} [options.getSettings] - 读当前设置（决定是否保留原文、保留多久）
 */
export function createHistory({ dir, getSettings } = {}) {
  const file = join(dir, 'history.jsonl')
  let cached = null

  function ensure() {
    try {
      mkdirSync(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  function settings() {
    try {
      return typeof getSettings === 'function' ? getSettings() ?? {} : {}
    } catch {
      return {}
    }
  }

  /** 注意：历史设置挂在 settings.ui 下（不是 settings 根）。写错一层就会静默取到默认值。 */
  function histSettings() {
    return settings()?.ui?.history ?? {}
  }

  function retentionDays() {
    const v = Number(histSettings()?.retentionDays)
    return Number.isFinite(v) && v > 0 ? Math.min(v, 3650) : DEFAULT_RETENTION_DAYS
  }

  function maxEntries() {
    const v = Number(histSettings()?.maxEntries)
    return Number.isFinite(v) && v > 0 ? Math.min(v, 100000) : DEFAULT_MAX_ENTRIES
  }

  function keepCommands() {
    return histSettings()?.keepCommands === true
  }

  function enabled() {
    return histSettings()?.enabled !== false
  }

  /** 加载全部记录（按时间倒序），顺带按保留期与条数上限裁剪。 */
  function load() {
    if (cached) return cached
    let rows = []
    try {
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n')
        for (const line of lines) {
          if (line.trim() === '') continue
          const parsed = safeParse(line, null)
          if (parsed && typeof parsed === 'object' && typeof parsed.at === 'string') rows.push(parsed)
        }
      }
    } catch {
      rows = []
    }
    // 越旧越靠前 → 裁剪时保留尾部（最新）
    rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))
    const cutoff = new Date(Date.now() - retentionDays() * 86400000).toISOString()
    const kept = rows.filter((r) => String(r.at) >= cutoff)
    const cap = maxEntries()
    const trimmed = kept.length > cap ? kept.slice(kept.length - cap) : kept
    if (trimmed.length !== rows.length) persistRows(trimmed)
    cached = trimmed
    return cached
  }

  function persistRows(rows) {
    try {
      ensure()
      const tmp = file + '.tmp'
      writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
      renameSync(tmp, file)
      return true
    } catch {
      return false
    }
  }

  /**
   * 记一条审批历史。
   * @param {object} entry
   * @param {string} entry.hash - sha256 全长
   * @param {string} [entry.command] - 命令原文（**只有开了 keepCommands 才会落盘**）
   * @param {string} [entry.toolName]
   * @param {string} [entry.mode] - 操作类型（只读 / 写入 / 删除 / 执行 …）
   * @param {string} [entry.risk]
   * @param {string} entry.decision - waterfall 的 outcome
   * @param {string} [entry.grantId] - 命中的授权规则 ID
   * @param {object} [entry.sections] - 七段翻译结果
   */
  function record(entry) {
    if (!enabled()) return null
    const decision = normalizeDecision(entry?.decision)
    const hash = String(entry?.hash ?? '')
    if (hash === '') return null
    const sections = entry?.sections && typeof entry.sections === 'object' ? entry.sections : {}
    const row = {
      at: new Date().toISOString(),
      hash,
      hash8: hash.slice(0, 8),
      decision,
      mode: oneLine(entry?.mode ?? '', 16),
      risk: oneLine(entry?.risk ?? '', 16),
      toolName: oneLine(entry?.toolName ?? '', 40),
      grantId: entry?.grantId ? String(entry.grantId) : null,
      sections: {
        intent: oneLine(sections.intent, 120),
        touch: oneLine(sections.touch, 160),
        mode: oneLine(sections.mode, 16),
        risk: oneLine(sections.risk, 16),
        advice: oneLine(sections.advice, 16),
        consequence: oneLine(sections.consequence, 200),
        benefit: oneLine(sections.benefit, 200),
      },
      // 原文**默认不记**；用户显式开启才写，且截断
      command: keepCommands() ? oneLine(entry?.command, MAX_COMMAND_CHARS) : null,
    }
    try {
      ensure()
      appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
      if (cached) {
        cached.push(row)
        // 超上限就地丢最旧的（只动内存缓存；文件下次 load 时裁剪）
        const cap = maxEntries()
        if (cached.length > cap) cached = cached.slice(cached.length - cap)
      }
      return row
    } catch {
      return null
    }
  }

  /**
   * 查询历史。
   * @param {object} q
   * @param {string} [q.decision] - 决定类型筛选，'all' 或空表示不限
   * @param {string} [q.range] - today / week / month / all
   * @param {string} [q.q] - 命令哈希搜索（大小写不敏感的子串匹配）
   * @param {number} [q.limit]
   */
  function list(q = {}) {
    const rows = load().slice().reverse() // 时间倒序
    const decision = String(q.decision ?? 'all')
    const cutoff = cutoffFor(q.range ?? 'all', Date.now())
    const needle = String(q.q ?? '').trim().toLowerCase()
    const limit = Math.max(1, Math.min(Number(q.limit) || DEFAULT_LIMIT, 5000))
    const out = []
    for (const row of rows) {
      if (decision !== 'all' && row.decision !== decision) continue
      if (cutoff && String(row.at) < cutoff) continue
      if (needle && !String(row.hash).toLowerCase().includes(needle)) continue
      out.push(row)
      if (out.length >= limit) break
    }
    return out
  }

  function stats() {
    const rows = load()
    const byDecision = {}
    for (const key of Object.keys(DECISION_LABELS)) byDecision[key] = 0
    let oldest = null
    for (const row of rows) {
      if (row.decision in byDecision) byDecision[row.decision] += 1
      if (!oldest || String(row.at) < oldest) oldest = row.at
    }
    return {
      total: rows.length,
      byDecision,
      oldest,
      newest: rows.length ? rows[rows.length - 1].at : null,
      retentionDays: retentionDays(),
      maxEntries: maxEntries(),
      keepCommands: keepCommands(),
      enabled: enabled(),
      file,
    }
  }

  function clear() {
    const removed = load().length
    cached = []
    try {
      if (existsSync(file)) writeFileSync(file, '', 'utf8')
      return { ok: true, removed }
    } catch {
      return { ok: false, removed }
    }
  }

  /**
   * 导出。
   * @param {object} [o]
   * @param {boolean} [o.redact] - 脱敏模式：连哈希一起去掉，只留时间/决定/风险
   */
  function exportAll(o = {}) {
    const redact = o?.redact === true
    const rows = list({ limit: 5000 }).map((row) => {
      if (!redact) return row
      // 显式置 null 而不是靠解构丢掉：丢掉会留下 undefined，
      // 导出的 JSON 里就没有这个键，下游没法区分「没有」和「是 null」。
      return {
        at: row.at,
        decision: row.decision,
        mode: row.mode,
        risk: row.risk,
        toolName: row.toolName,
        sections: row.sections,
        hash: null,
        hash8: null,
        grantId: null,
        command: null,
      }
    })
    return {
      generatedAt: new Date().toISOString(),
      plugin: 'dsh-plain-approval',
      version: HISTORY_VERSION,
      redact,
      note: redact
        ? '已脱敏：不含命令哈希、不含原文、不含授权规则 ID。'
        : '命令原文默认不记录；仅当用户在设置里显式开启「保留命令原文」时才会包含。',
      stats: stats(),
      items: rows,
    }
  }

  return {
    file,
    record,
    list,
    stats,
    clear,
    exportAll,
    load,
    /** 测试用：丢弃内存缓存，强制下次重新读文件。 */
    invalidate() {
      cached = null
    },
  }
}
