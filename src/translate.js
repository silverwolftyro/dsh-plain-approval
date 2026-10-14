/**
 * 翻译编排：规则 → 上下文 → 缓存 → 引擎链 → 降级 → 归并。
 *
 * v0.4 的引擎链（默认 **API 优先**，面向完全不懂技术的用户）：
 *   'auto'        ctx.llm（DSH 内置 AI）→ 凭据直连 HTTP      —— 不碰 Ollama
 *   'deepseek'    凭据直连 HTTP
 *   'local-first' Ollama → ctx.llm → HTTP
 *   'ollama'      只用 Ollama
 *
 * 防 OOM（任务一）与设备能力（任务二）都在这里落地：
 * 设备档位不合格 / 可用内存不足 / 排队已满 / 熔断中 → 直接跳过 Ollama 并记录降级原因。
 *
 * 设计红线：
 *  - 绝不阻塞审批（真正的翻译由客户端异步 HTTP 触发；宿主只做同步规则判断）；
 *  - 绝不空白（模型不可用也给「翻译不可用」+ 本地规则七段）；
 *  - 队列串行（由 ollama-guard 统一控制）。
 * @module dsh-plain-approval/translate
 */
import { analyzeCommand, ruleSummary } from './rules.js'
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.js'
import { parseSevenSection, renderPlainText, renderEnglish } from './parse.js'
import { estimateCost, formatCny, formatDaily } from './cost.js'
import { cacheKey } from './cache.js'
import { checkOllama, translateWithOllama } from './engines/ollama.js'
import {
  checkDeepSeek,
  describeEndpoint,
  resolveApiKey,
  resolveEndpoint,
  resolveRoute,
  translateWithCtxLlm,
  translateWithDeepSeek,
} from './engines/deepseek.js'
import { extractContext, contextForPrompt, fallbackIntent, NO_CONTEXT_NOTE, NO_INTENT_NOTE } from './context.js'
import { decideDepth, canUpgradeToL2, DEPTH_LABELS } from './depth.js'
import { shortHash, truncateCommand, hasCJK, oneLine, clampChars, asSentence } from './util.js'

export const ENGINE_LABELS = {
  ollama: '本地 Ollama',
  deepseek: 'DeepSeek API',
}

/** 通道 → 人话（降级提示里用）。 */
const CHANNEL_LABELS = {
  ollama: '本地 Ollama',
  llm: 'DSH 内置 AI',
  http: 'DeepSeek API',
}

/** 单飞队列：同一时刻只跑一个翻译，其余排队（对两个通道都适用）。 */
function createQueue() {
  let tail = Promise.resolve()
  return function enqueue(task) {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * @param {object} deps
 * @param {Function} deps.getSettings
 * @param {object} deps.cache
 * @param {object} deps.store
 * @param {object} deps.logger
 * @param {object} [deps.ctx]
 * @param {object} [deps.guard] - ollama-guard（防 OOM）
 * @param {Function} [deps.detectDevice]
 */
export function createTranslator(deps) {
  const { getSettings, cache, store, logger, ctx, guard, detectDevice } = deps
  const enqueue = createQueue()
  let lastProbe = null
  let lastDevice = null

  const settings = () => getSettings()

  async function deviceInfo(force = false) {
    if (!detectDevice) return null
    try {
      lastDevice = await detectDevice({ thresholds: settings().device, force })
      return lastDevice
    } catch {
      return null
    }
  }

  /**
   * 引擎链。默认 'auto' = **只用 API**（需求：禁止在用户没主动选本地的情况下静默调用 Ollama）。
   */
  function engineOrder(s) {
    if (s.engine === 'ollama') return ['ollama']
    if (s.engine === 'deepseek') return ['http']
    if (s.engine === 'local-first') return ['ollama', 'llm', 'http']
    return ['llm', 'http'] // auto
  }

  /** Ollama 能不能用（设备档位 + 临时禁用）。 */
  function localGate(s, tier) {
    if (s.device.localDisabledUntil > 0 && s.device.localDisabledUntil > Date.now()) {
      const mins = Math.ceil((s.device.localDisabledUntil - Date.now()) / 60000)
      return { ok: false, reason: `本地通道已临时禁用（${s.device.localDisabledReason || '连续失败'}），约 ${mins} 分钟后自动恢复` }
    }
    if (s.device.enabled && tier === 'unusable' && !s.device.allowUnusableLocal) {
      return { ok: false, reason: '本机配置不足（显存/内存未达阈值），已自动改用 API' }
    }
    return { ok: true }
  }

  /* ---------------------------------------------------------------- */
  /* 规则态结果                                                        */
  /* ---------------------------------------------------------------- */

  function publicRules(rules) {
    return {
      risk: rules.risk,
      advice: rules.advice,
      mode: rules.mode,
      danger: rules.danger,
      network: rules.network,
      permission: rules.permission,
      registry: rules.registry,
      elevate: rules.elevate,
      encoded: rules.encoded,
      paths: rules.paths,
      downloads: rules.downloads,
      localOnly: rules.localOnly === true,
      tempCleanup: rules.tempCleanup === true,
      segmentKind: rules.segments.kind,
    }
  }

  function publicCommand(input) {
    return {
      text: input.command,
      truncated: input.truncated === true,
      originalLength: input.originalLength,
      toolName: input.toolName,
      reason: input.reason,
    }
  }

  function buildRuleOnly(input, rules, status, extra = {}) {
    const intent = extra.intent ?? (input.context && input.context.available ? fallbackIntent(input.context) : NO_CONTEXT_NOTE)
    return {
      v: 1,
      status,
      engine: null,
      engineLabel: null,
      via: null,
      degraded: true,
      degradeNote: extra.degradeNote ?? null,
      degradations: extra.degradations ?? [],
      cached: false,
      intent,
      sections: {
        intent,
        what: clampChars(ruleSummary(input.command, rules, input.toolName), 40),
        touch: rules.touch,
        mode: rules.mode,
        risk: rules.risk,
        advice: rules.advice,
        consequence: asSentence(rules.consequence),
        benefit: asSentence(rules.benefit),
        parts: rules.segments.kind === 'single'
          ? []
          : rules.segments.segments.map((s) => ({ label: s.label, text: oneLine(s.text, 120) })),
      },
      notes: rules.notes,
      formatWarning: extra.formatWarning ?? null,
      cost: null,
      daily: null,
      rules: publicRules(rules),
      command: publicCommand(input),
      hash: shortHash(input.command),
      headline: extra.headline ?? '翻译不可用，请自行判断',
      needsConfirm: extra.needsConfirm === true,
      denyRecommended: rules.advice === '建议拒绝',
      elapsedMs: extra.elapsedMs ?? 0,
      usage: null,
      context: input.context ? { available: input.context.available === true, step: input.context.step ?? null, note: input.context.note } : null,
    }
  }

  /** 用规则结果「加固」模型结果：规则能证明的结论优先。 */
  function mergeSections(llmSections, rules, intent, forceIntent = false) {
    const merged = { ...llmSections }
    const overrides = rules.overrides || {}
    if (overrides.force) {
      if (overrides.risk) merged.risk = overrides.risk
      if (overrides.advice) merged.advice = overrides.advice
      if (overrides.consequence) merged.consequence = asSentence(overrides.consequence)
    }
    if (rules.risk === '危险') {
      merged.risk = '危险'
      merged.advice = '建议拒绝'
      merged.consequence = asSentence(rules.consequence)
      if (rules.mode === '删除' || rules.mode === '混合') merged.mode = rules.mode
    } else if (!overrides.force && rules.risk === '注意' && llmSections.risk === '安全') {
      merged.risk = '注意'
      merged.advice = '请先确认'
      if (!merged.consequence || merged.consequence.length < 4) merged.consequence = asSentence(rules.consequence)
    }
    if (rules.segments.kind !== 'single' && (!merged.parts || merged.parts.length === 0)) {
      merged.parts = rules.segments.segments.map((s) => ({ label: s.label, text: oneLine(s.text, 120) }))
    }
    // 「意图」由上下文决定（v0.5.5 起取代原来的「背景」）：
    //  - 读不到上下文时**强制**用「未读取到会话上下文」—— 这是「信息缺失」；
    //  - 读到了上下文、但模型没给出可用意图时，用上下文兜底文案；
    //    连兜底文案都给不出，才写「已读取到但无法确定意图」—— 这是「模型无能」。
    // 两者必须分开：用户需要知道自己在看的是哪一种。
    //
    // ⚠️ 这里**只管意图文案，不碰 risk/advice/consequence**。
    //    意图是模型对「对方想干什么」的推测，风险是本地规则的判定 ——
    //    两者必须解耦，否则一段听起来合理的意图就能把危险操作洗成安全。
    const modelIntent = oneLine(merged.intent ?? '', 120)
    const fallbackFromContext = oneLine(intent ?? '', 120)
    const hasContextFallback = fallbackFromContext !== '' && !/未读取到会话上下文|no session context/iu.test(fallbackFromContext)
    if (forceIntent) {
      merged.intent = NO_CONTEXT_NOTE
    } else if (hasContextFallback && (modelIntent === '' || /未读取到会话上下文|no session context/iu.test(modelIntent))) {
      merged.intent = clampChars(fallbackFromContext, 60)
    } else if (modelIntent === '' || /未读取到会话上下文|no session context/iu.test(modelIntent)) {
      merged.intent = NO_INTENT_NOTE
    } else {
      merged.intent = clampChars(modelIntent, 60)
    }
    // 兜底：模型没给 parts 时，至少把分段原文列出来（由调用方填）
    return merged
  }

  /* ---------------------------------------------------------------- */
  /* 探测 / 自检                                                       */
  /* ---------------------------------------------------------------- */

  async function probe() {
    const s = settings()
    const device = await deviceInfo(true)
    const [ollama, deepseek] = await Promise.all([
      checkOllama(s.ollama).catch((error) => ({ status: 'red', code: 'probe-failed', detail: '探测失败：' + oneLine(error?.message, 120), models: [] })),
      checkDeepSeek(s.deepseek, ctx).catch((error) => ({ status: 'red', code: 'probe-failed', detail: '探测失败：' + oneLine(error?.message, 120) })),
    ])
    let localStatus = ollama
    if (device && s.device.enabled && device.tier === 'unusable' && !s.device.allowUnusableLocal) {
      localStatus = {
        ...ollama,
        status: 'red',
        code: 'device-unsupported',
        detail: `本机配置不足（${device.note}），已自动切换到 API。想强行启用本地通道请到设置页点「我明白风险，仍要启用」。`,
      }
    } else if (device && device.tier === 'marginal' && ollama.status === 'green') {
      localStatus = { ...ollama, status: 'yellow', code: 'low-spec', detail: `本地配置偏低（${device.note}），不推荐用本地模型` }
    }
    if (s.device.localDisabledUntil > Date.now()) {
      localStatus = { ...localStatus, status: 'red', code: 'local-disabled', detail: `本地通道已临时禁用：${s.device.localDisabledReason || '连续失败'}` }
    }
    const route = resolveRoute(ctx)
    lastProbe = {
      at: new Date().toISOString(),
      engine: s.engine,
      ollama: localStatus,
      deepseek,
      device,
      ollamaGuard: guard?.stats?.() ?? null,
      cache: { driver: cache?.driver, stats: cache?.stats?.() ?? null },
      dataDir: store?.dir,
      keySource: deepseek.keySource ?? null,
      route: { viaLlm: route.viaLlm, provider: route.provider, model: route.model },
    }
    return lastProbe
  }

  async function diag() {
    const s = settings()
    const report = { at: new Date().toISOString(), checks: {} }

    let llm = null
    try {
      llm = ctx?.get?.('llm') ?? null
    } catch {
      llm = null
    }
    const llmMethods = []
    if (llm) {
      for (const key of ['stream', 'listProviders', 'listModels', 'prepareCall', 'imageRequestPricing', 'registerConfigurableProviders']) {
        if (typeof llm[key] === 'function') llmMethods.push(key)
      }
    }
    report.checks.llm = {
      available: Boolean(llm),
      methods: llmMethods,
      conclusion: llm
        ? '可用。调用方式：ctx.llm.stream({ provider, model, system, messages, maxTokens, signal })。'
        : "ctx.get('llm') 拿不到，通道 B 只能走直连 HTTP。",
    }

    let selection = null
    try {
      selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null
    } catch {
      selection = null
    }
    report.checks.agentDefaultModel = {
      available: Boolean(selection),
      selection,
      conclusion: selection ? `可用。DSH 当前用的是 ${selection.provider} / ${selection.model}。` : '拿不到，直连时改用插件默认模型。',
    }

    let credentials = null
    try {
      credentials = ctx?.get?.('credentials') ?? null
    } catch {
      credentials = null
    }
    let keyInfo = { available: false, source: null }
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve('DEEPSEEK_API_KEY')
        if (hit && typeof hit === 'object' && typeof hit.value === 'string' && hit.value !== '') {
          keyInfo = { available: true, source: hit.source ?? 'unknown', length: hit.value.length }
        }
      } catch (error) {
        keyInfo = { available: false, source: null, error: oneLine(error?.message, 120) }
      }
    }
    const settingsKey = String(s.deepseek.apiKey ?? '').trim() !== ''
    report.checks.credentials = {
      serviceAvailable: Boolean(credentials),
      resolved: keyInfo,
      manualKeyConfigured: settingsKey,
      conclusion: keyInfo.available
        ? `能拿到 Key（来源：${keyInfo.source}）。`
        : settingsKey
          ? 'DSH 凭据里没拿到 Key，但插件设置里手填了一个。'
          : 'DSH 凭据里没拿到 Key；需要在设置页「高级」里手填一次。',
    }

    const endpoint = resolveEndpoint(s, ctx)
    report.checks.endpoint = {
      baseUrl: endpoint.baseUrl,
      baseUrlStyle: endpoint.style,
      model: endpoint.model,
      summary: describeEndpoint(endpoint),
    }

    // v0.5.1：实测 DSH 是否把「用户提问」子系统暴露给插件上下文。
    // 官方名字是 ctx.userQuestions（复数），不是 ctx.userInteraction。
    // 提供方不是靠 registerProvider 注册，而是监听 'user-questions/request' 瀑布事件。
    let userQuestions = null
    let uqError = null
    try {
      userQuestions = ctx?.get?.('userQuestions') ?? null
    } catch (error) {
      userQuestions = null
      uqError = oneLine(error?.message, 120)
    }
    const uqMethods = []
    if (userQuestions) {
      for (const key of ['ask', 'askTimed', 'answer', 'attachWait']) {
        if (typeof userQuestions[key] === 'function') uqMethods.push(key)
      }
    }
    report.checks.userQuestions = {
      available: Boolean(userQuestions),
      methods: uqMethods,
      lookupError: uqError,
      alsoTriedSingular: (() => {
        try {
          return ctx?.get?.('userInteraction') != null
        } catch {
          return false
        }
      })(),
      conclusion: userQuestions
        ? `可用。ctx.userQuestions 拿到了，方法：${uqMethods.join(', ') || '（无）'}。`
        : "ctx.get('userQuestions') 拿不到 —— 本 DSH 版本没有向插件暴露用户提问子系统，冲突提示降级为自绘。",
    }

    const device = await deviceInfo(true)
    const guardStats = guard?.stats?.() ?? null
    report.checks.device = {
      available: Boolean(device),
      tier: device?.tier ?? 'unknown',
      note: device?.note ?? '',
      gpu: device?.gpu ?? null,
      memory: device?.memory ?? null,
      conclusion: device ? `${device.tierLabel}；${device.note}` : '未做设备检测',
    }
    report.checks.ollamaGuard = {
      available: Boolean(guard),
      running: guardStats?.running ?? 0,
      queued: guardStats?.queued ?? 0,
      avgMsLast10: guardStats?.avgMs ?? null,
      failures: guardStats?.failures ?? 0,
      breaker: guardStats?.breaker ?? null,
      conclusion: guard
        ? `最近 10 次平均耗时 ${guardStats?.avgMs ?? '—'}ms；当前排队 ${guardStats?.queued ?? 0} 条、在跑 ${guardStats?.running ?? 0} 条；` +
          (guardStats?.breaker?.open
            ? `**熔断中**，约 ${Math.ceil((guardStats.breaker.remainingMs ?? 0) / 1000)} 秒后自动恢复（${guardStats.breaker.reason}）`
            : '未熔断')
        : '未启用防 OOM 护栏',
    }

    report.settings = { engine: s.engine, apiStyle: s.deepseek.apiStyle, slotMode: s.ui.slotMode, onboarded: s.ui.onboarded }
    return report
  }

  /* ---------------------------------------------------------------- */
  /* 通道执行                                                          */
  /* ---------------------------------------------------------------- */

  async function runChannel(channel, s, prompts, tier, allowPaid) {
    if (channel === 'ollama') {
      const gate = localGate(s, tier)
      if (!gate.ok) return { ok: false, code: 'local-gated', reason: gate.reason }
      const guardGate = guard ? guard.check() : { ok: true }
      if (!guardGate.ok) return { ok: false, code: guardGate.code, reason: guardGate.reason }

      const status = await checkOllama(s.ollama).catch(() => ({ status: 'red', code: 'probe-failed', detail: 'Ollama 探测失败' }))
      if (status.status !== 'green') return { ok: false, code: status.code ?? 'unavailable', reason: status.detail }

      const run = () => translateWithOllama(s.ollama, prompts.ollama)
      const result = guard ? await guard.run(shortHash(prompts.ollamaUserKey), run) : await run()
      if (result?.gateBlocked) return { ok: false, code: result.code, reason: result.reason }
      if (result.ok) {
        return { ok: true, ...result, engine: 'ollama', via: 'ollama', channel: 'ollama', truncatedForOllama: prompts.ollamaTruncated === true }
      }
      return { ok: false, code: result.code, reason: result.message }
    }

    if (channel === 'llm') {
      const route = resolveRoute(ctx)
      if (!route.viaLlm) return { ok: false, code: 'no-llm-service', reason: 'DSH 的模型服务不可用' }
      const result = await translateWithCtxLlm(ctx, prompts.full, s.deepseek.timeoutMs, route)
      if (result.ok) return { ok: true, ...result, engine: 'deepseek', via: 'llm', channel: 'llm' }
      return { ok: false, code: result.code, reason: result.message }
    }

    if (channel === 'http') {
      if (s.deepseek.askBeforeCall && !allowPaid) {
        return { ok: false, code: 'needs-confirm', reason: '按设置要求，使用 API 前需要你确认一次', needsConfirm: true }
      }
      const key = await resolveApiKey(s.deepseek, ctx)
      if (!key) return { ok: false, code: 'no-api-key', reason: '没有可用的 DeepSeek API Key（DSH 未配置，插件里也没填）' }
      const result = await translateWithDeepSeek(s.deepseek, prompts.full, key.key, ctx)
      if (result.ok) return { ok: true, ...result, engine: 'deepseek', via: 'http', channel: 'http' }
      return { ok: false, code: result.code, reason: result.message }
    }

    return { ok: false, code: 'unknown-channel', reason: '未知通道 ' + channel }
  }

  /* ---------------------------------------------------------------- */
  /* 主入口                                                            */
  /* ---------------------------------------------------------------- */

  async function translate(input) {
    const started = Date.now()
    const s = settings()
    const rawCommand = String(input?.command ?? '')
    const truncated = truncateCommand(rawCommand, 4000)
    const context = input?.context && typeof input.context === 'object' && input.context.available !== undefined
      ? input.context
      : extractContext(input?.agent, input?.callId)
    const normalized = {
      command: truncated.text,
      originalLength: truncated.originalLength,
      truncated: truncated.truncated,
      toolName: input?.toolName,
      reason: input?.reason,
      cwd: input?.cwd,
      callId: input?.callId,
      context,
    }

    if (rawCommand.trim() === '') {
      const empty = buildRuleOnly(normalized, analyzeCommand('', {}), 'empty', { headline: '空命令，无可翻译内容' })
      empty.sections = {
        intent: context?.available ? fallbackIntent(context) : NO_CONTEXT_NOTE,
        what: '空命令，无可翻译内容',
        touch: '没有要碰的东西',
        mode: '只读',
        risk: '安全',
        advice: '可以允许',
        consequence: '这条命令什么都不做。',
        benefit: '什么都不会发生。',
        parts: [],
      }
      empty.headline = '空命令，无可翻译内容'
      empty.text = { zh: renderPlainText(empty.sections), en: renderEnglish(empty.sections) }
      empty.elapsedMs = Date.now() - started
      return empty
    }

    const rules = analyzeCommand(normalized.command, { blacklist: s.blacklist, toolName: normalized.toolName })

    const baseNotes = [...rules.notes]
    if (truncated.truncated) {
      baseNotes.push(`命令过长，仅翻译前 ${truncated.text.length} 个字符（原始 ${truncated.originalLength} 字符）`)
    }
    if (!context?.available) baseNotes.push(NO_CONTEXT_NOTE)

    // ---- v0.6.0：先决定用哪一层分析 ----
    const depthInfo = decideDepth({ rules, settings: s, force: input?.forceDepth })
    normalized.depth = depthInfo.depth

    // L1：纯本地规则，**零模型调用**。七段照样给全（意图/收益由规则拼），
    // 卡片底部会标注「本次分析：L1 基础」。
    if (depthInfo.depth === 'l1') {
      const l1 = buildRuleOnly(normalized, rules, 'local', { intent: context?.available ? fallbackIntent(context) : NO_CONTEXT_NOTE })
      l1.notes = [...baseNotes]
      l1.depth = 'l1'
      l1.depthLabel = DEPTH_LABELS.l1
      l1.depthReason = depthInfo.reason
      // v0.6.2：命中位置区间，客户端据此高亮原始命令里的危险片段
      l1.spans = Array.isArray(rules.spans) ? rules.spans : []
      l1.elapsedMs = Date.now() - started
      l1.cost = { tokens: 0, cny: 0, costText: '未调用模型，0 成本' }
      l1.canUpgrade = canUpgradeToL2({ depth: 'l1', settings: s })
      l1.text = {
        zh: renderPlainText(l1.sections, { notes: l1.notes, engineLabel: '本地规则（未消耗任何额度）' }),
        en: renderEnglish(l1.sections),
      }
      logger?.info('translate.l1', { hash: l1.hash, risk: rules.risk, ms: l1.elapsedMs, reason: depthInfo.reason })
      return l1
    }

    // v0.6.0 起**不再**对危险命令短路：危险恰恰最需要把「它想干什么、为什么危险」讲清楚，
    // 所以走 L2 让模型分析。风险等级仍由本地规则兜底（mergeSections 会强制写死），
    // 模型改不动 —— 这里的改动只是让危险命令也有一份好解释。

    // v0.5.4：把上下文指纹传进缓存键 —— 否则「背景」段会被上一份「无上下文」的快照冻住
    const key = cacheKey({ command: normalized.command, engineMode: s.engine, engineIdentity: cacheIdentity(s), context })
    if (s.cache.enabled) {
      const hit = cache.get(key, s.cache.ttlDays)
      if (hit.hit && hit.value) {
        const daily = store?.readDailyCost?.()
        return { ...hit.value, cached: true, elapsedMs: Date.now() - started, daily: daily ? formatDaily(daily) : null }
      }
    }

    const device = await deviceInfo(false)
    const tier = device?.tier ?? 'unknown'

    // 防 OOM：给 Ollama 单独准备一份被截断的提示词
    const ollamaMax = Number(s.ollama.maxCommandChars) || 2000
    const ollamaTruncated = truncated.text.length > ollamaMax
    const ollamaCommand = ollamaTruncated ? truncated.text.slice(0, ollamaMax) : truncated.text
    const contextBlock = contextForPrompt(context)
    const prompts = {
      full: { system: SYSTEM_PROMPT, user: buildUserPrompt({ ...normalized, rules, context: contextBlock }) },
      ollama: {
        system: SYSTEM_PROMPT,
        user: buildUserPrompt({
          ...normalized,
          command: ollamaCommand,
          truncated: truncated.truncated || ollamaTruncated,
          maxChars: ollamaTruncated ? ollamaMax : undefined,
          rules,
          context: contextBlock,
        }),
      },
      ollamaUserKey: ollamaCommand,
      ollamaTruncated,
    }

    const order = engineOrder(s)
    const degradations = []
    let engineResult = null

    for (const channel of order) {
      const attempt = await enqueue(() => runChannel(channel, s, prompts, tier, input?.confirmPaid === true))
      if (attempt.ok) {
        engineResult = attempt
        break
      }
      if (attempt.code === 'needs-confirm') {
        const result = buildRuleOnly(normalized, rules, 'needs-confirm', {
          headline: '需要你确认：本次将使用 DeepSeek API（会消耗一点额度）',
          needsConfirm: true,
          degradeNote: attempt.reason,
          elapsedMs: Date.now() - started,
        })
        result.notes = baseNotes
        result.text = { zh: renderPlainText(result.sections, { notes: baseNotes }), en: renderEnglish(result.sections) }
        return result
      }
      degradations.push({ from: CHANNEL_LABELS[channel] ?? channel, code: attempt.code, reason: attempt.reason })
      logger?.warn('translate.channel-failed', { channel, code: attempt.code, reason: oneLine(attempt.reason, 160) })
    }

    if (!engineResult) {
      const summary = degradations.length
        ? degradations.map((d) => `${d.from}：${d.reason}`).join('；')
        : '没有可用的翻译通道'
      const result = buildRuleOnly(normalized, rules, 'unavailable', {
        headline: '翻译不可用，请自行判断',
        degradeNote: summary,
        degradations,
        elapsedMs: Date.now() - started,
      })
      result.notes = [...baseNotes, '模型通道不可用，以上是本地规则判断，仅供参考。']
      result.text = { zh: renderPlainText(result.sections, { notes: result.notes }), en: renderEnglish(result.sections) }
      logger?.failure({ command: normalized.command, engine: s.engine, code: 'all-unavailable', message: summary, ms: Date.now() - started })
      return result
    }

    const parsed = parseSevenSection(engineResult.text)
    const contextAvailable = context?.available === true
    const intent = contextAvailable ? fallbackIntent(context) : NO_CONTEXT_NOTE
    let sections
    let formatWarning = null
    if (parsed.ok) {
      sections = mergeSections(parsed.value, rules, intent, !contextAvailable)
    } else {
      formatWarning = { kind: parsed.reason, raw: oneLine(parsed.raw, 600) }
      sections = mergeSections(
        {
          what: clampChars(ruleSummary(normalized.command, rules, normalized.toolName), 40),
          touch: rules.touch,
          mode: rules.mode,
          risk: rules.risk,
          advice: rules.advice,
          consequence: asSentence(rules.consequence),
          benefit: asSentence(rules.benefit),
          parts: [],
        },
        rules,
        intent,
        !contextAvailable,
      )
      logger?.failure({ command: normalized.command, engine: engineResult.engine, code: 'format-invalid', message: parsed.reason, ms: engineResult.ms })
    }

    const engineLabel = ENGINE_LABELS[engineResult.engine] ?? null
    const cost = engineResult.engine === 'deepseek' ? estimateCost(engineResult.usage, s.pricing) : null
    let dailyText = ''
    if (cost && store?.addDailyCost) {
      const slot = store.addDailyCost({ cny: cost.cny, tokens: cost.totalTokens, calls: 1 })
      dailyText = formatDaily(slot)
    }

    const notes = [...baseNotes]
    if (engineResult.truncatedForOllama) {
      notes.push(`命令过长，仅翻译前 ${ollamaMax} 个字符（防 OOM：本地模型限制）`)
    }
    if (formatWarning) notes.push('翻译格式异常，以下结果由本地规则补全，原始返回附在下方。')
    // 降级提示（需求 14）：让用户知道这次是谁翻译的、为什么
    for (const d of degradations) notes.push(`${d.from} 本次不可用（${d.reason}），已改用 ${engineLabel ?? '其它通道'}`)
    if (s.device.enabled && tier === 'unusable' && s.device.allowUnusableLocal && engineResult.engine === 'ollama') {
      notes.push('本地配置不足，本次翻译可能导致系统卡顿。')
    }

    const result = {
      v: 1,
      status: 'ok',
      engine: engineResult.engine,
      engineLabel,
      via: engineResult.via,
      degraded: degradations.length > 0,
      degradeNote: degradations.length ? degradations.map((d) => `${d.from}→${engineLabel}`).join('；') : null,
      degradations,
      cached: false,
      // v0.6.0：把本次用的分析深度带出去，卡片底部要显示它 + 耗时 + 费用
      depth: depthInfo.depth,
      depthLabel: DEPTH_LABELS[depthInfo.depth],
      depthReason: depthInfo.reason,
      canUpgrade: canUpgradeToL2({ depth: depthInfo.depth, settings: s }),
      intent: sections.intent,
      sections,
      // v0.6.2：命中位置区间，客户端据此高亮原始命令里的危险片段
      spans: Array.isArray(rules.spans) ? rules.spans : [],
      notes,
      formatWarning,
      cost: cost ? { ...cost, costText: formatCny(cost.cny), dailyText } : null,
      daily: dailyText || null,
      rules: publicRules(rules),
      command: publicCommand(normalized),
      hash: shortHash(normalized.command),
      headline: null,
      needsConfirm: false,
      denyRecommended: sections.advice === '建议拒绝',
      elapsedMs: Date.now() - started,
      usage: engineResult.usage ?? null,
      context: { available: context?.available === true, step: context?.step ?? null, note: context?.note },
    }
    result.text = {
      zh: renderPlainText(sections, { notes, engineLabel, costText: cost ? cost.costText + '（' + cost.breakdown + '）' : '' }),
      en: renderEnglish(sections),
    }

    if (s.cache.enabled && !formatWarning) {
      cache.set(key, stripRuntimeFields(result), engineResult.engine)
    }
    logger?.info('translate.ok', {
      hash: result.hash,
      engine: engineResult.engine,
      via: engineResult.via,
      ms: result.elapsedMs,
      tokens: cost?.totalTokens ?? engineResult.usage?.totalTokens ?? null,
      degraded: result.degraded,
      // v0.5.5：这个字段表示「会话上下文是否读到」，跟段落名无关了，
      // 叫 background 会让人误以为还在报「背景」段。统一改成 context。
      context: context?.available ? 'yes' : 'no',
    })
    return result
  }

  /** 缓存身份：引擎策略 + 模型身份，切引擎/换模型都不命中旧缓存。 */
  function cacheIdentity(s) {
    const parts = []
    if (['ollama', 'local-first'].includes(s.engine)) parts.push(`ollama:${s.ollama.baseUrl}|${s.ollama.model}|ctx${s.ollama.numCtx}`)
    if (['auto', 'deepseek', 'local-first'].includes(s.engine)) parts.push(`deepseek:${s.deepseek.baseUrl}|${s.deepseek.model}`)
    return `${s.engine}::${parts.join(';;')}`
  }

  /** 只有规则态（不联网），给宿主监听器同步使用。 */
  function ruleOnly(input) {
    const s = settings()
    const truncated = truncateCommand(String(input?.command ?? ''), 4000)
    const context = input?.context ?? extractContext(input?.agent, input?.callId)
    const normalized = {
      command: truncated.text,
      originalLength: truncated.originalLength,
      truncated: truncated.truncated,
      toolName: input?.toolName,
      reason: input?.reason,
      cwd: input?.cwd,
      callId: input?.callId,
      context,
    }
    const rules = analyzeCommand(normalized.command, { blacklist: s.blacklist, toolName: normalized.toolName })
    const result = buildRuleOnly(normalized, rules, rules.risk === '危险' ? 'local-danger' : 'pending', {})
    result.headline = rules.risk === '危险' ? null : '正在翻译…'
    result.notes = rules.notes
    result.text = {
      zh: renderPlainText(result.sections, { notes: rules.notes, engineLabel: '本地规则（正在等待模型翻译）' }),
      en: renderEnglish(result.sections),
    }
    return result
  }

  /** 一键自检：分别跑通道 A / 通道 B（需求 55）。 */
  async function selftest() {
    const s = settings()
    const sample = 'ls -la'
    const report = { at: new Date().toISOString(), sample, device: await deviceInfo(false), channels: {} }
    const prompt = {
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({ command: sample, toolName: 'pwsh', rules: analyzeCommand(sample, { blacklist: s.blacklist }) }),
    }

    try {
      const gate = localGate(s, report.device?.tier ?? 'unknown')
      if (!gate.ok) {
        report.channels.ollama = { ok: false, code: 'local-gated', message: gate.reason }
      } else {
        const guardGate = guard ? guard.check() : { ok: true }
        if (!guardGate.ok) {
          report.channels.ollama = { ok: false, code: guardGate.code, message: guardGate.reason }
        } else {
          const a = await translateWithOllama(s.ollama, prompt)
          if (guard) guard.record(a)
          report.channels.ollama = a.ok
            ? { ok: true, ms: a.ms, usage: a.usage, durations: a.durations, preview: oneLine(a.text, 120) }
            : { ok: false, code: a.code, message: a.message, ms: a.ms }
        }
      }
    } catch (error) {
      report.channels.ollama = { ok: false, code: 'exception', message: oneLine(error?.message, 160) }
    }

    try {
      const route = resolveRoute(ctx)
      if (route.viaLlm) {
        const b = await translateWithCtxLlm(ctx, prompt, s.deepseek.timeoutMs, route)
        report.channels.deepseek = b.ok
          ? { ok: true, ms: b.ms, via: 'llm', route: b.route, usage: b.usage, preview: oneLine(b.text, 120) }
          : { ok: false, code: b.code, message: b.message, ms: b.ms }
      } else {
        const key = await resolveApiKey(s.deepseek, ctx)
        if (!key) {
          report.channels.deepseek = { ok: false, code: 'no-api-key', message: '没有可用的 DeepSeek API Key' }
        } else {
          const b = await translateWithDeepSeek(s.deepseek, prompt, key.key, ctx)
          report.channels.deepseek = b.ok
            ? { ok: true, ms: b.ms, via: 'http', usage: b.usage, preview: oneLine(b.text, 120) }
            : { ok: false, code: b.code, message: b.message, ms: b.ms }
        }
      }
    } catch (error) {
      report.channels.deepseek = { ok: false, code: 'exception', message: oneLine(error?.message, 160) }
    }

    report.pricing = s.pricing
    report.ollamaGuard = guard?.stats?.() ?? null
    return report
  }

  return {
    translate,
    ruleOnly,
    probe,
    diag,
    selftest,
    settings,
    deviceInfo,
    engineOrder,
    cacheSummary: () => ({ driver: cache?.driver, stats: cache?.stats?.() ?? null }),
    get lastProbe() {
      return lastProbe
    },
    get lastDevice() {
      return lastDevice
    },
  }
}

/** 缓存里不保存运行期字段。 */
function stripRuntimeFields(result) {
  return { ...result, cached: false, elapsedMs: 0, daily: null }
}

export { hasCJK }
