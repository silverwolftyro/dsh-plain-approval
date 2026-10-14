/**
 * 审计日志（v0.3）：每次「长期同意自动放行」都要留痕。
 *
 * 记录内容：时间、命令哈希、翻译结果（七段）、授权规则 ID、工作区。
 * **绝不记录命令原文**（需求：日志只记哈希，保护隐私）。
 * 文件位置：`<DSH_HOME>/plain-approval/audit.jsonl`，不写工作区。
 * @module dsh-plain-approval/audit
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeParse, oneLine } from './util.js'

/** 最多保留多少行（超出后裁剪）。 */
const MAX_LINES = 5000

/**
 * @param {object} options
 * @param {string} options.dir - 插件数据目录
 */
export function createAudit({ dir } = {}) {
  const file = join(dir, 'audit.jsonl')

  function ensure() {
    try {
      mkdirSync(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }
  ensure()

  /** 只保留白名单字段，杜绝把命令原文写进去。 */
  function sanitize(entry) {
    const sections = entry && typeof entry.sections === 'object' && entry.sections !== null ? entry.sections : {}
    return {
      t: entry?.t ?? new Date().toISOString(),
      event: String(entry?.event ?? 'unknown'),
      hash: String(entry?.hash ?? ''),
      ruleId: String(entry?.ruleId ?? ''),
      workspace: String(entry?.workspace ?? ''),
      toolName: String(entry?.toolName ?? ''),
      risk: String(entry?.risk ?? ''),
      result: {
        intent: oneLine(sections.intent, 120),
        touch: oneLine(sections.touch, 160),
        mode: oneLine(sections.mode, 16),
        risk: oneLine(sections.risk, 16),
        advice: oneLine(sections.advice, 16),
        consequence: oneLine(sections.consequence, 200),
        benefit: oneLine(sections.benefit, 200),
      },
      engine: entry?.engine ?? null,
    }
  }

  return {
    file,

    record(entry) {
      const row = sanitize(entry)
      try {
        ensure()
        appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
        return row
      } catch {
        return null
      }
    },

    read(maxLines = 500) {
      try {
        if (!existsSync(file)) return []
        const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
        return lines.slice(-maxLines).map((l) => safeParse(l, { raw: l }))
      } catch {
        return []
      }
    },

    summary() {
      try {
        if (!existsSync(file)) return { exists: false, bytes: 0, lines: 0, path: file }
        const text = readFileSync(file, 'utf8')
        const lines = text.split('\n').filter((l) => l.trim() !== '').length
        return { exists: true, bytes: Buffer.byteLength(text), lines, path: file }
      } catch {
        return { exists: false, bytes: 0, lines: 0, path: file }
      }
    },

    exportAll() {
      return {
        generatedAt: new Date().toISOString(),
        plugin: 'dsh-plain-approval',
        note: '审计日志只记命令哈希（sha256），不记命令原文；翻译结果（七段）原样记录。',
        file,
        summary: this.summary(),
        entries: this.read(MAX_LINES),
      }
    },

    trim() {
      try {
        if (!existsSync(file)) return
        const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
        if (lines.length <= MAX_LINES) return
        writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8')
      } catch {
        /* 裁剪失败不影响主流程 */
      }
    },
  }
}
