/**
 * 分析深度分层（v0.6.0）：决定这一次翻译要花多少力气。
 *
 * 用户的诉求是「我想自己决定要多准」。于是有了两层：
 *
 *   L1 基础层 —— 纯本地规则，**零模型调用**，<100ms，0 成本。
 *              七段照样给全，但「意图 / 收益」是本地规则拼的，
 *              不会像模型那样结合上下文写出「你刚才让它补全模型」。
 *
 *   L2 标准层 —— 本地规则 + 模型翻译。当前默认行为，2~10 秒。
 *
 * （L3 深度层排在 v0.6.1 —— 它需要更长的上下文和一致性检查，
 *   收益要等审批历史攒够才说得清，现在做等于凭空猜。）
 *
 * ## 一条不可协商的底线
 *
 * **危险命令永远走 L2，不允许被降级成 L1。**
 * L1 的「意图」是本地规则拼的，看不懂复杂脚本；
 * 而危险恰恰是最需要被认真解释的场景 —— 这两件事撞在一起时，
 * 宁可多花一次模型调用的钱，也不能给危险操作一个「看起来没事」的快速通道。
 *
 * @module dsh-plain-approval/depth
 */

export const DEPTH_L1 = 'l1'
export const DEPTH_L2 = 'l2'

/** 展示用文案。 */
export const DEPTH_LABELS = {
  l1: 'L1 基础（本地规则，零模型调用）',
  l2: 'L2 标准（本地规则 + 模型）',
}

/**
 * 决定这一次翻译用哪一层。
 *
 * @param {object} input
 * @param {object} input.rules - analyzeCommand() 的结果
 * @param {object} input.settings - 完整设置
 * @param {string} [input.force] - 强制指定深度（用户点了「升级到 L2」）
 * @returns {{ depth: 'l1'|'l2', reason: string, forced: boolean }}
 */
export function decideDepth({ rules, settings, force } = {}) {
  const risk = String(rules?.risk ?? '')
  // v0.6.1：缺省 / 脏值一律按 'l2' 处理 —— 宁可多花一次调用的钱，
  // 也不要因为配置读不出来就静默降级成「看不清意图」的 L1。
  const pref = ['auto', 'l1', 'l2'].includes(settings?.ui?.analysisDepth) ? settings.ui.analysisDepth : 'l2'

  // 1) 用户手动升级 —— 优先级最高
  if (force === 'l2') return { depth: DEPTH_L2, reason: '用户手动升级', forced: true }

  // 2) 危险：硬底线，任何配置都改不了
  if (risk === '危险') return { depth: DEPTH_L2, reason: '危险命令强制 L2（不可降级）', forced: true }

  // 3) 显式偏好
  if (pref === 'l1') return { depth: DEPTH_L1, reason: '你设置为优先用本地规则', forced: false }
  if (pref === 'l2') return { depth: DEPTH_L2, reason: '你设置为一律用模型', forced: false }

  // 4) auto：安全走 L1，其余走 L2
  if (risk === '安全') return { depth: DEPTH_L1, reason: '安全命令用本地规则即可', forced: false }
  return { depth: DEPTH_L2, reason: `「${risk || '未知'}」命令需要模型分析`, forced: false }
}

/**
 * L1 能不能被降级成 L2？——用于 UI：卡片上要不要显示「升级到 L2」按钮。
 * L2 之上没有更深的层（v0.6.0），所以 L2 不显示。
 */
export function canUpgradeToL2({ depth, settings } = {}) {
  if (settings?.ui?.allowUpgrade === false) return false
  return depth === DEPTH_L1
}
