/**
 * 把模型返回解析成卡片要用的结构（v0.7.0：七段 → 四段 + 本地规则注入）。
 *
 * 边界情况（对应需求 5 / 10）：
 *  - 返回不是合法 JSON → 尝试修复（去代码围栏、取第一个 JSON 对象、去尾逗号）
 *  - 再不行 → 试「纯文本标签」的老格式
 *  - 还不行 → 贴原始返回并标注「翻译格式异常」，交给调用方降级
 *
 * ## 风险/建议/读写从哪来
 * v0.7.0 起**模型不再判风险**。risk / advice / mode 一律取本地规则（rules.js 的 analyze），
 * 本地规则没有时才回退到模型给的旧字段（兼容老模型输出）。
 * 这既让提示词短了一截，也是「慢」的主要来源（失败率 44.9%）的直接解法。
 * @module dsh-plain-approval/parse
 */
import { asSentence, clampChars, oneLine, safeParse } from './util.js'

export const MODES = ['只读', '写入', '执行', '删除', '混合']
export const RISKS = ['安全', '注意', '危险']
export const ADVICES = ['可以允许', '请先确认', '建议拒绝']

/** 去掉模型爱加的前后缀。 */
export function stripNoise(raw) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^```[a-zA-Z]*\s*/u, '').replace(/```\s*$/u, '')
  text = text.replace(/^(译文|翻译|结果|输出)\s*[:：]\s*/u, '')
  return text.trim()
}

/** 从一段文本里抠出第一个完整的 JSON 对象。 */
export function extractJsonObject(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

/** 去掉对象里的尾逗号。 */
export function removeTrailingCommas(text) {
  return String(text ?? '').replace(/,\s*([}\]])/gu, '$1')
}

/**
 * 尝试把模型返回解析成卡片结构。
 * @param {string} raw
 * @param {{risk?:string, advice?:string, mode?:string}} [rules] - 本地规则结论
 * @returns {{ ok: true, value: object } | { ok: false, raw: string, reason: string }}
 */
export function parseSections(raw, rules = {}) {
  const text = stripNoise(raw)
  if (text === '') return { ok: false, raw: '', reason: 'empty' }

  const candidates = [text]
  const extracted = extractJsonObject(text)
  if (extracted && extracted !== text) candidates.push(extracted)
  if (extracted) candidates.push(removeTrailingCommas(extracted))
  candidates.push(removeTrailingCommas(text))

  for (const candidate of candidates) {
    const parsed = safeParse(candidate)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const normalized = normalizeSections(parsed, rules)
      if (normalized) return { ok: true, value: normalized }
    }
  }

  // 兜底：模型直接给「1. 干什么：…」这种纯文本（老模型的老习惯）
  const labelled = parseLabelledText(text, rules)
  if (labelled) return { ok: true, value: labelled }

  return { ok: false, raw: text, reason: 'not-seven-section' }
}

/** 旧接口名保留：老测试和外部调用方还在用。 */
export const parseSevenSection = parseSections

const FIELD_KEYS = {
  // background / 背景 归 title 而不是 why：v0.4~v0.6 的老模型把它当「背景+干什么」用，
  // 实际吐出来的内容是标题类（例：「你刚才让它测试弹窗」）。归错会让标题落进兜底句。
  title: ['title', '标题', 'headline', 'summary', '一句话', 'intent', '意图', '目的', 'goal', 'purpose', 'what', '干什么', '做什么', 'action', 'background', '背景'],
  why: ['why', '为什么', '原因', 'because', 'reason'],
  touch: ['touch', '碰什么', '涉及', '对象', 'target', 'path'],
  mode: ['mode', '读写', '读还是写', 'type'],
  risk: ['risk', '风险', '风险等级', 'level'],
  advice: ['advice', '建议', 'recommendation'],
  outcome: ['outcome', '结果', '如果允许', '会怎样', 'consequence', '后果', '最坏', 'worst'],
  benefit: ['benefit', '收益', '好处', 'gain'],
}

function pick(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key]
  }
  return undefined
}

/**
 * 空字符串也要兜底。
 * `value ?? fallback` 只挡 undefined/null，挡不住模型返回的 `""` ——
 * 实测真实 Ollama 就吐过空 touch，卡片上会出现一行「碰什么：」后面什么都没有。
 */
function orFallback(value, fallback) {
  const text = oneLine(value ?? '', 400)
  return text.trim() === '' ? fallback : text
}

/**
 * 把任意对象规范化成卡片结构；缺关键字段则返回 null。
 *
 * @param {object} source - 模型输出
 * @param {{risk?:string, advice?:string, mode?:string}} [rules] - 本地规则结论（优先于模型）
 */
export function normalizeSections(source, rules = {}) {
  const obj = source && typeof source === 'object' && source.sections && typeof source.sections === 'object'
    ? { ...source, ...source.sections }
    : source
  if (!obj || typeof obj !== 'object') return null

  const title = pick(obj, FIELD_KEYS.title)
  const why = pick(obj, FIELD_KEYS.why)
  const touch = pick(obj, FIELD_KEYS.touch)
  const mode = pick(obj, FIELD_KEYS.mode)
  const risk = pick(obj, FIELD_KEYS.risk)
  const advice = pick(obj, FIELD_KEYS.advice)
  const outcome = pick(obj, FIELD_KEYS.outcome)
  const benefit = pick(obj, FIELD_KEYS.benefit)

  // 一个可用字段都没有 → 视为格式失败（交给调用方降级）
  if (title === undefined && why === undefined && outcome === undefined && risk === undefined) return null

  const parts = Array.isArray(obj.parts)
    ? obj.parts
      .map((p, i) => (p && typeof p === 'object'
        ? { label: oneLine(p.label ?? `第 ${i + 1} 步`, 24), text: oneLine(p.text ?? p.explain ?? '', 200) }
        : { label: `第 ${i + 1} 步`, text: oneLine(p, 200) }))
      .filter((p) => p.text !== '')
      .slice(0, 20)
    : []

  // ---- 本地规则优先：模型不判风险，判了也只作兜底 ----
  const finalRisk = RISKS.includes(String(rules?.risk)) ? String(rules.risk)
    : RISKS.includes(String(risk)) ? String(risk) : '注意'
  const finalAdvice = ADVICES.includes(String(rules?.advice)) ? String(rules.advice)
    : ADVICES.includes(String(advice)) ? String(advice) : '请先确认'
  const finalMode = MODES.includes(String(rules?.mode)) ? String(rules.mode)
    : MODES.includes(String(mode)) ? String(mode) : '执行'

  const finalTitle = clampChars(orFallback(title, '（无法判断这一步在干什么，请看下方原始命令）'), 60)
  // 兼容旧字段：intent 是 title 的旧名，consequence 是 outcome 的旧名
  const finalOutcome = asSentence(orFallback(
    outcome ?? (benefit ? `${benefit}` : undefined),
    '无法判断如果允许会发生什么，请谨慎。',
  ))
  // benefit 单独保留：本地规则给了就用规则的，没给就退回 outcome
  // （置空是错的：老调用方会把它当 falsy 当成「这段没有」）。
  const finalBenefit = asSentence(orFallback(
    rules?.benefit ?? benefit ?? undefined,
    finalOutcome,
  ))
  // why 也必须有硬上限：它在折叠区里，但折叠区也可能被点开，
  // 一段 400 字的「为什么」会把原始命令挤出视口。
  const finalWhy = clampChars(orFallback(why, '无法确定这一步的原因，请查看下方原始命令。'), 120)

  return {
    // ---- v0.7.0 新结构 ----
    title: finalTitle,
    why: finalWhy,
    touch: orFallback(touch, '未能识别具体对象'),
    outcome: finalOutcome,
    // ---- 判定来自本地规则 ----
    risk: finalRisk,
    advice: finalAdvice,
    mode: finalMode,
    // ---- 兼容旧字段 ----
    // intent 接 why（不是 title）：intent 的历史语义是「想干什么、为什么干」，
    // 「读不到上下文就强制写兜底句」这条规则作用在它身上。让 intent = title
    // 会把兜底语义废掉 —— 模型给什么标题，意图就变成什么。
    intent: finalWhy,
    what: finalTitle,
    consequence: finalOutcome,
    benefit: finalBenefit,
    parts,
  }
}

/** 解析「1. 意图：xxx」这类纯文本七段（老模型的退路）。 */
export function parseLabelledText(text, rules = {}) {
  const labels = [
    ['title', /^\s*[1１]?[.、)]?\s*(标题|意图|目的|干什么|做什么|一句话|背景)\s*[:：]\s*(.+)$/u],
    ['why', /^\s*[2２]?[.、)]?\s*(为什么|原因)\s*[:：]\s*(.+)$/u],
    ['touch', /^\s*[3３]?[.、)]?\s*(碰什么|涉及|对象|读还是写|读写)\s*[:：]\s*(.+)$/u],
    ['risk', /^\s*[4４]?[.、)]?\s*(风险等级|风险)\s*[:：]\s*(.+)$/u],
    ['advice', /^\s*[5５]?[.、)]?\s*(建议)\s*[:：]\s*(.+)$/u],
    ['outcome', /^\s*[6６]?[.、)]?\s*(后果|收益|好处|如果允许)\s*[:：]\s*(.+)$/u],
  ]
  const found = {}
  for (const line of String(text).split('\n')) {
    for (const [key, re] of labels) {
      const m = line.match(re)
      if (m && found[key] === undefined) found[key] = m[2]
    }
  }
  if (!found.title && !found.risk && !found.outcome) return null
  return normalizeSections(found, rules)
}

/** 把卡片结构拼成可复制的纯文本（供「一键复制」使用）。 */
export function renderPlainText(sections, meta = {}) {
  const lines = ['【说人话】']
  lines.push(
    `1. 在干什么：${sections.title}`,
    `2. 为什么：${sections.why}`,
    `3. 碰什么：${sections.touch}`,
    `4. 风险等级：${sections.risk}`,
    `5. 建议：${sections.advice}`,
    `6. 如果允许：${sections.outcome}`,
  )
  if (sections.parts?.length) {
    lines.push('', '分步目的：')
    for (const p of sections.parts) lines.push(`- ${p.label}：${p.text}`)
  }
  if (meta.notes?.length) {
    lines.push('', '注意：')
    for (const n of meta.notes) lines.push('- ' + n)
  }
  if (meta.engineLabel) lines.push('', `本次翻译由：${meta.engineLabel}`)
  if (meta.costText) lines.push(meta.costText)
  return lines.join('\n')
}

/** 英文版渲染（displayReason 的 en 面，保持基线可用）。 */
export function renderEnglish(sections) {
  const lines = []
  lines.push(
    '1. What it is doing: ' + sections.title,
    '2. Why: ' + sections.why,
    '3. What it touches: ' + sections.touch,
    '4. Risk: ' + sections.risk,
    '5. Advice: ' + sections.advice,
    '6. If allowed: ' + sections.outcome,
  )
  return lines.join('\n')
}
