/**
 * 通道 B：直接调用 DSH 正在使用的 DeepSeek。
 *
 * 取 Key 的三级顺序（不要求用户重复填写）：
 *   1. 设置页手动填写的 Key（用户自己显式指定时）
 *   2. DSH 凭据服务里的 DEEPSEEK_API_KEY（和 DSH 用的是同一个 Key）
 *   3. 进程环境变量 DEEPSEEK_API_KEY
 *
 * 走哪条路（两条都支持，优先第一条）：
 *   A. `ctx.llm.stream()` —— DSH 自己的模型路由，插件连 Key 都不碰
 *   B. 直连 HTTP —— baseUrl / 协议 / model 由 deepseek-endpoint.js 从 DSH 配置里解析
 *
 * 注意：使用通道 B 时，命令内容会发送到 DeepSeek（或 DSH 配置的代理 endpoint），
 * UI 必须明确警告。
 * @module dsh-plain-approval/engines/deepseek
 */
import { oneLine, sleep } from '../util.js'
import { resolveEndpoint, describeEndpoint } from '../deepseek-endpoint.js'

export const ENGINE_LABEL = 'DeepSeek API'
export const CREDENTIAL_REF = 'DEEPSEEK_API_KEY'

/**
 * 解析可用的 API Key。
 * @param {object} config - { apiKey }
 * @param {object} [ctx] - cordis 上下文（用于 ctx.get('credentials')）
 * @param {object} [env] - process.env
 * @returns {Promise<{ key:string, source:'settings'|'credentials'|'env' } | null>}
 */
export async function resolveApiKey(config, ctx, env = process.env) {
  const fromSettings = String(config?.apiKey ?? '').trim()
  if (fromSettings !== '') return { key: fromSettings, source: 'settings' }

  try {
    const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
    if (credentials && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(CREDENTIAL_REF)
      const value = hit && typeof hit === 'object' ? hit.value : undefined
      if (typeof value === 'string' && value.trim() !== '') return { key: value.trim(), source: 'credentials' }
    }
  } catch {
    /* 凭据服务不可用时继续往下找 */
  }

  const fromEnv = env?.[CREDENTIAL_REF]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { key: fromEnv.trim(), source: 'env' }
  return null
}

export function keySourceLabel(source) {
  if (source === 'settings') return '插件设置里填写的 Key'
  if (source === 'credentials') return 'DSH 凭据服务（和 DSH 同一个 Key）'
  if (source === 'env') return '环境变量 DEEPSEEK_API_KEY'
  return '未知来源'
}

/**
 * 首选路径：直接复用 DSH 已配置的 provider / model 跑一次对话。
 * 不接触 API Key，不需要用户额外填写任何东西。
 * @returns {{ viaLlm:boolean, provider:string, model:string, llm:object|null, selection:object|null }}
 */
export function resolveRoute(ctx) {
  let llm = null
  try {
    llm = ctx?.get?.('llm') ?? null
  } catch {
    llm = null
  }
  const endpoint = resolveEndpoint({ deepseek: {} }, ctx)
  const selection = endpoint.selection
  const provider = selection?.provider || 'deepseek-official'
  const model = selection?.model || 'deepseek-flash'
  return { viaLlm: Boolean(llm && typeof llm.stream === 'function'), provider, model, llm, selection }
}

/** 只做「能不能用」的探测，不消耗额度。 */
export async function checkDeepSeek(config, ctx, env = process.env) {
  const settings = { deepseek: config ?? {} }
  const endpoint = resolveEndpoint(settings, ctx, env)
  if (endpoint.viaLlm) {
    return {
      status: 'green',
      code: 'ok',
      detail: `复用 DSH 已配置的模型路由：${endpoint.selection?.provider ?? 'deepseek-official'} / ${endpoint.selection?.model ?? 'deepseek-flash'}（不需要额外的 API Key）`,
      via: 'llm',
      endpoint: describeEndpoint(endpoint),
      baseUrl: endpoint.baseUrl,
      style: endpoint.style,
      model: endpoint.model,
    }
  }
  const resolved = await resolveApiKey(config, ctx, env)
  if (!resolved) {
    return {
      status: 'red',
      code: 'no-api-key',
      detail: '通道 B 不可用：既拿不到 DSH 的模型路由，也找不到 DeepSeek API Key。请到 DSH「设置 → 模型」填入，或在插件设置页「高级」里手动填一次，或启用本地 Ollama。',
      via: 'http',
      endpoint: describeEndpoint(endpoint),
      baseUrl: endpoint.baseUrl,
      style: endpoint.style,
      model: endpoint.model,
    }
  }
  return {
    status: 'green',
    code: 'ok',
    detail: `DeepSeek API 就绪（Key 来源：${keySourceLabel(resolved.source)}；endpoint：${endpoint.baseUrl}；协议：${endpoint.style}）`,
    via: 'http',
    keySource: resolved.source,
    endpoint: describeEndpoint(endpoint),
    baseUrl: endpoint.baseUrl,
    style: endpoint.style,
    model: endpoint.model,
  }
}

/**
 * 通过 ctx.llm 跑一次翻译（首选）。
 * @returns {Promise<{ok:true,text:string,usage:object|null,ms:number,route:string,via:string}
 *   | {ok:false,code:string,message:string,ms:number}>}
 */
export async function translateWithCtxLlm(ctx, prompt, timeoutMs = 15000, route = undefined) {
  const started = Date.now()
  const resolved = route ?? resolveRoute(ctx)
  if (!resolved.viaLlm) return { ok: false, code: 'no-llm-service', message: 'DSH 的模型服务不可用', ms: 0 }

  const signal = AbortSignal.timeout(timeoutMs)
  let text = ''
  let usage = null
  let failure = null
  try {
    const stream = resolved.llm.stream({
      provider: resolved.provider,
      model: resolved.model,
      system: prompt.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
      maxTokens: 900,
      temperature: 0,
      signal,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
      else if (chunk.type === 'usage') usage = chunk.usage ?? null
      else if (chunk.type === 'finish' && chunk.reason?.failure) failure = chunk.reason.failure
    }
  } catch (error) {
    const ms = Date.now() - started
    if (error?.name === 'TimeoutError' || signal.aborted) {
      return { ok: false, code: 'timeout', message: `DeepSeek 超过 ${timeoutMs}ms 未返回`, ms }
    }
    return { ok: false, code: 'llm-error', message: 'DSH 模型调用失败：' + oneLine(error?.message, 180), ms }
  }

  const ms = Date.now() - started
  if (failure) {
    const code = String(failure.code ?? 'llm-failure')
    return { ok: false, code: mapFailureCode(code), message: failureMessage(code, failure), ms }
  }
  const value = String(text ?? '').trim()
  if (value === '') return { ok: false, code: 'empty', message: 'DeepSeek 返回了空内容', ms }
  return {
    ok: true,
    text: value,
    usage: normalizeCtxUsage(usage),
    ms,
    route: `${resolved.provider}/${resolved.model}`,
    via: 'llm',
  }
}

/** DSH TokenUsage → 统一 usage 形状。 */
export function normalizeCtxUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.inputTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const cacheRead = Number(usage.cacheReadTokens) || 0
  const cacheWrite = Number(usage.cacheWriteTokens) || 0
  const total = Number(usage.totalTokens) || input + output + cacheRead + cacheWrite
  return {
    promptTokens: input + cacheRead + cacheWrite,
    completionTokens: output,
    totalTokens: total,
    cacheHitTokens: cacheRead,
    cacheMissTokens: input,
  }
}

/**
 * 直连 HTTP 跑一次翻译（兜底）。
 * 同时支持 OpenAI 兼容接口与 Anthropic Messages 接口，具体走哪个由 endpoint.style 决定。
 * @param {object} config - 已归一化的 deepseek 设置
 * @param {{system:string,user:string}} prompt
 * @param {string} apiKey
 * @param {object} [ctx]
 * @param {object} [env]
 */
export async function translateWithDeepSeek(config, prompt, apiKey, ctx, env = process.env) {
  const endpoint = resolveEndpoint({ deepseek: config ?? {} }, ctx, env)
  const timeoutMs = Number(config?.timeoutMs) || 15000
  const retryOnRateLimit = config?.retryOnRateLimit !== false
  if (!apiKey) return { ok: false, code: 'no-api-key', message: '没有可用的 DeepSeek API Key', ms: 0, endpoint }

  const request = endpoint.style === 'anthropic'
    ? buildAnthropicRequest(endpoint, prompt, apiKey)
    : buildOpenAiRequest(endpoint, prompt, apiKey)

  const attempt = async () => {
    const started = Date.now()
    let response
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const ms = Date.now() - started
      if (error?.name === 'TimeoutError') return { ok: false, code: 'timeout', message: `DeepSeek 超过 ${timeoutMs}ms 未返回`, ms }
      return { ok: false, code: 'network', message: 'DeepSeek 网络异常：' + oneLine(error?.message, 160), ms }
    }

    const ms = Date.now() - started
    const text = await response.text().catch(() => '')

    if (response.status === 429) return { ok: false, code: 'rate-limit', message: 'DeepSeek 返回限流 429', ms }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'auth', message: 'DeepSeek API Key 无效或已失效，请检查 DSH 的模型设置或插件里手填的 Key', ms }
    }
    if (response.status === 402) return { ok: false, code: 'quota', message: 'DeepSeek 账户余额不足，请充值后再试', ms }
    if (!response.ok) {
      return { ok: false, code: 'http-' + response.status, message: `DeepSeek 返回 HTTP ${response.status}：${oneLine(text, 200)}`, ms }
    }

    const data = safeJson(text)
    const value = endpoint.style === 'anthropic' ? extractAnthropicText(data) : extractOpenAiText(data)
    if (value === '') return { ok: false, code: 'empty', message: 'DeepSeek 返回了空内容', ms }
    const usage = endpoint.style === 'anthropic' ? normalizeAnthropicUsage(data?.usage) : normalizeOpenAiUsage(data?.usage)
    return { ok: true, text: value, usage, ms, model: data?.model, via: 'http', endpoint }
  }

  const first = await attempt()
  if (first.ok) return first
  if (first.code === 'rate-limit' && retryOnRateLimit) {
    await sleep(1000)
    const second = await attempt()
    if (second.ok) return second
    return { ok: false, code: second.code, message: `限流后退避重试仍失败：${second.message}`, ms: first.ms + second.ms, endpoint }
  }
  return first
}

function buildOpenAiRequest(endpoint, prompt, apiKey) {
  const base = endpoint.baseUrl.replace(/\/+$/u, '')
  return {
    url: base.endsWith('/v1') ? base + '/chat/completions' : base + '/chat/completions',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: {
      model: endpoint.model,
      stream: false,
      temperature: 0,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    },
  }
}

function buildAnthropicRequest(endpoint, prompt, apiKey) {
  const base = endpoint.baseUrl.replace(/\/+$/u, '')
  const url = base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages'
  return {
    url,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: endpoint.model,
      max_tokens: 800,
      temperature: 0,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    },
  }
}

function extractOpenAiText(data) {
  return String(data?.choices?.[0]?.message?.content ?? '').trim()
}

function extractAnthropicText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : []
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
    .trim()
}

/** 把 OpenAI 风格 usage 规范化（含缓存命中/未命中拆分）。 */
export function normalizeOpenAiUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const promptTokens = Number(usage.prompt_tokens) || 0
  const completionTokens = Number(usage.completion_tokens) || 0
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens
  const cacheHit = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0
  const cacheMiss = Number(usage.prompt_cache_miss_tokens) || Math.max(0, promptTokens - cacheHit)
  return { promptTokens, completionTokens, totalTokens, cacheHitTokens: cacheHit, cacheMissTokens: cacheMiss }
}

/** 把 Anthropic 风格 usage 规范化。注意 inputTokens 不含缓存读/写。 */
export function normalizeAnthropicUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.input_tokens) || 0
  const output = Number(usage.output_tokens) || 0
  const cacheRead = Number(usage.cache_read_input_tokens) || 0
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0
  return {
    promptTokens: input + cacheRead + cacheWrite,
    completionTokens: output,
    totalTokens: input + output + cacheRead + cacheWrite,
    cacheHitTokens: cacheRead,
    cacheMissTokens: input,
  }
}

function mapFailureCode(code) {
  if (/RATE_LIMIT/u.test(code)) return 'rate-limit'
  if (/AUTH|CREDENTIAL/u.test(code)) return 'auth'
  if (/QUOTA/u.test(code)) return 'quota'
  if (/TIMEOUT/u.test(code)) return 'timeout'
  return code.toLowerCase()
}

function failureMessage(code, failure) {
  if (/MISSING_CREDENTIAL|INVALID_CREDENTIAL|AUTH/u.test(code)) return 'DeepSeek API Key 无效或未配置，请检查 DSH 的模型设置'
  if (/RATE_LIMIT/u.test(code)) return 'DeepSeek 返回限流（429），请稍后再试'
  if (/QUOTA/u.test(code)) return 'DeepSeek 账户额度不足，请检查账户余额'
  if (/TIMEOUT/u.test(code)) return 'DeepSeek 响应超时'
  return `DeepSeek 调用失败：${oneLine(failure?.message ?? code, 180)}`
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export { resolveEndpoint, describeEndpoint }
