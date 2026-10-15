/**
 * 诊断日志：失败、超时、格式异常都要留痕；日志里绝不出现命令原文，只记哈希。
 * @module dsh-plain-approval/logger
 */
import { shortHash, oneLine } from './util.js'

/**
 * @param {object} options
 * @param {object} options.store - createStore() 的返回值
 * @param {object} [options.ctx] - cordis 上下文（用于 ctx.logger）
 * @param {Function} [options.getSettings] - 读取当前设置
 */
export function createLogger({ store, ctx, getSettings } = {}) {
  const ring = []
  const MAX_RING = 500

  function push(level, event, details = {}) {
    const settings = typeof getSettings === 'function' ? getSettings() : undefined
    const entry = {
      t: new Date().toISOString(),
      level,
      event: String(event),
      ...sanitize(details),
    }
    ring.push(entry)
    if (ring.length > MAX_RING) ring.shift()
    if (settings === undefined || settings?.log?.enabled !== false) {
      try {
        store?.appendLog(entry)
      } catch {
        /* 日志写失败不影响审批 */
      }
    }
    return entry
  }

  function toCordis(level, message) {
    try {
      const logger = ctx?.logger
      if (!logger) return
      const fn = typeof logger[level] === 'function' ? logger[level] : logger.info
      if (typeof fn === 'function') fn.call(logger, '[plain-approval] ' + message)
    } catch {
      /* 忽略 */
    }
  }

  return {
    debug: (event, details) => push('debug', event, details),
    info: (event, details) => push('info', event, details),
    warn: (event, details) => {
      const e = push('warn', event, details)
      toCordis('warn', format(event, details))
      return e
    },
    error: (event, details) => {
      const e = push('error', event, details)
      toCordis('error', format(event, details))
      return e
    },
    /** 记录一次翻译失败（含哈希、引擎、原因码、耗时）。 */
    failure({ command, engine, code, message, ms }) {
      return push('error', 'translate.failure', {
        hash: command === undefined ? undefined : shortHash(command),
        engine,
        code,
        message: oneLine(message, 240),
        ms,
      })
    },
    ring: () => ring.slice(),
    /** 导出诊断日志（给「导出诊断日志」按钮用）。 */
    export() {
      return {
        generatedAt: new Date().toISOString(),
        plugin: 'dsh-plain-approval',
        note: '日志不含命令原文，只记命令哈希（sha256 前 16 位）。',
        logFile: store?.logSummary?.() ?? null,
        entries: store?.readLog?.(5000) ?? [],
        memory: ring.slice(),
      }
    },
  }
}

function format(event, details) {
  const extra = details && typeof details === 'object' ? ' ' + oneLine(JSON.stringify(sanitize(details)), 200) : ''
  return event + extra
}

/** 只保留安全字段，避免把命令原文写进日志。 */
function sanitize(details) {
  if (!details || typeof details !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (key === 'command' || key === 'text' || key === 'prompt' || key === 'raw') {
      // 显式禁止：原文一律换成哈希
      out[key + 'Hash'] = shortHash(value)
      continue
    }
    // stack / componentStack 是 React 渲染异常的命根子：截到 300 字符就只剩
    // "TypeError: Cannot read properties of undefined"，没有出错的组件栈，
    // 等于白记。这两个 key 放宽到 4000，其余字段维持 300 不变。
    if (typeof value === 'string') out[key] = oneLine(value, (key === 'stack' || key === 'componentStack') ? 4000 : 300)
    else if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else out[key] = oneLine(JSON.stringify(value), 300)
  }
  return out
}
