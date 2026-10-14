/**
 * 通用工具：哈希、截断、JSON、时间。
 * 这一层不依赖任何 DSH 包，纯 Node 标准库，便于单元测试。
 * @module dsh-plain-approval/util
 */
import { createHash } from 'node:crypto'

/** 命令哈希（隐私：日志/缓存只记哈希，不记命令原文）。 */
export function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

/** 短哈希，用于展示与日志。 */
export function shortHash(value) {
  return sha256(value).slice(0, 16)
}

/** 命令最大长度（超过则截断后再翻译）。 */
export const MAX_COMMAND_CHARS = 4000

/**
 * 截断超长命令。
 * @returns {{ text: string, truncated: boolean, originalLength: number }}
 */
export function truncateCommand(command, max = MAX_COMMAND_CHARS) {
  const raw = String(command ?? '')
  if (raw.length <= max) return { text: raw, truncated: false, originalLength: raw.length }
  return { text: raw.slice(0, max), truncated: true, originalLength: raw.length }
}

/** 安全 JSON 解析。 */
export function safeParse(text, fallback = undefined) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 安全 JSON 序列化（循环引用/大对象不抛错）。 */
export function safeStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

/** 把任意值收敛成单行短文本。 */
export function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 是否包含中日韩文字（判断「已经是中文，无需翻译」）。 */
export function hasCJK(value) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/u.test(String(value ?? ''))
}

/** 确保文本以句号结尾，读起来更像一句人话。 */
export function asSentence(text) {
  const value = String(text ?? '').trim()
  if (value === '') return value
  return /[。！？.!?]$/u.test(value) ? value : value + '。'
}

/** 截断到指定字数（用于「干什么」不超过 40 字的要求）。 */
export function clampChars(text, max) {
  const value = String(text ?? '').trim()
  return value.length > max ? value.slice(0, max) : value
}

/** 自适应等待。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 本地日期键 YYYY-MM-DD（用于当日累计费用）。 */
export function todayKey(now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
