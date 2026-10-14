/**
 * 费用估算：token → 人民币。
 * 只有通道 B 才产生费用；本地 Ollama 不产生任何费用。
 * @module dsh-plain-approval/cost
 */

/**
 * 默认单价（元 / 百万 token）。
 *
 * 取值依据：DeepSeek 官方定价页 deepseek-flash **峰时**价格
 * （缓存命中 $0.006 / 缓存未命中 $0.30 / 输出 $1.20 每百万 token），
 * 按 1 USD ≈ 7.2 元换算。峰时 = UTC 周一至周五 01:00–04:00 与 06:00–10:00，
 * 其余时段（含周末与节假日）为谷时，价格约为峰时的一半。
 *
 * 选峰时价是刻意保守：宁可把费用多显示一点，也不让用户在不知情的情况下花钱。
 * 数字随时会变，请以官网为准，并可在设置页「费用单价」里改成你看到的实际价格。
 */
export const DEFAULT_PRICING = {
  inputMissPerMillion: 2.16,
  inputHitPerMillion: 0.0432,
  outputPerMillion: 8.64,
}

/**
 * 估算一次翻译的费用。
 * @param {object|null} usage - { promptTokens, completionTokens, totalTokens, cacheHitTokens, cacheMissTokens }
 * @param {object} [pricing]
 * @returns {{
 *   promptTokens:number, completionTokens:number, totalTokens:number,
 *   cny:number, cnyText:string, breakdown:string
 * } | null}
 */
export function estimateCost(usage, pricing = DEFAULT_PRICING) {
  if (!usage) return null
  const promptTokens = Number(usage.promptTokens) || 0
  const completionTokens = Number(usage.completionTokens) || 0
  const totalTokens = Number(usage.totalTokens) || promptTokens + completionTokens
  const hit = Number(usage.cacheHitTokens) || 0
  const miss = usage.cacheMissTokens === undefined ? Math.max(0, promptTokens - hit) : Number(usage.cacheMissTokens) || 0

  const p = { ...DEFAULT_PRICING, ...(pricing || {}) }
  const cny =
    (miss / 1e6) * Number(p.inputMissPerMillion) +
    (hit / 1e6) * Number(p.inputHitPerMillion) +
    (completionTokens / 1e6) * Number(p.outputPerMillion)

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    cny,
    cnyText: formatCny(cny),
    breakdown: `输入 ${miss + hit} token（缓存命中 ${hit}） + 输出 ${completionTokens} token`,
  }
}

/** 费用显示：小钱也要看得见，但不显示成 0。 */
export function formatCny(value) {
  const n = Number(value) || 0
  if (n === 0) return '约 0 元（本次未产生费用）'
  if (n < 0.0001) return '约 0.0001 元（不足 0.1 厘）'
  if (n < 0.01) return `约 ${n.toFixed(4)} 元`
  if (n < 1) return `约 ${n.toFixed(3)} 元`
  return `约 ${n.toFixed(2)} 元`
}

/** 当日累计展示。 */
export function formatDaily(daily) {
  if (!daily) return ''
  return `当日累计：${Number(daily.calls) || 0} 次 · ${Number(daily.tokens) || 0} token · ${formatCny(daily.cny)}`
}
