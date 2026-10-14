import { readFileSync, writeFileSync } from 'node:fs'

const FILE = process.argv[2]
const lines = readFileSync(FILE, 'utf8').split('\n')

// A) 替换 createRuntime + mount（1-based 2388..2476）
const RUNTIME = `  /**
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
}`.split('\n')

lines.splice(2387, 2476 - 2388 + 1, ...RUNTIME)

let text = lines.join('\n')

// B) 生命周期组：先建 life，再用 life.api 注入 React；并且挂 ReviewChip 本体
const oldHead = `group('附加（v0.4.5）：完整渲染生命周期（挂载 → 交互 → 卸载）')
{
  const mod = loadClientModule()
  const client = mod.exports.__internal
  const life = mountLifecycle()`
const newHead = `group('附加（v0.4.5）：完整渲染生命周期（挂载 → 交互 → 卸载）')
{
  const life = mountLifecycle()
  // 把带真实 hooks 生命周期的 React 注入给 client.js（否则 effect 不会跑）
  const mod = loadClientModule({ react: life.api })
  const client = mod.exports.__internal`
if (!text.includes(oldHead)) throw new Error('找不到生命周期组头部')
text = text.replace(oldHead, newHead)

const oldMount = 'life.mount(mod.exports.__internal.ReviewChipEntry, { t: (k) => k, locale: \'zh\' })'
if (!text.includes(oldMount)) throw new Error('找不到 mount 调用')
text = text.split(oldMount).join('life.mount(mod.exports.__internal.ReviewChip, { t: (k) => k, locale: \'zh\' })')

writeFileSync(FILE, text, 'utf8')
console.log('patched')
