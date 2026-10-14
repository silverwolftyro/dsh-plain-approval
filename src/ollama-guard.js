/**
 * Ollama 防 OOM 护栏（v0.4 任务一）。
 *
 * 四件事：
 *  1. **并发闸门**：同一时间最多 N 条 Ollama 请求（默认 1），其余排队；
 *     队列上限 5 条，超了直接降级；队列里已有同一条命令时合并，不重复排队。
 *  2. **内存闸门**：每次调用前查本机可用内存，低于阈值（默认 2GB）直接降级。
 *  3. **熔断**：连续 3 次超时/失败 → 熔断 5 分钟，期间全部走通道 B；到点自动恢复。
 *  4. **记账**：每次调用的耗时 / token / 是否超时，供设置页与能力自检展示。
 *
 * 这里不碰网络，只做闸门与记账；真正的调用在 engines/ollama.js。
 * @module dsh-plain-approval/ollama-guard
 */
import { freeMemoryGB } from './device.js'

/** 最近多少次调用的记录用于平均耗时。 */
const HISTORY = 50

/**
 * @param {object} deps
 * @param {Function} deps.getSettings
 * @param {object} [deps.logger]
 * @param {Function} [deps.now]
 */
export function createOllamaGuard({ getSettings, logger, now = () => Date.now(), getDevice } = {}) {
  /** key → promise（排队中或正在跑），用于合并同一命令的重复请求。 */
  const inflight = new Map()
  /** 排队中的 key 顺序。 */
  const queue = []
  let running = 0
  let breakerOpenUntil = 0
  let consecutiveFailures = 0
  let breakerReason = ''
  const history = []

  const settings = () => getSettings()

  function breakerState() {
    const open = now() < breakerOpenUntil
    return {
      open,
      openUntil: open ? new Date(breakerOpenUntil).toISOString() : null,
      remainingMs: open ? breakerOpenUntil - now() : 0,
      consecutiveFailures,
      reason: open ? breakerReason : '',
    }
  }

  /** 自动恢复：到点就清空熔断。 */
  function refreshBreaker() {
    if (breakerOpenUntil !== 0 && now() >= breakerOpenUntil) {
      breakerOpenUntil = 0
      consecutiveFailures = 0
      breakerReason = ''
      logger?.info('ollama.breaker-closed', { reason: '熔断到期，自动恢复' })
    }
  }

  /**
   * 调 Ollama 之前先过闸。
   * @returns {{ ok:true } | { ok:false, code:string, reason:string }}
   */
  function check() {
    refreshBreaker()
    const s = settings()
    const state = breakerState()
    if (state.open) {
      return {
        ok: false,
        code: 'breaker',
        reason: `Ollama 已临时熔断（连续失败 ${state.consecutiveFailures} 次），约 ${Math.ceil(state.remainingMs / 1000)} 秒后自动恢复`,
      }
    }
    const minFree = Number(s.ollama?.minFreeMemoryGB ?? 2)
    const free = freeMemoryGB()
    // v0.4.1：有独立显卡且显存放得下模型时，模型跑在显存里，
    // 系统内存只要不被彻底吃干就行 —— 否则「12GB 显存 + 空闲 1.3GB 内存」
    // 会被误判成内存不足而白白降级。
    const vramGB = Number(getDevice?.()?.gpu?.vramTotalGB) || 0
    const vramBacked = vramGB >= 8
    const floor = vramBacked ? Math.min(minFree, 0.8) : minFree
    if (free < floor) {
      return {
        ok: false,
        code: 'low-memory',
        reason: vramBacked
          ? `本机可用内存只剩 ${free}GB（低于 ${floor}GB 底线，模型已在 ${vramGB}GB 显存里运行），为稳妥起见跳过本地模型`
          : `本机可用内存只剩 ${free}GB（低于 ${floor}GB 阈值），为防系统卡死跳过本地模型`,
      }
    }
    return { ok: true }
  }

  /**
   * 过闸排队执行。
   * @param {string} key - 合并键（命令哈希）
   * @param {() => Promise<object>} task - 真正的调用
   * @param {{ dedupe?: boolean }} [options]
   */
  function run(key, task, options = {}) {
    refreshBreaker()
    const gate = check()
    if (!gate.ok) return Promise.resolve({ gateBlocked: true, ...gate })

    const s = settings()
    const maxConcurrency = Math.max(1, Math.min(2, Number(s.ollama?.maxConcurrency ?? 1)))
    const maxQueue = Math.max(0, Number(s.ollama?.maxQueue ?? 5))

    if (options.dedupe !== false && inflight.has(key)) {
      return inflight.get(key).then((value) => ({ ...value, deduped: true }))
    }
    if (running >= maxConcurrency && queue.length >= maxQueue) {
      logger?.warn('ollama.queue-full', { queue: queue.length, maxQueue })
      return Promise.resolve({
        gateBlocked: true,
        code: 'busy',
        reason: `本地翻译排队已满（${queue.length}/${maxQueue}），本次改走通道 B`,
      })
    }

    const start = () => {
      running += 1
      return Promise.resolve()
        .then(task)
        .then((result) => {
          record(result)
          return result
        })
        .catch((error) => {
          record({ ok: false, code: 'exception', ms: 0, message: String(error?.message ?? error) })
          return { ok: false, code: 'exception', message: String(error?.message ?? error), ms: 0 }
        })
        .finally(() => {
          running -= 1
          inflight.delete(key)
          const next = queue.shift()
          if (next) next()
        })
    }

    const promise = new Promise((resolve) => {
      const startNow = () => {
        const p = start()
        p.then(resolve, (error) => resolve({ ok: false, code: 'exception', message: String(error?.message ?? error) }))
      }
      if (running < maxConcurrency) startNow()
      else queue.push(startNow)
    })

    inflight.set(key, promise)
    if (running >= maxConcurrency) {
      logger?.info('ollama.queued', { queue: queue.length, maxQueue, running })
    }
    return promise
  }

  /** 记一次调用结果，并更新熔断计数。 */
  function record(result) {
    const s = settings()
    const entry = {
      t: new Date().toISOString(),
      ok: result?.ok === true,
      code: result?.code ?? null,
      ms: Number(result?.ms) || 0,
      promptTokens: Number(result?.usage?.promptTokens) || Number(result?.promptTokens) || 0,
      completionTokens: Number(result?.usage?.completionTokens) || Number(result?.completionTokens) || 0,
      timeout: result?.code === 'timeout',
      memoryWarn: result?.code === 'low-memory',
    }
    history.push(entry)
    while (history.length > HISTORY) history.shift()

    const failure = !entry.ok
    if (failure) {
      consecutiveFailures += 1
      const threshold = Math.max(1, Number(s.ollama?.breakerFailures ?? 3))
      if (consecutiveFailures >= threshold && !breakerState().open) {
        const minutes = Math.max(1, Number(s.ollama?.breakerMinutes ?? 5))
        breakerOpenUntil = now() + minutes * 60 * 1000
        breakerReason = `连续失败 ${consecutiveFailures} 次（最近一次：${entry.code ?? 'unknown'}）`
        logger?.warn('ollama.breaker-open', { failures: consecutiveFailures, minutes, code: entry.code })
      }
    } else {
      consecutiveFailures = 0
    }
    return entry
  }

  function stats() {
    const recent = history.slice(-10)
    const okRecent = recent.filter((x) => x.ok)
    const avgMs = okRecent.length ? Math.round(okRecent.reduce((sum, x) => sum + x.ms, 0) / okRecent.length) : null
    const tokens = okRecent.reduce((sum, x) => sum + x.promptTokens + x.completionTokens, 0)
    return {
      calls: history.length,
      last10: recent,
      avgMs,
      avgTokens: okRecent.length ? Math.round(tokens / okRecent.length) : null,
      failures: history.filter((x) => !x.ok).length,
      running,
      queued: queue.length,
      breaker: breakerState(),
    }
  }

  /** 用户点「恢复本地通道」。 */
  function resetBreaker(reason = '用户手动恢复') {
    const was = breakerState()
    breakerOpenUntil = 0
    consecutiveFailures = 0
    breakerReason = ''
    logger?.info('ollama.breaker-reset', { reason, wasOpen: was.open })
    return { ok: true, wasOpen: was.open }
  }

  return { check, run, record, stats, resetBreaker, breakerState, queuedKeys: () => [...inflight.keys()] }
}
