/**
 * 插件默认配置。
 *
 * 两层配置：cordis.patch.yml 的行 config（低优先级） + 用户数据目录里的
 * settings.json（高优先级，由设置页写入）。两层都缺省时用这里的内置默认值。
 * 不依赖 @deepseek-ai/schemastery，缺依赖也能加载。
 * @module dsh-plain-approval/config
 */
import { join } from 'node:path'

/** 数据目录名（位于 DSH 用户数据目录下，绝不写工作区）。 */
export const DATA_DIR_NAME = 'plain-approval'

/** 默认黑名单关键词（命中直接标红）。 */
export const DEFAULT_BLACKLIST = [
  'rm -rf',
  'rm -fr',
  'rmdir /s',
  'rd /s',
  'del /f',
  'del /s',
  'del /q',
  'Remove-Item -Recurse',
  'Remove-Item -Force',
  'format ',
  'diskpart',
  'mkfs',
  'dd if=',
  'reg delete',
  'reg add',
  'bcdedit',
  'cipher /w',
  'shutdown /',
  'vssadmin delete',
  'takeown /f',
  'icacls .* /grant',
  'chmod 777',
  'chmod -R 777',
  '> /dev/sda',
  ':(){:|:&};:',
]

/** 内置默认配置。 */
export const DEFAULT_SETTINGS = {
  /**
   * 翻译引擎策略（v0.4 起**默认 API 优先**）：
   *   'auto'        （默认）优先用 DSH 内置的 AI 翻译（ctx.llm → 凭据直连）。**不碰 Ollama。**
   *   'local-first' 本地优先：Ollama → API（给有显卡、愿意折腾的人）
   *   'ollama'      只用本地 Ollama
   *   'deepseek'    只用 API 直连
   * 目标用户是完全不懂技术的人：装完就能用，不要求装任何额外软件。
   */
  engine: 'auto',

  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b',
    timeoutMs: 10000,
    /** 防 OOM：送进 Ollama 的命令长度上限（字符）。 */
    maxCommandChars: 2000,
    /** 防 OOM：显式限制生成 token 上限，不允许无上限生成。 */
    numPredict: 512,
    /** 防 OOM：显式限制上下文窗口，避免按模型默认最大值分配显存。 */
    numCtx: 2048,
    /** 防 OOM：Ollama 最大并发数（1-2）。 */
    maxConcurrency: 1,
    /** 防 OOM：排队上限，超过直接降级。 */
    maxQueue: 5,
    /** 防 OOM：可用内存低于这个值（GB）就不调用 Ollama。 */
    minFreeMemoryGB: 2,
    /** 防 OOM：连续失败多少次触发熔断。 */
    breakerFailures: 3,
    /** 防 OOM：熔断持续多少分钟。 */
    breakerMinutes: 5,
    /** 是否允许 Ollama 常驻显存（默认关闭：每次用完就卸载）。 */
    keepAlive: false,
  },

  /** 设备能力检测（v0.4 任务二）。 */
  device: {
    /** 是否启用检测与强制降级。 */
    enabled: true,
    /** 三档阈值。 */
    tierUnusableVramGB: 6,
    tierUnusableMemGB: 8,
    tierGoodVramGB: 8,
    tierGoodMemGB: 16,
    /** 用户在「不可用」档位强行开启本地通道（点过「我明白风险」）。 */
    allowUnusableLocal: false,
    /** 连续 OOM 失败后本地通道被临时禁用到这个时间戳（毫秒）。 */
    localDisabledUntil: 0,
    /** 临时禁用的原因。 */
    localDisabledReason: '',
    /** 读不到显卡信息时用户手填的显存（GB，0 = 未填）。 */
    manualVramGB: 0,
    /** 手填的显卡型号（可选，只用于显示）。 */
    manualGpuName: '',
  },

  deepseek: {
    /** 留空 = 使用 DSH 已配置的 DeepSeek Key（凭据服务 / 环境变量）。 */
    apiKey: '',
    /**
     * 留空 = 自动从 DSH 的配置里解析（DEEPSEEK_BASE_URL 环境变量 →
     * profile 的 cordis.patch.yml / cordis.yml 里 llm-deepseek 的 baseURL → 官方默认）。
     * 不要硬编码，用户走代理或自建 endpoint 时这里必须跟着变。
     */
    baseUrl: '',
    /** 留空 = 跟随 DSH 当前选择的模型。 */
    model: '',
    /** 'auto' | 'openai' | 'anthropic'；auto 按 baseUrl 是否以 /anthropic 结尾判断。 */
    apiStyle: 'auto',
    timeoutMs: 15000,
    /** 429 时指数退避重试一次。 */
    retryOnRateLimit: true,
    /** 单次翻译前询问（客户端弹小确认）。 */
    askBeforeCall: false,
  },

  cache: {
    enabled: true,
    /** 有效期（天）。 */
    ttlDays: 7,
    /** 'sqlite' | 'json'；sqlite 不可用时自动回落 json。 */
    driver: 'sqlite',
  },

  ui: {
    /** 是否启用颜色标注（绿/黄/红）。 */
    colors: true,
    /** 是否显示费用估算。 */
    showCost: true,
    /**
     * 审批卡片模式（v0.5.0-stable 重写，**取代** v0.4.x 的 slotPolicy 自动让位）：
     *   'takeover' 永远接管审批卡，不显示浮窗（默认）
     *   'overlay'  不接管审批卡，说人话显示在右下角固定浮窗
     *   'off'      完全不接管，回退到 DSH 原生卡片，也不显示浮窗
     *
     * v0.5.0 起**没有任何自动判定**：插件不会去探测别人装了什么、也不会自己翻转。
     * 冲突只做只读检测并提示一次，由用户在这里显式选择。
     */
    slotMode: 'takeover',
    /**
     * 冲突选择是否已完成。false = 还没问过用户，发现冲突时会问一次；
     * 用户选完写入 true，之后永不再问（设置页可随时改）。
     */
    conflictResolved: false,
    /** 首次启用引导是否已完成。 */
    onboarded: false,
    /** 用户是否点过「不再显示」捐款入口。 */
    hideDonate: false,
    /** 是否展示「背景」段（会话上下文感知）。 */
    showBackground: true,
    /**
     * 是否在原生审批卡片里显示一行翻译摘要（v0.4.3，**默认关闭**）。
     * 关闭时完全不碰 displayReason 的本地化文本，卡片用它自己的原生原因，
     * 翻译只从右下角浮窗进（入口是卡片上的「说人话」按钮）。
     */
    showInlineSummary: false,

    /**
     * 分析深度（v0.6.0；v0.6.1 把默认值从 'auto' 改成 'l2'）：
     *   'l2'（**默认**）—— 一律调用模型。本插件的价值主要来自模型结合上下文写出的那句
     *                     「你刚才让它补全 ComfyUI 缺的画图模型」；L1 的意图是规则拼的
     *                     字面描述（「用 Python 运行脚本」）。识别正确度是核心诉求，
     *                     所以默认给最准的那档，把「省钱 / 秒出」交给用户自己选。
     *   'auto'         —— 安全命令走 L1（零成本、秒出），注意 / 危险命令走 L2。给想省钱的人。
     *   'l1'           —— 尽量用本地规则（**危险命令仍然强制 L2**，不可覆盖）。
     */
    analysisDepth: 'l2',
    /** 是否允许在卡片上手动「升级到 L2」。 */
    allowUpgrade: true,

    /**
     * 审批历史（v0.5.3）。
     * 用途：回看每一次审批的决定，也是 v0.6.0「自动通过」的前置数据 ——
     * 在验证「本地规则判安全」的准确率之前，不会做任何自动放行。
     */
    history: {
      /** 总开关，默认开启。关掉后完全不记录。 */
      enabled: true,
      /** 保留天数，默认 90。 */
      retentionDays: 90,
      /** 条数上限，默认 5000。 */
      maxEntries: 5000,
      /**
       * 是否保留命令原文，**默认 false**。
       * 开启后历史文件里会存命令文本（前 4000 字）。
       * 关掉时只存 sha256 哈希 —— 想查「这条到底执行了什么」，只能靠原始会话。
       */
      keepCommands: false,
    },
  },

  /**
   * 需要主动让位的「功能层」插件（registrant 名）。
   * 默认把已知的槽位竞争者都列上；用户可自行增补。
   */
  caretakerPlugins: [
    'dsh-reject-message',
    'dsh-hover-approve',
    'approval-zh',
    '@local/approval-zh',
    'dsh-armory',
    'dsh-compat-vet',
    'dsh-integration-settings',
  ],

  /** 翻译失败时是否自动拒绝（默认否：只降级展示，绝不阻塞审批）。 */
  denyOnFailure: false,

  /** 用户自定义黑名单关键词。 */
  blacklist: [],

  /** 费用估算单价：元 / 百万 token。默认按 DeepSeek 官方 deepseek-flash 峰时价换算（见 cost.js）。 */
  pricing: {
    inputMissPerMillion: 2.16,
    inputHitPerMillion: 0.0432,
    outputPerMillion: 8.64,
  },

  /** 日志与诊断。 */
  log: {
    /** 是否把失败/超时/格式异常写入日志文件。 */
    enabled: true,
    maxLines: 2000,
  },
}

/** 深合并（数组整体替换，不做元素级合并）。 */
export function mergeDeep(base, patch) {
  if (patch === null || patch === undefined) return clone(base)
  if (Array.isArray(base) || Array.isArray(patch)) return clone(patch)
  if (typeof base !== 'object' || typeof patch !== 'object') return clone(patch)
  const out = {}
  for (const key of new Set([...Object.keys(base), ...Object.keys(patch)])) {
    out[key] = key in patch ? mergeDeep(base[key], patch[key]) : clone(base[key])
  }
  return out
}

function clone(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(clone)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = clone(v)
    return out
  }
  return value
}

/** v0.5.0 允许的槽位模式。 */
export const SLOT_MODES = ['takeover', 'overlay', 'off']

/** v0.4.x 的三种槽位策略。 */
const LEGACY_POLICIES = ['auto', 'takeover', 'off']

/**
 * 从**原始配置**（而不是 merge 之后的）推导 v0.5.0 的 slotMode / conflictResolved。
 *
 * 这里必须用原始值：`normalizeSettings` 开头做了 `mergeDeep(DEFAULT_SETTINGS, raw)`，
 * 默认值已经把 `slotMode: 'takeover'` 和 `conflictResolved: false` 填进去了，
 * 如果拿合并后的值判断，迁移分支永远走不到（`旧 off` 会被错迁成 `takeover`）。
 *
 * 规则：
 *   · 原始配置里已经有合法 slotMode → 直接采用；
 *   · 否则旧的 `takeover` / `off` → 沿用（用户当初表达过明确意图，不用再问）；
 *   · 旧的 `auto` → 映射成 `takeover`（新默认），但标记为「还没选过」，
 *     让用户**显式**选一次 —— 不再由代码替用户做决定；
 *   · 全新安装 / 脏值 → `takeover` + 未选过。
 */
export function migrateSlotConfig(rawUi) {
  const ui = rawUi && typeof rawUi === 'object' ? rawUi : {}
  const hasNew = SLOT_MODES.includes(ui.slotMode)
  const hasOld = LEGACY_POLICIES.includes(ui.slotPolicy)
  const legacyAuto = hasOld ? ui.slotPolicy === 'auto' : !hasOld

  const slotMode = hasNew ? ui.slotMode : hasOld && !legacyAuto ? ui.slotPolicy : 'takeover'
  const conflictResolved = ui.conflictResolved !== undefined ? ui.conflictResolved === true : !legacyAuto
  return { slotMode, conflictResolved }
}

/** 把任意输入规范化成合法配置（防止设置页写入脏值）。 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const merged = mergeDeep(DEFAULT_SETTINGS, source)
  // 迁移必须基于**原始**配置：merged 里 slotMode 已被默认值填成 'takeover'
  const migrated = migrateSlotConfig(source.ui)
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const str = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)

  return {
    engine: ['auto', 'local-first', 'ollama', 'deepseek'].includes(merged.engine) ? merged.engine : 'auto',
    ollama: {
      baseUrl: str(merged.ollama?.baseUrl, DEFAULT_SETTINGS.ollama.baseUrl).replace(/\/+$/u, ''),
      model: str(merged.ollama?.model, DEFAULT_SETTINGS.ollama.model),
      timeoutMs: num(merged.ollama?.timeoutMs, 10000, 500, 120000),
      maxCommandChars: num(merged.ollama?.maxCommandChars, 2000, 200, 20000),
      numPredict: num(merged.ollama?.numPredict, 512, 64, 4096),
      numCtx: num(merged.ollama?.numCtx, 2048, 512, 32768),
      maxConcurrency: num(merged.ollama?.maxConcurrency, 1, 1, 2),
      maxQueue: num(merged.ollama?.maxQueue, 5, 0, 50),
      minFreeMemoryGB: num(merged.ollama?.minFreeMemoryGB, 2, 0, 128),
      breakerFailures: num(merged.ollama?.breakerFailures, 3, 1, 20),
      breakerMinutes: num(merged.ollama?.breakerMinutes, 5, 1, 120),
      keepAlive: bool(merged.ollama?.keepAlive, false),
    },
    device: {
      enabled: bool(merged.device?.enabled, true),
      tierUnusableVramGB: num(merged.device?.tierUnusableVramGB, 6, 0, 512),
      tierUnusableMemGB: num(merged.device?.tierUnusableMemGB, 8, 0, 1024),
      tierGoodVramGB: num(merged.device?.tierGoodVramGB, 8, 0, 512),
      tierGoodMemGB: num(merged.device?.tierGoodMemGB, 16, 0, 1024),
      allowUnusableLocal: bool(merged.device?.allowUnusableLocal, false),
      localDisabledUntil: num(merged.device?.localDisabledUntil, 0, 0, Number.MAX_SAFE_INTEGER),
      localDisabledReason: typeof merged.device?.localDisabledReason === 'string' ? merged.device.localDisabledReason : '',
      manualVramGB: num(merged.device?.manualVramGB, 0, 0, 512),
      manualGpuName: typeof merged.device?.manualGpuName === 'string' ? merged.device.manualGpuName.trim() : '',
    },
    deepseek: {
      apiKey: typeof merged.deepseek?.apiKey === 'string' ? merged.deepseek.apiKey : '',
      baseUrl: typeof merged.deepseek?.baseUrl === 'string' ? merged.deepseek.baseUrl.trim().replace(/\/+$/u, '') : '',
      model: typeof merged.deepseek?.model === 'string' ? merged.deepseek.model.trim() : '',
      apiStyle: ['auto', 'openai', 'anthropic'].includes(merged.deepseek?.apiStyle) ? merged.deepseek.apiStyle : 'auto',
      timeoutMs: num(merged.deepseek?.timeoutMs, 15000, 1000, 180000),
      retryOnRateLimit: bool(merged.deepseek?.retryOnRateLimit, true),
      askBeforeCall: bool(merged.deepseek?.askBeforeCall, false),
    },
    cache: {
      enabled: bool(merged.cache?.enabled, true),
      ttlDays: num(merged.cache?.ttlDays, 7, 0, 365),
      driver: merged.cache?.driver === 'json' ? 'json' : 'sqlite',
    },
    ui: {
      colors: bool(merged.ui?.colors, true),
      showCost: bool(merged.ui?.showCost, true),
      slotMode: migrated.slotMode,
      conflictResolved: migrated.conflictResolved,
      onboarded: bool(merged.ui?.onboarded, false),
      hideDonate: bool(merged.ui?.hideDonate, false),
      showBackground: bool(merged.ui?.showBackground, true),
      showInlineSummary: bool(merged.ui?.showInlineSummary, false),
      // v0.6.1：缺省 / 脏值一律回落到 'l2'（最准的那档），不猜、不静默降级到 L1
      analysisDepth: ['auto', 'l1', 'l2'].includes(merged.ui?.analysisDepth) ? merged.ui.analysisDepth : 'l2',
      allowUpgrade: bool(merged.ui?.allowUpgrade, true),
      history: {
        enabled: bool(merged.ui?.history?.enabled, true),
        retentionDays: num(merged.ui?.history?.retentionDays, 90, 1, 3650),
        maxEntries: num(merged.ui?.history?.maxEntries, 5000, 100, 100000),
        keepCommands: bool(merged.ui?.history?.keepCommands, false),
      },
    },
    caretakerPlugins: Array.isArray(merged.caretakerPlugins)
      ? merged.caretakerPlugins.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : [],
    denyOnFailure: bool(merged.denyOnFailure, false),
    blacklist: Array.isArray(merged.blacklist)
      ? merged.blacklist.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : [],
    pricing: {
      inputMissPerMillion: num(merged.pricing?.inputMissPerMillion, 2.16, 0, 10000),
      inputHitPerMillion: num(merged.pricing?.inputHitPerMillion, 0.0432, 0, 10000),
      outputPerMillion: num(merged.pricing?.outputPerMillion, 8.64, 0, 10000),
    },
    log: {
      enabled: bool(merged.log?.enabled, true),
      maxLines: num(merged.log?.maxLines, 2000, 50, 50000),
    },
  }
}

/** DSH 用户数据目录（DSH_HOME 优先，否则 ~/.dsh）。 */
export function resolveDshHome(env = process.env, homedir = undefined) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const home = homedir ?? env.USERPROFILE ?? env.HOME ?? '.'
  return join(home, '.dsh')
}

/** 插件数据目录绝对路径。 */
export function resolveDataDir(env = process.env, homedir = undefined) {
  return join(resolveDshHome(env, homedir), DATA_DIR_NAME)
}

/**
 * 配置摘要（用于设置页展示「生效值」），自动隐去密钥。
 */
export function redactSettings(settings) {
  const out = clone(settings)
  if (out.deepseek) {
    out.deepseek.apiKey = out.deepseek.apiKey ? '******（已填写）' : ''
  }
  return out
}
