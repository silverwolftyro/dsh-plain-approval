/**
 * 把模型返回解析成固定七段。
 *
 * 边界情况（对应需求 5 / 10）：
 *  - 返回不是合法七段 → 尝试修复（去代码围栏、取第一个 JSON 对象、去尾逗号、补字段）
 *  - 修不了 → 贴原始返回并标注「翻译格式异常」
 *  - 返回空 → 视为失败，交给调用方降级
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
 * 尝试把模型返回解析成七段。
 * @returns {{ ok: true, value: object } | { ok: false, raw: string, reason: string }}
 */
export function parseSevenSection(raw) {
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
      const normalized = normalizeSections(parsed)
      if (normalized) return { ok: true, value: normalized }
    }
  }

  // 兜底：模型直接给「1. 干什么：…」这种七行文本
  const labelled = parseLabelledText(text)
  if (labelled) return { ok: true, value: labelled }

  return { ok: false, raw: text, reason: 'not-seven-section' }
}

const FIELD_KEYS = {
  /**
   * v0.5.5：「意图」取代了原先的「背景 + 干什么」两段。
   *
   * 为什么合并：原来分开时，用户看到的是「分步执行一段脚本」+「你刚才让它测试弹窗」，
   * 拼起来仍然不知道**它到底想达成什么**。合成一段之后，模型必须回答一个问题：
   * 「AI 想干什么、为什么干」。
   *
   * 后面几个别名是**兼容旧输出**用的：老模型只会吐 background / what，
   * 不能因为换字段名就让它们变成「未识别」。
   */
  intent: ['intent', '意图', '目的', 'goal', 'purpose', 'background', '背景', 'what', '干什么', '做什么', '一句话', 'summary', 'action'],
  touch: ['touch', '碰什么', '涉及', '对象', 'target', 'path'],
  mode: ['mode', '读写', '读还是写', 'type'],
  risk: ['risk', '风险', '风险等级', 'level'],
  advice: ['advice', '建议', 'recommendation'],
  consequence: ['consequence', '后果', '最坏', 'worst'],
  benefit: ['benefit', '收益', '好处', '好处是什么', 'gain'],
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
 * 空着比显示一句兜底更糟：用户会以为插件坏了。
 */
function orFallback(value, fallback) {
  const text = oneLine(value ?? '', 400)
  return text.trim() === '' ? fallback : text
}

/** 把任意对象规范化成七段；缺关键字段则返回 null。 */
export function normalizeSections(source) {
  const obj = source && typeof source === 'object' && source.sections && typeof source.sections === 'object'
    ? { ...source, ...source.sections }
    : source
  const intent = pick(obj, FIELD_KEYS.intent)
  const touch = pick(obj, FIELD_KEYS.touch)
  const mode = pick(obj, FIELD_KEYS.mode)
  const risk = pick(obj, FIELD_KEYS.risk)
  const advice = pick(obj, FIELD_KEYS.advice)
  const consequence = pick(obj, FIELD_KEYS.consequence)
  const benefit = pick(obj, FIELD_KEYS.benefit)

  if (intent === undefined && risk === undefined && consequence === undefined) return null

  const parts = Array.isArray(obj.parts)
    ? obj.parts
      .map((p, i) => (p && typeof p === 'object'
        ? { label: oneLine(p.label ?? `第 ${i + 1} 步`, 24), text: oneLine(p.text ?? p.explain ?? '', 200) }
        : { label: `第 ${i + 1} 步`, text: oneLine(p, 200) }))
      .filter((p) => p.text !== '')
      .slice(0, 20)
    : []

  return {
    // 「意图」段（v0.5.5）：最多 60 个汉字，放最前面
    intent: clampChars(orFallback(intent, '（无法判断这一步的意图，请看下方原始命令）'), 60),
    touch: orFallback(touch, '未能识别具体对象'),
    mode: MODES.includes(String(mode)) ? String(mode) : '执行',
    risk: RISKS.includes(String(risk)) ? String(risk) : '注意',
    advice: ADVICES.includes(String(advice)) ? String(advice) : '请先确认',
    consequence: asSentence(orFallback(consequence, '无法判断最坏后果，请谨慎。')),
    benefit: asSentence(orFallback(benefit, '无法判断收益，请谨慎。')),
    parts,
  }
}

/** 解析「1. 意图：xxx」这类纯文本七段。 */
export function parseLabelledText(text) {
  const labels = [
    // 「意图」的正则同时认旧标签，模型偶尔还会照着旧提示词吐「干什么」。
    ['intent', /^\s*[1１]?[.、)]?\s*(意图|目的|干什么|做什么|一句话|背景)\s*[:：]\s*(.+)$/u],
    ['touch', /^\s*[2２]?[.、)]?\s*(碰什么|涉及|对象)\s*[:：]\s*(.+)$/u],
    ['mode', /^\s*[3３]?[.、)]?\s*(读还是写|读写|类型)\s*[:：]\s*(.+)$/u],
    ['risk', /^\s*[4４]?[.、)]?\s*(风险等级|风险)\s*[:：]\s*(.+)$/u],
    ['advice', /^\s*[5５]?[.、)]?\s*(建议)\s*[:：]\s*(.+)$/u],
    ['consequence', /^\s*[6６]?[.、)]?\s*(后果)\s*[:：]\s*(.+)$/u],
    ['benefit', /^\s*[7７]?[.、)]?\s*(收益|好处)\s*[:：]\s*(.+)$/u],
  ]
  const found = {}
  for (const line of String(text).split('\n')) {
    for (const [key, re] of labels) {
      const m = line.match(re)
      if (m) found[key] = m[2]
    }
  }
  if (!found.intent && !found.risk) return null
  return normalizeSections(found)
}

/** 把七段拼成可复制的纯文本（供「一键复制」使用）。 */
export function renderPlainText(sections, meta = {}) {
  const lines = ['【说人话】']
  lines.push(
    `1. 意图：${sections.intent}`,
    `2. 碰什么：${sections.touch}`,
    `3. 读还是写：${sections.mode}`,
    `4. 风险等级：${sections.risk}`,
    `5. 建议：${sections.advice}`,
    `6. 后果：${sections.consequence}`,
    `7. 收益：${sections.benefit}`,
  )
  if (sections.parts?.length) {
    lines.push('', '分步意图：')
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
    '1. Intent: ' + sections.intent,
    '2. What it touches: ' + sections.touch,
    '3. Read or write: ' + sections.mode,
    '4. Risk: ' + sections.risk,
    '5. Advice: ' + sections.advice,
    '6. Worst case: ' + sections.consequence,
    '7. Benefit: ' + sections.benefit,
  )
  return lines.join('\n')
}
