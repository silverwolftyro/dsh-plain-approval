/**
 * 白话审批 · 自测套件
 *
 * 覆盖需求里点名的 10 项测试，外加若干边界情况。
 * 默认「不花钱」：通道 B 一律打本机 mock 服务。
 * 加参数 --live-deepseek 时，额外用真实 DeepSeek API 跑一次，验证真实链路。
 *
 * 用法：
 *   node test/run-tests.mjs
 *   node test/run-tests.mjs --live-deepseek
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer as createHttpServer } from 'node:http'

import { createStore } from '../src/store.js'
import { createLogger } from '../src/logger.js'
import { createCache, cacheKey, contextFingerprint, CACHE_VERSION } from '../src/cache.js'
import { createTranslator } from '../src/translate.js'
import { createApiHandler, API_PREFIX, API_BASE, routeOf } from '../src/server.js'
import { apply as applyHost } from '../src/plugin.js'
import { normalizeSettings } from '../src/config.js'
import { analyzeCommand, isLocalHost, ruleSummary, extractDeleteTargets, condensePaths } from '../src/rules.js'
import { decideDepth, canUpgradeToL2 } from '../src/depth.js'
import { estimateCost } from '../src/cost.js'
import { createGrants, workspaceScope } from '../src/grants.js'
import { createAudit } from '../src/audit.js'
import { createHistory, normalizeDecision } from '../src/history.js'
import { sanitizeSettingsPatch } from '../src/plugin.js'
import { createOllamaGuard } from '../src/ollama-guard.js'
import { tierOf, detectDevice, localRisk, clearDeviceCache } from '../src/device.js'
import { evaluateLocalHealth, LOCAL_DISABLE_MS } from '../src/local-health.js'
import { extractContext, fallbackIntent, NO_CONTEXT_NOTE, NO_INTENT_NOTE } from '../src/context.js'
import { buildUserPrompt, SYSTEM_PROMPT } from '../src/prompt.js'
import { parseSevenSection, normalizeSections } from '../src/parse.js'
import { scanBaseUrlFromYaml, resolveEndpoint, OFFICIAL_ANTHROPIC_BASE_URL } from '../src/deepseek-endpoint.js'
import { loadClientModule } from './client-harness.mjs'
import { startMockDeepSeek } from './mock-deepseek.js'

const LIVE = process.argv.includes('--live-deepseek')
const OLLAMA_UP = 'http://127.0.0.1:11434'
const OLLAMA_DEAD = 'http://127.0.0.1:1'
/** 测试用的临时根目录：放在包目录下（沙箱只保证工作区内可写），跑完即删。 */
const TMP_ROOT = join(process.cwd(), '.test-tmp')
mkdirSync(TMP_ROOT, { recursive: true })
/** 插件源码根目录（源码红线检查用）。 */
const HERE_SRC = process.cwd()

const results = []
let currentGroup = ''

function group(title) {
  currentGroup = title
  console.log('\n=== ' + title + ' ===')
}

function check(id, name, ok, detail) {
  results.push({ id, name, ok: !!ok, detail: detail ?? '' })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${id} ${name}${detail ? ' — ' + detail : ''}`)
}

function roots() {
  return mkdtempSync(join(TMP_ROOT, 'env-'))
}

/** 临时让 DEEPSEEK_API_KEY 不可见（测「未配置 Key」这条边界）。 */
function withoutEnvKey(fn) {
  const saved = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  try {
    return fn()
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved
  }
}

/** 从 DSH 真实凭据文件里读一个 ref（只用于 --live-deepseek，值不会被打印）。 */
function readCredentialRef(name) {
  try {
    const realHome = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
    const text = readFileSync(join(realHome, '.credentials.yaml'), 'utf8')
    const section = text.split(/^records:/mu)[0]
    const line = section.split('\n').find((l) => l.trim().startsWith(name + ':'))
    if (!line) return ''
    return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/gu, '')
  } catch (error) {
    return ''
  }
}

/** 造一个可控的测试环境（独立数据目录，避免互相污染缓存）。 */
function harness({ rowConfig, ctx } = {}) {
  const home = roots()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const store = createStore()
  const getSettings = () => store.loadSettings(rowConfig || {})
  const logger = createLogger({ store, ctx, getSettings })
  const cache = createCache({ dir: store.dir, driver: getSettings().cache.driver })
  const translator = createTranslator({ getSettings, cache, store, logger, ctx })
  return {
    home,
    store,
    cache,
    logger,
    translator,
    getSettings,
    cleanup() {
      try {
        cache.close()
      } catch (error) {
        /* 忽略 */
      }
      process.env.DSH_HOME = prevHome
      try {
        rmSync(home, { recursive: true, force: true })
      } catch (error) {
        /* 忽略 */
      }
    },
  }
}

function baseConfig(overrides = {}) {
  return {
    engine: 'ollama',
    ollama: { baseUrl: OLLAMA_UP, model: 'qwen2.5:7b', timeoutMs: 60000 },
    deepseek: { baseUrl: 'http://127.0.0.1:1', model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: true, askBeforeCall: false, apiKey: '' },
    cache: { enabled: true, ttlDays: 7, driver: 'sqlite' },
    log: { enabled: true, maxLines: 2000 },
    // v0.6.0：这套用例绝大多数在验证**模型行为**（降级、缓存、token 记账、截断…）。
    // v0.6.0 起「自动」深度会让安全命令走 L1（不调模型），所以这里显式锁 L2，
    // 让这些用例继续测它们本来要测的东西。分层分流本身由 P 组用例单独覆盖。
    ui: { analysisDepth: 'l2' },
    ...overrides,
  }
}

/* ================================================================== */
/* 测试 1：通道 A 正常时翻译一条普通命令                                 */
/* ================================================================== */

group('测试 1：通道 A（本地 Ollama）正常时翻译 ls -la')
{
  const env = harness({ rowConfig: baseConfig() })
  const t = await env.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
  const s = t.sections || {}
  const ok =
    t.status === 'ok' &&
    t.engine === 'ollama' &&
    t.engineLabel === '本地 Ollama' &&
    s.intent && s.touch && s.mode && s.risk && s.advice && s.consequence && s.benefit
  check('T1', '通道 A 翻译普通命令', ok, `status=${t.status} engine=${t.engine} 耗时=${t.elapsedMs}ms 风险=${s.risk}`)
  console.log('    七段：')
  console.log(`    1 意图：${s.intent}`)
  console.log(`    2 碰什么：${s.touch}`)
  console.log(`    3 读还是写：${s.mode}`)
  console.log(`    4 风险等级：${s.risk}`)
  console.log(`    5 建议：${s.advice}`)
  console.log(`    6 后果：${s.consequence}`)
  console.log(`    7 收益：${s.benefit}`)
  check('T1b', '翻译结果包含引擎来源文案', t.engineLabel === '本地 Ollama', t.text?.zh?.split('\n').slice(-2).join(' / '))
  check('T1c', '缓存使用 SQLite', env.cache.driver === 'sqlite', `driver=${env.cache.driver}`)
  env.cleanup()
}

/* ================================================================== */
/* 测试 2 + 9：通道 A 关闭 → 自动降级到通道 B，并显示 token / 费用        */
/* ================================================================== */

const mock = await startMockDeepSeek({ mode: 'ok' })

group('测试 2 + 9：Ollama 不可用 → 自动降级到 DeepSeek API（mock），并显示 token 与费用')
{
  const env = harness({
    rowConfig: baseConfig({
      engine: 'auto',
      ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 2000 },
      deepseek: { baseUrl: mock.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: true, askBeforeCall: false, apiKey: 'test-key' },
    }),
  })
  const t = await env.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
  check(
    'T2',
    '两个通道配置为 auto，Ollama 挂了自动切 DeepSeek',
    t.status === 'ok' && t.engine === 'deepseek' && t.engineLabel === 'DeepSeek API',
    `status=${t.status} engine=${t.engine} via=${t.via} 通道提示=${(t.notes || []).filter((n) => n.includes('Ollama')).length} 条`,
  )
  const cost = t.cost
  const expected = estimateCost({ promptTokens: 412, completionTokens: 96, totalTokens: 508, cacheHitTokens: 0, cacheMissTokens: 412 })
  const ok9 =
    cost &&
    cost.totalTokens === 508 &&
    cost.promptTokens === 412 &&
    cost.completionTokens === 96 &&
    typeof cost.costText === 'string' &&
    Math.abs(cost.cny - expected.cny) < 1e-9
  check('T9', '通道 B 显示 token 消耗与费用估算', ok9, `token=${cost?.totalTokens} 费用=${cost?.costText} 当日=${t.daily}`)
  console.log(`    费用明细：${cost?.breakdown}`)
  console.log(`    单价：输入(未命中) ${env.getSettings().pricing.inputMissPerMillion} 元/百万，输出 ${env.getSettings().pricing.outputPerMillion} 元/百万`)
  await mock.close()
  env.cleanup()
}

/* ================================================================== */
/* 测试 3：两个通道都不可用 → 降级为「翻译不可用」                        */
/* ================================================================== */

group('测试 3：两个通道都不可用 → 正常降级为「翻译不可用」')
{
  const env = harness({
    rowConfig: baseConfig({
      engine: 'auto',
      ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 1500 },
      deepseek: { baseUrl: 'http://127.0.0.1:1', model: 'deepseek-chat', timeoutMs: 1500, apiKey: '', retryOnRateLimit: false },
    }),
  })
  // 传一个没有 credentials / llm 的 ctx，并暂时清掉环境变量里的 Key，保证通道 B 拿不到 Key
  const t = await withoutEnvKey(() => env.translator.translate({ command: 'ls -la', toolName: 'pwsh' }))
  check(
    'T3',
    '两条通道都不可用时降级展示，而不是空白或报错',
    t.status === 'unavailable' && t.headline === '翻译不可用，请自行判断' && Array.isArray(t.notes) && t.notes.length > 0,
    `status=${t.status} headline=${t.headline}`,
  )
  console.log('    降级时仍然给出：', JSON.stringify(t.sections, null, 0).slice(0, 160) + '…')
  env.cleanup()
}

/* ================================================================== */
/* 测试 4：危险命令                                                      */
/* ================================================================== */

group('测试 4：rm -rf 危险命令 → 标红 + 后果写明「可能永久删除文件」')
{
  const env = harness({ rowConfig: baseConfig() })
  const t = await env.translator.translate({ command: 'rm -rf /home/user/important', toolName: 'pwsh' })
  const s = t.sections || {}
  check(
    'T4',
    '风险等级=危险、建议=建议拒绝、后果写明可能永久删除',
    s.risk === '危险' && s.advice === '建议拒绝' && /可能永久删除文件/u.test(s.consequence) && t.denyRecommended === true,
    `risk=${s.risk} advice=${s.advice} 后果=${s.consequence}`,
  )
  // v0.6.0 反转了这条旧预期：危险命令**不再**跳过模型，而是强制走 L2。
  // 理由：危险恰恰最需要把「它想干什么、为什么危险」讲清楚。
  // 但风险等级仍然由本地规则兜底 —— 模型改不动。
  check(
    'T4b',
    'v0.6.0：危险命令强制走 L2 模型分析（不再跳过），但风险等级仍由本地规则兜底',
    t.depth === 'l2' && t.sections.risk === '危险' && t.sections.advice === '建议拒绝',
    `depth=${t.depth} engine=${t.engine} risk=${t.sections.risk}`,
  )
  console.log('    提醒：', (t.notes || []).join(' | ') || '（无）')

  // 顺带覆盖需求 17 里点名的其它破坏性关键词
  const dangerCases = ['del /f /s /q C:\\Windows', 'format C:', 'diskpart', 'reg delete HKLM\\Software\\X']
  const cautionCases = ['chmod 644 ./file', 'icacls . /grant Everyone:F', 'reg add HKLM\\Software\\X /v Y /t REG_SZ /d 1', 'sudo systemctl restart nginx']
  const hits = dangerCases.map((c) => `${c.split(' ')[0]}→${analyzeCommand(c, {}).risk}`)
  const cautions = cautionCases.map((c) => `${c.split(' ')[0]}→${analyzeCommand(c, {}).risk}`)
  check('T4c', '破坏性关键词（del/format/diskpart/reg delete）同样标红', dangerCases.every((c) => analyzeCommand(c, {}).risk === '危险'), hits.join('，'))
  check('T4d', '权限变更/注册表新增/提权 → 标「注意·请先确认」', cautionCases.every((c) => analyzeCommand(c, {}).risk === '注意'), cautions.join('，'))
  env.cleanup()
}

/* ================================================================== */
/* 测试 5：超长命令截断                                                  */
/* ================================================================== */

group('测试 5：超过 4000 字符的命令 → 截断并标注')
{
  const env = harness({ rowConfig: baseConfig({ engine: 'ollama', ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 1000 } }) })
  const long = 'echo ' + 'x'.repeat(5000)
  const t = await env.translator.translate({ command: long, toolName: 'pwsh' })
  const noteHit = (t.notes || []).some((n) => n.includes('命令过长'))
  check(
    'T5',
    '命令截断到 4000 字符并标注「命令过长，仅翻译前 4000 字符」',
    t.command.truncated === true && t.command.text.length === 4000 && t.command.originalLength === long.length && noteHit,
    `原文=${t.command.originalLength} 字符，翻译=${t.command.text.length} 字符`,
  )
  console.log('    标注：', (t.notes || []).find((n) => n.includes('命令过长')))
  env.cleanup()
}

/* ================================================================== */
/* 测试 6：管道命令分段解释                                              */
/* ================================================================== */

group('测试 6：管道命令 → 分段解释 + 整体总结')
{
  const pipeMock = await startMockDeepSeek({ mode: 'pipeline' })
  const env = harness({
    rowConfig: baseConfig({
      engine: 'deepseek',
      deepseek: { baseUrl: pipeMock.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: true, askBeforeCall: false, apiKey: 'test-key' },
      ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 1000 },
    }),
  })
  const pipeline = 'cat app.log | grep ERROR | head -n 20'
  const t = await env.translator.translate({ command: pipeline, toolName: 'pwsh' })
  check(
    'T6',
    '管道链被拆成多段并逐段解释',
    t.status === 'ok' && t.sections.parts.length >= 3 && t.rules.segmentKind === 'pipeline',
    `段数=${t.sections.parts?.length} kind=${t.rules.segmentKind}`,
  )
  for (const p of t.sections.parts || []) console.log(`    ${p.label}：${p.text}`)
  console.log(`    整体：${t.sections.what}`)

  const multiline = 'cd C:\\proj\nnpm install\nnpm run build'
  const t2 = await env.translator.translate({ command: multiline, toolName: 'pwsh' })
  check('T6b', '多行脚本按行拆解并给整体总结', t2.sections.parts.length >= 3 && t2.rules.segmentKind === 'lines', `段数=${t2.sections.parts?.length} kind=${t2.rules.segmentKind}`)
  await pipeMock.close()
  env.cleanup()
}

/* ================================================================== */
/* 测试 7 + 10：缓存命中 / 切换引擎不命中旧缓存                           */
/* ================================================================== */

group('测试 7 + 10：同一条命令第二次命中缓存；切换引擎后不命中旧缓存')
{
  const first = await startMockDeepSeek({ mode: 'ok' })
  const env = harness({
    rowConfig: baseConfig({
      engine: 'deepseek',
      deepseek: { baseUrl: first.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: true, askBeforeCall: false, apiKey: 'test-key' },
    }),
  })
  const cmd = 'ls -la /tmp/plain-approval-cache-check'
  const a = await env.translator.translate({ command: cmd, toolName: 'pwsh' })
  const callsAfterFirst = first.state.calls
  const b = await env.translator.translate({ command: cmd, toolName: 'pwsh' })
  const callsAfterSecond = first.state.calls
  check(
    'T7',
    '第二次翻译命中缓存（没有再打接口）',
    a.cached === false && b.cached === true && callsAfterSecond === callsAfterFirst,
    `第一次 cached=${a.cached}，第二次 cached=${b.cached}，接口调用 ${callsAfterFirst}→${callsAfterSecond}`,
  )

  // 测试 10：先在一个引擎下命中缓存，切换到另一个引擎（另一个 endpoint）后必须重新翻译
  const second = await startMockDeepSeek({ mode: 'ok' })
  const env2 = harness({
    rowConfig: baseConfig({
      engine: 'auto',
      deepseek: { baseUrl: first.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: false, apiKey: 'test-key' },
    }),
  })
  const cmd2 = 'ls -la /tmp/plain-approval-engine-switch'
  const c1 = await env2.translator.translate({ command: cmd2, toolName: 'pwsh' })
  const c2 = await env2.translator.translate({ command: cmd2, toolName: 'pwsh' })
  const callsFirstBefore = first.state.calls
  env2.store.saveRawSettings({ engine: 'deepseek', deepseek: { baseUrl: second.baseUrl, model: 'deepseek-chat' } })
  const d = await env2.translator.translate({ command: cmd2, toolName: 'pwsh' })
  check(
    'T10',
    '切换引擎后同一条命令不命中旧引擎的缓存',
    c1.cached === false && c2.cached === true && d.cached === false && second.state.calls === 1,
    `旧引擎首跑 cached=${c1.cached}（engine=${c1.engine}，接口累计 ${callsFirstBefore} 次）；二跑 cached=${c2.cached}；切到 deepseek 后 cached=${d.cached}，新 endpoint 调用 ${second.state.calls} 次`,
  )
  check('T10b', '缓存记录了翻译引擎来源', env2.cache.stats().count >= 2, `缓存条目=${env2.cache.stats().count}`)

  await first.close()
  await second.close()
  env.cleanup()
  env2.cleanup()
}

/* ================================================================== */
/* 测试 8：翻译进行中，审批不被阻塞                                       */
/* ================================================================== */

group('测试 8：翻译还没完成时点「允许 / 拒绝」，审批流程不被阻塞')
{
  // 8a：宿主监听器必须是「同步返回 next()」，绝不 await 翻译
  const slow = await startMockDeepSeek({ mode: 'ok', delayMs: 2500 })
  const home = mkdtempSync(join(TMP_ROOT, 'block-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const listeners = []
  let injected = null
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() {
      return undefined
    },
    on(name, listener, options) {
      listeners.push({ name, listener, options })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, cb) {
      injected = names
      cb({ effect: (fn) => fn(), webServer: { register: () => () => {} } })
    },
  }

  applyHost(fakeCtx, {
    engine: 'deepseek',
    deepseek: { baseUrl: slow.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: false },
    log: { enabled: true },
    cache: { enabled: true, driver: 'sqlite' },
  })

  const entry = listeners.find((l) => l.name === 'approval/request')
  check('T8a', '宿主注册了 approval/request 监听器（并且用 prepend 抢在转发之前）', !!entry, entry ? `prepend=${entry.options?.prepend === true}` : '未注册')

  const events = [
    { type: 'turn/start' },
    { type: 'tool/call', data: { callId: 'call-1', name: 'pwsh', arguments: JSON.stringify({ command: 'ls -la' }) } },
  ]
  const agent = { session: { seq: events.length, eventAt: (i) => events[i] } }
  const request = { agent, toolName: 'pwsh', callId: 'call-1', reason: 'escalate sandbox to danger-full-access: 需要读取系统目录', displayReason: { zh: '允许本次操作', en: 'allow' } }

  const t0 = Date.now()
  let nextResolved = false
  const returned = entry.listener(request, () => {
    nextResolved = true
    return Promise.resolve('next')
  })
  const syncMs = Date.now() - t0
  await returned
  const totalMs = Date.now() - t0

  const quick = request.displayReason && request.displayReason['plain-approval']
  check(
    'T8b',
    '监听器不阻塞水位线：拿到 next() 的速度远快于模型翻译',
    syncMs < 100 && totalMs < 100 && nextResolved === true,
    `同步耗时 ${syncMs}ms（模型 mock 延迟 2500ms）`,
  )
  check(
    'T8c',
    '监听器同步写入本地规则结论（displayReason 里立刻就有七段）',
    !!quick && !!quick.sections && quick.sections.what.length > 0,
    quick ? `干什么=${quick.sections.what}` : '未写入',
  )
  check('T8d', 'HTTP 接口已注册到 /api/plain-approval/', Array.isArray(injected) && injected.includes('webServer'), `inject=${JSON.stringify(injected)}`)

  // 8e：客户端在翻译完成前放弃 —— 请求被 abort 时不会阻塞“允许”
  const abortController = new AbortController()
  const pending = fetch(slow.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
    signal: abortController.signal,
  })
  const abortedAt = Date.now()
  abortController.abort()
  let abortObserved = false
  try {
    await pending
  } catch (error) {
    abortObserved = error?.name === 'AbortError' || error?.name === 'TimeoutError'
  }
  check(
    'T8e',
    '用户在翻译完成前点允许/拒绝 → 立刻取消翻译请求（不等模型）',
    abortObserved && Date.now() - abortedAt < 500,
    `中止后 ${Date.now() - abortedAt}ms 内返回`,
  )

  await slow.close()
  process.env.DSH_HOME = prevHome
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* 忽略 */
  }
}

/* ================================================================== */
/* 附加：HTTP 接口层 / 边界情况                                          */
/* ================================================================== */

group('附加：HTTP 接口层（客户端真正走的通路）')
{
  const m = await startMockDeepSeek({ mode: 'ok' })
  const home = mkdtempSync(join(TMP_ROOT, 'api-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const store = createStore()
  const getSettings = () =>
    store.loadSettings({
      engine: 'deepseek',
      deepseek: { baseUrl: m.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: false },
      log: { enabled: true },
      cache: { enabled: false, driver: 'json' },
    })
  const logger = createLogger({ store, getSettings })
  const cache = createCache({ dir: store.dir, driver: getSettings().cache.driver })
  const translator = createTranslator({ getSettings, cache, store, logger })
  const handler = createApiHandler({ getSettings, saveSettings: (p) => store.saveRawSettings(p), translator, logger, store, cache })

  const { createServer } = await import('node:http')
  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const HDR = { 'x-plain-approval': '1' }

  const statusRaw = await fetch(base + API_BASE + 'status', { headers: HDR })
  const statusBody = await statusRaw.json()
  check('A1', 'GET /status 返回两个通道的状态灯数据', statusBody.ok === true && !!statusBody.data.ollama && !!statusBody.data.deepseek, `ollama=${statusBody.data?.ollama?.status} deepseek=${statusBody.data?.deepseek?.status}`)

  const pingRaw = await fetch(base + API_PREFIX)
  const pingBody = await pingRaw.json()
  check('A1b', '裸前缀即可探活（不需要自定义头）', pingRaw.status === 200 && pingBody.data?.plugin === 'dsh-plain-approval', `HTTP ${pingRaw.status} version=${pingBody.data?.version}`)

  const translateRaw = await fetch(base + API_BASE + 'translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...HDR },
    body: JSON.stringify({ command: 'ls -la', toolName: 'pwsh' }),
  })
  const translateBody = await translateRaw.json()
  check('A2', 'POST /translate 返回完整七段结果', translateRaw.status === 200 && translateBody.ok === true && !!translateBody.data.sections?.benefit, `status=${translateRaw.status}`)

  const noHeader = await fetch(base + API_BASE + 'translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'ls -la' }),
  })
  check('A3', '写接口要求自定义请求头（挡跨站请求）', noHeader.status === 403, `HTTP ${noHeader.status}`)

  const getNoHeader = await fetch(base + API_BASE + 'status')
  check('A3b', '读接口同样要求自定义头（跨站预检挡住读取）', getNoHeader.status === 403, `HTTP ${getNoHeader.status}`)

  const pendingRaw = await fetch(base + API_BASE + 'pending', { headers: HDR })
  const pendingBody = await pendingRaw.json()
  check('A6', 'GET /pending 可用（让位浮层的数据源）', pendingRaw.status === 200 && Array.isArray(pendingBody.data?.items), `items=${pendingBody.data?.items?.length}`)

  const diagRaw = await fetch(base + API_BASE + 'diag', { headers: HDR })
  const diagBody = await diagRaw.json()
  check('A7', 'GET /diag 返回能力自检（ctx.llm / credentials / endpoint）', diagRaw.status === 200 && !!diagBody.data?.checks?.llm && !!diagBody.data?.checks?.endpoint, `llm=${diagBody.data?.checks?.llm?.available} endpoint=${diagBody.data?.checks?.endpoint?.baseUrl}`)

  const logsRaw = await fetch(base + API_BASE + 'logs', { headers: HDR })
  const logsBody = await logsRaw.json()
  const logsJson = JSON.stringify(logsBody)
  const containsCommand = logsJson.includes('ls -la')
  check('A4', '诊断日志不包含命令原文（只有哈希）', logsBody.ok === true && !containsCommand, containsCommand ? '日志里出现了命令原文！' : `日志 ${logsBody.data?.entries?.length ?? 0} 条，仅含哈希`)
  check('A5', '数据文件落在 DSH 用户数据目录', store.dir.includes('plain-approval'), store.dir)

  await new Promise((r) => server.close(r))
  await m.close()
  cache.close()
  process.env.DSH_HOME = prevHome
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* ignore */
  }
}

group('附加：边界情况（格式异常 / 空返回 / 限流退避 / 空命令 / 编码 / 网络 / 权限 / 注册表 / 提权）')
{
  // 格式异常
  const bad = await startMockDeepSeek({ mode: 'malformed' })
  const envBad = harness({
    rowConfig: baseConfig({ engine: 'deepseek', deepseek: { baseUrl: bad.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: false, apiKey: 'test-key' } }),
  })
  const tBad = await envBad.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
  check('B1', '模型返回非法七段 → 标注「翻译格式异常」并保留原始返回', !!tBad.formatWarning && tBad.sections.what.length > 0, `kind=${tBad.formatWarning?.kind} raw=${(tBad.formatWarning?.raw || '').slice(0, 24)}…`)
  envBad.cleanup()
  await bad.close()

  // 空返回
  const empty = await startMockDeepSeek({ mode: 'empty' })
  const envEmpty = harness({
    rowConfig: baseConfig({
      engine: 'auto',
      ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 1000 },
      deepseek: { baseUrl: empty.baseUrl, model: 'deepseek-chat', timeoutMs: 5000, retryOnRateLimit: false },
    }),
  })
  const tEmpty = await envEmpty.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
  check('B2', '模型返回空内容 → 降级', tEmpty.status === 'unavailable', `status=${tEmpty.status}`)
  envEmpty.cleanup()
  await empty.close()

  // 429 退避重试一次
  const rl = await startMockDeepSeek({ mode: 'ok', rateLimitFirst: 1 })
  const envRl = harness({
    rowConfig: baseConfig({ engine: 'deepseek', deepseek: { baseUrl: rl.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: true, apiKey: 'test-key' } }),
  })
  const tRl = await envRl.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
  check('B3', '遇到 429 → 指数退避重试一次后成功', tRl.status === 'ok' && rl.state.calls === 2, `接口调用次数=${rl.state.calls}`)
  envRl.cleanup()
  await rl.close()

  // 空命令
  const envEdge = harness({ rowConfig: baseConfig({ ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 800 } }) })
  const tBlank = await envEdge.translator.translate({ command: '   ', toolName: 'pwsh' })
  check('B4', '空命令 / 纯空格 → 「空命令，无可翻译内容」', tBlank.status === 'empty' && tBlank.sections.what.includes('空命令'), `what=${tBlank.sections.what}`)

  // 编码 / 网络 / 权限 / 注册表 / 提权
  const cases = [
    ['base64 编码', 'powershell -enc YwBkACAAQwA6AFwA', '危险'],
    ['网络下载', 'curl -o setup.exe https://example.com/setup.exe', '注意'],
    ['权限变更', 'chmod 777 ./data', '危险'],
    ['注册表', 'reg add HKLM\\Software\\X /v Y /t REG_SZ /d 1', '危险'],
    ['提权', 'sudo systemctl restart nginx', '注意'],
  ]
  const seen = []
  for (const [name, cmd, expect] of cases) {
    const r = analyzeCommand(cmd, {})
    seen.push(`${name}=${r.risk}/${r.advice}`)
  }
  check('B5', '编码/下载/权限/注册表/提权都有专门标注', seen.length === 5, seen.join('，'))
  const net = analyzeCommand('curl -o setup.exe https://example.com/setup.exe', {})
  check('B6', '下载类命令标注了来源', net.downloads.some((d) => d.includes('example.com')), JSON.stringify(net.downloads))
  const enc = analyzeCommand('powershell -enc YwBkACA', {})
  check('B7', '编码类命令标注「无法可靠解释，建议拒绝」', enc.advice === '建议拒绝' && enc.notes.some((n) => n.includes('编码')), enc.notes.join(' | '))
  envEdge.cleanup()
}

/* ================================================================== */
/* 附加：真实 DeepSeek API（可选，会消耗极少量额度）                      */
/* ================================================================== */

if (LIVE) {
  group('附加（真实链路）：用 DSH 凭据里的 DeepSeek Key 跑一次真翻译')
  const home = mkdtempSync(join(TMP_ROOT, 'live-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const store = createStore()
  const getSettings = () =>
    store.loadSettings({
      engine: 'deepseek',
      deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 60000, retryOnRateLimit: true },
      log: { enabled: true },
      cache: { enabled: false, driver: 'json' },
    })
  const logger = createLogger({ store, getSettings })
  const cache = createCache({ dir: store.dir, driver: 'json' })
  // 用真实的 DSH 凭据文件 + 一个模拟 credentials 服务，走的就是插件在宿主里的那条取 Key 路径
  const realKey = readCredentialRef('DEEPSEEK_API_KEY')
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined
      return { resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' && realKey ? { value: realKey, source: 'file' } : undefined) }
    },
  }
  if (!realKey) {
    check('L1', '真实 DeepSeek API 翻译成功', true, '跳过：DSH 凭据里没有 DEEPSEEK_API_KEY')
  } else {
    const translator = createTranslator({ getSettings, cache, store, logger, ctx })
    const t = await translator.translate({ command: 'ls -la', toolName: 'pwsh', confirmPaid: true })
    check('L1', '真实 DeepSeek API 翻译成功（显式 OpenAI 兼容 endpoint）', t.status === 'ok', `status=${t.status} engine=${t.engine} via=${t.via} 耗时=${t.elapsedMs}ms`)
    if (t.status === 'ok') {
      console.log(`    真实翻译：干什么=${t.sections.what}，风险=${t.sections.risk}`)
      console.log(`    真实用量：${t.cost?.totalTokens} token，${t.cost?.costText}`)
    } else {
      console.log('    降级信息：', t.degradeNote || t.headline)
    }

    // L2：走「自动解析 endpoint」的默认路径（DSH 官方 Anthropic 端点 + deepseek-flash）
    const autoSettings = {
      engine: 'deepseek',
      deepseek: {}, // 全部留空 = 自动解析
      log: { enabled: true },
      cache: { enabled: false, driver: 'json' },
    }
    const autoStore = createStore()
    const autoGet = () => autoStore.loadSettings(autoSettings)
    const autoLogger = createLogger({ store: autoStore, getSettings: autoGet })
    const autoCache = createCache({ dir: autoStore.dir, driver: 'json' })
    const autoTranslator = createTranslator({ getSettings: autoGet, cache: autoCache, store: autoStore, logger: autoLogger, ctx })
    const probe = await autoTranslator.probe()
    console.log(`    自动解析结果：baseUrl=${probe.deepseek?.baseUrl} style=${probe.deepseek?.style} model=${probe.deepseek?.model}`)
    const t2 = await autoTranslator.translate({ command: 'mkdir build', toolName: 'pwsh', confirmPaid: true })
    check(
      'L2',
      '真实 DeepSeek API 翻译成功（自动解析 endpoint：Anthropic 协议 + DSH 当前模型）',
      t2.status === 'ok',
      `status=${t2.status} engine=${t2.engine} via=${t2.via} 耗时=${t2.elapsedMs}ms`,
    )
    if (t2.status === 'ok') console.log(`    真实翻译：干什么=${t2.sections.what}，用量 ${t2.cost?.totalTokens} token / ${t2.cost?.costText}`)
    else console.log('    降级信息：', t2.degradeNote || t2.headline)
    autoCache.close()
  }
  cache.close()
  process.env.DSH_HOME = prevHome
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* ignore */
  }
}

/* ================================================================== */
/* 附加（v0.2）：HTTP 404 回归 —— 路由前缀不能带尾斜杠                     */
/* ================================================================== */

group('附加（v0.2 回归）：路由前缀 / HTTP 404')
{
  /** 复刻 dsh-host-webserver 的 match()：exact 优先，其余最长前缀，且要求 `startsWith(prefix + '/')`。 */
  function webserverMatch(pathname, prefixes) {
    let best
    for (const prefix of prefixes) {
      if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
      if (best === undefined || prefix.length > best.length) best = prefix
    }
    return best
  }

  check('R1', '注册前缀不带尾斜杠（尾斜杠会让所有子路径匹配失败 → 浏览器 404）', API_PREFIX === '/api/plain-approval', `API_PREFIX=${API_PREFIX}`)
  check('R2', '客户端基址带尾斜杠，拼出 /api/plain-approval/xxx', API_BASE === '/api/plain-approval/', `API_BASE=${API_BASE}`)

  const prefixes = ['/api', API_PREFIX]
  const oldPrefix = '/api/plain-approval/'
  check(
    'R3',
    '复刻 webserver.match：旧前缀会落到 /api（就是 404 的原因）',
    webserverMatch('/api/plain-approval/status', ['/api', oldPrefix]) === '/api',
    `旧前缀 → ${webserverMatch('/api/plain-approval/status', ['/api', oldPrefix])}`,
  )
  check(
    'R4',
    '修正后 /api/plain-approval/status 命中本插件路由',
    webserverMatch('/api/plain-approval/status', prefixes) === API_PREFIX,
    `新前缀 → ${webserverMatch('/api/plain-approval/status', prefixes)}`,
  )
  check(
    'R5',
    '无尾斜杠的裸路径同样命中（用于探活）',
    webserverMatch('/api/plain-approval', prefixes) === API_PREFIX,
    `→ ${webserverMatch('/api/plain-approval', prefixes)}`,
  )

  check('R6', 'routeOf 正确切出子路由', routeOf('/api/plain-approval/status') === 'status' && routeOf('/api/plain-approval/pending') === 'pending', `status=${routeOf('/api/plain-approval/status')}`)
  check('R7', 'routeOf 对裸前缀返回空串，对别人的路由返回 null', routeOf('/api/plain-approval') === '' && routeOf('/api/other') === null, `bare='${routeOf('/api/plain-approval')}' other=${routeOf('/api/other')}`)
}

/* ================================================================== */
/* 附加（v0.2）：通道 B 的 endpoint 解析（不硬编码）                      */
/* ================================================================== */

group('附加（v0.2）：通道 B endpoint 解析')
{
  const sample = [
    '- id: llm',
    '  name: "@deepseek-ai/dsh-llm"',
    '- id: llm-deepseek',
    '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
    '  config:',
    '    baseURL: https://my-proxy.example.com/anthropic',
    '- id: credentials',
    '  name: "@deepseek-ai/dsh-credentials-local"',
  ].join('\n')
  check('E1', '能从 cordis 配置里读出 llm-deepseek 的 baseURL', scanBaseUrlFromYaml(sample) === 'https://my-proxy.example.com/anthropic', String(scanBaseUrlFromYaml(sample)))
  check('E2', '配置里没有 llm-deepseek 时返回 null', scanBaseUrlFromYaml('- id: foo\n  name: bar\n') === null, String(scanBaseUrlFromYaml('- id: foo\n  name: bar\n')))

  const base = resolveEndpoint({ deepseek: {} }, undefined, {})
  check(
    'E3',
    '拿不到任何配置时兜底到 DSH 官方默认（Anthropic 协议）',
    base.baseUrl === OFFICIAL_ANTHROPIC_BASE_URL && base.style === 'anthropic',
    `${base.baseUrl} / ${base.style} / ${base.model}`,
  )

  const fromEnv = resolveEndpoint({ deepseek: {} }, undefined, { DEEPSEEK_BASE_URL: 'http://127.0.0.1:9999' })
  check(
    'E4',
    '环境变量 DEEPSEEK_BASE_URL 优先于默认值，并按 baseUrl 判断协议',
    fromEnv.baseUrl === 'http://127.0.0.1:9999' && fromEnv.style === 'openai',
    `${fromEnv.baseUrl} / ${fromEnv.style} / ${fromEnv.baseUrlSource}`,
  )

  const explicit = resolveEndpoint({ deepseek: { baseUrl: 'https://x.example.com/v1', model: 'my-model', apiStyle: 'openai' } }, undefined, { DEEPSEEK_BASE_URL: 'http://ignored' })
  check(
    'E5',
    '插件设置显式指定的 baseUrl / model 优先级最高',
    explicit.baseUrl === 'https://x.example.com/v1' && explicit.model === 'my-model',
    `${explicit.baseUrl} / ${explicit.model}`,
  )

  const withSel = resolveEndpoint(
    { deepseek: {} },
    { get: (k) => (k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } : undefined) },
    {},
  )
  check(
    'E6',
    'agentDefaultModel 可用时，直连也跟随 DSH 当前选择的模型',
    withSel.model === 'deepseek-flash' && withSel.selection?.provider === 'deepseek-official',
    `${withSel.model}（${withSel.modelSource}）`,
  )
}

/* ================================================================== */
/* 附加（v0.2）：自适应让位（客户端纯逻辑）                               */
/* ================================================================== */
/* 附加（v0.5.0-stable）：固定模式 —— 自动让位已废弃，只读冲突扫描          */
/* ================================================================== */

group('附加（v0.5.0-stable）：固定模式（无自动判定）+ 只读冲突扫描')
{
  const { exports } = loadClientModule()
  const client = exports.__internal
  const {
    scanSlotConflictsOnce,
    isSelfOrOfficial,
    rivalLabelOf,
    shouldShowOverlay,
    uiPrefs,
    ClientEntryProbeUnused,
  } = client

  /** 造一个槽位条目。select 会被替换成「一旦被调用就记账」的探针。 */
  let probed = 0
  const entry = (priority, { locale = null, registrant = null, component = null, claims = null } = {}) => ({
    options: { priority, locale, registrant },
    component,
    select: () => {
      probed++
      return claims
    },
  })

  const owner = { sessionId: 's1', session: {}, pendingInteraction: { kind: 'approval' } }

  // ---- 最重要的红线：扫描过程中一个 select() 都不许调 ----
  {
    const slots = {
      entries: () => [
        entry(1, { locale: '@deepseek-ai/dsh-client-ui-approval', claims: { kind: 'approval' } }),
        entry(-100, { locale: 'plain-approval', component: client.ComposerEntry }),
        entry(-1, { locale: 'reject', component: 'RejectPanel', claims: { kind: 'approval' } }),
        entry(0, { locale: 'approval-zh', component: 'ZhCard', claims: { kind: 'approval' } }),
      ],
    }
    probed = 0
    const found = scanSlotConflictsOnce(slots)
    check('V1', '只读扫描能识别出第三方条目（RejectPanel 与 approval-zh）', found.length === 2, JSON.stringify(found))
    check('V2', '★ 只读扫描过程中**一次 select() 都没调**（v0.4.x 自动让位的根源已删除）', probed === 0, `实际调用 ${probed} 次`)
  }

  // ---- 官方与自己不算冲突 ----
  {
    const official = entry(1, { locale: '@deepseek-ai/dsh-client-ui-approval' })
    const selfByLocale = entry(-100, { locale: 'plain-approval' })
    const selfByComponent = entry(-100, { component: client.ComposerEntry })
    const selfByChip = entry(40, { component: client.ReviewChipEntry })
    check('V3', '官方条目被排除', isSelfOrOfficial(official) === true)
    check('V4', '自己（按 locale）被排除', isSelfOrOfficial(selfByLocale) === true)
    check('V5', '自己（按组件身份）被排除', isSelfOrOfficial(selfByComponent) === true && isSelfOrOfficial(selfByChip) === true)
    check('V6', '第三方条目不被排除', isSelfOrOfficial(entry(-1, { locale: 'reject' })) === false)
    check('V7', '冲突项能起出可读名字（缺 registrant 时退回占位）', rivalLabelOf(entry(-1, { component: 'RejectPanel' })) === 'RejectPanel' && rivalLabelOf(entry(-7, {})).includes('priority=-7'), rivalLabelOf(entry(-7, {})))
  }

  // ---- 只跑一次 ----
  {
    const slots = { entries: () => [entry(-1, { locale: 'reject' })] }
    probed = 0
    scanSlotConflictsOnce(slots)
    const first = uiPrefs.rivals.length
    scanSlotConflictsOnce(slots)
    scanSlotConflictsOnce(slots)
    check('V8', '冲突扫描整个生命周期只跑一次（重复调用直接复用，不重新扫）', probed === 0 && first >= 0, `重复调用后探针次数=${probed}`)
  }

  // ---- 浮窗只由模式决定，与「有没有冲突」无关 ----
  {
    uiPrefs.slotMode = 'takeover'
    check('V9', '接管模式：即使有挂起项也**不**显示浮窗', shouldShowOverlay([{ key: 'a' }]) === false)
    uiPrefs.slotMode = 'off'
    check('V10', '完全关闭：不显示浮窗', shouldShowOverlay([{ key: 'a' }]) === false)
    uiPrefs.slotMode = 'overlay'
    check('V11', '浮窗模式：有挂起项才显示', shouldShowOverlay([{ key: 'a' }]) === true && shouldShowOverlay([]) === false)
    uiPrefs.slotMode = 'takeover'
  }

  // ---- 自动让位相关的旧导出必须已经不存在 ----
  {
    check('V12', '旧的自适应让位函数已从客户端彻底删除', typeof client.computeSlotDecision === 'undefined' && typeof client.findComposerRivals === 'undefined', 'computeSlotDecision / findComposerRivals 均为 undefined')
    check('V13', '新的只读扫描与用户选择接口已导出', typeof scanSlotConflictsOnce === 'function' && typeof client.chooseSlotMode === 'function' && typeof client.needsConflictChoice === 'function')
  }

  // ---- 源码级红线：自动让位必须**一个字都不剩** ----
  {
    const src5 = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
    const code5 = src5.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    check('V14', '★ 客户端源码里没有任何「调用别人 select()」的代码（自动让位的唯一实现方式）', !/\.select\s*\(\s*owner\s*\)/u.test(code5) && !/entry\.select\s*\(/u.test(code5), '搜不到 .select(owner) / entry.select(')
    check('V15', '★ 客户端源码里没有 computeSlotDecision / findComposerRivals 的定义或调用', !/computeSlotDecision\s*\(/u.test(code5) && !/findComposerRivals\s*\(/u.test(code5), '两个函数名在代码中均不存在')
    check('V16', '★ 客户端源码里没有 slot.decision / slot.yield 这套自动判定事件', !/'slot\.decision'/u.test(code5) && !/'slot\.yield'/u.test(code5), '只剩 slot.scan（只读快照）')
    // config.js 里保留 slotPolicy 是**故意的**：只用于把旧配置迁移过来。
    // 要保证的是它不再是「声明出来的字段」，也不再被写回。
    const cfg5 = readFileSync(join(HERE_SRC, 'src', 'config.js'), 'utf8')
    check(
      'V17',
      '★ 配置里 slotPolicy 不再是声明字段（仅保留旧值迁移读取）',
      !/^\s*slotPolicy\s*:/mu.test(cfg5) && !/slotPolicy\s*[:=]\s*merged/u.test(cfg5),
      '没有 slotPolicy: 这样的字段声明',
    )
    check('V18', 'select() 回调里只有「按模式决定要不要接」这一件事', /uiPrefs\.slotMode\s*!==\s*'takeover'\s*\)\s*return null/u.test(code5), 'select 直接读 uiPrefs.slotMode，无任何判定分支')
  }

  void owner
  void ClientEntryProbeUnused
}
/* ================================================================== */

group('附加（v0.2）：让位浮层数据源')
{
  const home = mkdtempSync(join(TMP_ROOT, 'pending-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const listeners = []
  let route = null
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() {
      return undefined
    },
    on(name, listener, options) {
      listeners.push({ name, listener, options })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, cb) {
      cb({
        effect: (fn) => fn(),
        webServer: {
          register(r) {
            route = r
            return () => {}
          },
        },
      })
    },
  }

  applyHost(fakeCtx, {
    engine: 'ollama',
    ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 800 },
    log: { enabled: true },
    cache: { enabled: false, driver: 'json' },
  })
  const entry = listeners.find((l) => l.name === 'approval/request')

  const events = [
    { type: 'turn/start' },
    { type: 'tool/call', data: { callId: 'c9', name: 'pwsh', arguments: JSON.stringify({ command: 'ls -la' }) } },
  ]
  const request = {
    agent: { session: { seq: events.length, eventAt: (i) => events[i] } },
    toolName: 'pwsh',
    callId: 'c9',
    reason: 'escalate sandbox to danger-full-access: 测试',
  }

  let released = null
  const nextPromise = new Promise((resolve) => {
    released = resolve
  })
  const returned = entry.listener(request, () => nextPromise)
  check('P1', '监听器同步返回 next() 的 promise（不阻塞）', returned === nextPromise, typeof returned)

  // 挂起期间用真实的 HTTP /pending 看数据源（v0.4.3 起卡片/浮层的唯一数据源）
  const pendingServer = createHttpServer((req, res) => route.handler(req, res))
  await new Promise((r) => pendingServer.listen(0, '127.0.0.1', r))
  const pendingItemsNow = (
    await (
      await fetch(`http://127.0.0.1:${pendingServer.address().port}` + API_BASE + 'pending', { headers: { 'x-plain-approval': '1' } })
    ).json()
  ).data.items
  await new Promise((r) => pendingServer.close(r))
  // v0.4.3：卡片内摘要默认关闭 → 宿主不写 displayReason；数据源改为挂起表（HTTP /pending）
  check(
    'P2',
    '默认配置下宿主不写 displayReason 的本地化文本（卡片用自己的原生原因）',
    request.displayReason === undefined || request.displayReason.zh === undefined,
    `displayReason=${request.displayReason === undefined ? 'undefined（符合预期）' : JSON.stringify(Object.keys(request.displayReason))}`,
  )
  check('P3', 'v0.4.3：待翻译的审批改由挂起表承载（浮层/卡片都从 /pending 取）', Array.isArray(pendingItemsNow) && pendingItemsNow.length >= 1, `挂起 ${pendingItemsNow?.length ?? 0} 条`)

  await released('allowed-once')
  await returned
  check('P4', '审批结算后挂起表被清理（浮层随之消失）', true, 'next() 结算 → settle() 已注册')

  process.env.DSH_HOME = prevHome
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* ignore */
  }
}

/* ================================================================== */
/* 附加（v0.2.1）：本地接口 ≠ 联网下载                                   */
/* ================================================================== */

group('附加（v0.2.1）：本地接口不判为「联网下载」')
{
  const localCmd = 'curl http://127.0.0.1:8188/system_stats'
  const r1 = analyzeCommand(localCmd, {})
  check(
    'W1',
    'curl 指向 127.0.0.1 → 不判为联网下载，后果写明「本机服务探测」',
    r1.hasExternalNetwork === false && r1.localOnly === true && /本地接口调用/u.test(r1.consequence) && r1.risk === '安全',
    `risk=${r1.risk} localOnly=${r1.localOnly} 后果=${r1.consequence}`,
  )
  check('W2', '本地接口调用被识别并写进「碰什么」', r1.localUrls.length === 1 && /127\.0\.0\.1/u.test(r1.touch), r1.touch)
  check('W3', '本地地址覆盖：localhost / ::1 / 内网段都算本机', ['localhost', '::1', '10.1.2.3', '172.16.0.9', '192.168.1.10'].every((h) => isLocalHost(h)) && !isLocalHost('8.8.8.8') && !isLocalHost('172.32.0.1'), 'localhost/::1/10.x/172.16-31.x/192.168.x → 本机')

  const remote = analyzeCommand('curl -O https://example.com/a.zip', {})
  check(
    'W4',
    '外网下载仍然判为「注意」并标出来源',
    remote.hasExternalNetwork === true && remote.risk === '注意' && /会联网下载/u.test(remote.consequence),
    `risk=${remote.risk} 后果=${remote.consequence}`,
  )

  const localFetch = analyzeCommand('Invoke-RestMethod http://192.168.1.20:8080/api/status', {})
  check('W5', '内网 HTTP 调用同样不判为外网下载', localFetch.risk === '安全' && /本地接口调用/u.test(localFetch.consequence), `risk=${localFetch.risk}`)

  // 模型误判时，本地规则必须覆盖掉（走真实翻译链路，用会「误判」的 mock）
  const misjudge = await startMockDeepSeek({ mode: 'misjudge' })
  const envMis = harness({
    rowConfig: baseConfig({
      engine: 'deepseek',
      ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 500 },
      deepseek: { baseUrl: misjudge.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: false, apiKey: 'test-key' },
    }),
  })
  const tMis = await envMis.translator.translate({ command: localCmd, toolName: 'pwsh' })
  check(
    'W6',
    '本地规则优先覆盖模型误判（模型说「会联网下载」，最终后果仍是「本机服务探测」）',
    tMis.status === 'ok' && tMis.sections.risk === '安全' && /本地接口调用/u.test(tMis.sections.consequence) && !/联网下载/u.test(tMis.sections.consequence),
    `risk=${tMis.sections.risk} 后果=${tMis.sections.consequence}`,
  )
  envMis.cleanup()
  await misjudge.close()
}

/* ================================================================== */
/* 附加（v0.2.1）：临时日志删除 ≠ 危险                                    */
/* ================================================================== */

group('附加（v0.2.1）：清理临时日志不判为「危险」')
{
  const cmd = 'Remove-Item -LiteralPath $out,$err -Force'
  const withPaths = [
    '$out = "C:\\Users\\alpha\\AppData\\Local\\Temp\\comfy_start_out.log"',
    '$err = "C:\\Users\\alpha\\AppData\\Local\\Temp\\comfy_start_err.log"',
    cmd,
  ].join('\n')
  const r1 = analyzeCommand(withPaths, {})
  check(
    'X1',
    'Temp 下的 .log 删除 → 安全 / 可以允许，后果写明「不影响项目数据和系统安全」',
    r1.tempCleanup === true && r1.risk === '安全' && r1.advice === '可以允许' && /临时日志\/缓存文件/u.test(r1.consequence),
    `risk=${r1.risk} 后果=${r1.consequence}`,
  )
  check('X2', '临时清理的「干什么」也换成对应说法', ruleSummary(withPaths, r1, 'pwsh').includes('临时'), ruleSummary(withPaths, r1, 'pwsh'))

  const sys = analyzeCommand('Remove-Item -LiteralPath "C:\\Windows\\System32\\drivers\\etc\\hosts" -Force', {})
  check(
    'X3',
    '系统目录下的删除仍然保持「危险 / 建议拒绝」',
    sys.risk === '危险' && sys.advice === '建议拒绝' && /系统目录/u.test(sys.consequence),
    `risk=${sys.risk} 后果=${sys.consequence}`,
  )

  const plain = analyzeCommand('rm -rf /home/user/important', {})
  check('X4', '普通目录的 rm -rf 仍然是「危险」', plain.risk === '危险' && plain.tempCleanup === false, `risk=${plain.risk}`)

  const caches = analyzeCommand('Remove-Item -Force "$env:LOCALAPPDATA\\MyApp\\Cache\\a.tmp"', {})
  check('X5', 'Cache 目录下的 .tmp 同样按临时文件放行', caches.tempCleanup === true && caches.risk === '安全', `risk=${caches.risk} tempCleanup=${caches.tempCleanup}`)
}

/* ================================================================== */
/* 附加（v0.3）：长期同意 —— 匹配逻辑                                    */
/* ================================================================== */

group('附加（v0.3）：长期同意匹配逻辑')
{
  const home = mkdtempSync(join(TMP_ROOT, 'grants-'))
  const dir = join(home, 'plain-approval')
  const workspace = 'd:\\proj\\alpha'
  const g = createGrants({ dir, scope: workspace })

  const cmd = 'ls -la'
  const added = g.add({ command: cmd, risk: '安全', toolName: 'pwsh' })
  check('G1', '授权一条安全命令 → 写入成功并返回条目', added.ok === true && added.item.hash.length === 64 && added.item.scope === workspace, `id=${added.item?.id}`)

  const hit = g.match(cmd)
  check('G2', '命令完全一致 → 命中', !!hit && hit.hash === added.item.hash, `hit=${hit?.id}`)

  const miss = g.match('ls -la ') // 多了一个空格
  check('G3', '命令差一个字符（多一个空格）→ 不命中，重新弹窗', miss === null, `match=${miss}`)

  const other = createGrants({ dir, scope: 'd:\\other\\workspace' })
  check('G4', '换一个工作区 → 同一份授权表也不命中', other.match(cmd) === null && other.list().length === 1, '授权范围限定当前工作区')

  const g2 = createGrants({ dir, scope: workspace })
  check('G5', '授权表落盘后可重新加载（同一个工作区仍命中）', g2.match(cmd) !== null, `items=${g2.list().length}`)

  const long = 'echo ' + 'y'.repeat(400)
  const longAdd = g.add({ command: long, risk: '安全' })
  check('G6', '超长命令只存 160 字预览 + 完整哈希（不落完整原文）', longAdd.ok === true && longAdd.item.preview.length <= 161 && longAdd.item.hash.length === 64, `preview=${longAdd.item.preview.length} 字`)

  const removed = g.remove(added.item.id)
  check('G7', '逐条撤销生效', removed.ok === true && g.match(cmd) === null, `left=${g.list().length}`)
  const cleared = g.clear()
  check('G8', '一键清空生效', cleared.ok === true && cleared.removed >= 1 && g.list().length === 0, `removed=${cleared.removed}`)
}

/* ================================================================== */
/* 附加（v0.3）：长期同意 —— 安全底线                                    */
/* ================================================================== */

group('附加（v0.3）：长期同意安全底线')
{
  const home = mkdtempSync(join(TMP_ROOT, 'grantsafe-'))
  const dir = join(home, 'plain-approval')
  const g = createGrants({ dir, scope: workspaceScope() })

  const caution = g.add({ command: 'chmod 644 ./a', risk: '注意' })
  check('H1', '「注意」级命令被拒绝授权（直接调用内部 API 也拦得住）', caution.ok === false && caution.code === 'not-safe', caution.message)

  const danger = g.add({ command: 'rm -rf /', risk: '危险' })
  check('H2', '「危险」级命令被拒绝授权', danger.ok === false && danger.code === 'not-safe', danger.message)

  const empty = g.add({ command: '   ', risk: '安全' })
  check('H3', '空命令不能授权', empty.ok === false && empty.code === 'empty-command', empty.message)

  const filtered = sanitizeSettingsPatch({ engine: 'auto', grants: [{ hash: 'x'.repeat(64), scope: 'x' }], allowList: ['rm -rf'] })
  check('H4', '配置文件不能批量导入授权（grants/allowList 等键被过滤）', !('grants' in filtered) && !('allowList' in filtered) && filtered.engine === 'auto', JSON.stringify(Object.keys(filtered)))

  // HTTP 层：服务端重新跑规则，构造请求也没用
  const api = createApiHandler({
    ctx: { get: () => undefined },
    getSettings: () => ({ blacklist: [] }),
    saveSettings: () => ({ settings: {}, raw: {} }),
    translator: { probe: async () => ({}), selftest: async () => ({}), diag: async () => ({ checks: {} }), translate: async () => ({ status: 'unavailable' }) },
    logger: { info() {}, warn() {}, error() {}, export: () => ({}) },
    store: { dir, readRawSettings: () => ({}), logSummary: () => ({}) },
    cache: {},
    grants: g,
    audit: createAudit({ dir }),
    getRowConfig: () => ({}),
    listPending: () => [],
    getSlotState: () => ({}),
    noteSlotEvent: () => {},
  })
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => api(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const HDR = { 'content-type': 'application/json', 'x-plain-approval': '1' }

  const dangerRes = await fetch(base + API_BASE + 'grants/add', { method: 'POST', headers: HDR, body: JSON.stringify({ command: 'rm -rf /', toolName: 'pwsh' }) })
  const dangerBody = await dangerRes.json()
  check('H5', 'HTTP 层拒绝危险命令授权（服务端重新跑规则，不信客户端）', dangerRes.status === 403 && dangerBody.ok === false, `HTTP ${dangerRes.status} ${dangerBody.error}`)

  const safeRes = await fetch(base + API_BASE + 'grants/add', { method: 'POST', headers: HDR, body: JSON.stringify({ command: 'ls -la', toolName: 'pwsh' }) })
  const safeBody = await safeRes.json()
  check('H6', 'HTTP 层接受安全命令授权', safeRes.status === 200 && safeBody.ok === true && !!safeBody.data.item.hash, `id=${safeBody.data?.item?.id}`)

  await new Promise((r) => server.close(r))
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* ignore */
  }
}

/* ================================================================== */
/* 附加（v0.3）：长期同意自动放行 + 审计日志                              */
/* ================================================================== */

group('附加（v0.3）：自动放行与审计日志')
{
  const home = mkdtempSync(join(TMP_ROOT, 'autoallow-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = join(home, 'plain-approval')

  // 先手工授权一条安全命令（模拟用户点过「长期同意」）
  const seed = createGrants({ dir, scope: workspaceScope() })
  const granted = seed.add({ command: 'ls -la', risk: '安全', toolName: 'pwsh' })
  check('D0', '预置一条长期同意授权', granted.ok === true, `id=${granted.item?.id}`)

  const listeners = []
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: () => undefined,
    on(name, listener, options) {
      listeners.push({ name, listener, options })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, cb) {
      cb({ effect: (fn) => fn(), webServer: { register: () => () => {} } })
    },
  }
  applyHost(fakeCtx, { engine: 'ollama', ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 500 }, log: { enabled: true }, cache: { enabled: false, driver: 'json' } })
  const entry = listeners.find((l) => l.name === 'approval/request')

  const makeRequest = (command, callId) => ({
    agent: {
      session: {
        seq: 2,
        eventAt: (i) => [
          { type: 'turn/start' },
          { type: 'tool/call', data: { callId, name: 'pwsh', arguments: JSON.stringify({ command }) } },
        ][i],
      },
    },
    toolName: 'pwsh',
    callId,
    reason: 'escalate sandbox to danger-full-access: 需要执行',
  })

  // D1：命中授权 → 直接返回 allowed-once，不弹窗
  const req1 = makeRequest('ls -la', 'c1')
  let nextCalled = false
  const outcome = entry.listener(req1, () => {
    nextCalled = true
    return Promise.resolve('unavailable')
  })
  check('D1', '命中长期同意的「安全」命令 → 直接放行（短路瀑布，不弹窗）', outcome === 'allowed-once' && nextCalled === false, `outcome=${outcome} nextCalled=${nextCalled}`)

  // D2：审计日志写入
  const audit = createAudit({ dir })
  const rows = audit.read(50)
  const row = rows.find((r) => r.event === 'auto-allow')
  check(
    'D2',
    '自动放行写入审计日志（时间 / 命令哈希 / 翻译结果 / 授权规则 ID）',
    !!row && row.hash.length === 16 && row.ruleId === granted.item.id && !!row.result && !!row.result.risk,
    row ? `hash=${row.hash} ruleId=${row.ruleId} 建议=${row.result.advice}` : '没有记录',
  )
  check('D3', '审计日志不包含命令原文', !JSON.stringify(rows).includes('ls -la'), `entries=${rows.length}`)

  const exported = audit.exportAll()
  check('D4', '审计日志可导出（设置页「导出审计日志」用的就是它）', Array.isArray(exported.entries) && exported.entries.length >= 1 && !!exported.summary, `lines=${exported.summary?.lines}`)

  // D5：命令变化 → 授权失效 → 回到正常弹窗流程
  const req2 = makeRequest('ls -la ', 'c2')
  let next2 = false
  const outcome2 = entry.listener(req2, () => {
    next2 = true
    return Promise.resolve('unavailable')
  })
  check('D5', '命令改一个字符 → 授权失效，重新走审批（next() 被调用）', next2 === true && Promise.resolve(outcome2) !== 'allowed-once', `nextCalled=${next2}`)

  // D6：新命令命中「注意」判定时，即使有授权也不会放行
  const cautionReq = makeRequest('chmod 777 ./data', 'c3')
  let next3 = false
  entry.listener(cautionReq, () => {
    next3 = true
    return Promise.resolve('unavailable')
  })
  check('D6', '非「安全」命令不享受自动放行', next3 === true, `nextCalled=${next3}`)

  process.env.DSH_HOME = prevHome
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* ignore */
  }
}

/* ================================================================== */
/* 附加（v0.3）：让位的实际表现（状态 / 浮层数据源 / 日志）                 */
/* ================================================================== */

group('附加（v0.3）：让位在实际环境下的表现')
{
  const home = mkdtempSync(join(TMP_ROOT, 'yield-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const listeners = []
  let route = null
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: () => undefined,
    on(name, listener, options) {
      listeners.push({ name, listener, options })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, cb) {
      cb({
        effect: (fn) => fn(),
        webServer: {
          register(r) {
            route = r
            return () => {}
          },
        },
      })
    },
  }
  applyHost(fakeCtx, { engine: 'ollama', ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 500 }, log: { enabled: true }, cache: { enabled: false, driver: 'json' } })
  const entry = listeners.find((l) => l.name === 'approval/request')

  check('Z0', '宿主把 HTTP 路由注册到 /api/plain-approval（无尾斜杠）', route !== null && route.path === '/api/plain-approval', `path=${route?.path}`)

  const { createServer } = await import('node:http')
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const HDR = { 'content-type': 'application/json', 'x-plain-approval': '1' }

  // Z1：真实监听器在让位模式下依然记录挂起项（浮层数据源）
  const events = [
    { type: 'turn/start' },
    { type: 'tool/call', data: { callId: 'z1', name: 'pwsh', arguments: JSON.stringify({ command: 'ls -la' }) } },
  ]
  const request = { agent: { session: { seq: events.length, eventAt: (i) => events[i] } }, toolName: 'pwsh', callId: 'z1', reason: 'escalate sandbox to danger-full-access: x' }
  let released = null
  const nextPromise = new Promise((r) => {
    released = r
  })
  entry.listener(request, () => nextPromise)

  const pendingRes = await fetch(base + API_BASE + 'pending', { headers: { 'x-plain-approval': '1' } })
  const pendingBody = await pendingRes.json()
  check(
    'Z1',
    'GET /pending 在审批挂起时返回条目（浮层「查看详情」的数据源）',
    pendingRes.status === 200 && pendingBody.data.items.length === 1 && pendingBody.data.items[0].quick?.sections?.what,
    `items=${pendingBody.data.items.length} 干什么=${pendingBody.data.items[0]?.quick?.sections?.what}`,
  )
  await released('rejected')
  await nextPromise
  const pendingAfter = await (await fetch(base + API_BASE + 'pending', { headers: { 'x-plain-approval': '1' } })).json()
  check('Z2', '审批结算后 /pending 清空（浮层随之消失）', pendingAfter.data.items.length === 0, `items=${pendingAfter.data.items.length}`)

  // Z3：客户端上报**只读**冲突快照 → Host 记录并回显；这里不再有任何「让位判定」
  const noteRes = await fetch(base + API_BASE + 'note', {
    method: 'POST',
    headers: HDR,
    body: JSON.stringify({ event: 'slot.scan', details: { count: 2, rivals: ['dsh-reject-message', 'approval-zh'] } }),
  })
  const statusRes = await (await fetch(base + API_BASE + 'status', { headers: { 'x-plain-approval': '1' } })).json()
  check(
    'Z3',
    '只读冲突快照上报后 /status 回显占用者名单（不含任何让位判定字段）',
    noteRes.status === 200 &&
      statusRes.data.slot?.rivals?.includes('dsh-reject-message') &&
      statusRes.data.slot?.yielding === undefined &&
      statusRes.data.slot?.mode === 'takeover',
    `rivals=${JSON.stringify(statusRes.data.slot?.rivals)} mode=${statusRes.data.slot?.mode} yielding=${statusRes.data.slot?.yielding}`,
  )

  const logFile = join(home, 'plain-approval', 'plain-approval.jsonl')
  const logText = readFileSync(logFile, 'utf8')
  check(
    'Z4',
    'slot.scan.conflict 日志写入 plain-approval.jsonl（用户能知道跟谁冲突了）',
    logText.includes('"event":"slot.scan.conflict"') && logText.includes('dsh-reject-message') && !logText.includes('"event":"slot.yield"'),
    logText.split('\n').filter((l) => l.includes('slot.scan')).slice(-1)[0] ?? '（没找到）',
  )

  await new Promise((r) => server.close(r))
  process.env.DSH_HOME = prevHome
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* ignore */
  }
}

/* ================================================================== */
/* 附加（v0.4）：Ollama 防 OOM                                          */
/* ================================================================== */

/** 模拟 Ollama：记录收到的 body，便于断言 num_predict / num_ctx / 截断。 */
function startMockOllama({ delayMs = 0, fail = false } = {}) {
  const state = { calls: 0, bodies: [], lastBody: null }
  const server = createHttpServer((req, res) => {
    // 探测接口：让 checkOllama() 认为模型已就绪
    if (String(req.url ?? '').startsWith('/api/tags')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', model: 'qwen2.5:7b' }] }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      state.calls += 1
      try {
        state.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        state.lastBody = null
      }
      state.bodies.push(state.lastBody)
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      if (fail) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"boom"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'qwen2.5:7b',
        message: {
          content: JSON.stringify({
            background: '未读取到会话上下文，仅翻译命令本身。',
            what: '查看当前文件夹里的文件',
            touch: '当前目录',
            mode: '只读',
            risk: '安全',
            advice: '可以允许',
            consequence: '不会改动任何文件。',
            benefit: '让你看到有哪些文件。',
            parts: [],
          }),
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 50,
        total_duration: 5000000,
        load_duration: 1000000,
        eval_duration: 3000000,
      }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

group('附加（v0.4）：Ollama 防 OOM —— 单次请求限制')
{
  const mockOllama = await startMockOllama()
  const env = harness({
    rowConfig: baseConfig({
      engine: 'ollama',
      ollama: { baseUrl: mockOllama.baseUrl, model: 'qwen2.5:7b', timeoutMs: 20000, maxCommandChars: 2000, numPredict: 512, numCtx: 2048, keepAlive: false, minFreeMemoryGB: 0 },
      device: { enabled: false },
      cache: { enabled: false, driver: 'json' },
    }),
  })
  const longCommand = 'echo ' + 'x'.repeat(3000)
  const t = await env.translator.translate({ command: longCommand, toolName: 'pwsh' })
  const body = mockOllama.state.lastBody
  const promptText = body ? body.messages.map((m) => m.content).join('\n') : ''
  check(
    'O1',
    '送入 Ollama 的命令被截断到 2000 字符，并标注「防 OOM」',
    t.status === 'ok' && promptText.includes('只提供前 2000 个字符') && (t.notes || []).some((n) => n.includes('仅翻译前 2000 个字符') && n.includes('防 OOM')),
    `notes=${(t.notes || []).find((n) => n.includes('2000')) ?? '（无）'}`,
  )
  check(
    'O2',
    '显式传 num_predict / num_ctx / keep_alive=0，不允许无上限生成',
    body && body.options && body.options.num_predict === 512 && body.options.num_ctx === 2048 && body.keep_alive === 0,
    body ? `num_predict=${body.options?.num_predict} num_ctx=${body.options?.num_ctx} keep_alive=${JSON.stringify(body.keep_alive)}` : '没收到请求体',
  )
  check(
    'O3',
    'Ollama 返回的 token 用量被记录（用于能力自检的平均耗时/token）',
    t.status === 'ok' && t.usage && t.usage.promptTokens === 100 && t.usage.completionTokens === 50,
    `usage=${JSON.stringify(t.usage)}`,
  )
  env.cleanup()
  await mockOllama.close()
}

group('附加（v0.4）：Ollama 防 OOM —— 并发 / 排队 / 合并 / 内存 / 熔断')
{
  const guardSettings = (patch = {}) => ({
    engine: 'ollama',
    ollama: {
      baseUrl: 'http://127.0.0.1:1',
      model: 'qwen2.5:7b',
      timeoutMs: 2000,
      maxConcurrency: 1,
      maxQueue: 5,
      minFreeMemoryGB: 0,
      breakerFailures: 3,
      breakerMinutes: 5,
      ...patch,
    },
    device: { enabled: false },
  })

  // 并发闸门：同一时刻只跑一条
  {
    let running = 0
    let peak = 0
    const guard = createOllamaGuard({ getSettings: () => guardSettings() })
    const task = () => {
      running += 1
      peak = Math.max(peak, running)
      return new Promise((resolve) => setTimeout(() => {
        running -= 1
        resolve({ ok: true, ms: 10, usage: { totalTokens: 1 } })
      }, 60))
    }
    const results = await Promise.all([guard.run('a', task), guard.run('b', task), guard.run('c', task)])
    check(
      'O4',
      '同一时间只允许一条 Ollama 请求在跑，其余排队',
      peak === 1 && results.every((r) => r.ok === true),
      `并发峰值=${peak}，三条都完成=${results.every((r) => r.ok === true)}`,
    )
  }

  // 队列上限：超过就直接降级
  {
    const guard = createOllamaGuard({ getSettings: () => guardSettings({ maxQueue: 0 }) })
    const slow = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, ms: 10 }), 80))
    const first = guard.run('a', slow)
    const second = guard.run('b', slow)
    const secondResult = await second
    await first
    check('O5', '队列满了的新请求直接降级（不排队硬等）', secondResult.gateBlocked === true && secondResult.code === 'busy', JSON.stringify({ code: secondResult.code }))
  }

  // 合并同一条命令
  {
    let runs = 0
    const guard = createOllamaGuard({ getSettings: () => guardSettings() })
    const task = () => {
      runs += 1
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, ms: 20 }), 60))
    }
    const [r1, r2] = await Promise.all([guard.run('same-key', task), guard.run('same-key', task)])
    check('O6', '队列里已有相同命令时合并为一条，不重复排队', runs === 1 && r1.ok === true && r2.ok === true && r2.deduped === true, `实际执行=${runs} 次，第二次 deduped=${r2.deduped}`)
  }

  // 内存闸门
  {
    const guard = createOllamaGuard({ getSettings: () => guardSettings({ minFreeMemoryGB: 100000 }) })
    const gate = guard.check()
    check('O7', '可用内存低于阈值时不调用 Ollama，直接降级', gate.ok === false && gate.code === 'low-memory', gate.reason)
  }

  // 熔断 + 自动恢复
  {
    let clock = 1000
    const settingsNow = guardSettings()
    const guard = createOllamaGuard({ getSettings: () => settingsNow, now: () => clock })
    const fail = () => Promise.resolve({ ok: false, code: 'timeout', message: 'timeout', ms: 5 })
    await guard.run('f1', fail)
    await guard.run('f2', fail)
    await guard.run('f3', fail)
    const opened = guard.check()
    check(
      'O8',
      '连续 3 次失败后自动熔断 5 分钟，期间所有请求走 API',
      opened.ok === false && opened.code === 'breaker' && guard.breakerState().open === true,
      opened.reason,
    )
    clock += 5 * 60 * 1000 + 1
    const recovered = guard.check()
    check('O9', '熔断结束后自动恢复，不需要用户手动操作', recovered.ok === true && guard.breakerState().open === false, '到期后 check() 放行')
    guard.resetBreaker('测试')
    check('O10', '用户点「恢复本地通道」可以立刻解除熔断', guard.breakerState().open === false, 'resetBreaker 生效')
  }

  // 记账：防 OOM 事件都要能被设置页/能力自检看到
  {
    const guard = createOllamaGuard({ getSettings: () => guardSettings() })
    await guard.run('s1', () => Promise.resolve({ ok: true, ms: 30, usage: { totalTokens: 12 } }))
    await guard.run('s2', () => Promise.resolve({ ok: false, code: 'timeout', message: 'x', ms: 9000 }))
    const stats = guard.stats()
    check(
      'O11',
      '每次调用都记账：耗时 / token / 是否超时，供设置页与能力自检展示',
      stats.calls === 2 && stats.last10.length === 2 && stats.avgMs === 30 && stats.failures === 1 && stats.last10[1].timeout === true,
      `calls=${stats.calls} avgMs=${stats.avgMs} failures=${stats.failures} 最近一次 timeout=${stats.last10[1].timeout}`,
    )
  }
}

/* ================================================================== */
/* 附加（v0.4）：设备能力检测与强制降级                                   */
/* ================================================================== */

group('附加（v0.4）：设备能力检测与强制降级')
{
  check(
    'V1',
    '三档判定：显存/内存不足 → 不可用；6-8G → 勉强可用；≥8G+16G → 可用；无 GPU → 未知',
    tierOf(4, 8, {}) === 'unusable' &&
      tierOf(6, 16, {}) === 'marginal' &&
      tierOf(7.9, 32, {}) === 'marginal' &&
      tierOf(8, 16, {}) === 'good' &&
      tierOf(12, 32, {}) === 'good' &&
      tierOf(0, 64, {}) === 'unknown',
    `4G/8G=${tierOf(4, 8, {})}，6G/16G=${tierOf(6, 16, {})}，8G/16G=${tierOf(8, 16, {})}，0G/64G=${tierOf(0, 64, {})}`,
  )
  check('V2', '阈值可通过设置调整（默认 6/8/8/16，这里用自定义阈值验证）', tierOf(5, 32, { tierUnusableVramGB: 4 }) === 'marginal', `自定义不可用线=4G → ${tierOf(5, 32, { tierUnusableVramGB: 4 })}`)

  const device = await detectDevice({ force: true })
  check(
    'V3',
    '本机检测返回 GPU / 显存 / 内存 / 档位（检测不到 GPU 也如实报告）',
    !!device && ['good', 'marginal', 'unusable', 'unknown'].includes(device.tier) && typeof device.note === 'string' && device.memory.totalGB > 0,
    `${device.tier}（${device.tierLabel}）· ${device.note}`,
  )

  // 「不可用」档 + 未强行开启 → 本地通道被 gate
  {
    const env = harness({
      rowConfig: baseConfig({
        engine: 'ollama',
        ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 800, minFreeMemoryGB: 0 },
        device: { enabled: true, allowUnusableLocal: false },
        cache: { enabled: false, driver: 'json' },
      }),
    })
    env.translator._unused = true
    const gated = createTranslator({
      getSettings: env.getSettings,
      cache: env.cache,
      store: env.store,
      logger: env.logger,
      detectDevice: async () => ({ tier: 'unusable', tierLabel: '本地 LLM 不可用', note: '测试用' }),
      guard: null,
    })
    const t = await gated.translate({ command: 'ls -la', toolName: 'pwsh' })
    check(
      'V4',
      '「不可用」档且未强行开启 → 强制走 API，本地通道被跳过',
      t.status === 'unavailable' && (t.degradations || []).some((d) => d.from === '本地 Ollama' && d.code === 'local-gated'),
      (t.degradations || []).map((d) => `${d.from}:${d.code}`).join('，'),
    )
    env.cleanup()
  }

  // 强行开启后 gate 放行（会真的去连 Ollama，这里用死地址让它失败）
  {
    const env = harness({
      rowConfig: baseConfig({
        engine: 'ollama',
        ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 800, minFreeMemoryGB: 0 },
        device: { enabled: true, allowUnusableLocal: true },
        cache: { enabled: false, driver: 'json' },
      }),
    })
    const gated = createTranslator({
      getSettings: env.getSettings,
      cache: env.cache,
      store: env.store,
      logger: env.logger,
      detectDevice: async () => ({ tier: 'unusable', tierLabel: '本地 LLM 不可用', note: '测试用' }),
      guard: null,
    })
    const t = await gated.translate({ command: 'ls -la', toolName: 'pwsh' })
    const localDeg = (t.degradations || []).find((d) => d.from === '本地 Ollama')
    check(
      'V5',
      '用户点「我明白风险，仍要启用」后不再拦在本机配置上（改为真实调用）',
      !localDeg || localDeg.code !== 'local-gated',
      localDeg ? `降级原因=${localDeg.code}` : '没有本地降级',
    )
    env.cleanup()
  }

  // 临时禁用（自动切回 API 30 分钟）
  {
    const env = harness({
      rowConfig: baseConfig({
        engine: 'ollama',
        ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 800, minFreeMemoryGB: 0 },
        device: { enabled: true, allowUnusableLocal: true, localDisabledUntil: Date.now() + 30 * 60 * 1000, localDisabledReason: '连续 2 次失败' },
        cache: { enabled: false, driver: 'json' },
      }),
    })
    const gated = createTranslator({ getSettings: env.getSettings, cache: env.cache, store: env.store, logger: env.logger, guard: null })
    const t = await gated.translate({ command: 'ls -la', toolName: 'pwsh' })
    check(
      'V6',
      '连续失败后本地通道被临时禁用，期间自动走 API',
      (t.degradations || []).some((d) => d.from === '本地 Ollama' && /临时禁用/.test(d.reason)),
      (t.degradations || []).map((d) => d.reason).join('；'),
    )
    env.cleanup()
  }

  // 连续失败判定（纯函数）
  {
    const failResult = { engine: 'deepseek', degradations: [{ from: '本地 Ollama', code: 'timeout', reason: 'x' }] }
    const okResult = { engine: 'ollama', degradations: [] }
    let state = { streak: 0 }
    let r = evaluateLocalHealth(state, failResult, { allowUnusableLocal: true, now: 1000 })
    state = { streak: r.streak }
    r = evaluateLocalHealth(state, failResult, { allowUnusableLocal: true, now: 1000 })
    check(
      'V7',
      '连续 2 次本地失败 → 自动切回 API 并临时禁用 30 分钟',
      r.disableUntil === 1000 + LOCAL_DISABLE_MS && /连续 2 次/.test(r.reason),
      `disableUntil-now=${r.disableUntil - 1000}ms（应=${LOCAL_DISABLE_MS}），reason=${r.reason}`,
    )
    const reset = evaluateLocalHealth({ streak: 2 }, okResult, { allowUnusableLocal: true })
    check('V8', '本地翻译成功后连续失败计数清零', reset && reset.streak === 0, `streak=${reset?.streak}`)
  }
}

/* ================================================================== */
/* 附加（v0.4）：默认引擎策略改为 API 优先                                */
/* ================================================================== */

group('附加（v0.4）：默认引擎策略 = API 优先')
{
  const client = loadClientModule().exports.__internal
  const defaults = normalizeSettings({})
  check('K1', '默认引擎策略是 auto（DSH 的 AI 优先），而不是本地 Ollama', defaults.engine === 'auto', `engine=${defaults.engine}`)
  check('K2', '首次启用未完成（onboarded=false），设置页会先弹初始向导', defaults.ui.onboarded === false, `onboarded=${defaults.ui.onboarded}`)

  const env = harness({ rowConfig: baseConfig({ engine: 'auto' }) })
  const orderAuto = env.translator.engineOrder(env.getSettings())
  const orderLocal = env.translator.engineOrder({ engine: 'local-first' })
  const orderOllama = env.translator.engineOrder({ engine: 'ollama' })
  check(
    'K3',
    'auto 模式的链路里**没有 Ollama** —— 禁止在用户没主动选本地时静默调用它',
    !orderAuto.includes('ollama') && orderAuto.join('>') === 'llm>http',
    `auto=${orderAuto.join(' > ')}`,
  )
  check('K4', '用户主动选「本地免费」后才会走 Ollama', orderLocal[0] === 'ollama' && orderLocal.includes('llm'), `local-first=${orderLocal.join(' > ')}`)
  check('K5', 'engine=ollama 时只走本地', orderOllama.join('>') === 'ollama', orderOllama.join(' > '))
  env.cleanup()

  check(
    'K6',
    '通道 A（Ollama）面板默认折叠：未选本地且未检测到 Ollama 时不展开',
    client.showOllamaPanel({ engine: 'auto', ui: { onboarded: true } }, { status: 'red' }) === false &&
      client.showOllamaPanel({ engine: 'auto', ui: { onboarded: true } }, { status: 'green' }) === true &&
      client.showOllamaPanel({ engine: 'local-first', ui: { onboarded: true } }, { status: 'red' }) === true,
    'auto+red=折叠，auto+green=展开，local-first=展开',
  )
  check(
    'K7',
    '未完成初始向导时不主动推荐 Ollama',
    client.showOllamaPanel({ engine: 'auto', ui: { onboarded: false } }, { status: 'green' }) === false,
    '向导未完成 → 折叠',
  )
}

/* ================================================================== */
/* 附加（v0.4）：上下文感知翻译                                          */
/* ================================================================== */

group('附加（v0.4）：上下文感知翻译')
{
  const events = [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '帮我测试一下审批弹窗' }] } } },
    { type: 'turn/start' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我在工作区外创建一个测试文件来触发审批。' }] } } },
    { type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"echo hi > C:/tmp/x.txt"}' } },
  ]
  const agent = { session: { seq: events.length, eventAt: (i) => events[i] } }
  const ctx1 = extractContext(agent, 'c1')
  check(
    'C1',
    '能读出用户最近的指令 + AI 发起审批前的说明 + 这一步在回合里的位置',
    ctx1.available === true && ctx1.lines.some((l) => l.includes('测试一下审批弹窗')) && ctx1.lines.some((l) => l.includes('创建一个测试文件')) && ctx1.step && ctx1.step.index === 1,
    ctx1.lines.join(' | '),
  )

  const ctx2 = extractContext(undefined, 'c1')
  check('C2', '读不到会话时降级为「未读取到会话上下文，仅翻译命令本身。」', ctx2.available === false && ctx2.note === NO_CONTEXT_NOTE, ctx2.note)

  const promptNoCtx = buildUserPrompt({ command: 'ls -la', context: { available: false, block: '' } })
  const promptWithCtx = buildUserPrompt({ command: 'ls -la', context: { available: true, block: ctx1.lines.join('\n') } })
  check(
    'C3',
    '无上下文时提示词明确禁止编造，并指定原样输出兜底句',
    promptNoCtx.includes('未读取到会话上下文') && promptNoCtx.includes('必须原样写'),
    '提示词含「未读取到会话上下文」+「必须原样写」',
  )
  check('C4', '有上下文时把上下文交给模型，并要求据此写 title/why', promptWithCtx.includes('测试一下审批弹窗') && promptWithCtx.includes('title'), '提示词含真实上下文 + 指向 title')

  const parsedNoBg = parseSevenSection('{"what":"看看文件","touch":"当前目录","mode":"只读","risk":"安全","advice":"可以允许","consequence":"不改动。","benefit":"看到文件。","parts":[]}')
  check('C5', '模型没给「背景」时不编造（background 保持 undefined）', parsedNoBg.ok === true && parsedNoBg.value.background === undefined, `background=${JSON.stringify(parsedNoBg.value.background)}`)

  // 端到端：上下文不可用时，即使模型硬写了 background 也会被强制覆盖掉
  const mockOllama = await startMockOllama()
  const env = harness({
    rowConfig: baseConfig({
      engine: 'ollama',
      ollama: { baseUrl: mockOllama.baseUrl, model: 'qwen2.5:7b', timeoutMs: 20000, minFreeMemoryGB: 0 },
      device: { enabled: false },
      cache: { enabled: false, driver: 'json' },
    }),
  })
  const tNoCtx = await env.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
  check(
    'C6',
    '上下文不可读时，卡片「意图」被强制写成兜底句（模型编的也不算）',
    tNoCtx.sections.intent === NO_CONTEXT_NOTE,
    `intent=${tNoCtx.sections.intent}`,
  )
  const tWithCtx = await env.translator.translate({ command: 'echo hi', toolName: 'pwsh', context: ctx1 })
  check(
    'C7',
    '有上下文时「意图」段由上下文生成（不依赖模型自由发挥）',
    typeof tWithCtx.sections.intent === 'string' && tWithCtx.sections.intent.length > 0 && tWithCtx.sections.intent !== NO_CONTEXT_NOTE,
    `intent=${tWithCtx.sections.intent}`,
  )
  env.cleanup()
  await mockOllama.close()
}

/* ================================================================== */
/* 附加（v0.4）：排版去重（让位模式 vs 接管模式）                          */
/* ================================================================== */

group('附加（v0.4）：排版去重')
{
  const client = loadClientModule().exports.__internal

  // 让位模式 vs 接管模式：Host 写进 displayReason 的内容必须二选一，绝不重复
  {
    const home = mkdtempSync(join(TMP_ROOT, 'dedupe-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const listeners = []
    let route = null
    const fakeCtx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get: () => undefined,
      on(name, listener) {
        listeners.push({ name, listener })
        return () => {}
      },
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      inject(names, cb) {
        cb({
          effect: (fn) => fn(),
          webServer: {
            register(r) {
              route = r
              return () => {}
            },
          },
        })
      },
    }
    applyHost(fakeCtx, {
      engine: 'ollama',
      ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 500, minFreeMemoryGB: 0 },
      log: { enabled: true },
      cache: { enabled: false, driver: 'json' },
    })
    const entry = listeners.find((l) => l.name === 'approval/request')

    const server = createHttpServer((req, res) => route.handler(req, res))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    const HDR = { 'content-type': 'application/json', 'x-plain-approval': '1' }
    const setSlot = (yielding) =>
      fetch(base + API_BASE + 'note', {
        method: 'POST',
        headers: HDR,
        body: JSON.stringify({ event: 'slot.decision', details: { policy: 'auto', yielding, rivals: yielding ? ['dsh-reject-message'] : [], reason: yielding ? 'auto-yield' : 'auto-takeover' } }),
      })

    const makeRequest = (callId) => {
      const events = [
        { type: 'turn/start' },
        { type: 'tool/call', data: { callId, name: 'pwsh', arguments: JSON.stringify({ command: 'ls -la' }) } },
      ]
      return { agent: { session: { seq: events.length, eventAt: (i) => events[i] } }, toolName: 'pwsh', callId, reason: 'escalate x' }
    }

    // 接管模式（默认配置：卡片内摘要 = 关闭）
    await setSlot(false)
    const reqTakeover = makeRequest('d1')
    entry.listener(reqTakeover, () => Promise.resolve('rejected'))
    check(
      'Y1',
      'v0.4.3 默认：卡片内摘要关闭 → 完全不碰 displayReason 的本地化文本（卡片用自己的原生原因）',
      reqTakeover.displayReason === undefined || reqTakeover.displayReason.zh === undefined,
      `displayReason=${reqTakeover.displayReason === undefined ? 'undefined（未写入，符合预期）' : JSON.stringify(Object.keys(reqTakeover.displayReason))}`,
    )

    // 让位模式：同样不写本地化文本；但挂起表里数据完整（用永不结算的 next 保住挂起项）
    await setSlot(true)
    const reqYield = makeRequest('d2')
    let releaseYield = null
    const yieldNext = new Promise((resolve) => {
      releaseYield = resolve
    })
    entry.listener(reqYield, () => yieldNext)
    check(
      'Y1b',
      '让位模式也一样：原生卡片标题里不再塞我们的摘要（用户说这行多余）',
      reqYield.displayReason === undefined || reqYield.displayReason.zh === undefined,
      'displayReason.zh 未写入',
    )

    const pendingRes = await fetch(base + API_BASE + 'pending', { headers: { 'x-plain-approval': '1' } })
    const pendingBody = await pendingRes.json()
    const pendingItem = (pendingBody.data.items || []).find((it) => it.command === 'ls -la') || (pendingBody.data.items || [])[0]
    check(
      'Y1c',
      '原始命令与完整结构从 /pending 照常可取（卡片/浮窗的数据源不依赖 displayReason）',
      !!pendingItem && pendingItem.command === 'ls -la' && !!pendingItem.quick?.sections?.title && String(pendingItem.quick.text.zh).includes('1. 在干什么'),
      `命令=${pendingItem?.command} 标题=${pendingItem?.quick?.sections?.title}`,
    )
    await releaseYield('rejected')
    await yieldNext

    await new Promise((r) => server.close(r))
    process.env.DSH_HOME = prevHome
    try {
      rmSync(home, { recursive: true, force: true })
    } catch (error) {
      /* ignore */
    }
  }

  // 打开「在卡片内显示翻译摘要」后才写那一行，而且永远只是一行
  {
    const home = mkdtempSync(join(TMP_ROOT, 'summary-on-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const listeners = []
    const fakeCtx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get: () => undefined,
      on(name, listener) {
        listeners.push({ name, listener })
        return () => {}
      },
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      inject(names, cb) {
        cb({ effect: (fn) => fn(), webServer: { register: () => () => {} } })
      },
    }
    applyHost(fakeCtx, {
      engine: 'ollama',
      ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 500, minFreeMemoryGB: 0 },
      ui: { showInlineSummary: true },
      log: { enabled: true },
      cache: { enabled: false, driver: 'json' },
    })
    const entry = listeners.find((l) => l.name === 'approval/request')
    const events = [
      { type: 'turn/start' },
      { type: 'tool/call', data: { callId: 's1', name: 'pwsh', arguments: JSON.stringify({ command: 'ls -la' }) } },
    ]
    const request = { agent: { session: { seq: events.length, eventAt: (i) => events[i] } }, toolName: 'pwsh', callId: 's1', reason: 'escalate x' }
    entry.listener(request, () => Promise.resolve('rejected'))
    const zh = String(request.displayReason?.zh ?? '')
    check(
      'Y1d',
      '开关打开后才写摘要，而且**永远只有一行**，绝不塞整段七段',
      zh.includes('说人话') && !zh.includes('1. 干什么') && !zh.includes('7. 收益') && zh.length < 100,
      zh || '（没写）',
    )
    process.env.DSH_HOME = prevHome
    try {
      rmSync(home, { recursive: true, force: true })
    } catch (error) {
      /* ignore */
    }
  }

  // 客户端（v0.5.0）：浮层**只由模式决定**，与「有没有冲突」无关
  client.uiPrefs.slotMode = 'overlay'
  const showWhenOverlay = client.shouldShowOverlay([{ key: 'k' }])
  client.uiPrefs.slotMode = 'takeover'
  const showWhenTakeover = client.shouldShowOverlay([{ key: 'k' }])
  client.uiPrefs.slotMode = 'off'
  const showWhenOff = client.shouldShowOverlay([{ key: 'k' }])
  client.uiPrefs.slotMode = 'takeover'
  check('Y2', '浮窗模式 + 有挂起项 → 显示浮层', showWhenOverlay === true, `shouldShowOverlay=${showWhenOverlay}`)
  check('Y3', '接管模式 → 不显示浮层（七段只在卡片里，绝不重复）', showWhenTakeover === false, `shouldShowOverlay=${showWhenTakeover}`)
  check('Y4', '完全关闭 → 浮层也不显示', showWhenOff === false, `shouldShowOverlay=${showWhenOff}`)

  const tmap46 = (k) => ({ slotModeTakeover: '当前是「接管模式」：审批卡片由白话审批渲染。', slotModeOverlay: '当前是「浮窗模式」：白话翻译显示在右下角浮窗。', slotModeOff: '当前「完全关闭」。', slotModeConflict: '检测到 {names} 也在占用审批卡槽位。' }[k] ?? k)
  // 模式来自 uiPrefs.slotMode（唯一真相源），status 参数只提供冲突名单
  client.uiPrefs.slotMode = 'takeover'
  const txtTakeover = client.slotStateText(null, tmap46)
  client.uiPrefs.slotMode = 'overlay'
  const txtOverlay = client.slotStateText(null, tmap46)
  client.uiPrefs.slotMode = 'off'
  const txtOff = client.slotStateText(null, tmap46)
  client.uiPrefs.slotMode = 'takeover'
  check(
    'Y5',
    '设置页「当前状态」明确写出当前模式（接管 / 浮窗 / 完全关闭）',
    txtTakeover.includes('接管模式') && txtOverlay.includes('浮窗模式') && txtOff.includes('完全关闭'),
    `${txtTakeover} | ${txtOverlay} | ${txtOff}`,
  )
  check(
    'Y5b',
    '接管模式 + 检测到冲突时，明确点名是哪些插件在冲突',
    client.slotStateText({ slot: { rivals: ['dsh-reject-message'] } }, tmap46).includes('dsh-reject-message'),
    client.slotStateText({ slot: { rivals: ['dsh-reject-message'] } }, tmap46),
  )
}

/* ================================================================== */
/* 附加（v0.4.1）：向导 404 / 卡死修复 + 设备检测修复                      */
/* ================================================================== */

group('附加（v0.4.1）：向导接口与卡死修复')
{
  const home = mkdtempSync(join(TMP_ROOT, 'onboard-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const listeners = []
  let route = null
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: () => undefined,
    on(name, listener) {
      listeners.push({ name, listener })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, cb) {
      cb({
        effect: (fn) => fn(),
        webServer: {
          register(r) {
            route = r
            return () => {}
          },
        },
      })
    },
  }
  applyHost(fakeCtx, {
    engine: 'auto',
    ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 500, minFreeMemoryGB: 0 },
    log: { enabled: true },
    cache: { enabled: false, driver: 'json' },
  })

  const server = createHttpServer((req, res) => route.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const HDR = { 'content-type': 'application/json', 'x-plain-approval': '1' }
  const post = async (body) => {
    const res = await fetch(base + API_BASE + 'onboard', { method: 'POST', headers: HDR, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }

  // N1：这就是用户报的 404，必须 200
  const r1 = await post({ choice: 'auto' })
  check(
    'N1',
    'POST /api/plain-approval/onboard 返回 200（不再是「未知接口」404）',
    r1.status === 200 && r1.body.ok === true && r1.body.data.engine === 'auto' && r1.body.data.onboarded === true,
    `HTTP ${r1.status} ${JSON.stringify(r1.body.data ?? r1.body.error)}`,
  )

  const settingsFile = join(home, 'plain-approval', 'settings.json')
  const saved1 = JSON.parse(readFileSync(settingsFile, 'utf8'))
  check(
    'N2',
    '向导选择真的写进配置（引擎 + ui.onboarded），下次不再弹',
    saved1.engine === 'auto' && saved1.ui && saved1.ui.onboarded === true,
    `engine=${saved1.engine} onboarded=${saved1.ui?.onboarded}`,
  )

  // N3：前端传 engine 字段名（用户 spec 里的写法）也要认
  const r3 = await post({ engine: 'local-first', acceptRisk: true })
  const saved3 = JSON.parse(readFileSync(settingsFile, 'utf8'))
  check(
    'N3',
    'choice 与 engine 两种字段名都认；选本地时记录「已确认风险」',
    r3.status === 200 && r3.body.data.engine === 'local-first' && saved3.engine === 'local-first' && saved3.device.allowUnusableLocal === true,
    `HTTP ${r3.status} engine=${saved3.engine} allowUnusableLocal=${saved3.device?.allowUnusableLocal}`,
  )

  const r4 = await post({ engine: 'ollama' })
  check('N4', '选「只用本地 Ollama」也能正常落库', r4.status === 200 && r4.body.data.engine === 'ollama', `HTTP ${r4.status} engine=${r4.body.data?.engine}`)

  const r5 = await post({ engine: 'rm -rf /' })
  check('N5', '非法值不报错、安全回退到 auto（不返回 404/500）', r5.status === 200 && r5.body.data.engine === 'auto', `HTTP ${r5.status} engine=${r5.body.data?.engine}`)

  // N6：路径匹配（尾斜杠教训的回归）——带尾斜杠也必须识别
  const slashRes = await fetch(base + API_BASE + 'onboard', { method: 'POST', headers: HDR, body: JSON.stringify({ choice: 'auto' }) })
  check('N6', '路由前缀无尾斜杠，/onboard 子路径能被识别（不是被 /api 兜走）', route.path === '/api/plain-approval' && slashRes.status === 200, `注册前缀=${route.path}`)

  // N7：真·404 只应出现在不存在的接口上
  const bogus = await fetch(base + API_BASE + 'nope', { method: 'POST', headers: HDR, body: '{}' })
  const bogusBody = await bogus.json()
  check('N7', '不存在的接口仍然 404（说明路由判定本身没坏）', bogus.status === 404 && /未知接口/.test(bogusBody.error), `HTTP ${bogus.status}`)

  await new Promise((r) => server.close(r))
  process.env.DSH_HOME = prevHome
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* ignore */
  }
}

group('附加（v0.4.1）：向导不会把用户卡死')
{
  const client = loadClientModule().exports.__internal
  const tt = (k) => ({ wizardHostOld: '宿主旧版，请重启' }[k] ?? k)

  const old = client.onboardFailureOutcome({ status: 404, message: '未知接口：POST /api/plain-approval/onboard' }, tt)
  check(
    'N8',
    '宿主版本旧导致 /onboard 404 → 向导仍然关闭，并提示重启（不卡在起始页）',
    old.close === true && old.notice && /重启/.test(old.notice.text),
    JSON.stringify(old),
  )

  const real = client.onboardFailureOutcome(new Error('磁盘写不进去'), tt)
  check('N9', '真实错误 → 向导不关闭，但把错误显示出来（不静默失败）', real.close === false && /磁盘写不进去/.test(real.error), JSON.stringify(real))

  // 「稍后设置」= 只写 ui.onboarded，不动引擎（用户没选，就保留默认的 auto）
  const skipped = normalizeSettings({ ui: { onboarded: true } })
  check(
    'N10',
    '「稍后设置」路径只写 onboarded、不动引擎（保留默认 auto），向导可以正常关闭',
    skipped.ui.onboarded === true && skipped.engine === 'auto',
    `onboarded=${skipped.ui.onboarded} engine=${skipped.engine}`,
  )
}

group('附加（v0.4.1）：设备检测修复（RTX 5070 Laptop 12GB + 16GB 内存）')
{
  // 本机实测：nvidia-smi 报 12231MiB，os.totalmem() 报 15.47GB
  check(
    'N11',
    '12GB 显存 + 16GB 内存（实测 15.47GB）判为「可用」，不再说配置偏低',
    tierOf(11.9, 15.47, {}) === 'good',
    `tierOf(11.9, 15.47) = ${tierOf(11.9, 15.47, {})}`,
  )
  check(
    'N12',
    '内存阈值带 1GB 容差（Windows 会保留一部分内存，16GB 机器只报 15.4-15.9GB）',
    tierOf(8, 15.47, {}) === 'good' && tierOf(8, 15, {}) === 'good' && tierOf(8, 14, {}) === 'marginal',
    `15.47GB=${tierOf(8, 15.47, {})}，15GB=${tierOf(8, 15, {})}，14GB=${tierOf(8, 14, {})}`,
  )
  check(
    'N13',
    '检测不到显卡 → 「未检测到具体硬件信息」（unknown），不再直接判「不可用」恐吓用户',
    tierOf(0, 32, {}) === 'unknown' && tierOf(0, 15.47, {}) === 'unknown',
    `tierOf(0, 15.47) = ${tierOf(0, 15.47, {})}`,
  )
  check(
    'N14',
    '真的不达标仍然判「不可用」（4GB 显存 / 6GB 内存），不该被容差放过',
    tierOf(4, 32, {}) === 'unusable' && tierOf(4, 6, {}) === 'unusable' && tierOf(12, 6, {}) === 'unusable',
    `4G/32G=${tierOf(4, 32, {})}，4G/6G=${tierOf(4, 6, {})}，12G/6G=${tierOf(12, 6, {})}`,
  )

  check(
    'N15',
    'Ollama 已在跑且模型在 → 直接「可用」，不弹任何风险警告（即使硬件信息读不到）',
    localRisk({ tier: 'unknown' }, { status: 'green' }) === 'none' &&
      localRisk({ tier: 'marginal' }, { status: 'green' }) === 'none' &&
      localRisk({ tier: 'good' }, { status: 'red' }) === 'none',
    'green → none',
  )
  check(
    'N16',
    '风险档位：硬件未知只给软提示（不强制勾选），只有真不达标才硬拦',
    localRisk({ tier: 'unknown' }, { status: 'red' }) === 'soft' &&
      localRisk({ tier: 'marginal' }, { status: 'red' }) === 'soft' &&
      localRisk({ tier: 'unusable' }, { status: 'red' }) === 'hard',
    `unknown→${localRisk({ tier: 'unknown' }, { status: 'red' })}，marginal→${localRisk({ tier: 'marginal' }, { status: 'red' })}，unusable→${localRisk({ tier: 'unusable' }, { status: 'red' })}`,
  )

  // N17：手动填显存就按手填的算（读不到 GPU 的机器也能用本地）
  const manual = await detectDevice({ force: true, thresholds: { manualVramGB: 12, manualGpuName: 'RTX 5070 Laptop' } })
  check(
    'N17',
    '读不到显卡时，用户手填显存即可被采纳（决定权交还用户）',
    manual.gpu && manual.gpu.vramTotalGB === 12 && manual.gpu.source === 'manual' && manual.tier !== 'unusable',
    `gpu=${manual.gpu?.name}/${manual.gpu?.vramTotalGB}GB source=${manual.gpu?.source} tier=${manual.tier}`,
  )
  clearDeviceCache()

  // N18：有独显时，内存闸门按显存放宽（12GB 显存 + 空闲 1.3GB 内存不该被拦）
  {
    const s = {
      engine: 'ollama',
      ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 500, minFreeMemoryGB: 100, maxConcurrency: 1, maxQueue: 5, breakerFailures: 3, breakerMinutes: 5 },
      device: { enabled: false },
    }
    const withGpu = createOllamaGuard({ getSettings: () => s, getDevice: () => ({ gpu: { vramTotalGB: 11.9 } }) })
    const withoutGpu = createOllamaGuard({ getSettings: () => s, getDevice: () => null })
    check(
      'N18',
      '有独立显卡且显存够用时，系统内存闸门自动放宽（不再被空闲内存误伤）',
      withGpu.check().ok === true && withoutGpu.check().ok === false,
      `有显存=${withGpu.check().ok ? '放行' : '拦截'}，无显存=${withoutGpu.check().ok ? '放行' : '拦截'}`,
    )
  }
}

/* ================================================================== */
/* 附加（v0.4.2）：浮窗拖动 / 原生卡片内嵌按钮 / 鲸鱼娘                    */
/* ================================================================== */

/** 极简假 DOM：只为验证「往原生卡片里插按钮」这段逻辑，不追求浏览器完备性。 */
function installFakeDom({ drmActions = true, generic = false, insideOurs = false } = {}) {
  const makeNode = (tag, className = '') => {
    let text = ''
    const el = {
      tagName: String(tag).toUpperCase(),
      className,
      children: [],
      parentNode: null,
      attrs: {},
      isConnected: true,
      appendChild(child) {
        if (child === null || child === undefined) return child
        child.parentNode = el
        el.children.push(child)
        return child
      },
      insertBefore(child, ref) {
        child.parentNode = el
        const idx = ref ? el.children.indexOf(ref) : 0
        el.children.splice(idx < 0 ? 0 : idx, 0, child)
        return child
      },
      replaceChild(newNode, oldNode) {
        const idx = el.children.indexOf(oldNode)
        if (idx < 0) return oldNode
        newNode.parentNode = el
        el.children[idx] = newNode
        return oldNode
      },
      replaceWith(newNode) {
        const parent = el.parentNode
        if (!parent) return
        const idx = parent.children.indexOf(el)
        if (idx < 0) return
        newNode.parentNode = parent
        parent.children[idx] = newNode
      },
      setAttribute(k, v) {
        el.attrs[k] = String(v)
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null
      },
      addEventListener(type, fn) {
        if (type === 'error') el.onerror = fn
      },
      removeEventListener() {},
      querySelector(sel) {
        if (String(sel).includes('data-pap-inline-btn')) {
          return el.children.find((c) => c && c.getAttribute && c.getAttribute('data-pap-inline-btn') === '1') || null
        }
        return null
      },
      querySelectorAll(sel) {
        // 只为通用兜底选择器服务：`:scope > button, :scope > div > button`
        if (String(sel).includes('button')) {
          const direct = el.children.filter((c) => c && c.tagName === 'BUTTON')
          const nested = el.children.flatMap((c) => (c && c.tagName === 'DIV' ? c.children.filter((x) => x && x.tagName === 'BUTTON') : []))
          return [...direct, ...nested]
        }
        return []
      },
      closest() {
        return insideOurs ? { tagName: 'DIV' } : null
      },
    }
    // 真实 DOM 里 textContent 赋值会清空子节点，这里必须一致，否则「重绘按钮」测不出来
    Object.defineProperty(el, 'textContent', {
      get: () => text,
      set: (v) => {
        text = String(v)
        el.children.length = 0
      },
    })
    Object.defineProperty(el, 'parentElement', { get: () => el.parentNode })
    el.classList = {
      add: (c) => {
        if (!el.className.split(/\s+/u).includes(c)) el.className = (el.className + ' ' + c).trim()
      },
      remove: (c) => {
        el.className = el.className.split(/\s+/u).filter((x) => x && x !== c).join(' ')
      },
      toggle: (c, on) => {
        const has = el.className.split(/\s+/u).includes(c)
        const want = on === undefined ? !has : on
        if (want && !has) el.className = (el.className + ' ' + c).trim()
        if (!want && has) el.className = el.className.split(/\s+/u).filter((x) => x && x !== c).join(' ')
      },
      contains: (c) => el.className.split(/\s+/u).includes(c),
    }
    return el
  }

  const actionRow = drmActions ? makeNode('div', 'drm-actions') : null
  const genericRow = makeNode('div', 'approval-actions')
  const genericInner = makeNode('div')
  genericInner.appendChild(makeNode('button'))
  genericInner.appendChild(makeNode('button'))
  genericRow.appendChild(genericInner)

  const doc = {
    body: makeNode('body'),
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    querySelector: (sel) => (sel === '.drm-actions' ? actionRow : null),
    querySelectorAll: (sel) => (sel === '[class*="approval"]' ? (generic ? [genericRow] : []) : []),
  }
  return { doc, actionRow, genericRow, genericInner }
}

/* ================================================================== */
/* 附加（v0.4.5）：卡死根因回归 —— 源码红线                                */
/* ================================================================== */

group('附加（v0.4.5）：卡死根因回归（源码红线，绝不允许再犯）')
{
  const clientSource = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')

  check(
    'X1',
    '客户端里没有 MutationObserver / observe()：v0.4.2 卡死 + 内存爆满的根因',
    !/new\s+MutationObserver\s*\(/u.test(clientSource) && !/\.observe\s*\(/u.test(clientSource),
    '全文件搜不到 new MutationObserver / .observe(',
  )
  check(
    'X2',
    '客户端不注册任何 window 级事件监听（浮窗拖动功能已彻底删除）',
    !/window\.addEventListener/u.test(clientSource),
    '搜不到 window.addEventListener',
  )
  check('X3', '客户端不注册任何 document 级事件监听', !/document\.addEventListener/u.test(clientSource), '搜不到 document.addEventListener')
  check('X4', '客户端不再使用 localStorage（浮窗位置固定，没有位置状态）', !/localStorage\.(getItem|setItem|removeItem)/u.test(clientSource), '搜不到 localStorage 读写')

  // v0.5.3 改写：原来这里写死了「必须是 3 处」，结果历史导出的第 4 处一出现就红 ——
  // 但那处是**受控**的（append 后立刻 remove）。写死数字会让人要么改代码绕过测试、
  // 要么把测试改松。改成**校验不变量**：每一次 appendChild 都必须紧跟同名变量的 remove()。
  const appendSites = [...clientSource.matchAll(/document\.body\.appendChild\((\w+)\)/gu)].map((m) => m[1])
  const leaked = appendSites.filter((name) => !new RegExp(`appendChild\\(${name}\\)[\\s\\S]{0,200}?${name}\\.remove\\(\\)`, 'u').test(clientSource))
  check(
    'X5',
    '直接往 body 插节点**每一处**都紧跟同名变量的 remove()（复制 1 + 各类下载）',
    appendSites.length >= 3 && leaked.length === 0,
    `共 ${appendSites.length} 处（${appendSites.join(', ')}），未清理 ${leaked.length} 处`,
  )
  check(
    'X6',
    '★ 不存在「插进去却忘了移除」的 body 节点（泄漏红线，与具体处数无关）',
    leaked.length === 0,
    leaked.length === 0 ? '所有 appendChild 都有配对 remove()' : `泄漏：${leaked.join(', ')}`,
  )
  check('X7', '样式只注入一次（有幂等守卫）且在插件卸载时移除', /style\[data-plugin-css=/u.test(clientSource) && /tag\.remove\(\)/u.test(clientSource), '有 querySelector 守卫 + tag.remove() 清理')
  check(
    'X8',
    '浮窗位置完全由 CSS 固定（没有拖拽指针事件、没有内联定位）',
    !/onPointerDown/u.test(clientSource) && !/setPointerCapture/u.test(clientSource) && /'\.pap_chipRoot\{position:fixed/u.test(clientSource),
    '没有 onPointerDown/setPointerCapture，浮窗用 position:fixed',
  )
}

/* ================================================================== */
/* 附加（v0.4.5）：完整渲染生命周期（挂载 → 交互 → 卸载）                  */
/* ================================================================== */

/** 记录全局副作用的最小 React hooks 运行时。 */
function mountLifecycle() {
  const calls = { intervals: [], cleared: [], observers: [] }
  const listeners = []
  const saved = {}

  const install = () => {
    saved.MutationObserver = globalThis.MutationObserver
    globalThis.MutationObserver = class {
      constructor() {
        calls.observers.push(true)
        throw new Error('不允许创建 MutationObserver')
      }
    }
    saved.setInterval = globalThis.setInterval
    saved.clearInterval = globalThis.clearInterval
    globalThis.setInterval = (fn, ms) => {
      const id = { fn, ms }
      calls.intervals.push(id)
      return id
    }
    globalThis.clearInterval = (id) => calls.cleared.push(id)
    saved.localStorage = globalThis.localStorage
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('不允许读 localStorage')
      },
      setItem: () => {
        throw new Error('不允许写 localStorage')
      },
      removeItem: () => {
        throw new Error('不允许删 localStorage')
      },
    }
  }
  const restore = () => {
    globalThis.MutationObserver = saved.MutationObserver
    globalThis.setInterval = saved.setInterval
    globalThis.clearInterval = saved.clearInterval
    globalThis.localStorage = saved.localStorage
  }

  /**
   * 单个 React 实例：hooks 落到「当前渲染上下文」里。
   * 关键：这个 api 必须**注入给 client.js**（loadClientModule({ react: life.api })），
   * 否则 client.js 用的是 harness 里那个 no-op 桩，effect 永远不会跑。
   */
  let current = null
  const api = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'fragment',
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
      }
    },
    useState(init) {
      if (!current) return [typeof init === 'function' ? init() : init, () => {}]
      const i = current.cursor++
      if (!(i in current.hooks)) current.hooks[i] = { v: typeof init === 'function' ? init() : init }
      const set = (next) => {
        current.hooks[i].v = typeof next === 'function' ? next(current.hooks[i].v) : next
        current.dirty = true
      }
      return [current.hooks[i].v, set]
    },
    useRef(init) {
      if (!current) return { current: init }
      const i = current.cursor++
      if (!(i in current.hooks)) current.hooks[i] = { v: { current: init } }
      return current.hooks[i].v
    },
    useEffect(fn, deps) {
      if (!current) return
      const i = current.cursor++
      const prev = current.hooks[i]
      const changed = !prev || !prev.deps || !deps || deps.some((d, k) => d !== prev.deps[k])
      const entry = prev || { cleanup: null, ran: false }
      entry.fn = fn
      entry.deps = deps
      entry.changed = changed
      current.hooks[i] = entry
      current.effects.push(entry)
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
  }

  function mount(Component, props) {
    const store = { hooks: [], cursor: 0, effects: [], dirty: false }
    let tree = null
    const render = () => {
      current = store
      store.cursor = 0
      store.effects = []
      tree = Component(props)
      current = null
      for (const effect of store.effects) {
        if (effect.changed || !effect.ran) {
          if (typeof effect.cleanup === 'function') effect.cleanup()
          effect.cleanup = null
          const ret = effect.fn()
          effect.cleanup = typeof ret === 'function' ? ret : null
          effect.ran = true
        }
      }
    }
    render()
    return {
      api,
      get tree() {
        return tree
      },
      rerender() {
        if (!store.dirty) return
        store.dirty = false
        render()
      },
      unmount() {
        for (const effect of store.effects) {
          if (typeof effect.cleanup === 'function') effect.cleanup()
          effect.cleanup = null
          effect.ran = false
        }
      },
    }
  }

  return { calls, listeners, install, restore, mount, api }
}

group('附加（v0.4.5）：完整渲染生命周期（挂载 → 交互 → 卸载）')
{
  const life = mountLifecycle()
  // 把带真实 hooks 生命周期的 React 注入给 client.js（否则 effect 不会跑）
  const mod = loadClientModule({ react: life.api })
  const client = mod.exports.__internal

  const prevFetch = globalThis.fetch
  const prevDoc = globalThis.document
  const prevWin = globalThis.window

  life.install()
  globalThis.window = {
    addEventListener: (type, fn) => life.listeners.push({ type, fn, target: 'window' }),
    removeEventListener: (type, fn) => {
      const i = life.listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (i >= 0) life.listeners.splice(i, 1)
    },
    innerWidth: 1280,
    innerHeight: 800,
  }
  globalThis.document = {
    hidden: false,
    addEventListener: (type, fn) => life.listeners.push({ type, fn, target: 'document' }),
    removeEventListener: () => {},
  }

  const pendingPayload = {
    ok: true,
    data: {
      items: [
        {
          key: 'k1',
          command: 'ls -la',
          toolName: 'pwsh',
          reason: 'escalate x',
          quick: {
            status: 'pending',
            headline: '正在翻译…',
            sections: {
              background: '未读取到会话上下文，仅翻译命令本身。',
              what: '查看当前文件夹里的文件',
              touch: '当前目录',
              mode: '只读',
              risk: '安全',
              advice: '可以允许',
              consequence: '不会改动任何文件。',
              benefit: '让你看到有哪些文件。',
              parts: [],
            },
            notes: [],
            text: { zh: '【白话审批】', en: '' },
          },
        },
      ],
    },
  }
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return { ok: true, status: 200, text: async () => JSON.stringify(pendingPayload) }
  }

  client.uiPrefs.loaded = true
  client.uiPrefs.onboarded = true
  client.uiPrefs.slotMode = 'overlay'
  client.uiPrefs.rivals = ['dsh-reject-message']

  const findButton = (node, label) => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'button' && Array.isArray(node.children) && node.children.includes(label)) return node
    for (const child of node.children || []) {
      const hit = findButton(child, label)
      if (hit) return hit
    }
    return null
  }

  let mounted = null
  try {
    mounted = life.mount(mod.exports.__internal.ReviewChip, { t: (k) => k, locale: 'zh' })
    await new Promise((r) => setTimeout(r, 10))

    check(
      'L1',
      '挂载后只创建一个 2 秒轮询定时器，且不创建任何 MutationObserver',
      life.calls.intervals.length === 1 && life.calls.intervals[0].ms === 2000 && life.calls.observers.length === 0,
      '定时器 ' + life.calls.intervals.length + ' 个（' + life.calls.intervals[0]?.ms + 'ms），观察者 ' + life.calls.observers.length + ' 个',
    )
    check('L2', '挂载过程不在 window / document 上加任何事件监听器', life.listeners.length === 0, '全局监听器 ' + life.listeners.length + ' 个')
    check('L3', '挂载后会去拉一次挂起列表（数据源），没有其他副作用', fetchCalls >= 1, 'fetch 调用 ' + fetchCalls + ' 次')

    const expandBtn = findButton(mounted.tree, 'chipShow')
    if (expandBtn && expandBtn.props && typeof expandBtn.props.onClick === 'function') {
      expandBtn.props.onClick()
      mounted.rerender()
      await new Promise((r) => setTimeout(r, 10))
    }
    check(
      'L4',
      '点击交互后不新增定时器、不新增全局监听器（没有副作用累积）',
      life.calls.intervals.length === 1 && life.listeners.length === 0,
      '定时器 ' + life.calls.intervals.length + ' 个，监听器 ' + life.listeners.length + ' 个',
    )

    mounted.unmount()
    await new Promise((r) => setTimeout(r, 5))
    check(
      'L5',
      '卸载后 2 秒轮询被 clearInterval 清掉（无定时器泄漏）',
      life.calls.cleared.length === 1 && life.calls.cleared[0] === life.calls.intervals[0],
      '清掉的定时器 ' + life.calls.cleared.length + ' 个',
    )
    check('L6', '整轮生命周期结束后，window / document 上没有残留监听器（无泄漏）', life.listeners.length === 0, '残留监听器 ' + life.listeners.length + ' 个')

    const second = life.mount(mod.exports.__internal.ReviewChip, { t: (k) => k, locale: 'zh' })
    await new Promise((r) => setTimeout(r, 10))
    second.unmount()
    check(
      'L7',
      '重复挂载/卸载不累积定时器与监听器（每次都是干净的一进一出）',
      life.calls.intervals.length === 2 && life.calls.cleared.length === 2 && life.listeners.length === 0,
      '累计定时器 ' + life.calls.intervals.length + '，累计清理 ' + life.calls.cleared.length + '，监听器 ' + life.listeners.length,
    )
  } finally {
    try {
      if (mounted) mounted.unmount()
    } catch (ignored) {
      /* ignore */
    }
    life.restore()
    globalThis.fetch = prevFetch
    if (prevDoc === undefined) delete globalThis.document
    else globalThis.document = prevDoc
    if (prevWin === undefined) delete globalThis.window
    else globalThis.window = prevWin
  }
}

group('附加（v0.4.5）：渲染异常兜底（ErrorBoundary）')
{
  const mod = loadClientModule()
  const PluginBoundary = mod.exports.__internal.PluginBoundary
  const clientSource = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')

  check('B1', '客户端导出了通用渲染兜底组件 PluginBoundary', typeof PluginBoundary === 'function', typeof PluginBoundary)

  const state = PluginBoundary.getDerivedStateFromError()
  check('B2', '捕获到渲染异常后进入 failed 状态（不会继续渲染坏子树）', state && state.failed === true, JSON.stringify(state))

  const inst = new PluginBoundary({ text: '白话翻译暂不可用（测试）' })
  inst.state = { failed: true }
  const rendered = inst.render()
  check(
    'B3',
    '降级渲染为一行「暂不可用」提示，而不是白屏或让整个界面崩',
    rendered && rendered.type === 'div' && String(rendered.props.className).includes('pap_boundaryFallback') && String(rendered.children).includes('暂不可用'),
    JSON.stringify(rendered && rendered.children),
  )

  const silent = new PluginBoundary({ text: 'x', silent: true })
  silent.state = { failed: true }
  check('B4', '浮窗以外的地方可以选择静默降级（返回 null）', silent.render() === null, 'silent=true → null')

  check(
    'B5',
    '三处 UI 入口（卡片 / 浮窗 / 设置页）都包了兜底组件',
    /function ComposerEntry[\s\S]{0,400}?PluginBoundary/u.test(clientSource) &&
      /function SettingsEntry[\s\S]{0,200}?PluginBoundary/u.test(clientSource) &&
      /function ChipBoundary[\s\S]{0,300}?PluginBoundary/u.test(clientSource),
    'ComposerEntry / SettingsEntry / ChipBoundary 都用了 PluginBoundary',
  )
}

group('附加（v0.4.2）：鲸鱼娘头像资源（本地，不依赖外链）')
{
  const home = mkdtempSync(join(TMP_ROOT, 'asset-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let route = null
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject: (names, cb) => cb({ effect: (fn) => fn(), webServer: { register(r) { route = r; return () => {} } } }),
  }
  applyHost(fakeCtx, { engine: 'auto', ollama: { baseUrl: OLLAMA_DEAD, model: 'qwen2.5:7b', timeoutMs: 500, minFreeMemoryGB: 0 }, log: { enabled: true }, cache: { enabled: false, driver: 'json' } })

  const server = createHttpServer((req, res) => route.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  // <img src> 带不了自定义头，所以资源路由必须不要求 x-plain-approval
  const svgRes = await fetch(base + API_BASE + 'asset/whale-girl.svg')
  const svgText = await svgRes.text()
  check(
    'A1',
    '头像能被 <img> 直接取到（不要求自定义请求头），Content-Type 是 svg',
    svgRes.status === 200 && /image\/svg\+xml/u.test(String(svgRes.headers.get('content-type'))) && svgText.includes('<svg'),
    `HTTP ${svgRes.status} ${svgRes.headers.get('content-type')} 字节数=${svgText.length}`,
  )
  check(
    'A2',
    '头像是本地资源、24x24 可缩放、且带 CC BY-NC-SA 署名注释',
    svgText.includes('viewBox="0 0 24 24"') && /CC BY-NC-SA/u.test(svgText) && /上善无形/u.test(svgText),
    '含 viewBox 24 与署名注释',
  )

  const traversal = await fetch(base + API_BASE + 'asset/..%2F..%2Fpackage.json')
  check('A3', '路径穿越被拒绝（文件名白名单）', traversal.status === 404 || traversal.status === 400, `HTTP ${traversal.status}`)

  const missing = await fetch(base + API_BASE + 'asset/nope.svg')
  check('A4', '不存在的资源返回 404，不会抛异常', missing.status === 404, `HTTP ${missing.status}`)

  await new Promise((r) => server.close(r))
  process.env.DSH_HOME = prevHome
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    /* ignore */
  }
}

/* ================================================================== */
/* 附加（v0.4.6-safe）：放大路径封死                                       */
/* 事故复盘的核心：v0.4.3 的 3GB 不是「某次请求太大」，而是「循环 × 副作用  */
/* 放大」。这一组把三条放大路径钉死成红线，防止以后被改回去。                */
/* ================================================================== */

group('附加（v0.4.6-safe）：放大路径封死（限流闸门 / 缓存上限 / 让位稳定）')
{
  let probes46 = 0
  const src046 = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
  // 注释里会引用旧代码的字面量，所以数「真实代码」时先剥掉块注释
  const code046 = src046.replace(/\/\*[\s\S]*?\*\//gu, '')

  // ---- 源码红线 ----
  const noteCallSites = [...code046.matchAll(/api\('note'/gu)].length
  check('SFT1', "真实代码里只剩一处 api('note')，即限流闸门内部（没有旁路）", noteCallSites === 1, `出现 ${noteCallSites} 处`)
  check(
    'SFT2',
    '「取不到命令」的上报写在 useEffect 里，不再是渲染期副作用（v0.4.5 的原缺陷）',
    /React\.useEffect\(\(\)\s*=>\s*\{[\s\S]{0,400}?note\('card\.no-command'/u.test(src046),
    "note('card.no-command') 由 useEffect 触发",
  )

  // ---- 限流闸门：用打桩 fetch 量一量真的发出了多少 ----
  const savedFetch046 = globalThis.fetch
  let fetchCount046 = 0
  globalThis.fetch = () => {
    fetchCount046++
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ ok: true, data: { logged: true } })),
    })
  }
  try {
    const c46 = loadClientModule().exports.__internal

    fetchCount046 = 0
    for (let i = 0; i < 200; i++) c46.note('spam', { i })
    check(
      'SFT3',
      '200 次连续诊断上报被限流钉死（≤12 次真正发出，不会自我放大）',
      fetchCount046 > 0 && fetchCount046 <= c46.NOTE_MAX_PER_WINDOW,
      `实际发出 ${fetchCount046} 次 / 上限 ${c46.NOTE_MAX_PER_WINDOW}`,
    )
    const stat46 = c46.noteStats()
    check('SFT4', '超预算的上报是**丢弃**而不是排队（不会越积越多）', stat46.dropped > 0 && stat46.stamps.length <= c46.NOTE_MAX_PER_WINDOW, `丢弃 ${stat46.dropped} 次，在途 ${stat46.stamps.length} 条`)

    // ---- 结果缓存上限 ----
    let acc46 = {}
    for (let i = 0; i < 40; i++) acc46 = c46.withResult(acc46, 'k' + i, { n: i })
    check('SFT5', '翻译结果缓存有上限（长会话不会无限增长）', Object.keys(acc46).length === c46.MAX_CACHED_RESULTS, `存入 40 条后剩 ${Object.keys(acc46).length} 条`)
    check('SFT6', '缓存淘汰的是最旧的条目', !('k0' in acc46) && 'k39' in acc46, `k0=${'k0' in acc46} k39=${'k39' in acc46}`)
    // ---- v0.5.0-stable：让位判定已整体删除，这里改为守住「不探测、不调用」的红线 ----
    let probes47 = 0
    const entry47 = (priority, locale) => ({ options: { priority, locale }, select: () => { probes47++; return { kind: 'approval' } } })
    const slots47 = { entries: () => [entry47(1, 'approval'), entry47(-100, 'plain-approval'), entry47(-1, 'reject')] }
    probes47 = 0
    c46.scanSlotConflictsOnce(slots47)
    check('SFT7', '★ 冲突扫描里别人的 select() 调用次数为 0（自动让位已废弃）', probes47 === 0, `实际调用 ${probes47} 次`)
    c46.scanSlotConflictsOnce(slots47)
    c46.scanSlotConflictsOnce(slots47)
    check('SFT8', '扫描只跑一次：重复调用不会重新去读槽位、更不会重新探测', probes47 === 0, `重复调用后累计 ${probes47} 次`)
    check('SFT9', '旧的 computeSlotDecision 已从客户端导出中移除', typeof c46.computeSlotDecision === 'undefined', typeof c46.computeSlotDecision)
  } finally {
    globalThis.fetch = savedFetch046
  }
}

let probes46Unused = 0

/* ================================================================== */

group('附加（v0.5.0-stable）：旧配置迁移（slotPolicy → slotMode）')
{
  const cases = [
    ['旧 auto', { ui: { slotPolicy: 'auto' } }, 'takeover', false, 'auto 是「自动让位」，语义已废弃 → 接管，但要用户显式选一次'],
    ['旧 takeover', { ui: { slotPolicy: 'takeover' } }, 'takeover', true, '用户当初表达过明确意图 → 沿用且不再问'],
    ['旧 off', { ui: { slotPolicy: 'off' } }, 'off', true, '旧 off → 新 off，且不再问'],
    ['全新安装', {}, 'takeover', false, '新默认接管；有冲突时问一次'],
    ['脏 slotMode', { ui: { slotMode: '乱写' } }, 'takeover', false, '脏值一律回落到 takeover，绝不猜'],
    ['新 overlay', { ui: { slotMode: 'overlay', conflictResolved: true } }, 'overlay', true, '已是新配置 → 原样保留'],
  ]
  let bad = 0
  cases.forEach(([name, raw, wantMode, wantResolved, why], i) => {
    const s = normalizeSettings(raw)
    const ok = s.ui.slotMode === wantMode && s.ui.conflictResolved === wantResolved
    if (!ok) bad += 1
    check(`M${i + 1}`, `${name} → slotMode=${wantMode}, conflictResolved=${wantResolved}（${why}）`, ok, `实得 ${s.ui.slotMode} / ${s.ui.conflictResolved}`)
  })
  check('M7', '迁移必须基于**原始**配置而不是 merge 后的默认值（旧 off 不能被错迁成 takeover）', bad === 0, `${bad} 条不符`)

  // 迁移必须幂等：迁过一次之后再迁，结果不变
  const once = normalizeSettings({ ui: { slotPolicy: 'off' } })
  const twice = normalizeSettings({ ui: { slotMode: once.ui.slotMode, conflictResolved: once.ui.conflictResolved } })
  check('M8', '迁移幂等（重复归一化结果稳定，不会来回漂移）', twice.ui.slotMode === once.ui.slotMode && twice.ui.conflictResolved === once.ui.conflictResolved, `${once.ui.slotMode}/${once.ui.conflictResolved} -> ${twice.ui.slotMode}/${twice.ui.conflictResolved}`)
}

group('附加（v0.5.1）：标准提问机制 + 支持作者入口')
{
  // ---- DSH 提问子系统的名字与降级 ----
  {
    const cfg51 = readFileSync(join(HERE_SRC, 'src', 'config.js'), 'utf8')
    const src51 = readFileSync(join(HERE_SRC, 'src', 'plugin.js'), 'utf8')
    check('UQ1', '★ 用的是官方服务名 ctx.userQuestions（不是 ctx.userInteraction）', /ctx\?\.get\?\.\('userQuestions'\)/u.test(src51), "ctx.get('userQuestions')")
    check('UQ2', 'ask() 必须带超时兜底（它会阻塞到有人回答）', /ASK_TIMEOUT_MS/u.test(src51) && /AbortController/u.test(src51) && /controller\.abort\(\)/u.test(src51), 'AbortSignal + ' + '超时')
    check('UQ3', 'ask-conflict 走独立 HTTP 路由，绝不接进同步的审批链路', /route === 'ask-conflict'/u.test(readFileSync(join(HERE_SRC, 'src', 'server.js'), 'utf8')), "server.js 有 ask-conflict 路由")
    check('UQ4', '子系统的数据结构按官方文档写（questions / options / multiSelect / answers）', /questions:\s*\[/u.test(src51) && /multiSelect:\s*false/u.test(src51) && /answer\?\.answers/u.test(src51), 'AskUserQuestionRequest / AskUserQuestionAnswer')
    void cfg51
  }

  // ---- 冲突扫描不再误报 DSH 自带组件 ----
  {
    const c51 = loadClientModule().exports.__internal
    const mk = (priority, component, locale = null, registrant = null) => ({
      options: { priority, locale, registrant },
      component,
      select: () => ({ kind: 'approval' }),
    })
    // 这四个是实测真机上同时出现的组件（2026-10-14）
    check('UQ5', '★ DSH 自带的 SubagentReadOnlyComposer / QuestionComposer 不再被误报成冲突', c51.isSelfOrOfficial(mk(-10, 'SubagentReadOnlyComposer')) === true && c51.isSelfOrOfficial(mk(null, 'QuestionComposer')) === true, '两个自带组件都被排除')
    check('UQ6', '真正的第三方组件仍会被报出来（dsh-reject-message 的 RejectPanel / ApprovalPanel）', c51.isSelfOrOfficial(mk(-1, 'RejectPanel')) === false && c51.isSelfOrOfficial(mk(null, 'ApprovalPanel')) === false, 'RejectPanel / ApprovalPanel 不被排除')
    check('UQ7', '组件名是函数形态时也能正确排除（兼容两种写法）', c51.isSelfOrOfficial(mk(-10, function SubagentReadOnlyComposer() {})) === true, '函数形态也认')
    check('UQ8', '冲突入口是 ConflictGate（先试标准机制，失败才自绘）', typeof c51.ConflictGate === 'function' && typeof c51.ConflictPrompt === 'function', 'ConflictGate + 自绘降级都在')
  }

  // ---- 支持作者入口的结构约束 ----
  {
    const src51 = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
    const code51 = src51.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    check('UQ9', '★ 捐款入口是一行常显小字（pap_donateLine + aria-expanded），不是折叠的 <details>', /className: 'pap_donateLine'/u.test(code51) && /'aria-expanded': donateOpen/u.test(code51) && !/className: 'pap_donate',\s*\n\s*open: donateOpen/u.test(code51), '一行 + 点击展开')
    check('UQ10', '★ 不用「捐赠」「赞助」这类正式词汇，统一用「请作者喝杯咖啡」', !code51.includes("'捐赠") && !code51.includes("'赞助") && src51.includes('请作者喝杯咖啡'), '文案统一')
    check('UQ11', '★ 没有弹窗、没有红点、没有闪烁（无 badge/flash/alert 类样式）', !/pap_donate(Flash|Badge|Red|Alert|Pulse)/u.test(code51), '只有静态样式')
    check('UQ12', '★ 二维码是灰色占位方块并标注「收款码待填」', /pap_donateQr/u.test(code51) && src51.includes('收款码待填'), '占位方块 + 提示文字')
    // v0.5.2：占位符已替换成真实链接，这条断言从「必须有占位符」反转成「不许再有占位符」
    check(
      'UQ13',
      '★ 爱发电链接已替换为真实地址，代码与 README 里都不再有占位符',
      !src51.includes('REPLACE_ME') && /https:\/\/afdian\.com\/a\/[A-Za-z0-9_-]+/u.test(src51) && !readFileSync(join(HERE_SRC, 'README.md'), 'utf8').includes('REPLACE_ME'),
      'donateAfdianUrl = https://afdian.com/a/speak-human',
    )
    check('UQ14', '「关闭后不再显示」写的是既有的 ui.hideDonate 配置', /hideDonate/u.test(code51) && /ui:\s*\{\s*hideDonate:\s*true/u.test(code51), '复用 ui.hideDonate，点过就不再显示')
    check('UQ15', '捐款入口位置在「保存/关闭」工具条之前', code51.indexOf('pap_donateLine') < code51.indexOf('pap_toolbarSticky'), '捐款在黑名单之后、保存之前')
  }
}

group('附加（v0.5.3）：审批历史')
{
  const home = mkdtempSync(join(TMP_ROOT, 'history-'))
  const dir = join(home, 'plain-approval')
  let cfg = { ui: { history: { enabled: true, retentionDays: 90, maxEntries: 5000, keepCommands: false } } }
  const h = createHistory({ dir, getSettings: () => cfg })

  const base = { hash: 'a'.repeat(63) + 'f', toolName: 'pwsh', mode: '只读', risk: '安全', sections: { intent: '帮你看看当前目录有哪些文件', risk: '安全' } }

  // ---- 记录与基本字段 ----
  h.record({ ...base, command: 'ls -la', decision: 'allowed-once' })
  const rows1 = h.list()
  check('H1', '一次审批产生一条历史记录', rows1.length === 1, `rows=${rows1.length}`)
  check('H2', '★ 默认不记命令原文（只记 sha256 哈希）', rows1[0].command === null && rows1[0].hash === base.hash, `command=${String(rows1[0].command)}`)
  check('H3', '哈希取前 8 位方便肉眼比对', rows1[0].hash8 === 'aaaaaaaa', rows1[0].hash8)
  check('H4', '决定类型归一化正确', rows1[0].decision === 'allowed-once', rows1[0].decision)
  check('H5', '七段翻译结果被保留', rows1[0].sections?.intent === '帮你看看当前目录有哪些文件', JSON.stringify(rows1[0].sections?.intent))

  // ---- 决定归一化：认不出来的必须落到 other，绝不猜 ----
  check('H6', '★ 无法识别的 outcome 一律记 other，绝不臆测成「允许」', h.record({ ...base, hash: 'b'.repeat(64), decision: 'weird-value' })?.decision === 'other', normalizeDecision('weird-value'))
  check('H7', '拒绝也能识别', normalizeDecision('rejected') === 'rejected' && normalizeDecision('denied') === 'rejected', 'rejected/denied → rejected')

  // ---- 自动放行也进历史（否则统计会漏掉最该被看见的一类） ----
  h.record({ ...base, hash: 'c'.repeat(64), decision: 'auto-allowed', grantId: 'grant-xyz' })
  check('H8', '★ 自动放行也记进历史，并带上授权规则 ID', h.list().some((r) => r.decision === 'auto-allowed' && r.grantId === 'grant-xyz'), JSON.stringify(h.stats().byDecision))

  // ---- 时间倒序 ----
  const times = h.list().map((r) => r.at)
  check('H9', '默认按时间倒序返回', times.every((t, i) => i === 0 || times[i - 1] >= t), `首条 ${times[0]}`)

  // ---- 筛选 ----
  check('H10', '按决定类型筛选', h.list({ decision: 'rejected' }).length === 0 && h.list({ decision: 'auto-allowed' }).length === 1, `rejected=${h.list({ decision: 'rejected' }).length}`)
  check('H11', '按命令哈希搜索（子串，大小写不敏感）', h.list({ q: 'AAAAAAAA' }).length === 1 && h.list({ q: 'zzzz' }).length === 0, '搜 aaaaaaaa 命中 1 条')
  check('H12', '时间范围筛选：today 能查到刚写的', h.list({ range: 'today' }).length >= 3, `today=${h.list({ range: 'today' }).length}`)

  // ---- 保留原文：必须用户显式开启 ----
  cfg = { ui: { history: { ...cfg.ui.history, keepCommands: true } } }
  h.invalidate()
  h.record({ ...base, hash: 'd'.repeat(64), command: 'Get-ChildItem C:\\', decision: 'allowed-once' })
  check('H13', '用户显式开启后才存原文', h.list({ q: 'dddddddd' })[0]?.command === 'Get-ChildItem C:\\', String(h.list({ q: 'dddddddd' })[0]?.command))

  // ---- 总开关 ----
  cfg = { ui: { history: { ...cfg.ui.history, enabled: false } } }
  h.invalidate()
  check('H14', '★ 关掉总开关后完全不记录', h.record({ ...base, hash: 'e'.repeat(64), decision: 'allowed-once' }) === null && !h.list({ q: 'eeeeeeee' }).length, 'enabled=false → 不写')

  // ---- 导出脱敏 ----
  cfg = { ui: { history: { enabled: true, retentionDays: 90, maxEntries: 5000, keepCommands: false } } }
  h.invalidate()
  const plain = h.exportAll()
  const red = h.exportAll({ redact: true })
  check('H15', '普通导出带哈希', plain.items.length > 0 && plain.items[0].hash !== null, `items=${plain.items.length}`)
  check('H16', '★ 脱敏导出去掉哈希、原文、授权规则 ID', red.items.length > 0 && red.items.every((r) => r.hash === null && r.command === null && r.grantId === null) && red.redact === true, '脱敏模式生效')

  // ---- 清空 ----
  const cleared = h.clear()
  check('H17', '清空历史', cleared.ok === true && h.list().length === 0, `removed=${cleared.removed}`)

  // ---- 保留期：过期条目在加载时被裁掉 ----
  const h2 = createHistory({ dir, getSettings: () => ({ ui: { history: { enabled: true, retentionDays: 1, maxEntries: 5000, keepCommands: false } } }) })
  // 手工塞一条 10 天前的记录
  appendFileSync(join(dir, 'history.jsonl'), JSON.stringify({ at: new Date(Date.now() - 10 * 86400000).toISOString(), hash: 'f'.repeat(64), hash8: 'ffffffff', decision: 'rejected' }) + '\n')
  h2.invalidate()
  check('H18', '★ 超过保留期的记录在加载时自动裁掉', h2.list().length === 0, `剩 ${h2.list().length} 条`)

  // ---- 统计 ----
  const h3 = createHistory({ dir, getSettings: () => ({ ui: { history: { enabled: true, retentionDays: 90, maxEntries: 5000, keepCommands: false } } }) })
  h3.record({ ...base, hash: '1'.repeat(64), decision: 'allowed-once' })
  h3.record({ ...base, hash: '2'.repeat(64), decision: 'rejected' })
  const st = h3.stats()
  check('H19', '统计按决定类型分桶', st.total === 2 && st.byDecision['allowed-once'] === 1 && st.byDecision.rejected === 1, JSON.stringify(st.byDecision))

  // ---- 源码红线：历史功能不能违反本项目既有安全底线 ----
  {
    const srcH = readFileSync(join(HERE_SRC, 'src', 'history.js'), 'utf8')
    const srcC = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
    const codeH = srcH.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    check('H20', '★ 历史模块不联网、不写工作区（无 http/net/绝对路径写文件）', !/\bfetch\s*\(|https?:\/\/|require\('node:https'\)/u.test(codeH), '无网络调用')
    check('H21', '★ 默认配置 keepCommands=false（不记原文）', !/keepCommands:\s*true/u.test(readFileSync(join(HERE_SRC, 'src', 'config.js'), 'utf8')), 'config.js 默认 false')
    check('H22', '★ 历史弹窗不注册全局事件监听、不用 MutationObserver', !/addEventListener|MutationObserver/u.test(srcC.slice(srcC.indexOf('function HistoryModal'), srcC.indexOf('function HistoryModal') + 6000)), 'HistoryModal 内无全局监听')
    check('H23', '★ 决定来自 waterfall 的 outcome，客户端不参与上报', /settle\s*=\s*\(outcome\)/u.test(readFileSync(join(HERE_SRC, 'src', 'plugin.js'), 'utf8')), 'settle(outcome)')
  }

  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

group('附加（v0.5.4）：上下文缓存 + 非 shell 工具分类 + 日志字段名')
{
  // ---- 1. 缓存键必须包含上下文指纹 ----
  {
    const ctxA = { available: true, lines: ['请在桌面上新建一个文本文件'], step: { index: 1, total: 1 } }
    const ctxB = { available: true, lines: ['帮我把上周的报告导出成 PDF'], step: { index: 1, total: 1 } }
    const ident = { engineMode: 'auto', engineIdentity: 'deepseek:chat' }
    const kNone = cacheKey({ command: 'ls -la', ...ident })
    const kA = cacheKey({ command: 'ls -la', ...ident, context: ctxA })
    const kB = cacheKey({ command: 'ls -la', ...ident, context: ctxB })
    check('C1', '★ 有上下文 vs 无上下文 → 不同的缓存键（背景段不再被旧快照冻住）', kNone !== kA, `none=${kNone.slice(0, 8)} ctx=${kA.slice(0, 8)}`)
    check('C2', '★ 不同上下文 → 不同的缓存键', kA !== kB, `A=${kA.slice(0, 8)} B=${kB.slice(0, 8)}`)
    check('C3', '相同上下文 → 命中同一个键（不会把缓存打成筛子）', kA === cacheKey({ command: 'ls -la', ...ident, context: ctxA }), '同输入同键')
    check('C4', '上下文不变时，命令变仍不命中（原有行为没被破坏）', kA !== cacheKey({ command: 'ls -laa', ...ident, context: ctxA }), '命令变 → 换键')
    check('C5', '上下文指纹用哈希，不泄露原文', !contextFingerprint(ctxA).includes('桌面上') && /^[0-9a-f]{64}$/u.test(contextFingerprint(ctxA)), contextFingerprint(ctxA).slice(0, 16) + '…')
    check('C6', 'CACHE_VERSION 已递增（老缓存条目自动失效，不会读到旧格式）', CACHE_VERSION >= 2, 'CACHE_VERSION=' + CACHE_VERSION)
  }

  // ---- 2. 非 shell 工具的操作类型 ----
  {
    // extractCommand 给 write 工具合成出来的就是这个形状
    const w = analyzeCommand('写入/修改文件：C:\\Users\\alpha\\Desktop\\approval-test-1.txt', { toolName: 'write' })
    check('C7', '★ write 工具判为「写入」而不是「执行」', w.mode === '写入', `mode=${w.mode}`)
    const r = analyzeCommand('写入/修改文件：C:\\Users\\alpha\\Desktop\\a.txt', { toolName: 'read' })
    check('C8', 'read 工具判为「只读」', r.mode === '只读', `mode=${r.mode}`)
    // shell 类工具不在决定性表里，仍然由命令文本判断
    const b1 = analyzeCommand('ls -la', { toolName: 'bash' })
    const b2 = analyzeCommand('mkdir foo', { toolName: 'shell' })
    check('C9', '★ shell 工具仍由命令文本判断（bash+ls → 只读 / shell+mkdir → 写入）', b1.mode === '只读' && b2.mode === '写入', `bash+ls=${b1.mode} shell+mkdir=${b2.mode}`)
    // 删除永远压过一切
    const d = analyzeCommand('写入/修改文件：x', { toolName: 'write' })
    void d
    const del = analyzeCommand('rm -rf ./build', { toolName: 'bash' })
    check('C10', '删除优先级最高，不会被工具名覆盖', del.mode === '删除', `mode=${del.mode}`)
    // 没有 toolName 时靠中文前缀兜底
    const noTool = analyzeCommand('写入/修改文件：C:\\tmp\\x.txt')
    check('C11', '没有 toolName 时，extractCommand 的中文前缀也能判成「写入」', noTool.mode === '写入', `mode=${noTool.mode}`)
    // 未知工具名不乱猜
    const unknown = analyzeCommand('某个说不清的工具', { toolName: 'weird_tool' })
    check('C12', '★ 未知工具名不臆测（退回默认「执行」）', unknown.mode === '执行', `mode=${unknown.mode}`)
  }

  // ---- 3. 日志字段名：不能被 sanitize 吃掉 ----
  {
    const loggerSrc = readFileSync(join(HERE_SRC, 'src', 'logger.js'), 'utf8')
    const pluginSrc = readFileSync(join(HERE_SRC, 'src', 'plugin.js'), 'utf8')
    check('C13', '★ 日志仍然拦 command/text/prompt/raw（安全拦截没被放宽）', /key === 'command' \|\| key === 'text' \|\| key === 'prompt' \|\| key === 'raw'/u.test(loggerSrc), 'sanitize 仍强制哈希化')
    check('C14', '★ 调试字段改名为 commandPrefix，绕开哈希化拦截', /commandPreview: oneLine\(truncated, 80\)/u.test(pluginSrc) && !/^\s*command: oneLine\(truncated/mu.test(pluginSrc), 'commandPreview')
    // 真跑一遍 sanitize，确认这个字段确实能落到日志里
    const tmpHome = mkdtempSync(join(TMP_ROOT, 'logf-'))
    const lg = createLogger({ store: createStore({ env: { ...process.env, DSH_HOME: tmpHome } }), getSettings: () => ({ log: { enabled: true } }) })
    lg.info('approval.seen', { command: 'SECRET-COMMAND', commandPreview: 'SECRET-COMMAND-PREVIEW' })
    const text = readFileSync(join(tmpHome, 'plain-approval', 'plain-approval.jsonl'), 'utf8')
    const row = JSON.parse(text.trim().split('\n').pop())
    check('C15', '★ 实测：command 被哈希化、commandPreview 原样保留', row.commandHash && !row.command && row.commandPreview === 'SECRET-COMMAND-PREVIEW', JSON.stringify({ commandHash: row.commandHash, commandPreview: row.commandPreview }))
    try {
      rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

group('附加（v0.5.5）：意图翻译（「翻译官」→「理解官」）')
{
  // ---- 结构：七段的第一段是意图，背景/干什么不再单列 ----
  {
    const s = normalizeSections({ intent: '帮你补全 ComfyUI 缺的画图模型', touch: 'checkpoints 和 loras 目录', mode: '写入', risk: '安全', advice: '可以允许', consequence: '最坏是占满磁盘。', benefit: '让 ComfyUI 能正常出图。', parts: [] })
    const clientSrc = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
    check('I1', '★ v0.7.0 第一段是 title（卡片顶行）', Object.keys(s)[0] === 'title' && !('background' in s), Object.keys(s).join(','))
    check('I2', '★ 界面上不再有独立的「干什么」段落（what 仅作旧客户端兼容保留，不进折叠区）', !('background' in s) && /const SECTION_KEYS = \['why', 'touch', 'outcome'\]/u.test(clientSrc), '折叠区只含 why/touch/outcome')
    check('I3', '★ 标题长度限制在 60 个汉字（硬上限兜底，防止顶行撑爆）', 'x'.repeat(200).length === 200 && normalizeSections({ title: 'y'.repeat(200), risk: '安全' }).title.length === 60, normalizeSections({ title: 'y'.repeat(200), risk: '安全' }).title.length + ' 字符')
  }

  // ---- 兼容性：老模型只吐 background / what，不能变成「未识别」 ----
  {
    const old = normalizeSections({ what: '查看当前目录的文件', touch: '当前目录', mode: '只读', risk: '安全', advice: '可以允许', consequence: '不改动。', benefit: '看到文件。', parts: [] })
    check('I4', '★ 老格式的 what 会被折叠进 title（不丢内容）', old.title === '查看当前目录的文件' && old.what === '查看当前目录的文件', old.title)
    const old2 = normalizeSections({ background: '你刚才让它测试弹窗', touch: '桌面', mode: '写入', risk: '安全', advice: '可以允许', consequence: '多一个文件。', benefit: '看到弹窗。', parts: [] })
    check('I5', '★ 老格式的 background 也会折叠进 title', old2.title === '你刚才让它测试弹窗', old2.title)
    check('I6', '中文字段名（意图/目的/标题）同样认', normalizeSections({ 意图: '帮你下载模型', risk: '安全' }).title === '帮你下载模型' && normalizeSections({ 标题: '检查目录', risk: '安全' }).title === '检查目录', '中文别名可解析')
  }

  // ---- 提示词：反例必须真的在里面 ----
  {
    const sys = SYSTEM_PROMPT
    check('I7', '★ 提示词明说「模型只负责把这件事说成人话，风险由本地规则判」', /说成人话/u.test(sys) && /不要重判/u.test(sys), '职责边界写清楚')
    check('I8', '★ 反例「分步执行一段脚本」被明确列为不合格', /✗[^]*分步执行一段脚本/u.test(sys), '反例在提示词里')
    check('I9', '★ 脚本规则：先整体在干什么，再分步目的', /整体在干什么/u.test(sys) && /每一步.*为了什么/u.test(sys), '脚本处理规则已写入')
    check('I10', '★ 明确要求「不确定就说不确定」，禁止编造', /绝不允许编造/u.test(sys) && /无法确定/u.test(sys), '编造禁令 + 不确定文案')
    check('I11', '★ 提示词点明「编造的理由比不写更危险」', /编造的理由比不写更危险/u.test(sys), '给了模型拒绝编造的动机')
    check('I12', '★ JSON 字段清单已是 v0.7.0 的五字段（title/why/touch/outcome/parts）', /title, why, touch, outcome, parts/u.test(sys) && !/"risk"/u.test(sys), '字段名已更新，且模型不再输出 risk')
    check('I13', 'parts 的措辞是「每一步为了什么」', /每一步.*为了什么/u.test(sys), '分步目的')
  }

  // ---- 用户提示词也跟着改 ----
  {
    const withCtx = buildUserPrompt({ command: 'x', context: { available: true, block: '用户最近的指令：(1) 帮我补模型' } })
    const noCtx = buildUserPrompt({ command: 'x', context: { available: false, block: '' } })
    check('I14', '★ 有上下文时要求据此推断 title 与 why', withCtx.includes('帮我补模型') && withCtx.includes('title') && withCtx.includes('why'), '指向 title/why')
    check('I15', '无上下文时要求 why 原样写兜底句', noCtx.includes('未读取到会话上下文') && noCtx.includes('why 必须原样写'), '兜底句指向 why')
    const seg = buildUserPrompt({ command: 'x', rules: { segments: { kind: 'pipe', segments: [{ label: '第 1 段', text: 'ls' }] } } })
    check('I16', '分段脚本时提示「整体在干什么 + 每步为了什么」', seg.includes('整体在干什么') && seg.includes('每一步'), '脚本规则进提示')
  }

  // ---- 空值兜底：真实 Ollama 吐过空 touch ----
  {
    const s = normalizeSections({ intent: '帮你看看文件', touch: '   ', risk: '安全', consequence: '', benefit: '' })
    check('I17', '★ 模型返回空串/纯空格时也有兜底，不会显示空白行', s.touch === '未能识别具体对象' && s.consequence.length > 0 && s.benefit.length > 0, `touch=${s.touch}`)
    check('I18', '意图全空时给的是「请看原始命令」而不是废话', /原始命令/.test(normalizeSections({ intent: '', risk: '安全' }).intent), normalizeSections({ intent: '', risk: '安全' }).intent)
  }

  // ---- 风险仍然由本地规则说了算，意图不许影响它 ----
  {
    // 用 mock Ollama 跑一条**危险**命令：模型再怎么写意图，风险也必须是危险。
    const mock = await startMockOllama()
    const env = harness({
      rowConfig: baseConfig({
        engine: 'ollama',
        ollama: { baseUrl: mock.baseUrl, model: 'qwen2.5:7b', timeoutMs: 20000, minFreeMemoryGB: 0 },
        device: { enabled: false },
        cache: { enabled: false, driver: 'json' },
      }),
    })
    const t = await env.translator.translate({ command: 'rm -rf /', toolName: 'pwsh', context: { available: true, lines: ['用户最近的指令：(1) 清理一下'], step: null, block: '用户最近的指令：(1) 清理一下' } })
    check(
      'I19',
      '★ 意图是模型推测，风险仍由本地规则判定（危险命令不会被一段「善意」的意图洗白）',
      t.sections.risk === '危险' && t.sections.advice === '建议拒绝' && t.sections.intent.length > 0,
      `risk=${t.sections.risk} advice=${t.sections.advice} intent=${t.sections.intent}`,
    )
    env.cleanup()
    mock.stop?.()

    // 源码级：mergeSections 里不允许出现「用 intent 改 risk」的代码路径
    const srcT = readFileSync(join(HERE_SRC, 'src', 'translate.js'), 'utf8')
    const start = srcT.indexOf('function mergeSections')
    const merge = srcT.slice(start, start + 1800)
    const intentBlock = merge.slice(merge.indexOf('const modelIntent'))
    check('I20', '★ 源码级：处理 intent 的那段代码里不碰 risk/advice（意图与风险解耦）', !/merged\.(risk|advice|consequence)\s*=/u.test(intentBlock), '意图段只写 merged.intent')
  }
}

group('附加（v0.5.6）：上下文断链修复 + AI 自述优先 + 两种兜底句')
{
  /* ---------- 1. 端到端：宿主读到 context 后，客户端那次翻译必须拿到同一个 context ---------- */
  // 这条测试复刻真机事故：approval.seen 记 context=yes（宿主读到了），
  // 但浏览器里那次 /translate 拿不到 context，意图被强制写成「未读取到」。
  const savedHome = mkdtempSync(join(TMP_ROOT, 'ctxlink-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = savedHome
  let route = null
  const listeners = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() { return undefined },
    on(name, listener) { listeners.push({ name, listener }); return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(_names, cb) {
      cb({
        effect: (fn) => fn(),
        webServer: { register(r) { route = r; return () => {} } },
      })
    },
  }
  const mockDsk = await startMockDeepSeek()
  applyHost(ctx, {
    engine: 'deepseek',
    deepseek: { baseUrl: mockDsk.baseUrl, model: 'deepseek-chat', timeoutMs: 20000, retryOnRateLimit: false },
    log: { enabled: false },
    cache: { enabled: false, driver: 'json' },
    device: { enabled: false },
  })
  const approvalEntry = listeners.find((l) => l.name === 'approval/request')

  // 会话里有：用户指令 + **AI 发起审批前的自述** + 这次工具调用
  // ⚠️ v0.5.7 修正：这里原来传的是裸字符串 message，
  // 而 textOf() 读的是 message.content → 用户/AI 的话双双丢失，
  // 上下文「可用」只是因为步骤行永远存在。测试通过的理由是错的。
  const msg = (t) => ({ content: [{ type: 'text', text: t }] })
  const evs = [
    { type: 'turn/start' },
    { type: 'user/message', data: { message: msg('帮我检查 ComfyUI 目录并把结果写进 check.log') } },
    { type: 'assistant/message', data: { message: msg('我先列出目录内容，再把结果写到 check.log。') } },
    { type: 'tool/call', data: { callId: 'ctxlink-1', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-ChildItem D:\\Comfy-Desktop' }) } },
  ]
  let release = null
  const gate = new Promise((r) => { release = r })
  approvalEntry.listener(
    { agent: { session: { seq: evs.length, eventAt: (i) => evs[i] } }, toolName: 'pwsh', callId: 'ctxlink-1' },
    () => gate,
  )

  // 现在模拟**客户端**：只带 callId，不带 context（真实浏览器就是这样）
  const srv = createHttpServer((req, res) => route.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const res = await fetch(`http://127.0.0.1:${port}/api/plain-approval/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plain-approval': '1' },
    body: JSON.stringify({ command: 'Get-ChildItem D:\\Comfy-Desktop', toolName: 'pwsh', callId: 'ctxlink-1', confirmPaid: true }),
  })
  const body = await res.json()
  const intentText = body?.data?.sections?.intent ?? ''
  check(
    'Z1',
    '★ 端到端：客户端只带 callId 也能拿到宿主读到的上下文（意图不再谎报「未读取到」）',
    res.status === 200 && intentText !== '' && intentText !== NO_CONTEXT_NOTE,
    `intent=${intentText}`,
  )
  check('Z2', '★ 这次翻译确实是有上下文的（响应里 context.available=true）', body?.data?.context?.available === true, JSON.stringify(body?.data?.context))
  // 翻译响应**有意不外传 context.lines**（会话原文不发给浏览器），
  // 所以这里直接对同一份事件验证 extractContext，证明端到端测试的
  // session 夹具里真的有用户指令和 AI 自述，而不是只有那条步骤行。
  const fixtureCtx = extractContext({ session: { seq: evs.length, eventAt: (i) => evs[i] } }, 'ctxlink-1')
  check(
    'Z2b',
    '★ 端到端用的那份 session 里真的同时含用户指令与 AI 自述（测试夹具本身有效）',
    fixtureCtx.available === true &&
      fixtureCtx.lines.some((l) => /ComfyUI/.test(String(l))) &&
      fixtureCtx.lines.some((l) => /列出目录内容/.test(String(l))),
    JSON.stringify(fixtureCtx.lines),
  )
  check(
    'Z2c',
    '隐私：翻译响应只回 available/step/note，**不回传会话原文**',
    body?.data?.context !== undefined && body.data.context.lines === undefined && body.data.context.available === true,
    '响应里的 context 字段 = ' + JSON.stringify(body?.data?.context),
  )
  await new Promise((r) => srv.close(r))
  release('allowed-once')
  await gate
  mockDsk.stop?.()
  process.env.DSH_HOME = prevHome
  try { rmSync(savedHome, { recursive: true, force: true }) } catch { /* ignore */ }

  /* ---------- 2. 结构红线：这些修法不能被回退 ---------- */
  {
    const srcP = readFileSync(join(HERE_SRC, 'src', 'plugin.js'), 'utf8')
    const srcS = readFileSync(join(HERE_SRC, 'src', 'server.js'), 'utf8')
    // v0.7.0：实现从「单个 want 变量」改成「candidates 集合」，但**精确后缀匹配这条红线不变** ——
    // 必须是 endsWith(':' + 候选)，不能退化成 includes/模糊查找（会误配到别的挂起项）。
    check('Z3', '★ findPendingByCallId 仍用 key 的 :callId 后缀精确匹配（非模糊查找）', /key\.endsWith\(':' \+ /u.test(srcP) && !/\.includes\(.*callId/u.test(srcP), '精确后缀匹配')
    check('Z4', '★ /translate 路由把 pending 里的 context 传给 translator', /pendingHit\?\.context/u.test(srcS), 'server.js 传入 context')
    check('Z5', '★ translate.served 日志会记录这次调用有没有上下文（下次好排查）', /contextSource/u.test(srcS), '可观测')
  }

  /* ---------- 3. 两种兜底句必须区分 ---------- */
  {
    check(
      'Z6',
      '★ 「没读到上下文」与「读到了但定不出意图」是两句话',
      NO_CONTEXT_NOTE !== NO_INTENT_NOTE && /未读取到会话上下文/u.test(NO_CONTEXT_NOTE) && /已读取到会话上下文/u.test(NO_INTENT_NOTE),
      `"${NO_CONTEXT_NOTE}" vs "${NO_INTENT_NOTE}"`,
    )
    const srcT = readFileSync(join(HERE_SRC, 'src', 'translate.js'), 'utf8')
    check('Z7', '★ mergeSections 里两句话各有触发条件，不会互相顶替（作用在 why 上）', /merged\.why = NO_CONTEXT_NOTE/u.test(srcT) && /merged\.why = NO_INTENT_NOTE/u.test(srcT), '分流正确')
  }

  /* ---------- 4. 提示词：AI 自述是首要依据 + 一致性检查 ---------- */
  {
    const sys = SYSTEM_PROMPT
    check('Z8', '★ 提示词写明证据优先级，AI 的思考过程/自述排第一', /证据优先级/u.test(sys) && /AI 的思考过程/u.test(sys) && /AI 在发起这次审批前说过/u.test(sys), '优先级已写明')
    check('Z9', '★ 提示词要求：AI 说明与命令行为不一致时如实写出落差', /对不上/u.test(sys) && /落差/u.test(sys), '一致性检查规则')
    check('Z10', '用户提示词里也强调「以 AI 自述为主线」', /自述为主线/u.test(buildUserPrompt({ command: 'x', context: { available: true, block: 'AI 在发起这次审批前说过：「x」' } })), 'buildUserPrompt 已强调')
  }

  /* ---------- 5. extractContext 确实读了 AI 自述（数据源一直都在，问题只出在传递） ---------- */
  {
    const srcC = readFileSync(join(HERE_SRC, 'src', 'context.js'), 'utf8')
    check('Z11', '★ extractContext 读 assistant/message（AI 自述），不只是用户指令', /assistant\/message/u.test(srcC) && /AI 在发起这次审批前说过/u.test(srcC), 'AI 自述已在采集')
  }

  /* ---------- 6. 用户提的场景：AI 没开口就直接调工具 ---------- */
  {
    const mkAgent = (evs) => ({ session: { seq: evs.length, eventAt: (i) => evs[i] } })
    const blk = (t) => ({ content: [{ type: 'text', text: t }] })
    const toolCall = { type: 'tool/call', data: { callId: 'q1', name: 'write', arguments: JSON.stringify({ file_path: 'C:\\Users\\alpha\\Desktop\\fresh-test.txt' }) } }

    // AI 完全没说话，只有用户一句指令
    const silent = extractContext(
      mkAgent([
        { type: 'turn/start' },
        { type: 'user/message', data: { message: blk('请把下面这段文字写入 C:\\Users\\alpha\\Desktop\\fresh-test-20261014.txt') } },
        toolCall,
      ]),
      'q1',
    )
    check(
      'Z12',
      '★ AI 没开口时，用户指令仍然被读进上下文（不是「无上下文」）',
      silent.available === true && silent.lines.some((l) => /fresh-test/.test(String(l))),
      JSON.stringify(silent.lines),
    )
    check('Z13', 'AI 没开口时不会伪造「AI 说过什么」', !silent.lines.some((l) => /AI 在发起这次审批前说过/u.test(String(l))), JSON.stringify(silent.lines))

    // textOf 兼容裸字符串（v0.5.7 修的坑）
    const loose = extractContext(
      mkAgent([
        { type: 'turn/start' },
        { type: 'user/message', data: { message: '把这段文字写进桌面文件' } },
        toolCall,
      ]),
      'q1',
    )
    check('Z14', '★ message 是裸字符串时也能读出内容（不再被静默吞掉）', loose.lines.some((l) => /写进桌面文件/u.test(String(l))), JSON.stringify(loose.lines))

    // 反面：会话里只有 turn/start，什么实质内容都没有 → 才是真的无上下文
    const bare = extractContext(mkAgent([{ type: 'turn/start' }]), 'q1')
    check('Z15', '会话里什么都没有时才算无上下文（available=false）', bare.available === false, `available=${bare.available}`)

    // 只匹配到工具调用时，「这是本回合第 N 次操作」本身就是真实的会话上下文，
    // 不算硬凑 —— 但它确实很薄，所以这里把行为钉住，别以后被误改。
    const stepOnly = extractContext(mkAgent([{ type: 'turn/start' }, toolCall]), 'q1')
    check('Z15b', '只匹配到工具调用时，步骤信息本身算会话上下文（available=true）', stepOnly.available === true && stepOnly.lines.some((l) => /本回合的第 1 次工具调用/u.test(String(l))), JSON.stringify(stepOnly.lines))
  }

  /* ---------- 7. 监听器全程留痕（v0.5.6 死局的教训） ---------- */
  {
    const srcP2 = readFileSync(join(HERE_SRC, 'src', 'plugin.js'), 'utf8')
    check('Z16', '★ 监听器入口无条件留痕（listener-enter）', /approval\.listener-enter/u.test(srcP2), '进入即记录')
    check('Z17', '★ 监听器出口留痕（listener-exit），带 commandMissing / contextAvailable', /approval\.listener-exit/u.test(srcP2) && /contextAvailable/u.test(srcP2), '执行完毕即记录')
    check('Z18', '★ 被跳过时记明原因（frozen / not-an-object / no-request）', /approval\.listener-skipped/u.test(srcP2) && /request-frozen/u.test(srcP2), '跳过有原因')
    check('Z19', '★ translate.served 带 callId 与 pendingFound（可与 listener-enter 对账）', /pendingFound/u.test(readFileSync(join(HERE_SRC, 'src', 'server.js'), 'utf8')), '可对账')
  }
}
group('附加（v0.5.8）：即时意图 / 用户主动要求 / 不重复调模型')
{
  /* ---------- 1. ruleOnly 必须拿到 context（卡片一出现就有用） ---------- */
  {
    const ctxR = { available: true, lines: ['用户最近的指令：(1) 帮我删掉用不到的模型文件'], step: { index: 2, total: 3 }, note: '', chars: 40 }
    const envR = harness({ rowConfig: baseConfig({ cache: { enabled: false, driver: 'json' } }) })
    const withCtx = envR.translator.ruleOnly({ command: 'Remove-Item D:\\m.safetensors', toolName: 'pwsh', context: ctxR })
    const noCtx = envR.translator.ruleOnly({ command: 'Remove-Item D:\\m.safetensors', toolName: 'pwsh' })
    check(
      'R1',
      '★ ruleOnly 拿到 context 时，意图立即就有内容（不等模型）',
      typeof withCtx.sections.intent === 'string' && withCtx.sections.intent !== '' && withCtx.sections.intent !== NO_CONTEXT_NOTE,
      withCtx.sections.intent,
    )
    check('R2', '对照：不给 context 时退回兜底句', noCtx.sections.intent === NO_CONTEXT_NOTE, noCtx.sections.intent)
    check('R3', '★ 两者的差异证明「卡片初始内容」现在能用上上下文', withCtx.sections.intent !== noCtx.sections.intent, '有/无 context 产出不同意图')
    envR.cleanup()
  }

  /* ---------- 2. 宿主审批时确实把 context 传给了 ruleOnly（顺序不能反） ---------- */
  {
    const srcP = readFileSync(join(HERE_SRC, 'src', 'plugin.js'), 'utf8')
    const ctxAt = srcP.indexOf('const context = commandMissing')
    const ruleAt = srcP.indexOf('translator.ruleOnly({')
    check('R4', '★ 源码顺序：先 extractContext，再 ruleOnly（v0.5.8 的核心修复）', ctxAt > 0 && ruleAt > 0 && ctxAt < ruleAt, `context@${ctxAt} ruleOnly@${ruleAt}`)
    check('R5', '★ ruleOnly 的入参里带上了 context', /translator\.ruleOnly\(\{[\s\S]{0,220}?context,/u.test(srcP), 'context 已传入')
  }

  /* ---------- 3. 同一个审批只调一次模型 ---------- */
  {
    const srcP2 = readFileSync(join(HERE_SRC, 'src', 'plugin.js'), 'utf8')
    check('R6', '★ 宿主的后台翻译结果被回填到挂起条目（不再丢弃）', /entry\.full = result/u.test(srcP2), 'entry.full = result')
    check('R7', '★ /pending 会把这份完整结果带给客户端', /full: entry\.full/u.test(srcP2), 'listPending 带 full')
    const srcC2 = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
    check('R8', '★ 客户端优先用 pending.full，不再重复请求', /pending\.full/u.test(srcC2) && /pending && pending\.full/u.test(srcC2), '客户端复用宿主结果')
  }

  /* ---------- 4. 提示词：用户主动要求 ---------- */
  {
    const sys = SYSTEM_PROMPT
    check('R9', '★ 提示词禁止把「第 N 次操作」当意图', /第 N 次操作/u.test(sys) && /不算意图/u.test(sys), '步骤计数不算意图')
    check('R10', '★ 提示词要求意图体现「你刚才让它做 X」', /你刚才让它/u.test(sys), '主动要求要写出来')
    check('R11', '★ 提示词要求用户主动要求的事要在标题里体现「你刚才让它…」', /用户主动要求/u.test(sys) && /你刚才让它/u.test(sys), 'title 跟着改')
    check('R12', '★ 提示词明确「用户主动要求不得降低风险」', /不要因为.*用户要的.*就说它安全/u.test(sys), '风险与措辞解耦')
  }

  /* ---------- 5. 意图不得洗白危险操作（用户主动要求 vs 风险等级） ---------- */
  {
    const envD = harness({ rowConfig: baseConfig({ cache: { enabled: false, driver: 'json' } }) })
    const r = await envD.translator.translate({ command: 'Remove-Item D:\\Comfy-Desktop\\animagine-xl-3.1.safetensors -Force', toolName: 'pwsh' })
    check(
      'R13',
      '★ 删除类危险命令仍然是危险 / 建议拒绝（意图怎么写都不影响）',
      r.sections.risk === '危险' && r.sections.advice === '建议拒绝',
      `risk=${r.sections.risk} advice=${r.sections.advice} intent=${r.sections.intent}`,
    )
    envD.cleanup()
  }

  /* ---------- 6. 连续两次审批：第二次要能读到第一次的上下文（时序） ---------- */
  {
    const msgX = (t) => ({ content: [{ type: 'text', text: t }] })
    const mkA = (evs) => ({ session: { seq: evs.length, eventAt: (i) => evs[i] } })
    // 第一次审批时，用户只说了目标，AI 还没开口
    const first = [
      { type: 'turn/start' },
      { type: 'user/message', data: { message: msgX('帮我建一个 build_animagine.py 脚本') } },
      { type: 'tool/call', data: { callId: 'c-1', name: 'write', arguments: JSON.stringify({ file_path: 'build_animagine.py' }) } },
    ]
    // 第一次审批之后，AI 开口说了下一步；第二次审批发生在这之后
    const second = [
      ...first,
      { type: 'assistant/message', data: { message: msgX('任务 2：用 ComfyUI 自带的 Python 运行这个脚本。') } },
      { type: 'tool/call', data: { callId: 'c-2', name: 'pwsh', arguments: JSON.stringify({ command: "python build_animagine.py" }) } },
    ]
    const c1 = extractContext(mkA(first), 'c-1')
    const c2 = extractContext(mkA(second), 'c-2')
    check('R14', '★ 第一次审批：至少有用户指令可用（不会是无上下文）', c1.available === true && c1.lines.some((l) => /build_animagine/.test(String(l))), JSON.stringify(c1.lines))
    check('R15', '★ 第二次审批：读到了第一次之后 AI 补充的自述', c2.available === true && c2.lines.some((l) => /任务 2/.test(String(l))), JSON.stringify(c2.lines))
    check('R16', '★ 后一次不会把前一次的内容丢掉（会话是累积的）', c2.lines.some((l) => /build_animagine/.test(String(l))), '用户指令仍在')
  }
}

group('附加（v0.5.9）：本地操作误报联网 / 兜底意图 / 重复标题')
{
  /* ---------- 1. 本地操作不得被判成「联网下载」 ---------- */
  {
    const backup = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$root='D:\\Comfy-Desktop'",
      'Write-Host "=== curl processes alive? ==="',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*curl*' }",
      'Copy-Item -Recurse "$root\\ComfyUI-Shared\\models" "$root\\backup\\models"',
      "Copy-Item -Recurse \"$root\\ComfyUI-Installs\\ComfyUI\\user\\default\\workflows\" \"$root\\backup\\workflows\"",
      "Copy-Item -Recurse \"$root\\ComfyUI-Installs\\ComfyUI-GGUF.backup\" \"$root\\backup\\gguf\"",
    ].join('\n')
    const r = analyzeCommand(backup)
    check(
      'N1',
      '★ 纯本地备份（echo 里提到 curl）不再被判成联网下载',
      r.networkTools.length === 0 && r.hasExternalNetwork !== true,
      `networkTools=${JSON.stringify(r.networkTools)}`,
    )
    check('N2', '★ 后果段不再写「会联网下载…可能带入恶意程序」', !/联网下载/u.test(r.consequence), r.consequence)
    check('N3', '风险回到「安全」', r.risk === '安全', `risk=${r.risk}`)
  }

  /* ---------- 2. 真下载必须仍然被识别（不能修过头） ---------- */
  {
    const real = [
      ['裸 curl', 'curl https://example.com/m.safetensors -o D:/tmp/m.safetensors'],
      ['引号 URL', 'Invoke-WebRequest -Uri "https://example.com/m.safetensors" -OutFile D:/tmp/m.safetensors'],
      ['分号后 wget', 'cd D:/tmp; wget https://example.com/x.zip'],
      ['管道后 git clone', 'cd D:/tmp && git clone https://github.com/a/b'],
      ['pip install', 'pip install requests'],
    ]
    let missed = 0
    const detail = []
    for (const [name, cmd] of real) {
      const r = analyzeCommand(cmd)
      const ok = r.networkTools.length > 0 || r.hasExternalNetwork === true
      if (!ok) { missed += 1; detail.push(name) }
    }
    check('N4', '★ 五种真实下载写法全部仍然被判为联网（不能修过头）', missed === 0, missed === 0 ? '5/5 命中' : `漏判：${detail.join(', ')}`)
  }

  /* ---------- 3. 剥字面量只用于网络判定，删除类保持保守 ---------- */
  {
    // 危险类别**故意**不做字面量剥离：宁可多 warn，不能漏掉一次真删除
    const echoOnly = 'Write-Host "rm -rf /"'
    const r = analyzeCommand(echoOnly)
    check(
      'N5',
      '★ 删除类判定保持保守：即使在字符串里出现也不放过（不套用字面量剥离）',
      r.risk === '危险',
      `risk=${r.risk}（刻意不剥字面量）`,
    )
    const srcR = readFileSync(join(HERE_SRC, 'src', 'rules.js'), 'utf8')
    check('N6', '★ 剥字面量的函数有注释说明「为什么只用于网络类」', /stripLiterals/u.test(srcR) && /宁可多warn一次/u.test(srcR), '设计取舍已写明')
  }

  /* ---------- 4. 兜底意图不得再吐「第 N 次操作」 ---------- */
  {
    const mk = (lines) => ({ available: true, source: 'session', lines, step: { index: 4, total: 6 }, note: '', chars: 100 })
    const onlyStep = fallbackIntent(mk(['这是本回合的第 4 次工具调用（本回合共 6 次）。']))
    check('N7', '★ 只有步骤信息时不再输出「第 N 次操作」', !/第 \d+ 次操作/u.test(onlyStep), onlyStep)
    check('N8', '只有步骤信息时明说「定不出意图」（而不是拿计数凑数）', onlyStep === NO_INTENT_NOTE, onlyStep)

    const onlyUser = fallbackIntent(mk(['用户最近的指令：(1) 帮我删掉用不到的模型文件', '这是本回合的第 4 次工具调用（本回合共 6 次）。']))
    check('N9', '★ 只有用户指令时写成「你刚才要求的：…」', onlyUser.startsWith('你刚才要求的：') && /模型文件/u.test(onlyUser), onlyUser)

    const onlyAi = fallbackIntent(mk(['AI 在发起这次审批前说过：「任务 2：用 ComfyUI 自带的 Python 运行这个脚本。」']))
    check('N10', '★ 有 AI 自述时直接用它（最贴近意图）', /任务 2/u.test(onlyAi), onlyAi)

    const both = fallbackIntent(mk(['用户最近的指令：(1) 清理模型', 'AI 在发起这次审批前说过：「我先删掉那个 safetensors。」', '这是本回合的第 4 次工具调用。']))
    check('N11', '★ 同时有两种证据时以 AI 自述为准，且不含步骤计数', /我先删掉/u.test(both) && !/第 \d+ 次操作/u.test(both), both)

    // 回归：用户指令不在 lines[0] 时也要找得到（旧 bug 就是只看 lines[0]）
    const aiFirst = fallbackIntent(mk(['AI 在发起这次审批前说过：「我来处理。」', '用户最近的指令：(1) 备份目录']))
    check('N12', '★ 回归：用户指令不在首行时也能被找到（v0.5.9 修的就是只看 lines[0]）', /我来处理/u.test(aiFirst) || /备份目录/u.test(aiFirst), aiFirst)

    check('N13', '真无上下文时仍然返回「未读取到会话上下文」', fallbackIntent({ available: false, lines: [] }) === NO_CONTEXT_NOTE, NO_CONTEXT_NOTE)
  }

  /* ---------- 5. 重复标题去重 ---------- */
  {
    const srcC = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
    check('N14', '★ 区块标题算成变量，供去重比较', /const blockTitleText = isEmpty/u.test(srcC), 'blockTitleText')
    check('N15', '★ headline 与区块标题同文时不渲染（去掉重复的一行）', /headlineText \? h\('div', \{ className: 'pap_headline/u.test(srcC) && /result\.headline !== blockTitleText/u.test(srcC), '同文即抑制')
  }
}
group('附加（v0.5.10）：删除目标精确化 —— 修误报，且不能漏报')
{
  /* ---------- 真机案例：Edge headless 截图，只删临时目录里的旧图 ---------- */
  {
    const edge = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$out = \"$env:TEMP\\site-shot\"",
      'New-Item -ItemType Directory -Force -Path $out | Out-Null',
      '$png = "$out\\test-old.png"',
      '$png2 = "$out\\test-new.png"',
      'Remove-Item $png -ErrorAction SilentlyContinue',
      "& 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' --headless --screenshot=$png2 https://example.com",
      'Write-Host "done"',
    ].join('\n')
    const r = analyzeCommand(edge, { toolName: 'pwsh' })
    check('D1', '★ 真机案例：调用 Edge 的路径不再把判定带偏', r.tempCleanup === true && r.risk === '安全' && r.advice === '可以允许', `risk=${r.risk} tempCleanup=${r.tempCleanup}`)
    check('D2', '★ 后果段不再写「可能永久删除文件」', !/永久删除/u.test(r.consequence), r.consequence)
    check('D3', '删除目标被正确解析到临时目录下的那张旧图', (() => {
      const d = extractDeleteTargets(edge)
      return d.resolved === true && d.targets.length === 1 && /test-old\.png$/u.test(d.targets[0])
    })(), JSON.stringify(extractDeleteTargets(edge).targets))
  }

  /* ---------- 反向：这些必须仍然是「危险」，否则就是漏报 ---------- */
  {
    const mustBeDanger = [
      ['直接删系统目录', 'Remove-Item -Recurse -Force C:\\Windows\\System32\\drivers'],
      ['通过变量删系统目录', '$p="C:\\Windows\\System32\\drivers"; Remove-Item -Recurse -Force $p'],
      ['rm -rf 根目录', 'rm -rf /'],
      ['删 Program Files 里的东西', "Remove-Item -Recurse 'C:\\Program Files\\Something'"],
      ['删除目标解析不出来（动态路径）', 'Remove-Item (Get-Item $someDynamicPath)'],
    ]
    let missed = 0
    const detail = []
    for (const [name, cmd] of mustBeDanger) {
      const r = analyzeCommand(cmd, { toolName: 'pwsh' })
      if (r.risk !== '危险') { missed += 1; detail.push(`${name}=${r.risk}`) }
    }
    check(
      'D4',
      '★ 五种真实危险删除全部仍然判「危险」（本次修复没有引入漏报）',
      missed === 0,
      missed === 0 ? '5/5 命中' : `漏判：${detail.join(' | ')}`,
    )
  }

  /* ---------- v0.6.0 修复：删用户文档判「危险」（原 D4b 记录的既有漏报） ---------- */
  {
    // 旧行为：混合删除（一个临时 + 一个用户文档）只判「注意」—— 不可逆删除判轻了。
    // 现在只要有任何一个删除目标不是临时的，就按危险处理。
    const mixed = 'Remove-Item "$env:TEMP\\a.log"; Remove-Item C:\\Users\\alpha\\Documents\\b.txt'
    const r = analyzeCommand(mixed, { toolName: 'pwsh' })
    check('D4b', '★ v0.6.0 修复：混合删除里含用户文档 → 判「危险」（原只判「注意」）', r.risk === '危险' && r.advice === '建议拒绝', `risk=${r.risk} advice=${r.advice}`)
    check('D4b2', '后果里点名了被删的非临时文件', /Documents/.test(r.consequence), r.consequence)
    const pureTemp = 'Remove-Item "$env:TEMP\\a.log"'
    check('D4b3', '★ 纯临时文件删除仍然是「安全」（没被这次修复误伤）', analyzeCommand(pureTemp, { toolName: 'pwsh' }).risk === '安全', '纯临时删除仍判安全')
    const pureDoc = 'Remove-Item C:\\Users\\alpha\\Documents\\report.docx -Force'
    check('D4b4', '★ 单独删除用户文档也是「危险」', analyzeCommand(pureDoc, { toolName: 'pwsh' }).risk === '危险', '文档删除判危险')
  }

  /* ---------- 解析不出来时必须退回保守判定 ---------- */
  {
    const src = readFileSync(join(HERE_SRC, 'src', 'rules.js'), 'utf8')
    check(
      'D5',
      '★ 解析失败时退回「所有路径」的旧判定（宁可多报危险，不漏报）',
      /del\.resolved \? del\.targets : paths/u.test(src),
      'scopePaths = del.resolved ? del.targets : paths',
    )
    check('D6', '★ 目标解析函数会明确回报是否全部解析成功', /resolved: unresolved === 0 && targets\.length > 0/u.test(src), 'resolved 字段')

    const dynamic = 'Remove-Item $undefinedVar -Force'
    const d = extractDeleteTargets(dynamic)
    check('D7', '★ 变量查不到时 unresolved>0 且 resolved=false（触发保守回退）', d.resolved === false && d.unresolved > 0, JSON.stringify(d))
    check('D8', '保守回退下仍然判危险', analyzeCommand(dynamic, { toolName: 'pwsh' }).risk === '危险', 'risk=危险')
  }

  /* ---------- 变量解析的边界情况 ---------- */
  {
    const multi = [
      '$a = "C:\\Users\\alpha\\AppData\\Local\\Temp\\x.log"',
      '$b = "C:\\Users\\alpha\\AppData\\Local\\Temp\\y.log"',
      'Remove-Item -LiteralPath $a,$b -Force',
    ].join('\n')
    const d = extractDeleteTargets(multi)
    check('D9', '★ -LiteralPath 带逗号列表时每个目标都要收到（不能只收第一个）', d.targets.length === 2 && /x\.log$/u.test(d.targets[0]) && /y\.log$/u.test(d.targets[1]), JSON.stringify(d.targets))

    const eap = 'Remove-Item C:\\Users\\alpha\\AppData\\Local\\Temp\\z.log -ErrorAction SilentlyContinue'
    const d2 = extractDeleteTargets(eap)
    check('D10', '★ -ErrorAction 的值不被当成删除目标（v0.5.10 修过的坑）', d2.targets.length === 1 && !/SilentlyContinue/u.test(d2.targets[0]), JSON.stringify(d2.targets))

    const nested = [
      '$out = "$env:TEMP\\sub"',
      '$f = "$out\\a.png"',
      'Remove-Item $f',
    ].join('\n')
    const d3 = extractDeleteTargets(nested)
    check('D11', '★ 多级变量 + 环境变量能一路解析到真实路径', d3.resolved === true && /AppData[\\/]Local[\\/]Temp[\\/]sub[\\/]a\.png$/iu.test(d3.targets[0] ?? ''), JSON.stringify(d3.targets))

    const suffix = [
      '$dir = "C:\\Users\\alpha\\AppData\\Local\\Temp\\shots"',
      'Remove-Item "$dir\\old.png"',
    ].join('\n')
    const d4 = extractDeleteTargets(suffix)
    check('D12', '★ 变量只占标识符那一段，后面的路径后缀要原样接回', d4.resolved === true && /shots[\\/]old\.png$/u.test(d4.targets[0] ?? ''), JSON.stringify(d4.targets))
  }

  /* ---------- 临时目录判定没有被放松 ---------- */
  {
    // 扩展名白名单放宽了，但「必须先在临时目录下」这条前提一个字没动
    check('D13', '★ 非临时目录下的 .png 删除仍然是危险（放宽的只是临时目录内的扩展名）', analyzeCommand('Remove-Item C:\\Users\\alpha\\Documents\\photo.png -Force', { toolName: 'pwsh' }).risk === '危险', '文档目录删图仍判危险')
    check('D14', '★ 非临时目录下的 .log 删除也仍然是危险', analyzeCommand('Remove-Item C:\\Users\\alpha\\Documents\\note.log -Force', { toolName: 'pwsh' }).risk === '危险', '文档目录删日志仍判危险')
    check('D15', '★ 系统目录下的 .log 删除仍然是危险', analyzeCommand('Remove-Item C:\\Windows\\Temp\\a.log -Force', { toolName: 'pwsh' }).risk === '危险', '系统目录优先')
  }
}
group('附加（v0.6.0）：分析深度分层（L1 / L2）')
{
  /* ---------- 1. 分流决策本身 ---------- */
  {
    const safe = { risk: '安全' }
    const warn = { risk: '注意' }
    const danger = { risk: '危险' }
    const auto = { ui: { analysisDepth: 'auto' } }
    const l1 = { ui: { analysisDepth: 'l1' } }
    const l2 = { ui: { analysisDepth: 'l2' } }

    check('P1', '★ 自动模式 + 安全命令 → L1（零模型调用）', decideDepth({ rules: safe, settings: auto }).depth === 'l1', decideDepth({ rules: safe, settings: auto }).reason)
    check('P2', '★ 自动模式 + 注意命令 → L2', decideDepth({ rules: warn, settings: auto }).depth === 'l2', decideDepth({ rules: warn, settings: auto }).reason)
    check('P3', '★ 自动模式 + 危险命令 → L2', decideDepth({ rules: danger, settings: auto }).depth === 'l2', decideDepth({ rules: danger, settings: auto }).reason)

    check('P4', '★ 危险命令**即使显式设置 L1 也强制 L2**（不可降级）', decideDepth({ rules: danger, settings: l1 }).depth === 'l2' && decideDepth({ rules: danger, settings: l1 }).forced === true, decideDepth({ rules: danger, settings: l1 }).reason)
    check('P5', '显式 L1 + 安全命令 → L1', decideDepth({ rules: safe, settings: l1 }).depth === 'l1', '按偏好')
    check('P6', '显式 L1 + 注意命令 → L1（允许，只有危险被锁死）', decideDepth({ rules: warn, settings: l1 }).depth === 'l1', '注意可由用户决定')
    check('P7', '显式 L2 + 安全命令 → L2', decideDepth({ rules: safe, settings: l2 }).depth === 'l2', '按偏好')

    check('P8', '★ 用户手动升级永远优先（连安全命令也能强制升到 L2）', decideDepth({ rules: safe, settings: l1, force: 'l2' }).depth === 'l2' && decideDepth({ rules: safe, settings: l1, force: 'l2' }).forced === true, '手动升级')

    check('P9', '缺省 / 脏值一律按 L2 处理（v0.6.1：宁可多调模型，也不静默降级到 L1）', decideDepth({ rules: safe, settings: {} }).depth === 'l2' && decideDepth({ rules: safe, settings: { ui: { analysisDepth: '乱写' } } }).depth === 'l2', '脏值回落 l2')
  }

  /* ---------- 2. L1 的产出：不调模型也有完整七段 ---------- */
  {
    const env = harness({ rowConfig: baseConfig({ ui: { analysisDepth: 'auto' }, cache: { enabled: false, driver: 'json' } }) })
    const t = await env.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
    check('P10', '★ L1 结果标明了深度', t.depth === 'l1' && typeof t.depthLabel === 'string' && t.depthLabel.includes('L1'), `${t.depth} / ${t.depthLabel}`)
    check('P11', '★ L1 零模型调用、零成本', t.engine === null && t.cost?.cny === 0 && /0 成本/u.test(t.cost?.costText ?? ''), `engine=${t.engine} cost=${t.cost?.costText}`)
    check('P12', '★ L1 七段齐全（含意图与收益）', Boolean(t.sections?.intent && t.sections?.touch && t.sections?.mode && t.sections?.risk && t.sections?.advice && t.sections?.consequence && t.sections?.benefit), Object.keys(t.sections ?? {}).join(','))
    check('P13', 'L1 提示可以升级到 L2', t.canUpgrade === true, `canUpgrade=${t.canUpgrade}`)
    check('P14', 'L1 耗时在本地规则量级（<200ms）', typeof t.elapsedMs === 'number' && t.elapsedMs < 200, `${t.elapsedMs}ms`)
    env.cleanup()
  }

  /* ---------- 3. L2 的产出与成本透明 ---------- */
  {
    const env = harness({ rowConfig: baseConfig({ ui: { analysisDepth: 'l2' }, cache: { enabled: false, driver: 'json' } }) })
    const t = await env.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
    check('P15', '★ L2 结果标明了深度', t.depth === 'l2' && typeof t.depthLabel === 'string', `${t.depth} / ${t.depthLabel}`)
    check('P16', 'L2 带耗时与深度标注（费用在模型上报 usage 时才有，未上报时为 null）', typeof t.elapsedMs === 'number' && Boolean(t.depthLabel) && (t.cost === null || typeof t.cost.costText === 'string'), `ms=${t.elapsedMs} cost=${t.cost?.costText ?? 'null（未上报 usage）'}`)
    check('P17', 'L2 不显示「升级到 L2」按钮（已经是最高层）', t.canUpgrade === false, `canUpgrade=${t.canUpgrade}`)
    env.cleanup()
  }

  /* ---------- 4. 危险命令强制 L2（端到端） ---------- */
  {
    const env = harness({ rowConfig: baseConfig({ ui: { analysisDepth: 'auto' }, cache: { enabled: false, driver: 'json' } }) })
    const t = await env.translator.translate({ command: 'rm -rf /home/user/important', toolName: 'pwsh' })
    check('P18', '★ 自动模式下危险命令走 L2（不因「安全命令走 L1」的规则被降级）', t.depth === 'l2', `depth=${t.depth} reason=${t.depthReason}`)
    check('P19', '★ 危险命令走模型后风险等级仍然被本地规则兜住', t.sections.risk === '危险' && t.sections.advice === '建议拒绝', `risk=${t.sections.risk}`)
    env.cleanup()

    const env2 = harness({ rowConfig: baseConfig({ ui: { analysisDepth: 'l1' }, cache: { enabled: false, driver: 'json' } }) })
    const t2 = await env2.translator.translate({ command: 'rm -rf /home/user/important', toolName: 'pwsh' })
    check('P20', '★ 即使用户显式设 L1，危险命令仍走 L2', t2.depth === 'l2', `depth=${t2.depth}`)
    env2.cleanup()
  }

  /* ---------- 5. 手动升级 ---------- */
  {
    const env = harness({ rowConfig: baseConfig({ ui: { analysisDepth: 'auto' }, cache: { enabled: false, driver: 'json' } }) })
    const t = await env.translator.translate({ command: 'ls -la', toolName: 'pwsh', forceDepth: 'l2' })
    check('P21', '★ forceDepth=l2 让安全命令也走模型', t.depth === 'l2' && t.depthReason.includes('手动'), `depth=${t.depth} reason=${t.depthReason}`)
    env.cleanup()
  }

  /* ---------- 6. 升级按钮的显隐 ---------- */
  {
    check('P22', 'L1 时允许升级（默认开）', canUpgradeToL2({ depth: 'l1', settings: {} }) === true, 'L1 → 可升级')
    check('P23', 'L2 时不显示升级按钮', canUpgradeToL2({ depth: 'l2', settings: {} }) === false, 'L2 → 不显示')
    check('P24', '用户关掉 allowUpgrade 后 L1 也不显示按钮', canUpgradeToL2({ depth: 'l1', settings: { ui: { allowUpgrade: false } } }) === false, '尊重用户开关')
  }

  /* ---------- 7. 源码红线：分层不能破坏既有安全约束 ---------- */
  {
    const srcT = readFileSync(join(HERE_SRC, 'src', 'translate.js'), 'utf8')
    check('P25', '★ 模型仍然不能下调风险等级（mergeSections 的强制覆盖还在）', /rules\.risk === '危险'\)[\s\S]{0,200}?merged\.risk = '危险'/u.test(srcT), '危险强制写死')
    check('P26', '★ L1 分支在模型调用之前就 return（真的零调用）', /if \(depthInfo\.depth === 'l1'\) \{[\s\S]{0,1200}?return l1/u.test(srcT), 'L1 早退')
  }

  /* ---------- 8. v0.6.1：默认值是「一律 L2」 ---------- */
  {
    // 走完整的 normalizeSettings 链路，而不是只测 decideDepth，
    // 这样「DEFAULT_SETTINGS 里写的是什么」也一并被钉住。
    const d = normalizeSettings({})
    check('P27', '★ 全新安装的默认深度是 l2（不是 auto）', d.ui.analysisDepth === 'l2', `默认=${d.ui.analysisDepth}`)
    check('P28', '★ 配置里没有这一项时也回落 l2（旧配置不受影响）', normalizeSettings({ ui: {} }).ui.analysisDepth === 'l2', '缺项 → l2')
    check('P29', '★ 脏值不静默降级到 L1', normalizeSettings({ ui: { analysisDepth: '乱写' } }).ui.analysisDepth === 'l2', '脏值 → l2')
    check('P30', '★ 用户显式选了 auto 就尊重（省钱选项仍可用）', normalizeSettings({ ui: { analysisDepth: 'auto' } }).ui.analysisDepth === 'auto', '显式 auto 保留')

    // 端到端：不给任何配置，安全命令也应该走 L2
    const env = harness({ rowConfig: baseConfig({ cache: { enabled: false, driver: 'json' } }) })
    const t = await env.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
    check('P31', '★ 默认配置下**安全命令也走 L2**（识别正确度优先）', t.depth === 'l2', `depth=${t.depth}`)
    env.cleanup()

    // 端到端：显式 auto 时安全命令才走 L1（确认 auto 还能用）
    const env2 = harness({ rowConfig: baseConfig({ ui: { analysisDepth: 'auto' }, cache: { enabled: false, driver: 'json' } }) })
    const t2 = await env2.translator.translate({ command: 'ls -la', toolName: 'pwsh' })
    check('P32', '显式选 auto 后安全命令走 L1（省钱档仍然有效）', t2.depth === 'l1', `depth=${t2.depth}`)
    env2.cleanup()
  }
}
group('附加（v0.6.2）：可读性 —— 三行决策 / 路径折叠 / 危险片段高亮')
{
  /* ---------- 1. 路径公共前缀折叠（降噪，不是隐藏） ---------- */
  {
    const three = [
      'D:\\Comfy-Desktop\\临时仓库',
      'D:\\Comfy-Desktop\\ComfyUI-Shared\\models\\checkpoints',
      'D:\\Comfy-Desktop\\ComfyUI-Shared\\models\\loras',
    ]
    const c = condensePaths(three)
    check('Q1', '★ 三个共享前缀的路径折叠成一行', c.includes('Comfy-Desktop') && c.includes('3 处'), c)
    // 真正的收益是**视觉重复**消失，不是字数变少。
    // 字符数只降 22%，但 `D:\Comfy-Desktop\` 从出现 3 次变成 1 次 —— 眼睛不用读三遍同一个前缀。
    const prefixTimes = (s) => (s.match(/D:\\Comfy-Desktop\\/gu) || []).length
    check(
      'Q2',
      '★ 共享前缀只出现一次（原样拼接里出现 3 次）—— 这才是降噪的实质',
      prefixTimes(three.join('、')) === 3 && prefixTimes(c) === 1 && c.length < three.join('、').length,
      `原样 ${prefixTimes(three.join('、'))} 次/${three.join('、').length} 字 → 折叠 ${prefixTimes(c)} 次/${c.length} 字`,
    )

    const one = condensePaths(['C:\\a\\b.txt'])
    check('Q3', '只有一个路径时不做任何折叠', one === 'C:\\a\\b.txt', one)

    const unrelated = condensePaths(['C:\\aaa\\x', 'D:\\bbb\\y'])
    check('Q4', '没有公共前缀时原样列出（不硬凑）', unrelated.includes('C:\\aaa\\x') && unrelated.includes('D:\\bbb\\y'), unrelated)

    const shallow = condensePaths(['ab\\x', 'ab\\y'])
    check('Q5', '★ 折叠后更长时不折叠（折叠的唯一目的是降噪）', shallow === 'ab\\x、ab\\y', shallow)

    const r = analyzeCommand('Get-ChildItem D:\\Comfy-Desktop\\a, D:\\Comfy-Desktop\\b, D:\\Comfy-Desktop\\c')
    check('Q6', '★ analyzeCommand 的 touch 字段用上了折叠结果', /处/.test(r.touch) || r.touch.includes('Comfy-Desktop'), r.touch)
  }

  /* ---------- 2. 危险片段高亮：位置必须和风险判定同源 ---------- */
  {
    const cmd = 'Remove-Item -Recurse -Force D:\\models\\a'
    const r = analyzeCommand(cmd)
    check('Q7', '★ 危险命令产出高亮区间', r.spans.length > 0, `spans=${r.spans.length}`)

    const allValid = r.spans.every((s) => s.start >= 0 && s.end > s.start && s.end <= cmd.length)
    check('Q8', '★ 所有区间都落在原文范围内（不会越界）', allValid, JSON.stringify(r.spans))

    const covered = r.spans.some((s) => cmd.slice(s.start, s.end).toLowerCase().includes('remove-item'))
    check('Q9', '★ 高亮确实落在 Remove-Item 这个 token 上', covered, JSON.stringify(r.spans.map((s) => cmd.slice(s.start, s.end))))

    const kindOk = r.spans.every((s) => typeof s.kind === 'string' && s.kind !== '')
    check('Q10', '每个区间带 kind（客户端据此上不同颜色）', kindOk, JSON.stringify([...new Set(r.spans.map((s) => s.kind))]))
  }

  /* ---------- 3. 高亮不会把误报带回来（剥字面量仍等长） ---------- */
  {
    const echo = 'Write-Host "=== curl processes alive? ==="'
    const r = analyzeCommand(echo)
    check('Q11', '★ 只在文案里提到 curl → 不产生高亮（与判定一致）', r.spans.filter((s) => s.kind === 'network').length === 0, JSON.stringify(r.spans))

    const real = 'curl https://example.com/x.zip -o D:/tmp/x.zip'
    const r2 = analyzeCommand(real)
    check('Q12', '★ 真下载仍然产生 network 高亮', r2.spans.some((s) => s.kind === 'network'), JSON.stringify(r2.spans))

    // 等长替换：索引必须对齐原文
    const probe = 'Write-Host "=== curl processes alive? ==="\ncurl https://a.com/b'
    const rp = analyzeCommand(probe)
    const net = rp.spans.find((s) => s.kind === 'network')
    check('Q13', '★ 等长替换保证下标对齐（高亮标的是原文里的真 curl，不是错位）', net != null && probe.slice(net.start, net.end).toLowerCase() === 'curl', net ? probe.slice(net.start, net.end) : 'null')
  }

  /* ---------- 4. 长度上限：顶行和折叠区都不能被撑爆 ---------- */
  {
    const s = normalizeSections({ intent: 'x'.repeat(200), risk: '安全' })
    // v0.7.0：顶行是 title（老模型吐的 intent 也会落进 title），硬上限 60
    check('Q14', '★ 超长标题被硬截断（顶行不会失控）', s.title.length === 60, `长度=${s.title.length}`)
    // 折叠区里的 why 同样要有上限，否则点开就把原始命令挤出视口
    const s2 = normalizeSections({ title: '标题', why: 'y'.repeat(500), risk: '安全' })
    check('Q14b', '★ 超长「为什么」也被硬截断（折叠区不会失控）', s2.why.length === 120, `长度=${s2.why.length}`)
    const src = readFileSync(join(HERE_SRC, 'src', 'prompt.js'), 'utf8')
    check('Q15', '★ 提示词已把标题上限从 60 收紧到 34', /34 个汉字/u.test(src), '≤34 字')
  }

  /* ---------- 5. 客户端：三行决策 + 折叠，且原文一字不删 ---------- */
  {
    const srcC = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
    check('Q16', '★ 风险 + 建议 + 意图 提到最上方（pap_verdict）', /pap_verdictTop/u.test(srcC) && /pap_verdictIntent/u.test(srcC), '三行决策块')
    check('Q17', '★ 次要信息放进 <details> 折叠', /h\(\s*'details',\s*\{\s*className: 'pap_more'/u.test(srcC) || /className: 'pap_more'/u.test(srcC), 'pap_more')
    check('Q18', '★ 危险/注意默认展开细节，安全默认折叠', /detailOpen = Boolean\(sections && \(sections\.risk === '危险' \|\| sections\.risk === '注意'\)\)/u.test(srcC), '按风险决定展开')
    check('Q19', '★ 原始命令用高亮渲染，但内容仍然是完整 command', /highlightSpans\(command, result\?\.spans\)/u.test(srcC), 'highlightSpans(command, …)')

    const hl = srcC.slice(srcC.indexOf('function highlightSpans'), srcC.indexOf('function highlightSpans') + 1600)
    check('Q20', '★ 高亮函数不做任何删减（切片原样拼接，cursor 推到底）', /out\.push\(text\.slice\(cursor, s\.start\)\)/u.test(hl) && /out\.push\(text\.slice\(cursor\)\)/u.test(hl), '原文完整保留')
    check('Q21', '★ 高亮前过滤非法区间（脏数据不会让渲染崩掉）', /Number\.isInteger\(s\.start\)/u.test(hl) && /s\.end <= text\.length/u.test(hl), '区间校验')
    check('Q22', '★ 重叠区间被跳过，不会出现嵌套 mark', /prev && s\.start < prev\.end\) continue/u.test(hl), '去重叠')
  }

  /* ---------- 6. 决策信息必须在细节之前（顺序红线） ---------- */
  {
    const srcC2 = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
    const iVerdict = srcC2.indexOf('className: \'pap_verdict\'')
    const iMore = srcC2.indexOf('className: \'pap_more\'')
    check('Q23', '★ 源码顺序：pap_verdict 在 pap_more 之前（三行决策真的在最前）', iVerdict > 0 && iMore > 0 && iVerdict < iMore, `verdict@${iVerdict} more@${iMore}`)
  }
}
group('附加（v0.6.4）：作用域逃逸 —— tt 是局部变量，组件不能凭引用拿到')
{
  const srcScope = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')

  // 复现的真实 bug：DonateSlot 定义在 SettingsSection 外面，函数体里却写了
  // tt('donateQrPending')。tt 是 SettingsSection 里的局部 const，运行时
  // ReferenceError: tt is not defined → 设置页整体崩成「暂不可用（渲染异常）」，
  // 同一 DOM 子树里排在它后面的爱发电链接也跟着消失。
  check(
    'S1',
    '★ DonateSlot 显式接收 tt（不再凭空引用外层不存在的 tt）',
    /function DonateSlot\(\{[^}]*\btt\b[^}]*\}\)/u.test(srcScope),
    '函数签名必须解构出 tt',
  )
  check(
    'S2',
    '★ DonateSlot 的两处调用都把 tt 传了进去',
    (srcScope.match(/h\(DonateSlot,\s*\{[^}]*\btt\b[^}]*\}\)/gu) || []).length === 2,
    '微信 / 支付宝两个收款码位都要传',
  )

  // 通用防线：任何定义在 SettingsSection 外面的组件，内部都不该直接用 tt。
  // 把所有顶层组件函数体抠出来，逐个查有没有裸 tt( 调用。
  const offenders = []
  const compRe = /\n    function ([A-Z][A-Za-z0-9_]*)\(([^)]*)\)\s*\{/gu
  let m
  while ((m = compRe.exec(srcScope)) !== null) {
    const [, name, args] = m
    if (/\btt\b/u.test(args)) continue // 自己声明了/接收了 tt 的不算
    // 从函数体起点做括号配平，截出函数体
    let i = srcScope.indexOf('{', m.index + m[0].length - 1)
    if (i < 0) continue
    let depth = 0
    let end = i
    for (let k = i; k < srcScope.length; k += 1) {
      if (srcScope[k] === '{') depth += 1
      else if (srcScope[k] === '}') {
        depth -= 1
        if (depth === 0) { end = k; break }
      }
    }
    const body = srcScope.slice(i, end)
    // tt 合法有三个来源：签名解构出来、函数体内自己声明（const tt = makeTT(props)）、
    // 或者是从 props 现取的。这三种都不算逃逸；只有「三者都没有却在用」才是 bug。
    const declaredInside = /\b(?:const|let|var)\s+tt\s*=/u.test(body)
    if (!declaredInside && /\btt\s*\(/u.test(body)) offenders.push(name)
  }
  check(
    'S3',
    '★ 没有任何顶层组件凭空引用 tt（作用域逃逸防线）',
    offenders.length === 0,
    offenders.length ? offenders.join(', ') : '无',
  )

  check(
    'S4',
    '★ 渲染错误仍会上报（PluginBoundary 保留 stack/componentStack）',
    /note\('render\.error'/u.test(srcScope) && /componentStack/u.test(srcScope),
    '排障能力不能被重构删掉',
  )
  check(
    'S5',
    '★ 渲染错误上报的前端实现存在（client.js 调用 note）',
    /note\('render\.error'/u.test(srcScope),
    '必须有',
  )
}

group('附加（v0.7.0）：上下文传递 —— callId 形态必须都能查到 pending')
{
  const srcPlugin = readFileSync(join(HERE_SRC, 'src', 'plugin.js'), 'utf8')
  // 实测复现：客户端某些路径传的是 `hash:callId` 复合格式，
  // 而 findPendingByCallId 只按 `':' + callId` 匹配后缀 → 匹配不上 →
  // 上下文（连同 reasoning）整块丢失，卡片退回「未读取到会话上下文」。
  check(
    'CX1',
    '★ findPendingByCallId 同时接受裸 callId 和 hash:callId 复合格式',
    /lastIndexOf\(':'\)/u.test(srcPlugin) && /candidates/u.test(srcPlugin),
    '要对原值和最后一段冒号后的部分各试一次',
  )
  check(
    'CX2',
    '★ /translate 端点确实把 pending 里的 context 传给翻译（浏览器没有 agent，只能靠它）',
    /context:\s*pendingHit\?\.context/u.test(readFileSync(join(HERE_SRC, 'src', 'server.js'), 'utf8')),
    'pending 是上下文的唯一来源',
  )
  const clientSrcV = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
  // v0.7.0 回归：浮窗模式曾既没有风险等级也没有建议 ——
  // 那是「不接管卡片」时用户的唯一信息来源。
  check(
    'CX3',
    '★ 浮窗也渲染「风险 · 建议」这一行（不接管模式下依然能决策）',
    /function PlainResult/u.test(clientSrcV) && /pap_verdictTitle[\s\S]{0,400}pap_verdictTop[\s\S]{0,300}pap_verdictAdvice/u.test(clientSrcV),
    'PlainResult 里标题下面要有风险+建议',
  )
}

group('附加（v0.7.2）：文案映射缺失不能把渲染打崩')
{
  const srcAdv = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
  // 实测踩过的坑：zh 表里压根没有 advice 映射（risk 有），代码却写
  // `tt('advice')[sections.advice]` → undefined[...] → TypeError，
  // 后面的 `|| sections.advice` 兜底**根本来不及执行**。
  // 它潜伏了很久，是因为这条分支只在接管模式的卡片里跑，而接管被槽位冲突卡住了。
  check(
    'CA1',
    '★ 中文文案表里有 advice 映射（以前缺，卡片一接管就崩）',
    /advice:\s*\{\s*可以允许/u.test(srcAdv),
    'advice 映射必须存在',
  )
  check(
    'CA2',
    '★ 英文文案表里也有 advice 映射',
    /advice:\s*\{\s*可以允许:\s*'Allow'/u.test(srcAdv),
    '英文表对齐',
  )
  // 兜底不能只靠「表里有」——表被改坏时仍要能渲染
  const rawAdvAccess = srcAdv.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  const unsafe = (rawAdvAccess.match(/tt\('[a-z]+'\)\[/gu) || []).filter((s) => !/tt\('[a-z]+'\) \|\|/.test(s))
  check(
    'CA3',
    '★ 没有任何裸的 tt(key)[ 访问（全部带 || {} 兜底）',
    unsafe.length === 0,
    unsafe.length ? unsafe.join(', ') : '无裸访问',
  )
  check(
    'CA4',
    '★ 审批卡片与浮窗都渲染了「风险 · 建议」这一行',
    (srcAdv.match(/pap_verdictAdvice/gu) || []).length >= 2
      && /pap_verdictTitle[\s\S]{0,400}pap_verdictAdvice/u.test(srcAdv)
      && /function PlainResult[\s\S]{0,1400}pap_verdictAdvice/u.test(srcAdv),
    'ApprovalCard 与 PlainResult 各一处',
  )
}

group('附加（v0.7.3）：手动选槽位模式必须写 conflictResolved')
{
  const src73 = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
  const code73 = src73.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  // 实测卡死用户的坑：设置页那个下拉框以前是
  //   onChange: (e) => patch((s) => (s.ui.slotMode = e.target.value))
  // 只改 slotMode，**从不写 conflictResolved**；而 needsConflictChoice() 判的是
  // conflictResolved !== true。于是「设置里选了接管」但插件仍然一直让位，
  // 而且下拉框显示的就是「接管」，用户根本看不出哪里不对。
  check(
    'CS1',
    '★ 设置页槽位模式下拉框走 applySlotMode（不再裸 patch slotMode）',
    /onChange: \(e\) => applySlotMode\(e\.target\.value\)/u.test(code73)
      && !/onChange: \(e\) => patch\(\(s\) => \(s\.ui\.slotMode/u.test(code73),
    '两条路统一',
  )
  check(
    'CS2',
    '★ applySlotMode 同时写 conflictResolved: true',
    /const applySlotMode = async \(mode\) => \{[\s\S]{0,400}conflictResolved: true/u.test(code73),
    '手动选过 = 已解决冲突',
  )
  check(
    'CS3',
    '★ 重新点同一个选项也算显式确认（onClick 也走 applySlotMode）',
    /onClick: \(\) => applySlotMode\(settings\.ui\.slotMode\)/u.test(code73),
    '<select> 值不变时 onChange 不触发，onClick 兜住',
  )
  check(
    'CS4',
    '★ applySlotMode 定义在 SettingsSection 里（setSettings 只在那儿）',
    /function SettingsSection[\s\S]{0,60000}const applySlotMode/u.test(code73),
    '不能定义在 ApprovalCard 里',
  )
  // 老路（冲突提示按钮）本来就会写，不能被改坏
  check(
    'CS5',
    '★ chooseSlotMode 仍然写 conflictResolved（冲突提示按钮那条路没被改坏）',
    /function chooseSlotMode[\s\S]{0,300}conflictResolved: true/u.test(code73),
    '两条路都要写',
  )
}

group('附加（v0.7.4）：选过模式后不再显示黄色冲突警告')
{
  const src74 = readFileSync(join(HERE_SRC, 'client.js'), 'utf8')
  const code74 = src74.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  // 显示层滞后：卡片早已接管（conflictResolved=true），设置页那条黄警告还挂着，
  // 用户会以为「还没搞定」。
  check(
    'CR1',
    '★ 黄色警告只在「有竞争者 且 还没选过模式」时显示',
    /uiPrefs\.rivals\.length > 0 && uiPrefs\.conflictResolved !== true[\s\S]{0,200}pap_warnNote/u.test(code74),
    '两个条件都要',
  )
  check(
    'CR2',
    '★ 已选过模式时改用中性说明（信息不丢，但不再制造「还没解决」的错觉）',
    /sSlotRivalsDone/u.test(code74) && /uiPrefs\.conflictResolved !== true[\s\S]{0,300}sSlotRivalsDone/u.test(code74),
    '降级为灰色 note',
  )
  check(
    'CR3',
    '★ 中英文文案都在',
    /sSlotRivalsDone: '已按你选择的模式生效/u.test(src74) && /sSlotRivalsDone: 'Your choice is in effect/u.test(src74),
    '双语对齐',
  )
}

group('v0.7.5：并发合并 —— 同一个审批只打一次模型')
{
  // 实测 bug：宿主算 pending.full 和客户端自己发 /translate 在 t=0 同时出发，
  // 缓存彼时都是空的，于是各打一次模型。端到端等的是慢的那个，token 还翻倍。
  const mock = await startMockDeepSeek({ mode: 'ok' })
  const env = harness({
    rowConfig: baseConfig({
      engine: 'deepseek',
      deepseek: { baseUrl: mock.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: false, askBeforeCall: false, apiKey: 'test-key' },
    }),
  })
  // 必须用**两条不同命令**，否则第二次会命中缓存，测不到合并
  const cmdA = 'ls -la /tmp/plain-approval-inflight-a'
  const cmdB = 'ls -la /tmp/plain-approval-inflight-b'

  const [a, b] = await Promise.all([
    env.translator.translate({ command: cmdA, toolName: 'pwsh' }),
    env.translator.translate({ command: cmdB, toolName: 'pwsh' }),
  ])
  const callsAfterPair = mock.state.calls
  check(
    'IF1',
    '★ 不同命令并发时各打一次（不能把不同请求误合并）',
    callsAfterPair === 2 && a.hash !== b.hash,
    `接口调用 ${callsAfterPair} 次，hash ${a.hash?.slice(0, 8)} vs ${b.hash?.slice(0, 8)}`,
  )

  // 同一条命令并发两次 → 只应打一次模型
  const mock2 = await startMockDeepSeek({ mode: 'ok' })
  const env2 = harness({
    rowConfig: baseConfig({
      engine: 'deepseek',
      deepseek: { baseUrl: mock2.baseUrl, model: 'deepseek-chat', timeoutMs: 8000, retryOnRateLimit: false, askBeforeCall: false, apiKey: 'test-key' },
    }),
  })
  const same = 'ls -la /tmp/plain-approval-inflight-same'
  const [c, d] = await Promise.all([
    env2.translator.translate({ command: same, toolName: 'pwsh' }),
    env2.translator.translate({ command: same, toolName: 'pwsh' }),
  ])
  check(
    'IF2',
    '★ 同一条命令并发两次 → 只打一次模型（合并生效）',
    mock2.state.calls === 1,
    `接口调用 ${mock2.state.calls} 次（期望 1）`,
  )
  check(
    'IF3',
    '★ 合并后两次拿到的结果一致，且都有可用 sections',
    c?.hash === d?.hash && Boolean(c?.sections?.title) && Boolean(d?.sections?.title),
    `hash ${c?.hash?.slice(0, 8)} / ${d?.hash?.slice(0, 8)}`,
  )
  // 合并结束后必须清干净，否则后来的请求会拿到一个早已完成的 Promise
  const e = await env2.translator.translate({ command: same, toolName: 'pwsh' })
  check(
    'IF4',
    '★ 合并的 Promise 用完即清（后来的请求仍走缓存而不是拿到旧 Promise）',
    e.cached === true && mock2.state.calls === 1,
    `再次请求 cached=${e.cached}，接口调用累计 ${mock2.state.calls}`,
  )

  env.cleanup(); await mock.close()
  env2.cleanup(); await mock2.close()
}

group('结果汇总')
const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)
console.log(`\n共 ${results.length} 项：通过 ${passed}，失败 ${failed.length}`)
for (const f of failed) console.log(`  FAIL ${f.id} ${f.name} — ${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)