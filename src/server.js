/**
 * HTTP 接口层：客户端（浏览器）通过它拿到翻译、状态、设置和日志。
 *
 * 为什么不用 remote 事件：`approval/request` 是白名单里的转发事件，第三方插件
 * 不能新增事件（Host 侧只有一个事件源名额）。HTTP 路由是文档认可的通路，
 * 而且天然支持「审批卡片先显示、翻译结果后到」的异步体验 —— 绝不阻塞审批。
 *
 * ⚠️ 前缀不能带尾斜杠！
 * dsh-host-webserver 的 `match()` 判定是 `pathname.startsWith(prefix + '/')`，
 * 所以注册 `/api/plain-approval/` 会让 `/api/plain-approval/status` **匹配不上**，
 * 请求落到 dsh-client-connection 注册的 `/api` 上，浏览器里表现为 **HTTP 404**。
 * 正确写法是注册 `/api/plain-approval`（无尾斜杠），客户端再拼 `/status`。
 *
 * 安全：只监听 webserver 配置的 127.0.0.1，写操作要求自定义头（挡跨站表单），
 * 并且永远不回传 API Key 原文。
 * @module dsh-plain-approval/server
 */
import { safeParse, oneLine } from './util.js'
import { analyzeCommand } from './rules.js'
import { DECISION_LABELS, RANGE_DAYS } from './history.js'
import { checkOllama } from './engines/ollama.js'
import { localRisk } from './device.js'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 路由前缀：**无尾斜杠**（见文件头说明）。 */
export const API_PREFIX = '/api/plain-approval'
/** 客户端拼接用的基址：**带尾斜杠**，保证拼出 /api/plain-approval/xxx。 */
export const API_BASE = API_PREFIX + '/'
const REQUIRED_HEADER = 'x-plain-approval'

/** 读取请求体（上限 256KB）。 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      resolve(text === '' ? {} : safeParse(text, null))
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* 连接可能已断开 */
  }
}

function sendText(res, status, text, filename) {
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  }
  if (filename) headers['content-disposition'] = `attachment; filename="${filename}"`
  try {
    res.writeHead(status, headers)
    res.end(text)
  } catch {
    /* 忽略 */
  }
}

function isLocalRequest(req) {
  const host = String(req.headers?.host ?? '')
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(host) || host === ''
}

/** `/api/plain-approval/status` → `status`。 */
export function routeOf(pathname) {
  if (pathname === API_PREFIX) return ''
  if (!pathname.startsWith(API_BASE)) return null
  return pathname.slice(API_BASE.length).replace(/^\/+/u, '')
}

/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {Function} deps.getSettings
 * @param {Function} deps.saveSettings
 * @param {object} deps.translator
 * @param {object} deps.logger
 * @param {object} deps.store
 * @param {object} deps.cache
 * @param {Function} [deps.listPending] - 当前挂起的审批（让位浮层用）
 * @param {Function} [deps.getSlotState] - 槽位自适应状态
 * @param {Function} [deps.askConflict] - 用 DSH 标准提问机制询问槽位冲突处理方式
 */
export function createApiHandler(deps) {
  const { getSettings, saveSettings, translator, logger, store, cache, getRowConfig, listPending, findPendingByCallId, getSlotState, noteSlotEvent, askConflict, history, grants, audit, guard, detectDevice } = deps

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = routeOf(url.pathname)
    const method = String(req.method ?? 'GET').toUpperCase()

    if (route === null) {
      sendJson(res, 404, { ok: false, error: '不属于本插件的路由：' + url.pathname })
      return
    }
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: '只允许本机访问' })
      return
    }

    /**
     * 静态资源（v0.4.2）：鲸鱼娘头像等。
     * `<img src>` 无法带自定义请求头，所以这一条**不要求** x-plain-approval；
     * 依旧只允许回环地址访问，文件名走白名单，杜绝路径穿越。
     */
    if (route.startsWith('asset/')) {
      const name = route.slice('asset/'.length)
      if (!/^[A-Za-z0-9._-]+$/u.test(name) || name.includes('..')) {
        sendJson(res, 404, { ok: false, error: '资源名不合法' })
        return
      }
      const assetsDir = deps.assetsDir ? resolve(deps.assetsDir) : fileURLToPath(new URL('../assets/', import.meta.url))
      try {
        const data = readFileSync(join(assetsDir, name))
        const type = name.endsWith('.svg')
          ? 'image/svg+xml; charset=utf-8'
          : name.endsWith('.png')
            ? 'image/png'
            : name.endsWith('.json')
              ? 'application/json; charset=utf-8'
              : 'application/octet-stream'
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
        res.end(data)
      } catch {
        sendJson(res, 404, { ok: false, error: '资源不存在：' + name })
      }
      return
    }

    const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE'
    // 除探活外一律要求自定义头：GET 也会因此触发 CORS 预检，跨站页面读不到响应。
    const headerOk = req.headers?.[REQUIRED_HEADER] === '1'
    if (route !== 'ping' && route !== '' && !headerOk) {
      sendJson(res, 403, { ok: false, error: '缺少本插件自定义请求头（挡跨站请求）' })
      return
    }
    if (isWrite && !headerOk) {
      sendJson(res, 403, { ok: false, error: '缺少本插件自定义请求头（挡跨站请求）' })
      return
    }

    try {
      if (route === '' || route === 'ping') {
        sendJson(res, 200, { ok: true, data: { plugin: 'dsh-plain-approval', version: deps.version ?? 'unknown', prefix: API_PREFIX, route, method } })
        return
      }

      if (route === 'status' && (method === 'GET' || method === 'HEAD')) {
        const probe = await translator.probe()
        sendJson(res, 200, {
          ok: true,
          data: {
            ...probe,
            version: deps.version ?? 'unknown',
            settings: redact(getSettings()),
            cache: { driver: cache?.driver, stats: cache?.stats?.() ?? null },
            log: store?.logSummary?.() ?? null,
            slot: getSlotState?.() ?? null,
            pendingCount: (listPending?.() ?? []).length,
            grants: { count: grants?.size?.() ?? 0, workspace: grants?.scope ?? null },
            audit: audit?.summary?.() ?? null,
          },
        })
        return
      }

      /* ---------------- 长期同意（v0.3） ---------------- */

      if (route === 'grants' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          data: {
            workspace: grants?.scope ?? null,
            file: grants?.file ?? null,
            items: grants?.list?.() ?? [],
          },
        })
        return
      }

      if (route === 'grants/add' && method === 'POST') {
        const body = await readBody(req)
        const command = String(body?.command ?? '')
        if (command.trim() === '') {
          sendJson(res, 400, { ok: false, error: '空命令不能长期同意' })
          return
        }
        const settings = getSettings()
        // 安全底线：服务端**重新跑一遍本地规则**，不信任客户端传来的 risk
        const rules = analyzeCommand(command, { blacklist: settings.blacklist, toolName: body?.toolName })
        if (rules.risk !== '安全') {
          logger?.warn('grant.rejected', { risk: rules.risk, reason: 'not-safe' })
          sendJson(res, 403, {
            ok: false,
            error: `只有「安全」等级的命令才能长期同意。按本地规则，这条被判定为「${rules.risk}」（${rules.advice}），必须每次手动确认。`,
            data: { risk: rules.risk, advice: rules.advice, consequence: rules.consequence },
          })
          return
        }
        const result = grants.add({ command, risk: rules.risk, toolName: body?.toolName })
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.message, data: { code: result.code } })
          return
        }
        logger?.info('grant.added', { hash: result.item.hash.slice(0, 16), ruleId: result.item.id, workspace: result.item.scope, already: result.already === true })
        sendJson(res, 200, { ok: true, data: { item: result.item, already: result.already === true, workspace: grants.scope } })
        return
      }

      if (route === 'grants/remove' && method === 'POST') {
        const body = await readBody(req)
        const result = grants.remove(String(body?.id ?? ''))
        if (!result.ok) {
          sendJson(res, 404, { ok: false, error: result.message })
          return
        }
        logger?.info('grant.removed', { id: String(body?.id ?? '') })
        sendJson(res, 200, { ok: true, data: { removed: result.removed, items: grants.list() } })
        return
      }

      if (route === 'grants/clear' && method === 'POST') {
        const result = grants.clear()
        logger?.info('grant.cleared', { removed: result.removed })
        sendJson(res, 200, { ok: true, data: { removed: result.removed, items: [] } })
        return
      }

      if (route === 'audit' && method === 'GET') {
        const payload = audit?.exportAll?.() ?? { entries: [] }
        if (url.searchParams.get('download') === '1') {
          sendText(res, 200, JSON.stringify(payload, null, 2), 'dsh-plain-approval-audit.json')
        } else {
          sendJson(res, 200, { ok: true, data: payload })
        }
        return
      }

      if (route === 'diag' && method === 'GET') {
        const report = await translator.diag()
        sendJson(res, 200, { ok: true, data: { ...report, slot: getSlotState?.() ?? null } })
        return
      }

      /* ---------------- 设备能力 / 防 OOM（v0.4） ---------------- */

      if (route === 'device' && method === 'GET') {
        const settings = getSettings()
        let device = null
        try {
          device = detectDevice ? await detectDevice({ thresholds: settings.device, force: url.searchParams.get('force') === '1' }) : null
        } catch (error) {
          device = { error: oneLine(error?.message, 160), tier: 'unknown' }
        }
        // 向导要知道「本地通道现在能不能用」，这里顺带探测一次（失败也不影响响应）
        let ollamaStatus = null
        try {
          ollamaStatus = await checkOllama(settings.ollama)
        } catch (error) {
          ollamaStatus = { status: 'red', code: 'probe-failed', detail: oneLine(error?.message, 160), models: [] }
        }
        sendJson(res, 200, {
          ok: true,
          data: {
            device,
            ollama: ollamaStatus,
            localRisk: localRisk(device, ollamaStatus),
            settings: { engine: settings.engine, device: settings.device, ollama: settings.ollama },
            ollamaGuard: guard?.stats?.() ?? null,
            breaker: guard?.breakerState?.() ?? null,
          },
        })
        return
      }

      if (route === 'reset-local' && method === 'POST') {
        const result = guard?.resetBreaker?.('用户点「恢复本地通道」') ?? { ok: true, wasOpen: false }
        saveSettings({ device: { localDisabledUntil: 0, localDisabledReason: '' } })
        logger?.info('device.local-restored', { wasBreakerOpen: result.wasOpen === true })
        sendJson(res, 200, { ok: true, data: { restored: true, wasBreakerOpen: result.wasOpen === true } })
        return
      }

      /**
       * 初始向导落库（v0.4.1：修 404 与「点了没反应」）。
       * 接受 `choice` 或 `engine` 两种字段名，值域 auto / 'local-first' / ollama / deepseek。
       * 无论如何都返回结构化结果，不抛异常 —— 客户端据此关闭向导。
       */
      if (route === 'onboard' && method === 'POST') {
        const body = await readBody(req)
        if (!body || typeof body !== 'object') {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const raw = String(body.choice ?? body.engine ?? 'auto')
        const engine = ['auto', 'local-first', 'ollama', 'deepseek'].includes(raw) ? raw : 'auto'
        const patch = { ui: { onboarded: true }, engine }
        if (engine === 'local-first' || engine === 'ollama') {
          patch.device = { allowUnusableLocal: body?.acceptRisk === true }
        }
        saveSettings(patch)
        logger?.info('onboard.saved', { choice: engine, acceptRisk: body?.acceptRisk === true, requested: raw })
        sendJson(res, 200, { ok: true, data: { engine, onboarded: true, skipped: body?.skipped === true } })
        return
      }

      /* v0.5.1：用 DSH 标准提问机制问「槽位冲突怎么处理」。
         失败/不可用一律返回 supported:false，由客户端降级为自绘提示 ——
         这条路由绝不抛错，也绝不阻塞审批。 */
      /* v0.5.3：审批历史。只读查询 / 导出 / 清空，绝不写。 */
      if (route === 'history' && (method === 'GET' || method === 'HEAD')) {
        if (typeof history !== 'function') {
          sendJson(res, 200, { ok: true, data: { items: [], stats: { total: 0 }, decisionLabels: {} } })
          return
        }
        const q = url.searchParams
        const items = history.list({
          decision: q.get('decision') ?? 'all',
          range: q.get('range') ?? 'all',
          q: q.get('q') ?? '',
          limit: q.get('limit') ?? undefined,
        })
        sendJson(res, 200, {
          ok: true,
          data: {
            items,
            stats: history.stats(),
            decisionLabels: DECISION_LABELS,
            ranges: Object.keys(RANGE_DAYS),
          },
        })
        return
      }

      if (route === 'history/export' && (method === 'GET' || method === 'HEAD')) {
        const payload = typeof history === 'function' ? history.exportAll({ redact: url.searchParams.get('redact') === '1' }) : { items: [] }
        if (url.searchParams.get('download') === '1') {
          sendText(res, 200, JSON.stringify(payload, null, 2), 'dsh-plain-approval-history.json')
        } else {
          sendJson(res, 200, { ok: true, data: payload })
        }
        return
      }

      if (route === 'history/clear' && method === 'POST') {
        const result = typeof history === 'function' ? history.clear() : { ok: false, removed: 0 }
        logger?.warn('history.cleared', { removed: result?.removed ?? 0, by: 'user' })
        sendJson(res, 200, { ok: true, data: result })
        return
      }

      if (route === 'ask-conflict' && method === 'POST') {
        const body = (await readBody(req)) || {}
        const rivals = Array.isArray(body.rivals) ? body.rivals.slice(0, 10).map((x) => oneLine(x, 80)) : []
        let outcome
        try {
          outcome = typeof askConflict === 'function'
            ? await askConflict(rivals)
            : { supported: false, reason: 'no-handler', detail: '宿主没有注入 askConflict' }
        } catch (error) {
          outcome = { supported: false, reason: 'throw', detail: oneLine(error?.message, 160) }
          logger?.warn('ask-conflict.threw', { message: outcome.detail })
        }
        sendJson(res, 200, { ok: true, data: outcome })
        return
      }

      if (route === 'pending' && method === 'GET') {        sendJson(res, 200, { ok: true, data: { items: listPending?.() ?? [], at: new Date().toISOString() } })
        return
      }

      if (route === 'note' && method === 'POST') {
        const body = await readBody(req)
        if (!body || typeof body !== 'object') {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const event = oneLine(body.event ?? 'client.note', 64)
        const details = typeof body.details === 'object' && body.details !== null ? body.details : {}
        logger?.info('client.' + event, details)
        noteSlotEvent?.(event, details)
        sendJson(res, 200, { ok: true, data: { logged: true } })
        return
      }

      if (route === 'settings' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          data: {
            settings: redact(getSettings()),
            raw: store.readRawSettings(),
            rowConfig: getRowConfig?.() ?? {},
            dataDir: store.dir,
            slot: getSlotState?.() ?? null,
          },
        })
        return
      }

      if (route === 'settings' && method === 'POST') {
        const body = await readBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const result = saveSettings(body)
        logger?.info('settings.saved', { keys: Object.keys(body).join(',') })
        sendJson(res, 200, { ok: true, data: { settings: redact(result.settings), raw: result.raw, slot: getSlotState?.() ?? null } })
        return
      }

      if (route === 'translate' && method === 'POST') {
        const body = await readBody(req)
        if (!body || typeof body !== 'object') {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        // v0.5.6：把宿主侧已经读到的上下文补上。
        // 客户端那次调用发生在浏览器里，没有 agent，自己读不到会话 ——
        // 结果就是「日志 context=yes，卡片却说未读取到」。
        const pendingHit = typeof findPendingByCallId === 'function' ? findPendingByCallId(body.callId) : null
        const result = await translator.translate({
          command: body.command,
          toolName: body.toolName,
          reason: body.reason,
          cwd: body.cwd,
          callId: body.callId,
          confirmPaid: body.confirmPaid === true,
          context: pendingHit?.context,
          contextSource: pendingHit ? 'pending' : 'none',
        })
        logger?.info('translate.served', {
          hash: result.hash,
          status: result.status,
          cached: result.cached === true,
          ms: result.elapsedMs,
          context: result.context?.available === true ? 'yes' : 'no',
          contextSource: pendingHit ? 'pending' : 'none',
          // v0.5.7：带上 callId，下次可以直接和 approval.listener-enter 对账 ——
          // 「宿主记了没有 / 客户端有没有带对」一眼可见。
          callId: String(body.callId ?? ''),
          pendingFound: Boolean(pendingHit),
        })
        sendJson(res, 200, { ok: true, data: result })
        return
      }

      if (route === 'selftest' && method === 'POST') {
        const report = await translator.selftest()
        sendJson(res, 200, { ok: true, data: report })
        return
      }

      if (route === 'logs' && method === 'GET') {
        const payload = logger.export()
        if (url.searchParams.get('download') === '1') {
          sendText(res, 200, JSON.stringify(payload, null, 2), 'dsh-plain-approval-diagnostic.json')
        } else {
          sendJson(res, 200, { ok: true, data: payload })
        }
        return
      }

      if (route === 'clearcache' && method === 'POST') {
        cache?.clear()
        sendJson(res, 200, { ok: true, data: { cleared: true, driver: cache?.driver } })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${url.pathname}` })
    } catch (error) {
      logger?.error('api.failed', { route: method + ' ' + route, message: oneLine(error?.message, 300) })
      sendJson(res, 500, { ok: false, error: oneLine(error?.message ?? String(error), 300) })
    }
  }
}

/** 设置回传前抹掉 API Key 原文。 */
function redact(settings) {
  const copy = JSON.parse(JSON.stringify(settings))
  if (copy?.deepseek) {
    copy.deepseek.apiKeyConfigured = copy.deepseek.apiKey !== ''
    copy.deepseek.apiKey = ''
  }
  return copy
}

export { readBody, sendJson, sendText, isLocalRequest }
