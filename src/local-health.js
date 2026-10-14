/**
 * 本地通道健康度（v0.4 任务二·四.2）。
 *
 * 规则：用户在低配机器上**强行开启**本地通道后，连续 2 次本地翻译失败
 * （超时 / 内存不足 / OOM / 连不上）就自动切回 API，并把本地通道临时禁用 30 分钟。
 * 纯函数，方便单测。
 * @module dsh-plain-approval/local-health
 */

export const LOCAL_DISABLE_AFTER = 2
export const LOCAL_DISABLE_MS = 30 * 60 * 1000

/**
 * @param {{ streak:number }} state - 上一次的连续失败次数
 * @param {object} result - translator.translate() 的返回
 * @param {object} options
 * @param {boolean} options.allowUnusableLocal - 用户是否强行启用了本地通道
 * @param {number} [options.now]
 * @param {number} [options.disableAfter]
 * @param {number} [options.disableMs]
 * @returns {{ streak:number, disableUntil:number, reason:string } | null} null 表示无需变更
 */
export function evaluateLocalHealth(state, result, options = {}) {
  const streak = Number(state?.streak) || 0
  if (!result) return null

  const localFailure = Array.isArray(result.degradations)
    ? result.degradations.find((d) => d.from === '本地 Ollama')
    : undefined

  if (result.engine === 'ollama' && !localFailure) {
    return streak === 0 ? null : { streak: 0, disableUntil: 0, reason: '' }
  }
  if (!localFailure) return null

  const next = streak + 1
  const disableAfter = Number(options.disableAfter ?? LOCAL_DISABLE_AFTER)
  const disableMs = Number(options.disableMs ?? LOCAL_DISABLE_MS)
  const now = Number(options.now ?? Date.now())

  if (options.allowUnusableLocal === true && next >= disableAfter) {
    return {
      streak: 0,
      disableUntil: now + disableMs,
      reason: `连续 ${next} 次本地翻译失败（${localFailure.code}）`,
    }
  }
  return { streak: next, disableUntil: 0, reason: '' }
}
