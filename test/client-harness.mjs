/**
 * 把 client.js 当成浏览器的模块加载器那样跑一遍，取出它的纯逻辑做单元测试。
 * client.js 是纯脚本（没有 import/export），顶层只做一件事：
 * `window.__ModuleLoader__.load({ id, factory })`。
 * 所以给一个假 window 就能把 factory 抓出来，再喂一个最小 React 桩。
 * @module dsh-plain-approval/test/client-harness
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function stubReact() {
  const Component = class {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...next }
    }
  }
  return {
    // 返回一个轻量节点对象而不是 null：这样「往按钮里塞图标」这类逻辑才测得到
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Component,
    Fragment: 'fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/**
 * @returns {{ definition: object, exports: object }}
 */
export function loadClientModule(options = {}) {
  const code = readFileSync(join(HERE, '..', 'client.js'), 'utf8')
  let definition = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(def) {
        definition = def
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', code)(fakeWindow)
  if (!definition) throw new Error('client.js 没有向 window.__ModuleLoader__ 注册模块')

  // 允许测试注入自定义 React（例如带真实 hooks 生命周期的最小实现）
  const react = options.react ?? stubReact()
  const requireStub = (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return {}
    throw new Error('client.js 请求了未预期的模块：' + id)
  }
  return { definition, exports: definition.factory(requireStub), window: fakeWindow }
}
