/**
 * 说人话 —— Host 半边。
 *
 * 职责：
 *  1. 在 `approval/request` 水位线上做**同步**的本地规则判断，把七段结论写回
 *     `req.displayReason['plain-approval']`（绝不 await，绝不拖住审批弹窗）。
 *  2. **长期同意（v0.3）**：命中的「安全」命令直接返回 `allowed-once` 短路瀑布 ——
 *     不弹窗、自动放行，并写审计日志。
 *  3. 记录挂起审批，供客户端在**让位模式**下用浮层展示。
 *  4. 注册 `/api/plain-approval/*`（前缀**不带尾斜杠**，见 server.js）。
 *  5. 记录槽位自适应（让位/接管）的决定。
 *
 * 任何环节失败都只降级，绝不抛错、绝不阻断审批。
 * @module dsh-plain-approval/plugin
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.js'
import { createLogger } from './logger.js'
import { createCache } from './cache.js'
import { createTranslator } from './translate.js'
import { createApiHandler, API_PREFIX } from './server.js'
import { createGrants, workspaceScope } from './grants.js'
import { createAudit } from './audit.js'
import { createHistory } from './history.js'
import { createOllamaGuard } from './ollama-guard.js'
import { detectDevice } from './device.js'
import { extractContext } from './context.js'
import { evaluateLocalHealth } from './local-health.js'
import { analyzeCommand } from './rules.js'
import { normalizeSettings, mergeDeep, DEFAULT_SETTINGS } from './config.js'
import { safeParse, shortHash, sha256, oneLine } from './util.js'

export const name = 'plain-approval'
export const PLUGIN_ID = 'dsh-plain-approval'

/** 插件版本（用于确认「跑起来的到底是哪一版」）。 */
export const VERSION = (() => {
  try {
    return createRequire(import.meta.url)('../package.json').version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 挂起审批最多保留多少条（防止泄漏）。 */
const MAX_PENDING = 20
/** 挂起审批的最长保留时间（毫秒）——兜底，正常靠 next() 结算清理。 */
const PENDING_TTL_MS = 10 * 60 * 1000

export function apply(ctx, rowConfig = {}) {
  const store = createStore({ env: process.env })
  let userSettings = store.readRawSettings()
  let cachedSettings = normalizeSettings(mergeDeep(rowConfig || {}, userSettings || {}))

  function getSettings() {
    return cachedSettings
  }

  function refreshSettings() {
    userSettings = store.readRawSettings()
    cachedSettings = normalizeSettings(mergeDeep(rowConfig || {}, userSettings || {}))
    return cachedSettings
  }

  function saveSettings(patch) {
    const result = store.saveRawSettings(sanitizeSettingsPatch(patch))
    refreshSettings()
    return { settings: cachedSettings, raw: result.settings }
  }

  const logger = createLogger({ store, ctx, getSettings })
  const cache = createCache({ dir: store.dir, driver: cachedSettings.cache.driver })
  const guard = createOllamaGuard({ getSettings, logger, getDevice: () => translator.lastDevice })
  const translator = createTranslator({ getSettings, cache, store, logger, ctx, guard, detectDevice })
  const grants = createGrants({ dir: store.dir, scope: workspaceScope() })
  const audit = createAudit({ dir: store.dir })
  // v0.5.3：审批历史。它记的是**用户的真实决定**（来自 waterfall 的 outcome），
  // 不是客户端上报的 —— 客户端伪造不了，也省掉一次往返。
  const history = createHistory({ dir: store.dir, getSettings })

  ctx.logger?.info?.(
    '%s v%s: host 已加载，引擎=%s，缓存=%s，槽位模式=%s，工作区=%s，数据目录=%s',
    PLUGIN_ID,
    VERSION,
    cachedSettings.engine,
    cache.driver,
    cachedSettings.ui.slotMode,
    grants.scope,
    store.dir,
  )
  logger.info('host.loaded', {
    version: VERSION,
    engine: cachedSettings.engine,
    cache: cache.driver,
    slotMode: cachedSettings.ui.slotMode,
    workspace: grants.scope,
    grants: grants.size(),
  })

  /* v0.5.1：启动时就把「DSH 是否向插件暴露用户提问子系统」记进日志。
     写在启动日志里而不是只放进设置页自检，是因为 DSH 的 web server 有鉴权，
     外部探针打不进来 —— 日志是唯一可靠的取证渠道。 */
  try {
    const uq = getUserQuestionsService()
    const methods = []
    if (uq) {
      for (const key of ['ask', 'askTimed', 'answer', 'attachWait']) {
        if (typeof uq[key] === 'function') methods.push(key)
      }
    }
    let singular = false
    try {
      singular = ctx?.get?.('userInteraction') != null
    } catch {
      singular = false
    }
    logger.info('probe.userQuestions', {
      available: Boolean(uq),
      methods: methods.join(','),
      singularAvailable: singular,
      note: uq ? '可用' : "ctx.get('userQuestions') 不可用 —— 冲突提示将降级为自绘",
    })
  } catch (error) {
    logger.warn('probe.userQuestions.failed', { message: oneLine(error?.message, 160) })
  }

  /* ---------------------------------------------------------------- */
  /* 0. 槽位状态（v0.5.0-stable：固定模式 + 只读冲突快照）                */
  /* ---------------------------------------------------------------- */
  /*                                                                  */
  /* v0.4.x 这里跑的是「自动让位」：客户端把 conversation.composer 上  */
  /* 每个条目的 select() 都调一遍，谁接手就让位，判定一变就整棵子树换  */
  /* 挂。那套逻辑既不可预测（v0.4.3 的内存爆炸就发生在它决定的让位路径 */
  /* 上），也让用户失去控制。                                        */
  /*                                                                  */
  /* v0.5.0 起：                                                       */
  /*   · 模式只来自配置 ui.slotMode，代码**不做任何判定、不做任何翻转**；*/
  /*   · 客户端只上报一次「只读冲突快照」（只读条目元数据，            */
  /*     **绝不调用任何人的 select()**，绝不改任何东西），只用于设置页   */
  /*     提示和首次的一次性选择；                                     */
  /*   · 是否接管完全由用户在设置页显式决定。                          */
  /* ---------------------------------------------------------------- */

  const MODE_LABEL = { takeover: '说人话接管审批卡', overlay: '说人话显示在右下角浮窗', off: '完全不接管（回退到 DSH 原生）' }

  let slotState = {
    mode: cachedSettings.ui.slotMode,
    conflictResolved: cachedSettings.ui.conflictResolved === true,
    rivals: [],
    scannedAt: null,
    note: '客户端尚未上报冲突快照（页面还没刷新，或客户端未加载）',
  }

  /**
   * 客户端上报「只读冲突快照」。
   * 只认 list 这一项；客户端保证它**没有调用过任何人的 select()**。
   * 这里同样不做任何判定 —— 只是记下来给设置页显示。
   */
  function noteSlotEvent(event, details) {
    if (event === 'slot.scan') {
      const list = Array.isArray(details.rivals) ? details.rivals.slice(0, 10) : []
      const changed = list.join(',') !== slotState.rivals.join(',')
      slotState = {
        mode: cachedSettings.ui.slotMode,
        conflictResolved: cachedSettings.ui.conflictResolved === true,
        rivals: list,
        scannedAt: new Date().toISOString(),
        note: list.length === 0
          ? '未发现会处理审批卡的第三方插件'
          : '检测到这些插件也在占用审批卡槽位：' + list.join('、'),
      }
      if (changed) {
        logger.info(list.length === 0 ? 'slot.scan.clean' : 'slot.scan.conflict', {
          count: list.length,
          rivals: list.join(','),
          mode: cachedSettings.ui.slotMode,
        })
      }
    }
    if (event === 'slot.choice') {
      logger.info('slot.choice', { mode: cachedSettings.ui.slotMode })
    }
    if (event === 'card.no-command') {
      logger.warn('card.no-command', { tool: details.tool, callId: details.callId })
    }
  }

  function getSlotState() {
    return { ...slotState, mode: cachedSettings.ui.slotMode, label: MODE_LABEL[cachedSettings.ui.slotMode] ?? MODE_LABEL.takeover }
  }

  /* ---------------------------------------------------------------- */
  /* 1.5 用户提问（v0.5.1）：优先走 DSH 标准提问机制                      */
  /* ---------------------------------------------------------------- */
  /*                                                                  */
  /* 官方子系统是 ctx.userQuestions（复数），提供方不是注册式，而是     */
  /* 监听 'user-questions/request' 瀑布事件。这里只是**发起方**：调用  */
  /* ask() 后由已连接的 Client 或其它提供方回答。                       */
  /*                                                                  */
  /* 三条硬约束，全部在这里兜住：                                       */
  /*   1. ask() 会**阻塞**直到有人回答 —— 所以必须带 AbortSignal + 超时；*/
  /*   2. 审批流水线是同步的，绝不能被它拖住 —— 所以只走独立的 HTTP 路由；*/
  /*   3. 本子系统在某些 DSH 版本 / 某些上下文里可能不存在 —— 所以任何   */
  /*      一步失败都返回 supported:false，由客户端降级为自绘提示。       */
  /* ---------------------------------------------------------------- */

  /** 提问超时：给用户 5 分钟；超时视为「没回答」，客户端保持自绘提示。 */
  const ASK_TIMEOUT_MS = 5 * 60 * 1000

  /** 选项 label → slotMode。label 必须和下面 askConflict 里的 options 完全一致。 */
  const ASK_OPTION_TO_MODE = {
    '只用说人话（接管模式）': 'takeover',
    '让给对方，我用右下角浮窗（浮窗模式）': 'overlay',
    '两个都不显示（完全关闭）': 'off',
  }

  function getUserQuestionsService() {
    try {
      return ctx?.get?.('userQuestions') ?? null
    } catch {
      return null
    }
  }

  /**
   * 用 DSH 标准提问机制问「槽位冲突怎么处理」。
   * @param {string[]} rivals 检测到的冲突项显示名
   * @returns {Promise<{supported: boolean, mode?: string, reason?: string, detail?: string}>}
   */
  async function askConflict(rivals) {
    const uq = getUserQuestionsService()
    if (!uq || typeof uq.ask !== 'function') {
      logger.warn('user-questions.unavailable', {
        hasService: Boolean(uq),
        reason: "ctx.get('userQuestions') 拿不到；本 DSH 版本未向插件暴露用户提问子系统",
        fallback: 'self-rendered',
      })
      return { supported: false, reason: 'not-exposed', detail: "ctx.get('userQuestions') 不可用" }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }, ASK_TIMEOUT_MS)

    try {
      const answer = await uq.ask({
        signal: controller.signal,
        questions: [
          {
            id: 'plain-approval-conflict',
            question: '检测到另一个插件也在处理审批卡片，你想让谁显示？',
            detail: `冲突项：${(Array.isArray(rivals) ? rivals : []).join('、') || '未知插件'}。这个选择会被记住，以后不会再问。`,
            header: '说人话 · 卡片归属',
            multiSelect: false,
            options: [
              { label: '只用说人话（接管模式）', description: '审批卡片由说人话渲染，显示完整七段' },
              { label: '让给对方，我用右下角浮窗（浮窗模式）', description: '别人的卡片保持原样，说人话显示在右下角' },
              { label: '两个都不显示（完全关闭）', description: '回退到 DSH 原生审批卡片' },
            ],
          },
        ],
      })
      const item = Array.isArray(answer?.answers) ? answer.answers.find((a) => a && a.id === 'plain-approval-conflict') : null
      const picked = Array.isArray(item?.selected) && item.selected.length > 0 ? String(item.selected[0]) : ''
      const mode = ASK_OPTION_TO_MODE[picked] ?? null
      if (!mode) {
        logger.warn('user-questions.unmapped', { picked: oneLine(picked, 120), custom: oneLine(item?.custom ?? '', 120) })
        return { supported: false, reason: 'unmapped-answer', detail: `无法识别的回答：${oneLine(picked || item?.custom || '空', 120)}` }
      }
      logger.info('user-questions.answered', { mode })
      return { supported: true, mode }
    } catch (error) {
      const code = error?.code ?? ''
      logger.warn('user-questions.failed', { code: String(code), message: oneLine(error?.message, 160), fallback: 'self-rendered' })
      return { supported: false, reason: String(code || 'error'), detail: oneLine(error?.message, 160) }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ---------------------------------------------------------------- */
  /* 1. 挂起审批表                                                     */
  /* ---------------------------------------------------------------- */

  const pending = new Map()

  function prunePending() {
    const now = Date.now()
    for (const [key, entry] of pending) {
      if (now - entry.at > PENDING_TTL_MS) pending.delete(key)
    }
    while (pending.size > MAX_PENDING) {
      const oldest = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!oldest) break
      pending.delete(oldest[0])
    }
  }

  function listPending() {
    prunePending()
    return [...pending.values()]
      .sort((a, b) => b.at - a.at)
      .map((entry) => ({
        key: entry.key,
        at: new Date(entry.at).toISOString(),
        toolName: entry.toolName,
        reason: entry.reason,
        hash: entry.hash,
        command: entry.command,
        commandMissing: entry.commandMissing === true,
        quick: entry.quick,
        // v0.5.8：宿主已算好的完整翻译（还没算完时为 null）。
        // 客户端拿到它就不必再发一次 /translate —— 省掉一整轮 6~20 秒。
        full: entry.full ?? null,
      }))
  }

  /**
   * 按 callId 找回挂起条目。
   *
   * v0.5.6 修：客户端请求 /translate 时**拿不到上下文** —— 那次调用发生在浏览器里，
   * 没有 agent，只能 extractContext(undefined, callId) → 空 → 意图被强制写成
   * 「未读取到会话上下文」。而宿主在审批监听器里明明读到了（approval.seen 的 context=yes）。
   *
   * v0.7.0 修（实测复现）：上面那条只对**裸 callId** 生效。真机上抓到过
   *   pendingFound=false 的一次，日志里 callId 是 `92d4aaf2...:call_00_qGfO99mC...` ——
   *   客户端某些路径传的是**已经被拼上 hash 的复合形式**，再拼一次 ':' 自然匹配不上后缀，
   *   上下文（连同 reasoning）就整块丢了，卡片退回「未读取到会话上下文」。
   *
   * 现在两种形态都能查到：对原值、以及它最后一段冒号后的部分，各试一次。
   */
  function findPendingByCallId(callId) {
    if (callId === undefined || callId === null || callId === '') return null
    const raw = String(callId)
    const candidates = new Set([raw])
    const tail = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : ''
    if (tail && tail !== raw) candidates.add(tail)
    for (const entry of pending.values()) {
      const key = String(entry?.key ?? '')
      for (const c of candidates) {
        if (c !== '' && key.endsWith(':' + c)) return entry
      }
    }
    return null
  }

  /* ---------------------------------------------------------------- */
  /* 2. 审批水位线                                                      */
  /* ---------------------------------------------------------------- */

  /** 连续多少次「本地通道失败」就临时禁用本地（需求 四.2：2 次）。 */
  let localFailStreak = 0

  /**
   * 观察一次翻译结果里的本地通道健康状况。
   * 用户强行在低配机器上开本地时，连续 2 次因内存/超时失败就自动切回 API 30 分钟。
   */
  function observeLocalHealth(result) {
    try {
      const s = getSettings()
      const next = evaluateLocalHealth({ streak: localFailStreak }, result, {
        allowUnusableLocal: s.device.allowUnusableLocal === true,
      })
      if (!next) return
      localFailStreak = next.streak
      if (next.disableUntil > 0) {
        saveSettings({
          device: { localDisabledUntil: next.disableUntil, localDisabledReason: next.reason },
        })
        logger.warn('device.local-disabled', {
          until: new Date(next.disableUntil).toISOString(),
          reason: next.reason,
        })
      } else if (next.streak > 0) {
        logger.warn('ollama.fail-streak', { streak: next.streak })
      }
    } catch (error) {
      logger.warn('ollama.health-observe-failed', { message: oneLine(error?.message, 160) })
    }
  }

  function commandFromSession(agent, callId) {    try {
      const session = agent?.session
      if (!session || callId === undefined || callId === null) return undefined
      const end = typeof session.seq === 'number' ? session.seq : 0
      for (let seq = end - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt(seq)
        if (!event) continue
        if (event.type !== 'tool/call') continue
        if (String(event.data?.callId) !== String(callId)) continue
        return extractCommand(event.data?.arguments)
      }
    } catch {
      return undefined
    }
    return undefined
  }

  function listener(request, next) {
    let settle = null
    // v0.5.7 诊断：v0.5.6 真机上出现过「approval.seen 之后所有日志全无」的死局，
    // 根因查不出来。现在从进入监听器开始全程留痕 —— 哪怕什么都没做，也得有痕迹。
    let skipReason = ''
    let ctxAvailable = null
    let cmdMissing = null
    try {
      // 无条件留一条：只要监听器被调用过，这里就一定有记录。
      // 如果这条都没有，说明监听器根本没被调用（没注册 / 被 dispose / 事件没转发过来）。
      logger.info('approval.listener-enter', {
        tool: String(request?.toolName ?? ''),
        callId: String(request?.callId ?? ''),
        frozen: Boolean(request && typeof request === 'object' && Object.isFrozen(request)),
      })
      if (request && typeof request === 'object' && !Object.isFrozen(request)) {
        const settings = getSettings()
        const fromSession = commandFromSession(request.agent, request.callId)
        const commandMissing = fromSession === undefined || fromSession === ''
        const toolName = request.toolName
        // 需求（稳定性）：取不到命令原文也要给卡片一个可渲染的结果，绝不空白。
        const rawCommand = commandMissing ? '' : fromSession
        const truncated = rawCommand.length > 4000 ? rawCommand.slice(0, 4000) : rawCommand

        const rules = analyzeCommand(truncated, { blacklist: settings.blacklist, toolName })

        // v0.5.8 关键修复：**先读上下文，再算 quick**。
        //
        // 以前顺序反了：ruleOnly() 先算（没给 context → 意图被写成「未读取到会话上下文」），
        // 下一行才读 context，但只用来填 quick.contextInfo，没进 sections。
        // 而客户端卡片的**初始内容就是这份 quick**，要等 6~20 秒模型返回才会被替换 ——
        // 于是用户看到的是「未读取到会话上下文 + 正在翻译…」，哪怕宿主其实读到了上下文。
        //
        // 现在 context 先读出来直接喂给 ruleOnly，卡片**一出现就是有用的**：
        // 意图用 fallbackIntent(context) 从会话内容即时生成，模型返回后再升级为完整版。
        const context = commandMissing ? null : extractContext(request.agent, request.callId)

        const quick = translator.ruleOnly({
          command: truncated,
          toolName,
          reason: request.reason,
          callId: request.callId,
          context,
        })
        quick.commandMissing = commandMissing
        if (commandMissing) {
          quick.headline = '未能从会话里取到命令原文；卡片会用客户端读到的命令继续翻译'
          quick.sections.intent = `准备执行 ${toolZhSafe(toolName)}（原文未能取到）`
        }

        // 会话上下文：已在上面读出（v0.5.8 提前到 ruleOnly 之前），这里只回填信息位
        quick.contextInfo = context ? { available: context.available === true, step: context.step ?? null } : { available: false }

        const display = request.displayReason && typeof request.displayReason === 'object' && !Array.isArray(request.displayReason)
          ? request.displayReason
          : {}
        display['plain-approval'] = quick
        // 卡片内摘要（v0.4.3）：**默认关闭**。
        // 原生卡片（dsh-reject-message 的 `.drm-headline`）会把 displayReason 的本地化字符串
        // 直接当标题渲染；用户嫌那行摘要多余。关闭时**完全不碰**本地化文本，
        // 让卡片回落到它自己的原生原因，翻译只从浮窗进（入口是卡片上的「说人话」按钮）。
        if (getSettings().ui.showInlineSummary === true) {
          display.zh = `说人话：${oneLine(quick.sections.intent, 30)}（风险：${quick.sections.risk}）· 点卡片上的「说人话」看详情`
          display.en = `Plain: ${oneLine(quick.sections.intent, 40)} (risk: ${quick.sections.risk}) · click "Translate" on the card for details`
        }
        const hadDisplay = request.displayReason !== undefined
        if (hadDisplay || getSettings().ui.showInlineSummary === true) {
          request.displayReason = display
        }

        if (!commandMissing) {
          // ---- 长期同意（v0.3）：命中且规则判「安全」→ 短路瀑布，不弹窗 ----
          const grant = grants.match(truncated)
          if (grant && grant.risk === '安全' && rules.risk === '安全') {
            const used = grants.markUsed(grant.id)
            audit.record({
              event: 'auto-allow',
              hash: shortHash(truncated),
              ruleId: grant.id,
              workspace: grant.scope,
              toolName,
              risk: rules.risk,
              engine: 'grant',
              sections: quick.sections,
            })
            audit.trim()
            logger.info('grant.auto-allow', {
              hash: shortHash(truncated),
              ruleId: grant.id,
              workspace: grant.scope,
              uses: used?.uses ?? null,
              tool: toolName,
            })
            // v0.5.3：自动放行也要进历史 —— 否则历史里只有「手动」，
            // 统计「自动 vs 手动」时会漏掉最需要被看见的那一类。
            history.record({
              hash: sha256(truncated),
              command: truncated,
              toolName,
              mode: rules.mode,
              risk: rules.risk,
              decision: 'auto-allowed',
              grantId: grant.id,
              sections: quick.sections,
            })
            return 'allowed-once'
          }

          const key = shortHash(truncated) + ':' + String(request.callId ?? '')
          pending.set(key, {
            key,
            at: Date.now(),
            toolName,
            reason: typeof request.reason === 'string' ? oneLine(request.reason, 200) : undefined,
            hash: shortHash(truncated),
            command: truncated,
            commandMissing: false,
            context,
            quick,
          })
          prunePending()
          // v0.5.3：settle 拿到的是 waterfall 的真实 outcome（'allowed-once' / 'rejected'），
          // 也就是**用户实际点了什么**。在这里记历史，客户端不参与、也无法伪造。
          const historyMeta = {
            hash: sha256(truncated),
            command: truncated,
            toolName,
            mode: rules.mode,
            risk: rules.risk,
            sections: quick.sections,
          }
          settle = (outcome) => {
            pending.delete(key)
            history.record({ ...historyMeta, decision: outcome })
          }

          // 需求 35：翻译排队执行；这里只排队，不等结果，不阻塞审批。
          // 顺带观察通道 A 的失败：连续 2 次因 OOM/超时失败就临时禁用本地通道 30 分钟。
          void translator
            .translate({
              command: truncated,
              toolName,
              reason: request.reason,
              callId: request.callId,
              confirmPaid: true,
              context,
            })
            .then((result) => {
              observeLocalHealth(result)
              // v0.5.8：把完整翻译结果**回填**到挂起条目。
              //
              // 以前算完就丢掉了（只拿去观察通道健康度），客户端只能再发一次 /translate ——
              // 也就是同一个审批调了两次模型，每次 6~20 秒。真机日志里成对出现的
              // translate.ok（如 6645ms + 19931ms）就是这么来的。
              //
              // 现在回填后：① 缓存里有了这份结果，客户端那次能直接命中；
              // ② /pending 也能直接带上它，卡片升级不必再等一次往返。
              const entry = pending.get(key)
              if (entry && result && result.sections) entry.full = result
            })
            .catch(() => undefined)
          logger.info('approval.seen', {
            hash: shortHash(truncated),
            risk: rules.risk,
            tool: toolName,
            localOnly: rules.localOnly === true,
            tempCleanup: rules.tempCleanup === true,
            commandMissing: false,
            context: context?.available === true ? 'yes' : 'no',
            slotMode: cachedSettings.ui.slotMode,
            // v0.5.0：调试字段。短哈希看不清「到底是哪条命令」，
            // 出现多条相同 hash 时无法判断是同一条命令跑了两遍，还是提取错了。
            // 这里记命令原文前 80 字（仅本机日志，不进网络、不进缓存键）。
            // v0.5.4 修：字段名不能叫 `command` —— logger.sanitize() 会把任何叫
            // command/text/prompt/raw 的键**强制改写成哈希**，导致这个调试字段从来
            // 没真正落进日志。改用 commandPrefix 绕开（不放宽那个安全拦截）。
            commandPreview: oneLine(truncated, 80),
            commandChars: truncated.length,
            callId: String(request.callId ?? ''),
            ctxLines: Array.isArray(context?.lines) ? context.lines.length : 0,
            ctxChars: Number(context?.chars ?? 0),
          })
        } else {
          logger.warn('approval.no-command', { tool: toolName, callId: String(request.callId ?? ''), slotMode: cachedSettings.ui.slotMode })
        }
        cmdMissing = commandMissing
        ctxAvailable = context?.available === true
      } else {
        skipReason = !request ? 'no-request' : typeof request !== 'object' ? 'not-an-object' : 'request-frozen'
      }
    } catch (error) {
      logger.warn('approval.listener-failed', { message: oneLine(error?.message, 200), stack: oneLine(error?.stack ?? '', 300) })
    }
    if (skipReason) {
      logger.warn('approval.listener-skipped', { reason: skipReason, callId: String(request?.callId ?? '') })
    } else {
      // 出口留痕：走到这里说明监听器被调用且执行完毕，哪怕前面什么都没记上也看得见。
      logger.info('approval.listener-exit', {
        callId: String(request?.callId ?? ''),
        commandMissing: cmdMissing === true,
        contextAvailable: ctxAvailable === true,
      })
    }

    // 关键：立刻把控制权交回去（同步），绝不 await 翻译。
    let outcome
    try {
      outcome = next()
    } catch (error) {
      // next() 抛了 → 这次审批**没有产生任何决定**，记成 other 而不是伪造一个
      settle?.('other')
      throw error
    }
    // outcome resolve 的值就是用户的真实决定（'allowed-once' / 'rejected'），
    // settle 会把它写进审批历史。reject 分支同样记 other。
    if (settle) Promise.resolve(outcome).then(settle, () => settle('other'))
    return outcome
  }

  try {
    const disposer = ctx.on('approval/request', listener, { prepend: true })
    ctx.effect(() => disposer, PLUGIN_ID + ': approval/request listener')
  } catch (error) {
    try {
      const disposer = ctx.on('approval/request', listener)
      ctx.effect(() => disposer, PLUGIN_ID + ': approval/request listener (fallback)')
    } catch (inner) {
      logger.warn('approval.listen-failed', { message: oneLine(inner?.message, 200) })
    }
  }

  /* ---------------------------------------------------------------- */
  /* 3. HTTP 接口                                                       */
  /* ---------------------------------------------------------------- */

  try {
    ctx.inject(['webServer'], (scope) => {
      const handler = createApiHandler({
        ctx,
        version: VERSION,
        getSettings,
        saveSettings,
        translator,
        logger,
        store,
        cache,
        grants,
        audit,
        guard,
        detectDevice,
        assetsDir: fileURLToPath(new URL('../assets/', import.meta.url)),
        getRowConfig: () => rowConfig,
        listPending,
        findPendingByCallId,
        getSlotState,
        noteSlotEvent,
        askConflict,
        history,
      })
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'prefix',
            // ⚠️ 不要加尾斜杠：webserver.match() 用 `startsWith(prefix + '/')` 判定，
            // 带尾斜杠会让所有子路径都匹配不上，表现为浏览器里 HTTP 404。
            path: API_PREFIX,
            handler: (req, res) => {
              Promise.resolve(handler(req, res)).catch((error) => {
                try {
                  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                  res.end(JSON.stringify({ ok: false, error: oneLine(error?.message, 200) }))
                } catch {
                  /* 忽略 */
                }
              })
            },
          }),
        PLUGIN_ID + ': http api',
      )
      logger.info('http.registered', { prefix: API_PREFIX })
    })
  } catch (error) {
    logger.warn('http.register-failed', { message: oneLine(error?.message, 200) })
  }

  ctx.effect(() => () => {
    try {
      cache.close()
    } catch {
      /* 忽略 */
    }
  }, PLUGIN_ID + ': teardown')
}

function toolZhSafe(toolName) {
  const map = { pwsh: 'PowerShell 命令', bash: '命令行命令', write: '写文件', edit: '改文件', read: '读文件' }
  const key = String(toolName ?? '').trim()
  return map[key] || key || '工具'
}

/**
 * 长期同意授权**不能**通过配置文件批量导入。
 * 这里把所有可能被用来夹带授权表的键全部剔除，只允许逐条手动授权。
 * @param {object} patch
 * @returns {object} 过滤后的设置
 */
export function sanitizeSettingsPatch(patch) {
  const clean = { ...(patch || {}) }
  for (const key of ['grants', 'grantList', 'longTermApprovals', 'alwaysAllow', 'allowList', 'whitelist']) {
    delete clean[key]
  }
  return clean
}

/** tool/call 事件的 arguments 可能是字符串，也可能是对象。 */
export function extractCommand(argumentsRaw) {
  if (typeof argumentsRaw === 'string') {
    const parsed = safeParse(argumentsRaw)
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.command === 'string') return parsed.command
      if (typeof parsed.file_path === 'string') return `写入/修改文件：${parsed.file_path}`
      if (typeof parsed.path === 'string') return `读写路径：${parsed.path}`
      return JSON.stringify(parsed)
    }
    return argumentsRaw
  }
  if (argumentsRaw && typeof argumentsRaw === 'object') {
    if (typeof argumentsRaw.command === 'string') return argumentsRaw.command
    if (typeof argumentsRaw.file_path === 'string') return `写入/修改文件：${argumentsRaw.file_path}`
    if (typeof argumentsRaw.path === 'string') return `读写路径：${argumentsRaw.path}`
    return JSON.stringify(argumentsRaw)
  }
  return undefined
}

export { DEFAULT_SETTINGS, normalizeSettings, createStore, createCache, createTranslator, createLogger, createApiHandler }
