/**
 * 通道 A：本地 Ollama。
 *
 * 隐私承诺：命令内容只发往本机 http://127.0.0.1:11434，不联网、不上传外部服务器。
 * 全部失败路径都返回结构化结果，绝不抛异常给审批流程。
 * @module dsh-plain-approval/engines/ollama
 */
import { oneLine } from '../util.js'

export const ENGINE_LABEL = '本地 Ollama'

/** 判断一个地址是不是本机回环地址（用于隐私提示）。 */
export function isLoopback(baseUrl) {
  try {
    const url = new URL(baseUrl)
    return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * 探测 Ollama 状态（设置页状态灯用）。
 * @returns {Promise<{ status:'green'|'yellow'|'red', code:string, detail:string, models:string[] }>}
 */
export async function checkOllama(config) {
  const baseUrl = String(config?.baseUrl ?? '').replace(/\/+$/u, '')
  const model = String(config?.model ?? '')
  if (!baseUrl) return { status: 'red', code: 'no-base-url', detail: '未配置 Ollama 地址', models: [] }

  let response
  try {
    response = await fetch(baseUrl + '/api/tags', {
      method: 'GET',
      signal: AbortSignal.timeout(Math.min(Number(config?.timeoutMs) || 10000, 5000)),
    })
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? 'timeout' : 'unreachable'
    return {
      status: 'red',
      code,
      detail: code === 'timeout'
        ? `Ollama 响应超时（${baseUrl}）`
        : `连不上 Ollama（${baseUrl}），可能未安装或未启动`,
      models: [],
    }
  }
  if (!response.ok) {
    return { status: 'red', code: 'http-' + response.status, detail: `Ollama 返回 HTTP ${response.status}`, models: [] }
  }
  const data = await response.json().catch(() => null)
  const models = Array.isArray(data?.models) ? data.models.map((m) => String(m?.name ?? m?.model ?? '')).filter(Boolean) : []
  const has = models.some((m) => m === model || m.split(':')[0] === model)
  if (!has) {
    return {
      status: 'yellow',
      code: 'model-missing',
      detail: `Ollama 已启动，但没找到模型 ${model}。请先执行：ollama pull ${model}`,
      models,
    }
  }
  return { status: 'green', code: 'ok', detail: `Ollama 可用，模型 ${model} 已就绪`, models }
}

/**
 * 调用 Ollama 生成翻译。
 * @param {object} config - { baseUrl, model, timeoutMs }
 * @param {{ system: string, user: string }} prompt
 * @returns {Promise<{ ok:true, text:string, ms:number } | { ok:false, code:string, message:string, ms:number }>}
 */
export async function translateWithOllama(config, prompt) {
  const started = Date.now()
  const baseUrl = String(config?.baseUrl ?? '').replace(/\/+$/u, '')
  const model = String(config?.model ?? '')
  const timeoutMs = Number(config?.timeoutMs) || 10000
  const numPredict = Number(config?.numPredict) > 0 ? Number(config.numPredict) : 512
  const numCtx = Number(config?.numCtx) > 0 ? Number(config.numCtx) : 2048
  if (!baseUrl) return { ok: false, code: 'no-base-url', message: '未配置 Ollama 地址', ms: 0 }

  const body = {
    model,
    stream: false,
    format: 'json',
    // 防 OOM：用完就卸载，除非用户明确要求常驻显存
    keep_alive: config?.keepAlive === true ? '5m' : 0,
    options: {
      temperature: 0,
      num_predict: numPredict,
      num_ctx: numCtx,
    },
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  }

  let response
  try {
    response = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const ms = Date.now() - started
    if (error?.name === 'TimeoutError') {
      return { ok: false, code: 'timeout', message: `Ollama 超过 ${timeoutMs}ms 未返回`, ms }
    }
    return { ok: false, code: 'unreachable', message: '连不上 Ollama：' + oneLine(error?.message, 160), ms }
  }

  const ms = Date.now() - started
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (response.status === 404 && /model/iu.test(text)) {
      return { ok: false, code: 'model-missing', message: `Ollama 没有模型 ${model}，请执行：ollama pull ${model}`, ms }
    }
    return { ok: false, code: 'http-' + response.status, message: `Ollama 返回 HTTP ${response.status}：${oneLine(text, 160)}`, ms }
  }

  const data = await response.json().catch(() => null)
  if (!data) return { ok: false, code: 'bad-json', message: 'Ollama 返回了无法解析的内容', ms }
  const text = String(data?.message?.content ?? data?.response ?? '').trim()
  if (text === '') return { ok: false, code: 'empty', message: 'Ollama 返回了空内容', ms }
  const promptTokens = Number(data.prompt_eval_count) || 0
  const completionTokens = Number(data.eval_count) || 0
  const cached = Number(data.prompt_eval_cached_count) || 0
  return {
    ok: true,
    text,
    ms,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cacheHitTokens: cached,
      cacheMissTokens: Math.max(0, promptTokens - cached),
    },
    durations: {
      totalMs: Math.round((Number(data.total_duration) || 0) / 1e6),
      loadMs: Math.round((Number(data.load_duration) || 0) / 1e6),
      evalMs: Math.round((Number(data.eval_duration) || 0) / 1e6),
    },
  }
}
