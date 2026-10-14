/**
 * v0.4.5 安全版：把 client.js 里「浮窗开关 / 原生卡片内嵌按钮 / 拖动」整段
 * （从 '浮窗开关 / 原生卡片内嵌按钮' 注释开始，到 `class ChipBoundary` 之前）
 * 替换为**零直接 DOM 操作**的实现。
 *
 * 替换掉的内容包含卡死根因：
 *   new MutationObserver(...) 观察 document.body(subtree) + 回调里无条件写 DOM
 *   → 微任务无限自激 → 主线程饿死 + 每轮新建 img/textNode → 内存爆涨 → renderer killed
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = process.argv[2]
if (!FILE) throw new Error('用法: node splice.mjs <client.js>')

const src = readFileSync(FILE, 'utf8')
const START = src.indexOf('    /* -------------------------------------------------------------- */\n    /* 浮窗开关 / 原生卡片内嵌按钮（v0.4.2）')
const END = src.indexOf('    class ChipBoundary extends React.Component')
if (START < 0) throw new Error('找不到起点锚点')
if (END < 0) throw new Error('找不到终点锚点')
if (END <= START) throw new Error('锚点顺序不对')

const NEW_BLOCK = `    /* -------------------------------------------------------------- */
    /* 浮窗（v0.4.5 安全版）                                              */
    /*                                                                  */
    /* 这里刻意**不做任何直接 DOM 操作**：                                  */
    /*   ✗ 不建 MutationObserver —— v0.4.2/0.4.3 界面卡死 + 内存爆满的根因    */
    /*   ✗ 不往别的插件（原生审批卡片）里插 DOM 节点                          */
    /*   ✗ 不加任何 window / document 级事件监听（拖动功能已彻底删除）         */
    /*   ✗ 不用 localStorage 记录位置（浮窗固定右下角）                       */
    /*                                                                  */
    /* 只用 React 状态 + CSS 固定定位。唯一的定时器是 2 秒一次的 /pending 轮询， */
    /* 它只调用 setState，绝不直接改 DOM。                                   */
    /* -------------------------------------------------------------- */

    /** 鲸鱼娘头像（本地资源，走插件自己的 HTTP 路由，不依赖外链）。 */
    const WHALE_URL = API + 'asset/whale-girl.svg'

    /** 头像元素（React 专用）。 */
    function whaleIcon(size) {
      return h('img', {
        className: 'pap_whale',
        src: WHALE_URL,
        width: size || 20,
        height: size || 20,
        alt: '',
        'aria-hidden': 'true',
        draggable: false,
      })
    }

    const toastListeners = new Set()
    let toastText = null
    let toastLevel = 'info'
    let toastTimer = null
    /** 轻提示（比如「宿主需要重启」）。只改 React 状态，不碰 DOM。 */
    function showToast(level, text) {
      toastLevel = level === 'warn' ? 'warn' : 'info'
      toastText = String(text ?? '')
      for (const fn of toastListeners) fn({ text: toastText, level: toastLevel })
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toastText = null
        for (const fn of toastListeners) fn({ text: null, level: 'info' })
      }, 10000)
    }

    /**
     * 右下角固定浮窗。
     *
     * - 让位模式下自动出现（原来是「原生卡片里的按钮」负责唤出，那个 DOM 注入已删除）；
     * - 可由用户折叠成一行「白话翻译 · 点击展开」；
     * - 位置固定（CSS \`right/bottom\`），没有拖动，也就没有位置状态、没有全局监听器。
     */
    function ReviewChip(props) {
      const tt = makeTT(props)
      const [items, setItems] = React.useState([])
      const [openKey, setOpenKey] = React.useState(null)
      const [results, setResults] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState(false)
      const [toast, setToast] = React.useState({ text: toastText, level: toastLevel })
      const alive = React.useRef(true)

      React.useEffect(() => {
        toastListeners.add(setToast)
        return () => {
          toastListeners.delete(setToast)
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        if (!uiPrefs.loaded) refreshPrefs()
        let aliveLocal = true
        const tick = async () => {
          if (typeof document !== 'undefined' && document.hidden) return
          try {
            const data = await api('pending')
            if (aliveLocal && alive.current) setItems(Array.isArray(data.items) ? data.items : [])
          } catch (error) {
            /* 宿主暂时不可达：保持现状 */
          }
        }
        tick()
        const timer = setInterval(tick, 2000)
        return () => {
          aliveLocal = false
          clearInterval(timer)
        }
      }, [])

      // 'off' = 彻底关闭：不接管，也不显示浮窗
      const needsOnboarding = uiPrefs.loaded && uiPrefs.onboarded !== true && uiPrefs.slotPolicy !== 'off'
      if (needsOnboarding) {
        return h(OnboardPrompt, {
          t: tt,
          onDone: (choice, notice) => {
            uiPrefs.onboarded = true
            if (notice) showToast(notice.level, notice.text)
            refreshPrefs()
          },
        })
      }

      const toastNode = toast.text
        ? h('div', { className: 'pap_chip pap_toast' + (toast.level === 'warn' ? ' pap_toastWarn' : '') }, toast.text)
        : null

      if (!shouldShowOverlay(items)) {
        if (!toastNode) return null
        return h('div', { className: 'pap_chipRoot', 'data-plain-approval': 'toast' }, toastNode)
      }

      const current = items.find((it) => it.key === openKey) || null

      const expand = async (item) => {
        if (openKey === item.key) {
          setOpenKey(null)
          return
        }
        setOpenKey(item.key)
        if (results[item.key] || item.quick) {
          setResults((prev) => ({ ...prev, [item.key]: prev[item.key] || item.quick }))
        }
        // 已经拿到过完整结果就不再重复请求
        if (results[item.key] && results[item.key].status === 'ok') return
        setBusy(true)
        try {
          const data = await api('translate', {
            method: 'POST',
            body: { command: item.command, toolName: item.toolName, reason: item.reason, callId: item.key, confirmPaid: false },
          })
          if (alive.current) setResults((prev) => ({ ...prev, [item.key]: data }))
        } catch (error) {
          /* 保留本地规则结果 */
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      if (collapsed) {
        return h(
          'div',
          { className: 'pap_chipRoot', 'data-plain-approval': 'chip' },
          toastNode,
          h(
            'button',
            { type: 'button', className: 'pap_chip pap_chipMini', onClick: () => setCollapsed(false) },
            whaleIcon(18),
            h('span', null, tt('chipExpand')),
          ),
        )
      }

      const result = results[current?.key] || current?.quick || null

      return h(
        'div',
        { className: 'pap_chipRoot', 'data-plain-approval': 'chip' },
        toastNode,
        h(
          'div',
          { className: 'pap_chip pap_chipWide' },
          h(
            'div',
            { className: 'pap_chipHead pap_chipHeadStatic' },
            whaleIcon(20),
            h('span', { className: 'pap_chipTitle' }, tt('chipTitle')),
            h(
              'span',
              { className: 'pap_chipHeadBtns' },
              h('button', { type: 'button', className: 'pap_iconBtn', title: tt('chipCollapse'), onClick: () => setCollapsed(true) }, '\\u25be'),
              h('button', { type: 'button', className: 'pap_iconBtn', title: tt('close'), onClick: () => setOpenKey(null) }, '\\u2715'),
            ),
          ),
          h(
            'div',
            { className: 'pap_chipNote' },
            interpolate(tt('chipYielded'), { names: slotDecision.rivals.join('\\u3001') || '\\u5176\\u5b83\\u63d2\\u4ef6' }),
          ),
          current && openKey === current.key
            ? h(
              'div',
              { className: 'pap_chipBody pap_chipScroll' },
              busy && !(result && result.status === 'ok')
                ? h('div', { className: 'pap_note' }, tt('translating'))
                : h(PlainResult, { result, tt, colors: uiPrefs.colors, showCost: uiPrefs.showCost, stacked: true }),
            )
            : h(
              'div',
              { className: 'pap_chipBody' },
              h('button', { type: 'button', className: 'pap_btn pap_btnPrimary pap_btnWide', onClick: () => expand(items[0]) }, tt('chipShow')),
            ),
        ),
      )
    }

`

const out = src.slice(0, START) + NEW_BLOCK + src.slice(END)
writeFileSync(FILE, out, 'utf8')
console.log('已替换，字节数', src.length, '→', out.length)
