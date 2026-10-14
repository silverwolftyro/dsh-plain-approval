/**
 * 解析「通道 B 到底该往哪儿发、用哪个模型」。
 *
 * 需求：**不要硬编码 `https://api.deepseek.com`**。
 * DSH 可能把 DeepSeek 走到了代理或自建 endpoint（`llm-deepseek` 的 `baseURL`
 * 配置项，或 `DEEPSEEK_BASE_URL` 环境变量），插件必须跟着走。
 *
 * 解析优先级：
 *   1. 插件设置里的 `deepseek.baseUrl`（用户显式指定，最高）
 *   2. 环境变量 `DEEPSEEK_BASE_URL`（DSH 官方适配器认这个变量）
 *   3. profile / DSH_HOME 里 `cordis.yml` / `cordis.patch.yml` 中 `llm-deepseek` 行的 `baseURL`
 *   4. DSH 官方默认 `https://api.deepseek.com`
 *
 * 协议风格（apiStyle）：
 *   - baseUrl 以 `/anthropic` 结尾（DSH 官方适配器的默认值就是
 *     `https://api.deepseek.com/anthropic`）→ 走 Anthropic Messages 协议
 *   - 否则 → 走 OpenAI 兼容的 `/chat/completions`
 * @module dsh-plain-approval/deepseek-endpoint
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from './config.js'

export const OFFICIAL_BASE_URL = 'https://api.deepseek.com'
export const OFFICIAL_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
export const DEFAULT_OPENAI_MODEL = 'deepseek-chat'
export const DEFAULT_ANTHROPIC_MODEL = 'deepseek-flash'

/** 可能写着 llm-deepseek 配置的文件（按优先级）。 */
function candidateConfigFiles(env) {
  const files = []
  const profileDir = env?.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    files.push(join(profileDir, 'cordis.patch.yml'))
    files.push(join(profileDir, 'cordis.yml'))
  }
  const home = resolveDshHome(env)
  files.push(join(home, 'cordis.patch.yml'))
  files.push(join(home, 'cordis.yml'))
  return files
}

/**
 * 在 YAML 里找 `llm-deepseek` 那一行的 `baseURL`。
 * 不做完整 YAML 解析（避免引入依赖），按行做块扫描即可。
 * @returns {string|null}
 */
export function scanBaseUrlFromYaml(text) {
  const lines = String(text ?? '').split(/\r?\n/u)
  let blockIndent = null
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    // 块结束：出现缩进更浅、且还是列表项/键的行
    const indent = line.length - line.trimStart().length
    if (inBlock && indent <= blockIndent && /^(-\s|\w)/u.test(trimmed)) {
      inBlock = false
      blockIndent = null
    }

    if (!inBlock) {
      // 进入一个含 llm-deepseek 的条目
      if (/\bllm-deepseek\b/u.test(trimmed) && /^(-\s+|name:|id:)/u.test(trimmed)) {
        inBlock = true
        blockIndent = indent
        // 同一行里也可能直接写着 baseURL
        const inline = trimmed.match(/baseURL\s*:\s*['"]?([^'"\s,}]+)/u)
        if (inline) return inline[1]
      }
      continue
    }

    const match = trimmed.match(/^baseURL\s*:\s*['"]?([^'"\s,}]+)/u)
    if (match) return match[1]
  }
  return null
}

/** 从配置文件里解析 baseURL。 */
export function scanBaseUrlFromFiles(env) {
  for (const file of candidateConfigFiles(env)) {
    try {
      if (!existsSync(file)) continue
      const found = scanBaseUrlFromYaml(readFileSync(file, 'utf8'))
      if (found) return { value: found, source: file }
    } catch {
      /* 读不了就跳过 */
    }
  }
  return null
}

/** 按 baseUrl 猜协议风格。 */
export function styleOf(baseUrl, configured = 'auto') {
  if (configured === 'openai' || configured === 'anthropic') return configured
  return /\/anthropic\/?$/u.test(String(baseUrl ?? '')) ? 'anthropic' : 'openai'
}

/** DSH 当前选中的 provider / model（拿不到就返回 null）。 */
export function dshSelection(ctx) {
  try {
    const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
    if (selection && (selection.provider || selection.model)) {
      return { provider: selection.provider ?? null, model: selection.model ?? null }
    }
  } catch {
    /* 服务不在就算了 */
  }
  return null
}

/**
 * 解析通道 B 的完整目标。
 * @param {object} settings - 已归一化的插件设置
 * @param {object} [ctx] - cordis 上下文
 * @param {object} [env] - process.env
 * @returns {{
 *   baseUrl: string, style: 'openai'|'anthropic', model: string,
 *   selection: object|null, viaLlm: boolean,
 *   baseUrlSource: string, modelSource: string, alternatives: string[]
 * }}
 */
export function resolveEndpoint(settings, ctx, env = process.env) {
  const configured = settings?.deepseek ?? {}
  const selection = dshSelection(ctx)

  let baseUrl = ''
  let baseUrlSource = ''
  const alternatives = []

  if (configured.baseUrl) {
    baseUrl = configured.baseUrl
    baseUrlSource = '插件设置'
  }
  if (!baseUrl) {
    const fromEnv = env?.DEEPSEEK_BASE_URL
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      baseUrl = fromEnv.trim().replace(/\/+$/u, '')
      baseUrlSource = '环境变量 DEEPSEEK_BASE_URL'
    }
  }
  if (!baseUrl) {
    const fromFile = scanBaseUrlFromFiles(env)
    if (fromFile) {
      baseUrl = fromFile.value.trim().replace(/\/+$/u, '')
      baseUrlSource = 'DSH 配置：' + fromFile.source
    }
  }
  if (!baseUrl) {
    // 兜底：DSH 适配器的公开默认值
    baseUrl = OFFICIAL_ANTHROPIC_BASE_URL
    baseUrlSource = 'DSH 官方默认值（未找到任何显式配置）'
    alternatives.push(OFFICIAL_BASE_URL)
  }

  const style = styleOf(baseUrl, configured.apiStyle)

  let model = configured.model
  let modelSource = model ? '插件设置' : ''
  if (!model) {
    if (style === 'anthropic' && selection?.model) {
      model = selection.model
      modelSource = 'DSH 当前选择的模型（agentDefaultModel）'
    } else {
      model = style === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL
      modelSource = '插件默认值'
    }
  }

  let viaLlm = false
  try {
    const llm = ctx?.get?.('llm')
    viaLlm = Boolean(llm && typeof llm.stream === 'function')
  } catch {
    viaLlm = false
  }

  return { baseUrl, style, model, selection, viaLlm, baseUrlSource, modelSource, alternatives }
}

/** 给诊断接口用的人类可读摘要。 */
export function describeEndpoint(endpoint) {
  return [
    `baseUrl=${endpoint.baseUrl}（来源：${endpoint.baseUrlSource}）`,
    `协议=${endpoint.style === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}`,
    `model=${endpoint.model}（来源：${endpoint.modelSource}）`,
    `DSH 模型路由=${endpoint.viaLlm ? '可用' : '不可用'}`,
    endpoint.selection ? `DSH 当前选择=${endpoint.selection.provider}/${endpoint.selection.model}` : 'DSH 当前选择=未知',
  ].join('；')
}
