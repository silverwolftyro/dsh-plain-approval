/**
 * dsh-plain-approval —— Client 半边（浏览器纯 JS，无需构建）。
 *
 * 两件事：
 *  1. 接管 `conversation.composer` 的审批卡片（chain 槽位，priority 越小越优先），
 *     用「七段白话」重绘：翻译在上、原始命令在下、风险颜色+文字双标注、
 *     一键复制、引擎来源与费用透明；用户随时可以点允许/拒绝，绝不阻塞。
 *  2. 在 `settings.section` 加一个「说人话」设置页：状态灯、一键测试、
 *     导出诊断日志、全部配置项。
 *
 * 所有远端数据都走同源 HTTP `/api/plain-approval/*`（由 Host 半边注册）。
 * 任何内部异常都会降级成「最小可用面板」，保证审批流程永远可用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plain-approval',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'plain-approval'
    /**
     * 客户端拼路径用的基址（**带尾斜杠**）。
     * 宿主注册的路由前缀是 `/api/plain-approval`（**无尾斜杠**）——
     * dsh-host-webserver 的 match() 用 `startsWith(prefix + '/')` 判定，
     * 前缀带尾斜杠会让所有子路径都匹配不上，浏览器里表现为 HTTP 404。
     */
    const API = '/api/plain-approval/'
    /**
     * 审批卡片优先级。DSH 自带审批面板是 1；已装的 dsh-reject-message 用 -1。
     * v0.2 起默认「自适应让位」：真正决定要不要接管的是 select()，不是这个数字。
     */
    const PRIORITY = -100
    /** 翻译等待上限：超时就不再等，直接展示本地规则结果（绝不卡住用户）。 */
    const FETCH_TIMEOUT_MS = 20000
    /** 官方客户端包：它们的槽位占用是官方行为，不算「功能层插件」，不触发让位。 */
    const OFFICIAL_REGISTRANT = /^@deepseek-ai\/dsh-client-/u
    /** 本插件的 registrant 名（loader 条目 id / 插件 name）。 */
    const MY_REGISTRANTS = new Set(['plain-approval', 'dsh-plain-approval'])

    const zh = {
      nav: '说人话',
      waiting: '等待审批',
      translating: '正在翻译…',
      translationTitle: '说人话',
      detailAria: '审批详情',
      reject: '拒绝',
      allowOnce: '允许一次',
      copy: '复制白话说明',
      copied: '已复制',
      original: '原始命令（保留原文，方便复查）',
      engineLine: '本次翻译由：{engine}',
      engineLocal: '本地 Ollama',
      engineApi: 'DeepSeek API',
      engineRule: '本地规则（未调用模型）',
      unavailable: '翻译不可用，请自行判断',
      unavailableHint: '本地模型和 DeepSeek 都连不上：下面是本地规则的判断，仅供参考。',
      emptyCommand: '空命令，无可翻译内容',
      costLine: '本次消耗 {tokens} token，{cost}',
      dailyLine: '当日累计：{text}',
      cached: '（命中缓存，未产生新费用）',
      sections: [
        ['意图', 'intent'],
        ['碰什么', 'touch'],
        ['读还是写', 'mode'],
        ['风险等级', 'risk'],
        ['建议', 'advice'],
        ['后果', 'consequence'],
        ['收益', 'benefit'],
      ],
      risk: { 安全: '安全', 注意: '注意', 危险: '危险' },
      // ⚠️ advice 的映射表以前**根本不存在**，而代码里到处写 `tt('advice')[sections.advice]` ——
      //   一旦渲染到就抛 TypeError（`undefined[...]`，后面的 `|| sections.advice` 兜底来不及生效）。
      //   之前一直没炸，是因为这个分支只在**接管模式的卡片**里跑，而接管被槽位冲突卡住了。
      advice: { 可以允许: '可以允许', 请先确认: '请先确认', 建议拒绝: '建议拒绝' },
      // v0.7.0：七段压成「首屏标题 + 折叠三段」。
      // 标题在首屏单独渲染（pap_verdictTitle），这里只管折叠区那三段标签。
      'label.why': '为什么',
      'label.touch': '碰什么',
      'label.outcome': '如果允许',
      // 旧字段标签保留：历史记录页和旧数据还会用到
      'label.intent': '意图',
      'label.mode': '读还是写',
      'label.risk': '风险等级',
      'label.advice': '建议',
      'label.consequence': '后果',
      'label.benefit': '收益',
      parts: '分步意图',
      notes: '提醒',
      formatWarn: '翻译格式异常，下面由本地规则补全；模型原始返回：',
      copiedTip: '已复制到剪贴板',
      chipTitle: '说人话',
      chipShow: '查看详情 ▾',
      chipHide: '收起 ▴',
      chipExpand: '说人话 · 点击展开',
      chipCollapse: '收起为一行',
      // v0.4.6-safe：拖动 / 复位功能已永久移除，位置由 CSS 固定，相关文案一并删除
      sInlineSummary: '在卡片内显示翻译摘要',
      sInlineSummaryHint: '默认关闭。开启后原生审批卡片顶部会多一行「说人话：…」，不想让卡片多这行就保持关闭。',
      // v0.7.0：思考过程开关 + 隐私说明
      sUseReasoning: '把 AI 的思考过程也用于判断意图',
      sUseReasoningHint: '默认开启。AI 在发起这次审批前的推理过程（reasoning）会连同自述一起交给翻译模型，用来更准地判断「它到底想干什么」。这些都是你本机上的内容，只在你这台机器上跑，不外发；关掉后插件**根本不读取**思考过程，不只是不显示。',
      sUseReasoningOn: '已开启：翻译时会参考 AI 的思考过程',
      sUseReasoningOff: '已关闭：翻译时完全不读取 AI 的思考过程',
      chipOverlay: '当前是「浮窗模式」：{names} 负责审批卡片，说人话显示在右下角浮层。',
      grantForever: '长期同意',
      grantForeverHint: '只有「安全」等级的命令才能长期同意：命令完全一致才生效，限定当前工作区，可随时撤销。',
      grantOnlySafe: '只有「安全」等级的命令才能长期同意。',
      granted: '已长期同意（仅当前工作区、命令完全一致才生效）',
      grantFailed: '长期同意失败',
      sGrants: '长期同意（仅安全命令）',
      sGrantsDesc: '只有风险等级为「安全」的命令会出现在这里。匹配规则：命令字符串完全一致；范围：当前工作区；随时可撤销。注意/危险命令永远不会出现在这里。',
      sGrantsEmpty: '还没有长期同意的命令。',
      sGrantsCount: '已授权 {n} 条',
      sGrantRevoke: '撤销',
      sGrantClear: '一键清空',
      sGrantCleared: '已清空长期同意',
      sGrantWorkspace: '工作区',
      sGrantUses: '自动放行 {n} 次',
      sGrantCreated: '授权于',
      sAudit: '审计日志',
      sAuditDesc: '每次「长期同意自动放行」都会记录下来：时间、命令哈希、翻译结果、授权规则 ID。只记哈希，不记命令原文。',
      sAuditView: '查看最近记录',
      sAuditExport: '导出审计日志',
      sAuditEmpty: '还没有自动放行记录。',
      // ---- v0.4 ----
      slotModeConflict: '当前是「接管模式」，但检测到 {names} 也在占用审批卡槽位。需要共存请切换到浮窗模式。',
      // v0.7.4：用户已经明确选过模式后的中性说明（不再用黄色警告）。
      sSlotRivalsDone: '已按你选择的模式生效（{mode}）。另有 {names} 也在占用审批卡槽位 —— 它们不会再让位；卡位不足时请改用浮窗模式。',
      slotModeTakeover: '当前是「接管模式」：审批卡片由说人话渲染，含完整说人话，不显示浮层。',
      slotModeOverlay: '当前是「浮窗模式」：不接管审批卡，说人话显示在右下角固定浮窗。',
      slotModeOff: '当前「完全关闭」：既不接管卡片，也不显示浮层。',
      slotModeUnknown: '客户端还没上报槽位决定（刷新页面后即可看到）。',
      wizardTitle: '先选一下：用谁来翻译？',
      wizardDesc: '不用懂技术，选一个就行。之后可以随时在设置里改。',
      wizardA: '自动（推荐）—— 用 DSH 的 AI 翻译，可能消耗少量额度，但什么都不用装。',
      wizardB: '本地免费 —— 用你自己电脑上的 Ollama 翻译，不花钱，但需要先安装 Ollama。',
      wizardC: '我自己填 API Key —— 用你自己的 DeepSeek 或其他 API。',
      wizardNext: '下一步',
      // ---- v0.4.1 向导修复 ----
      wizardSkip: '稍后设置（先用推荐方案）',
      wizardChecking: '正在检查本机环境…',
      wizardUnknownHardware: '未检测到具体硬件信息，建议直接用 API 翻译；想用本地模型也可以，插件不会拦你。',
      wizardOllamaReady: '检测到 Ollama 已运行且模型已在，本地通道可用，没有任何风险提示。',
      wizardLocalOk: '本机配置够用，本地通道可以放心开。',
      wizardHostOld: '选择已保存。但宿主（Node 侧）还是旧版本，请完全退出 DeepSeek Harness 再重新启动，之后一切正常。',
      sManualVram: '读不到显卡？手动填显存（GB）',
      sManualVramHint: '填 0 表示不手动指定。填了之后按你给的值判定，插件不会拦你。',
      sManualGpuName: '显卡型号（可选，仅用于显示）',
      wizardAUnavailable: 'DSH 还没配置 API Key：请先到「设置 → 模型」里配置，或选 B 用本地 Ollama。',
      wizardLocalWarn: '本机配置偏低，用本地模型可能导致系统卡顿甚至卡死。',
      wizardLocalRisk: '我明白风险，仍要启用本地通道',
      wizardRerun: '重新运行初始设置',
      sDevice: '本机能力检测',
      sDeviceGpu: 'GPU',
      sDeviceVram: '显存',
      sDeviceMem: '内存',
      sDeviceFree: '当前空闲内存',
      sDeviceTierGood: '本地 LLM 可用',
      sDeviceTierMarginal: '本地 LLM 勉强可用，不推荐',
      sDeviceTierUnusable: '本地 LLM 不可用',
      sDeviceTierUnknown: '未检测到 GPU',
      sDeviceForceOn: '我明白风险，仍要启用本地通道',
      sDeviceForceOff: '取消强行启用（改回自动用 API）',
      sDeviceRestore: '恢复本地通道',
      sDeviceDisabled: '本地通道已临时禁用：{reason}（约 {mins} 分钟后自动恢复）',
      sDeviceForcedNotice: '已强行启用本地通道。每次用本地模型翻译时，卡片上都会提示「本地配置不足」。',
      sDeviceDetect: '重新检测',
      sDeviceRiskList: '强行启用可能导致的后果：系统卡死、显存/内存耗尽（OOM）、整机卡顿、Ollama 进程崩溃。',
      sOom: '本地模型防 OOM',
      sOomMaxChars: '单次翻译最大命令长度（字符）',
      sOomNumCtx: '上下文窗口 num_ctx（越小越省显存）',
      sOomNumPredict: '最大生成 token num_predict',
      sOomConcurrency: 'Ollama 最大并发数（1-2）',
      sOomMaxQueue: '排队上限（超过直接降级）',
      sOomMinMem: '可用内存低于多少 GB 就不调用 Ollama',
      sOomKeepAlive: '允许 Ollama 常驻显存（默认关闭）',
      sOomHint: '连续 {n} 次失败会熔断 {m} 分钟，期间自动走 API，到点自动恢复。',
      sOomBreaker: 'Ollama 已临时熔断：{reason}，约 {sec} 秒后自动恢复',
      sOomStats: '最近 10 次平均耗时 {ms}ms · 排队 {queued} 条 · 在跑 {running} 条',
      donateTitle: '喜欢这个插件？请作者喝杯咖啡 ☕',
      donateBody: '这个插件是免费开源的（MIT 协议），不捐也完全没关系。如果你觉得它帮到了你，可以请作者喝杯咖啡。捐款完全自愿，不影响任何功能。',
      donateWechat: '微信收款码',
      donateAlipay: '支付宝收款码',
      donateAfdian: '爱发电',
      // ⚠️ 占位：请把这里换成你自己的爱发电主页地址再发布
      donateAfdianUrl: 'https://afdian.com/a/speak-human',
      donateQrPending: '收款码待填',
      donateHide: '关闭后不再显示',
      donateHidden: '已隐藏，之后不再显示。',
      deviceNote: '备注',
      privacyB: '注意：通道 B 会把命令内容发送到 DeepSeek 官方 API。',
      confirmPaidTitle: '这次翻译要花一点点钱',
      confirmPaidBody: '本次将使用 DeepSeek API 翻译，按 DeepSeek 官方价格大约几厘到几分钱。你也可以改为「只用本地 Ollama」以免费用。',
      confirmPaidOk: '同意并继续',
      confirmPaidCancel: '只显示本地规则',
      retry: '重新翻译',
      settingsNav: '说人话',
      sTitle: '说人话',
      sDesc: '让每一条提权命令都先说人话：审批卡片上的七段说人话，由本地 Ollama 或 DSH 的 DeepSeek 完成。',
      sEngine: '翻译引擎',
      sEngineAuto: '自动降级（推荐）：先本地 Ollama，不可用再切 DeepSeek',
      sEngineOllama: '只用本地 Ollama（完全离线、免费）',
      sEngineDeepseek: '只用 DeepSeek API（开箱即用、会消耗额度）',
      sOllama: '本地 Ollama',
      sBaseUrl: '地址',
      sModel: '模型',
      sTimeout: '超时（毫秒）',
      sPull: '拉取模型命令：ollama pull {model}',
      sDeepseek: 'DeepSeek API',
      sDsTimeout: '超时（毫秒）',
      sAsk: '每次用 API 前先问我一次（默认否）',
      sPrivacy: '使用 DeepSeek API 时，命令内容会发送到 DeepSeek 官方服务器。本地 Ollama 不会。',
      sPricing: '费用单价（元 / 百万 token，用于估算）',
      sPriceMiss: '输入·缓存未命中',
      sPriceHit: '输入·缓存命中',
      sPriceOut: '输出',
      sCache: '翻译缓存',
      sCacheOn: '启用缓存（同一条命令不重复翻译）',
      sCacheTtl: '有效期（天）',
      sUi: '展示',
      sColors: '风险用颜色区分（绿/黄/红）',
      sShowCost: '显示费用估算',
      sDeny: '翻译失败时自动拒绝（默认否：只降级展示）',
      sBlacklist: '黑名单关键词（每行一个，命中直接标红）',
      sBlacklistHint: '内置危险关键词始终生效，这里填的是你额外想标红的词。',
      sSlot: '审批卡片模式（v0.5.0：固定模式，无自动判定）',
      sSlotHint: '说人话不会自动让位，也不会探测别的插件。是否接管完全由你在这里选，选完一直生效；随时可以改。',
      sSlotTakeover: '接管：说人话卡片替换 DSH 原生审批卡（默认）',
      sSlotOverlay: '浮窗：不接管审批卡，说人话显示在右下角固定浮窗',
      sSlotOff: '完全关闭：不接管，也不显示浮窗（回退到 DSH 原生）',
      sSlotCurrent: '当前状态',
      sSlotRivals: '检测到 {names} 也在占用审批卡槽位。当前模式为 {mode}，两者可能互相遮挡 —— 建议先在上面的下拉框里选一个明确模式。',
      sCaretakers: '让位名单（每行一个插件名，可自己补充）',
      conflictTitle: '检测到别的插件也在处理审批卡片',
      conflictBody: '{names} 也占用着审批卡槽位。请选一个处理方式，选完会记住，以后不再询问。',
      conflictPickA: 'A. 只用说人话（推荐）',
      conflictPickB: 'B. 让给对方，我用右下角浮窗',
      conflictPickC: 'C. 两个都不显示，回退到 DSH 原生',
      conflictFoot: '随时可以在「设置 → 说人话 → 审批卡片模式」里改回来。',
      // ---- 审批历史（v0.5.3）----
      sDepth: '分析深度',
      sDepthHint: 'L1 只用本地规则，秒出、不花钱，但意图是字面描述；L2 会调用模型，把「AI 想干什么」讲清楚。',
      sDepthAuto: '自动：安全命令用 L1（不花钱、秒出），注意 / 危险命令用 L2',
      sDepthL1: '尽量 L1：能本地判断的不调模型（危险命令仍强制 L2）',
      sDepthL2: '一律 L2（默认）：每条命令都调用模型，意图最准',
      sDepthAllow: '卡片上允许手动「升级到 L2」',
      sDepthNow: '本次分析',
      sDepthUpgrade: '升级到 L2（会调用模型，产生费用）',
      sDepthUpgrading: '正在升级…',
      sDepthElapsed: '耗时',
      sDepthCost: '费用',
      sHistory: '审批历史',
      showMore: '展开细节（碰什么 / 读写 / 收益 / 分步）',
      showMoreEn: 'Show details',
      sHistoryHint: '记录每一次审批的决定（谁按了允许、谁按了拒绝）。默认只记命令哈希，不记原文。',
      sHistoryOpen: '查看历史',
      sHistoryEnabled: '记录审批历史',
      sHistoryKeepCmd: '在历史里保留命令原文',
      sHistoryKeepCmdHint: '默认关闭。打开后历史文件会存命令文本（最多 4000 字）—— 方便回查，但会降低隐私保护。',
      sHistoryRetention: '历史保留天数',
      sHistoryStats: '共 {n} 条 · 最近一条 {last}',
      sHistoryEmpty: '还没有任何审批记录。触发一次审批后这里就会出现内容。',
      sHistoryFilterDecision: '决定',
      sHistoryFilterRange: '时间范围',
      sHistorySearch: '搜索命令哈希',
      sHistoryAll: '全部',
      sHistoryToday: '今天',
      sHistoryWeek: '最近 7 天',
      sHistoryMonth: '最近 30 天',
      sHistoryExport: '导出 JSON',
      sHistoryExportRedact: '导出（脱敏）',
      sHistoryClear: '清空历史',
      sHistoryClearConfirm: '确定要清空全部审批历史吗？此操作不可撤销。',
      sHistoryCleared: '已清空 {n} 条历史。',
      sHistoryNoCommand: '（未保留原文）',
      sHistoryAutoAllowed: '自动放行',
      sCaretakersHint: '仅用于提示。v0.5.0 起这里的名字不参与任何判定，只影响上面的冲突提示文案。',
      sDiag: '能力自检：DSH 到底向插件暴露了什么',
      sDiagRun: '运行自检',
      sDiagRunning: '自检中…',
      sEndpoint: '通道 B 目标（baseUrl / 协议 / 模型）',
      sEndpointHint: '留空即自动从 DSH 配置里解析，不硬编码。',
      sAdvanced2: '高级',
      diagLlm: 'ctx.llm（DSH 模型路由）',
      diagModel: 'ctx.agentDefaultModel（当前模型）',
      diagCred: 'ctx.credentials（DeepSeek Key）',
      diagEndpoint: '通道 B 目标',
      sSave: '保存',
      sSaved: '已保存',
      sSaving: '保存中…',
      sReset: '恢复默认',
      sTest: '一键测试两个通道',
      sTesting: '测试中…',
      sExport: '导出诊断日志',
      sClearCache: '清空缓存',
      sCleared: '缓存已清空',
      sStatus: '通道状态',
      sLightA: '通道 A · 本地 Ollama',
      sLightB: '通道 B · DeepSeek API',
      sDataDir: '数据目录（设置、缓存、日志都在这里）',
      sAdvanced: '高级：DeepSeek API Key',
      sApiKey: 'API Key（留空 = 复用 DSH 已配置的 Key，和 DSH 用的是同一个）',
      sGreen: '可用',
      sYellow: '可用但不推荐',
      sRed: '不可用',
      sTestA: '通道 A',
      sTestB: '通道 B',
      ok: '成功',
      fail: '失败',
      ms: '耗时 {ms}ms',
      close: '关闭',
    }

    const en = {
      nav: 'Plain Approval',
      waiting: 'Waiting for approval',
      translating: 'Translating…',
      translationTitle: 'Plain-language translation',
      detailAria: 'Approval details',
      reject: 'Reject',
      allowOnce: 'Allow once',
      copy: 'Copy plain explanation',
      copied: 'Copied',
      original: 'Original command (kept for review)',
      engineLine: 'Translated by: {engine}',
      engineLocal: 'Local Ollama',
      engineApi: 'DeepSeek API',
      engineRule: 'Local rules (no model call)',
      unavailable: 'Translation unavailable — judge for yourself',
      unavailableHint: 'Neither the local model nor DeepSeek is reachable; the local rule findings below are advisory.',
      emptyCommand: 'Empty command — nothing to translate',
      costLine: 'This call used {tokens} tokens, {cost}',
      dailyLine: 'Today total: {text}',
      cached: ' (cache hit, no new cost)',
      sections: [
        ['Intent', 'intent'],
        ['What it touches', 'touch'],
        ['Read or write', 'mode'],
        ['Risk', 'risk'],
        ['Advice', 'advice'],
        ['Worst case', 'consequence'],
        ['Benefit', 'benefit'],
      ],
      risk: { 安全: 'Safe', 注意: 'Caution', 危险: 'Danger' },
      // 与 zh 表对齐：advice 的映射以前也缺（见 zh 处注释）。
      advice: { 可以允许: 'Allow', 请先确认: 'Confirm first', 建议拒绝: 'Suggest reject' },
      'label.why': 'Why',
      'label.touch': 'What it touches',
      'label.outcome': 'If allowed',
      'label.intent': 'Intent',
      'label.mode': 'Read or write',
      'label.risk': 'Risk',
      'label.advice': 'Advice',
      'label.consequence': 'Worst case',
      'label.benefit': 'Benefit',
      parts: 'Step by step',
      notes: 'Notes',
      formatWarn: 'Malformed model output; the local rules filled the gaps. Raw model output:',
      copiedTip: 'Copied to clipboard',
      chipTitle: 'Plain translation',
      chipShow: 'Show details ▾',
      chipHide: 'Hide ▴',
      chipExpand: 'Plain translation · click to expand',
      chipCollapse: 'Collapse to one line',
      // v0.4.6-safe：拖动 / 复位功能已永久移除，位置由 CSS 固定，相关文案一并删除
      sInlineSummary: 'Show a translation summary inside the card',
      sInlineSummaryHint: 'Off by default. When on, the native approval card also shows a one-line "Plain: …" summary at the top.',
      // v0.7.0: reasoning switch + privacy note
      sUseReasoning: "Also use the AI's reasoning to judge intent",
      sUseReasoningHint: "On by default. The AI's reasoning before it asked for approval is passed to the translation model alongside its own messages, so the intent is judged more accurately. This stays on your machine. When off, the plugin does not read the reasoning at all — it is not merely hidden.",
      sUseReasoningOn: 'On: reasoning is used when translating',
      sUseReasoningOff: 'Off: reasoning is never read',
      chipOverlay: 'Overlay mode: {names} owns the approval card; the plain translation shows in the bottom-right panel.',
      grantForever: 'Always allow',
      grantForeverHint: 'Only "safe" commands can be always-allowed: exact command match, current workspace only, revocable anytime.',
      grantOnlySafe: 'Only "safe" commands can be always-allowed.',
      granted: 'Always-allowed (exact command, current workspace only)',
      grantFailed: 'Always-allow failed',
      sGrants: 'Always-allow (safe commands only)',
      sGrantsDesc: 'Only commands rated "safe" appear here. Exact string match, current workspace only, revocable anytime. Caution/danger commands never appear.',
      sGrantsEmpty: 'No always-allowed commands yet.',
      sGrantsCount: '{n} allowed',
      sGrantRevoke: 'Revoke',
      sGrantClear: 'Clear all',
      sGrantCleared: 'Cleared',
      sGrantWorkspace: 'Workspace',
      sGrantUses: 'auto-allowed {n} times',
      sGrantCreated: 'granted at',
      sAudit: 'Audit log',
      sAuditDesc: 'Every automatic allow is recorded: time, command hash, translation, rule id. Hash only — never the raw command.',
      sAuditView: 'View recent',
      sAuditExport: 'Export audit log',
      sAuditEmpty: 'No automatic allows yet.',
      // ---- v0.4 ----
      slotModeConflict: 'Takeover mode, but {names} also occupies the approval-card slot. Switch to overlay mode if you want both.',
      // v0.7.4: neutral note shown after the user has already chosen a mode.
      sSlotRivalsDone: 'Your choice is in effect ({mode}). {names} also occupy the approval-card slot — they will not yield; use overlay mode if the slot is contended.',
      slotModeTakeover: 'Currently TAKING OVER: the approval card is rendered by Plain Approval, with the full translation and no overlay.',
      slotModeOverlay: 'Currently OVERLAY: not taking over; the translation shows in the fixed bottom-right panel.',
      slotModeOff: 'Currently OFF: neither the card nor the overlay is shown.',
      slotModeUnknown: 'The client has not reported a slot decision yet (refresh the page).',
      wizardTitle: 'How should we translate?',
      wizardDesc: 'No technical knowledge needed. You can change this later in Settings.',
      wizardA: 'Automatic (recommended) — use DSH\'s AI. Costs a tiny amount, installs nothing.',
      wizardB: 'Local & free — use Ollama on this machine. Free, but you must install Ollama first.',
      wizardC: 'I will provide an API key — use your own DeepSeek or other API.',
      wizardNext: 'Next',
      // ---- v0.4.1 ----
      wizardSkip: 'Later (use the recommended setup)',
      wizardChecking: 'Checking this machine…',
      wizardUnknownHardware: 'No hardware details detected. Using the API is recommended, but the local model is not blocked either.',
      wizardOllamaReady: 'Ollama is running and the model is present — the local channel is ready, no warning needed.',
      wizardLocalOk: 'This machine is capable enough; the local channel is safe to use.',
      wizardHostOld: 'Choice saved. But the host (Node side) is still an older build — fully quit and restart DeepSeek Harness and everything will work.',
      sManualVram: 'Cannot read the GPU? Enter VRAM (GB) manually',
      sManualVramHint: '0 means no manual override. Your value is used and nothing is blocked.',
      sManualGpuName: 'GPU model (optional, display only)',
      wizardAUnavailable: 'DSH has no API key configured yet. Configure it under Settings → Models, or pick B for local Ollama.',
      wizardLocalWarn: 'This machine is below the recommended spec; using a local model may freeze the system.',
      wizardLocalRisk: 'I understand the risk, enable the local channel anyway',
      wizardRerun: 'Run the first-time setup again',
      sDevice: 'Device capability',
      sDeviceGpu: 'GPU',
      sDeviceVram: 'VRAM',
      sDeviceMem: 'Memory',
      sDeviceFree: 'Free memory now',
      sDeviceTierGood: 'Local LLM usable',
      sDeviceTierMarginal: 'Local LLM barely usable, not recommended',
      sDeviceTierUnusable: 'Local LLM unusable',
      sDeviceTierUnknown: 'No GPU detected',
      sDeviceForceOn: 'I understand the risk, enable the local channel anyway',
      sDeviceForceOff: 'Revert to automatic API use',
      sDeviceRestore: 'Restore local channel',
      sDeviceDisabled: 'Local channel temporarily disabled: {reason} (auto-restores in ~{mins} min)',
      sDeviceForcedNotice: 'The local channel was force-enabled. Each local translation adds a "device below spec" note.',
      sDeviceDetect: 'Re-detect',
      sDeviceRiskList: 'Possible consequences: system freeze, VRAM/RAM exhaustion (OOM), whole-machine stutter, Ollama crash.',
      sOom: 'Local model OOM protection',
      sOomMaxChars: 'Max command length per translation (chars)',
      sOomNumCtx: 'Context window num_ctx (smaller = less VRAM)',
      sOomNumPredict: 'Max output tokens num_predict',
      sOomConcurrency: 'Max Ollama concurrency (1-2)',
      sOomMaxQueue: 'Queue limit (beyond this, degrade)',
      sOomMinMem: 'Skip Ollama when free memory is below (GB)',
      sOomKeepAlive: 'Keep Ollama resident in VRAM (default off)',
      sOomHint: '{n} consecutive failures trip a {m}-minute breaker; requests use the API and recover automatically.',
      sOomBreaker: 'Ollama breaker is open: {reason}, auto-recovers in ~{sec}s',
      sOomStats: 'Last 10 avg {ms}ms · queued {queued} · running {running}',
      donateTitle: 'Like this plugin? Buy the author a coffee ☕',
      donateBody: 'This plugin is free and open source (MIT). Donating is entirely optional and changes nothing about the features. If it helped you, you may buy the author a coffee.',
      donateWechat: 'WeChat QR',
      donateAlipay: 'Alipay QR',
      donateAfdian: 'Aifadian',
      // ⚠️ Placeholder: replace with your own Aifidian page before publishing
      donateAfdianUrl: 'https://afdian.com/a/speak-human',
      donateQrPending: 'QR pending',
      donateHide: 'Close and do not show again',
      donateHidden: 'Hidden. It will not be shown again.',
      deviceNote: 'Note',
      privacyB: 'Note: channel B sends the command text to the official DeepSeek API.',
      confirmPaidTitle: 'This translation costs a little money',
      confirmPaidBody: 'This call will use the DeepSeek API (roughly a fraction of a cent). You can switch to local Ollama only to avoid any cost.',
      confirmPaidOk: 'Agree and continue',
      confirmPaidCancel: 'Show local rules only',
      retry: 'Retry',
      settingsNav: 'Plain Approval',
      sTitle: 'Plain Approval',
      sDesc: 'Every privileged command explained in plain words, by local Ollama or DSH’s DeepSeek.',
      sEngine: 'Translation engine',
      sEngineAuto: 'Auto fallback (recommended): local Ollama first, DeepSeek when unavailable',
      sEngineOllama: 'Local Ollama only (offline, free)',
      sEngineDeepseek: 'DeepSeek API only (works out of the box, consumes quota)',
      sOllama: 'Local Ollama',
      sBaseUrl: 'Base URL',
      sModel: 'Model',
      sTimeout: 'Timeout (ms)',
      sPull: 'Pull the model with: ollama pull {model}',
      sDeepseek: 'DeepSeek API',
      sDsTimeout: 'Timeout (ms)',
      sAsk: 'Ask me before every paid API call (default: no)',
      sPrivacy: 'With the DeepSeek API the command text leaves this machine. Local Ollama never does.',
      sPricing: 'Prices (CNY per 1M tokens, estimate only)',
      sPriceMiss: 'Input · cache miss',
      sPriceHit: 'Input · cache hit',
      sPriceOut: 'Output',
      sCache: 'Cache',
      sCacheOn: 'Enable cache (never translate the same command twice)',
      sCacheTtl: 'TTL (days)',
      sUi: 'Display',
      sColors: 'Colour-code risk (green/amber/red)',
      sShowCost: 'Show cost estimate',
      sDeny: 'Auto-reject when translation fails (default: no, degrade only)',
      sBlacklist: 'Blacklist keywords (one per line, always flagged red)',
      sBlacklistHint: 'Built-in dangerous keywords always apply; add your own here.',
      sSlot: 'Approval-card mode (v0.5.0: fixed mode, no auto-detection)',
      sSlotHint: 'Plain Approval never auto-yields and never probes other plugins. You choose here, the choice sticks, and you can change it any time.',
      sSlotTakeover: 'Take over: the plain card replaces the native approval card (default)',
      sSlotOverlay: 'Overlay: do not take over; show the translation in the fixed bottom-right panel',
      sSlotOff: 'Off: neither take over nor show the overlay (falls back to native)',
      sSlotCurrent: 'Current state',
      sSlotRivals: 'Detected: {names} also occupies the approval-card slot. Current mode is {mode}; the two may overlap — pick an explicit mode in the dropdown above.',
      sCaretakers: 'Yield-to list (one plugin name per line)',
      sCaretakersHint: 'Advisory only. Since v0.5.0 these names take part in no decision; they only affect the conflict notice above.',
      conflictTitle: 'Another plugin also handles approval cards',
      conflictBody: '{names} occupies the approval-card slot too. Pick how to handle it; the choice is remembered and never asked again.',
      conflictPickA: 'A. Plain translation only (recommended)',
      conflictPickB: 'B. Let them have it, I use the overlay',
      conflictPickC: 'C. Show neither, fall back to native',
      conflictFoot: 'You can always change this in Settings → Speak Human → Approval-card mode.',
      // ---- Approval history (v0.5.3) ----
      sDepth: 'Analysis depth',
      sDepthHint: 'L1 uses local rules only — instant and free, but the intent is a literal description. L2 calls the model to explain what the AI is really trying to do.',
      sDepthAuto: 'Auto: L1 for safe commands (free, instant), L2 for caution / danger',
      sDepthL1: 'Prefer L1: skip the model when local rules suffice (danger still forces L2)',
      sDepthL2: 'Always L2 (default): call the model for every command — most accurate intent',
      sDepthAllow: 'Allow manual "upgrade to L2" on the card',
      sDepthNow: 'Analysis',
      sDepthUpgrade: 'Upgrade to L2 (calls the model, costs tokens)',
      sDepthUpgrading: 'Upgrading…',
      sDepthElapsed: 'Elapsed',
      sDepthCost: 'Cost',
      sHistory: 'Approval history',
      showMore: 'Show details (touches / read-write / benefit / steps)',
      showMoreEn: 'Show details',
      sHistoryHint: 'Records the decision on every approval (who allowed, who rejected). Stores command hashes only, never the command text, unless you turn that on below.',
      sHistoryOpen: 'View history',
      sHistoryEnabled: 'Record approval history',
      sHistoryKeepCmd: 'Keep command text in history',
      sHistoryKeepCmdHint: 'Off by default. When on, the history file stores the command text (up to 4000 chars) — easier to look up, but weaker privacy.',
      sHistoryRetention: 'Retention (days)',
      sHistoryStats: '{n} entries · most recent {last}',
      sHistoryEmpty: 'No approvals recorded yet. Trigger one and it will show up here.',
      sHistoryFilterDecision: 'Decision',
      sHistoryFilterRange: 'Time range',
      sHistorySearch: 'Search command hash',
      sHistoryAll: 'All',
      sHistoryToday: 'Today',
      sHistoryWeek: 'Last 7 days',
      sHistoryMonth: 'Last 30 days',
      sHistoryExport: 'Export JSON',
      sHistoryExportRedact: 'Export (redacted)',
      sHistoryClear: 'Clear history',
      sHistoryClearConfirm: 'Clear the entire approval history? This cannot be undone.',
      sHistoryCleared: 'Cleared {n} history entries.',
      sHistoryNoCommand: '(command text not kept)',
      sHistoryAutoAllowed: 'Auto-allowed',
      sDiag: 'Capability check: what DSH exposes to plugins',
      sDiagRun: 'Run check',
      sDiagRunning: 'Running…',
      sEndpoint: 'Channel B target (baseUrl / protocol / model)',
      sEndpointHint: 'Empty = resolved from DSH configuration automatically; nothing is hard-coded.',
      sAdvanced2: 'Advanced',
      diagLlm: 'ctx.llm (DSH model routing)',
      diagModel: 'ctx.agentDefaultModel (current model)',
      diagCred: 'ctx.credentials (DeepSeek key)',
      diagEndpoint: 'Channel B target',
      sSave: 'Save',
      sSaved: 'Saved',
      sSaving: 'Saving…',
      sReset: 'Reset to defaults',
      sTest: 'Test both channels',
      sTesting: 'Testing…',
      sExport: 'Export diagnostics',
      sClearCache: 'Clear cache',
      sCleared: 'Cache cleared',
      sStatus: 'Channel status',
      sLightA: 'Channel A · local Ollama',
      sLightB: 'Channel B · DeepSeek API',
      sDataDir: 'Data directory (settings, cache and logs live here)',
      sAdvanced: 'Advanced: DeepSeek API key',
      sApiKey: 'API key (empty = reuse DSH’s own key)',
      sGreen: 'Ready',
      sYellow: 'Usable, not recommended',
      sRed: 'Unavailable',
      sTestA: 'Channel A',
      sTestB: 'Channel B',
      ok: 'OK',
      fail: 'Failed',
      ms: '{ms}ms',
      close: 'Close',
    }

    /* -------------------------------------------------------------- */
    /* 小工具                                                          */
    /* -------------------------------------------------------------- */

    function makeTT(props) {
      const seat = props && typeof props.t === 'function' ? props.t : null
      return (key, fallback) => {
        if (!seat) return fallback === undefined ? zh[key] : fallback
        try {
          const value = seat(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch (error) {
          /* 取不到就用内置中文 */
        }
        return fallback === undefined ? zh[key] : fallback
      }
    }

    function interpolate(template, params) {
      return String(template).replace(/\{(\w+)\}/gu, (m, key) => (params && params[key] !== undefined ? String(params[key]) : m))
    }

    /** v0.6.2：单行短文本（给日志用，避免换行污染 jsonl）。 */
    function oneLineText(value, max = 200) {
      const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
      return text.length > max ? text.slice(0, max) + '…' : text
    }

    /**
     * v0.6.2：把原始命令按命中区间切成高亮片段。
     *
     * 关键约束：**原始命令一个字都不删**。只是给危险片段加个视觉落点，
     * 让读者的眼睛有地方落 —— 而不是从左扫到右去找那几个 token。
     *
     * @param {string} command
     * @param {{start:number,end:number,kind:string}[]} spans
     */
    function highlightSpans(command, spans) {
      const text = String(command ?? '')
      const list = (Array.isArray(spans) ? spans : [])
        .filter((s) => s && Number.isInteger(s.start) && Number.isInteger(s.end) && s.end > s.start && s.start >= 0 && s.end <= text.length)
        .sort((a, b) => a.start - b.start)
      if (list.length === 0) return text

      // 去重叠：同一起点优先取更长的区间
      const merged = []
      for (const s of list) {
        const prev = merged[merged.length - 1]
        if (prev && s.start < prev.end) continue
        merged.push(s)
      }

      const out = []
      let cursor = 0
      for (const s of merged) {
        if (s.start > cursor) out.push(text.slice(cursor, s.start))
        out.push(
          h('mark', { className: 'pap_hot pap_hot_' + String(s.kind || 'x').replace(/[^\w-]/gu, ''), key: s.start + ':' + s.end }, text.slice(s.start, s.end)),
        )
        cursor = s.end
      }
      if (cursor < text.length) out.push(text.slice(cursor))
      return out
    }

    async function api(path, options = {}) {
      const headers = { accept: 'application/json', 'x-plain-approval': '1' }
      const init = { method: options.method || 'GET', headers, credentials: 'same-origin' }
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      if (options.signal) init.signal = options.signal
      const response = await fetch(API + path, init)
      const text = await response.text()
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const message = (payload && (payload.error || payload.message)) || `HTTP ${response.status}`
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      return payload.data
    }

    /* ------------------------------------------------------------------ */
    /* v0.4.6-safe：诊断上报总闸门                                          */
    /* ------------------------------------------------------------------ */
    /* 事故复盘的核心教训：v0.4.3 的内存爆炸不是「某次请求太大」，而是         */
    /* 「一次渲染循环 × 每次循环都发请求」这种**放大效应**。                   */
    /* 只要任何副作用能在渲染路径上被反复触发，它就会在几秒内把渲染进程撑爆。   */
    /* 所以这里对所有 note 类上报做进程级限流：                                */
    /* 即使上游再出现循环，请求量和宿主侧磁盘写入都被钉死在固定上限。          */
    const NOTE_WINDOW_MS = 5000
    const NOTE_MAX_PER_WINDOW = 12
    let noteStamps = []
    let noteDropped = 0

    /**
     * 受限的诊断上报。超预算时**静默丢弃**，绝不排队、绝不重试。
     * @param {string} event
     * @param {object} [details]
     */
    function note(event, details = {}) {
      try {
        const now = Date.now()
        noteStamps = noteStamps.filter((t) => now - t < NOTE_WINDOW_MS)
        if (noteStamps.length >= NOTE_MAX_PER_WINDOW) {
          noteDropped++
          return
        }
        noteStamps.push(now)
        api('note', { method: 'POST', body: { event, details } }).catch(() => undefined)
      } catch (error) {
        /* 诊断绝不影响主流程 */
      }
    }

    /** 翻译结果缓存上限：长会话里不无限增长（超过就丢最旧的）。 */
    const MAX_CACHED_RESULTS = 8
    function withResult(prev, key, value) {
      const next = { ...prev, [key]: value }
      const keys = Object.keys(next)
      if (keys.length <= MAX_CACHED_RESULTS) return next
      for (const k of keys.slice(0, keys.length - MAX_CACHED_RESULTS)) delete next[k]
      return next
    }

    /** 从会话快照里按 callId 取回工具参数（和官方 ApprovalCommand 同源）。 */
    function toolCallOf(useChat, callId) {
      if (typeof useChat !== 'function' || callId === undefined || callId === null) return undefined
      return useChat((snapshot) => {
        try {
          const nodes = snapshot && snapshot.nodes
          if (!nodes || typeof nodes.values !== 'function') return undefined
          let fallback
          for (const node of nodes.values()) {
            const root = node && node.kind === 'tool-call' ? node.data && node.data.root : undefined
            if (!root || root.callId === undefined) continue
            if (String(root.callId) !== String(callId)) continue
            if (root.argsRaw === undefined) continue
            if (!('kind' in root) && root.phase === 'start') return root.argsRaw
            if (fallback === undefined) fallback = root.argsRaw
          }
          return fallback
        } catch (error) {
          return undefined
        }
      })
    }

    function argsOf(argsRaw, toolName) {
      if (typeof argsRaw !== 'string' || argsRaw === '') return { command: '', toolName }
      let parsed = null
      try {
        parsed = JSON.parse(argsRaw)
      } catch {
        return { command: argsRaw, toolName }
      }
      if (!parsed || typeof parsed !== 'object') return { command: String(parsed ?? ''), toolName }
      if (typeof parsed.command === 'string') return { command: parsed.command, toolName: toolName || 'pwsh' }
      if (typeof parsed.file_path === 'string') return { command: `写入/修改文件：${parsed.file_path}`, toolName }
      if (typeof parsed.path === 'string') return { command: `读写路径：${parsed.path}`, toolName }
      if (typeof parsed.pattern === 'string') return { command: `查找：${parsed.pattern}`, toolName }
      return { command: argsRaw, toolName }
    }

    /**
     * 展示偏好：从 Host 拉一次，设置页保存后刷新。
     * v0.5.0-stable：`slotPolicy` 已废弃，取而代之的是 `slotMode`
     * （takeover / overlay / off），**只由用户在设置页显式决定，代码不做任何判定**。
     */
    const uiPrefs = {
      colors: true,
      showCost: true,
      slotMode: 'takeover',
      conflictResolved: false,
      rivals: [],
      caretakerPlugins: [],
      onboarded: false,
      loaded: false,
    }
    async function refreshPrefs() {
      try {
        const data = await api('settings')
        const ui = (data && data.settings && data.settings.ui) || {}
        uiPrefs.colors = ui.colors !== false
        uiPrefs.showCost = ui.showCost !== false
        uiPrefs.slotMode = ['takeover', 'overlay', 'off'].includes(ui.slotMode) ? ui.slotMode : 'takeover'
        uiPrefs.conflictResolved = ui.conflictResolved === true
        const slot = data && data.slot
        uiPrefs.rivals = slot && Array.isArray(slot.rivals) ? slot.rivals.slice() : []
        uiPrefs.caretakerPlugins = Array.isArray(data?.settings?.caretakerPlugins) ? data.settings.caretakerPlugins : []
        uiPrefs.onboarded = ui.onboarded === true
        uiPrefs.loaded = true
      } catch (error) {
        /* 拿不到就保持默认值 */
      }
    }

    /**
     * 浮层是否应当显示。
     * v0.5.0：**只看模式**。接管模式（takeover）下永远不显示浮窗，
     * 完全关闭（off）下也不显示 —— 只有 overlay 模式才显示右下角浮窗。
     * 这里没有任何「判定」，也就没有判定带来的抖动。
     */
    function shouldShowOverlay(items) {
      if (uiPrefs.slotMode !== 'overlay') return false
      return Array.isArray(items) && items.length > 0
    }

    /* ------------------------------------------------------------------ */
    /* v0.5.0-stable：槽位冲突**只读快照**                                     */
    /* ------------------------------------------------------------------ */
    /* v0.4.x 在这里做的是「自动让位判定」：把 conversation.composer 上每个条目  */
    /* 的 select() 都调一遍，谁接手就让位；判定一变，整棵子树就在「审批卡片」   */
    /* 和「右下角浮窗」之间换挂。那套逻辑的问题不是「慢」，而是**不可预测**：    */
    /* 判定依赖当下的 DOM 与别人的内部实现，而审批弹出的那一瞬间正是状态变化   */
    /* 最密集的时刻 —— v0.4.3 的内存爆炸就发生在它选中的让位路径上。            */
    /*                                                                        */
    /* v0.5.0 起这里只做一件事：**只读地看一眼链上有谁**。                      */
    /*   · 只读 options 元数据（priority / locale / registrant / 组件名）       */
    /*   · **绝不调用任何人的 select()**（v0.4.x 的自动让位就是靠调它实现的）   */
    /*   · 绝不修改任何东西，绝不注册监听器，绝不碰 DOM                         */
    /*   · 只跑一次，结果仅用于「首次提示一次」与设置页展示                     */
    /* 是否接管完全由用户在设置页显式决定（ui.slotMode）。                     */
    /* ------------------------------------------------------------------ */

    /**
     * DSH 自带组件名单（只读元数据里分不出来，只能显式排除）。
     *
     * 为什么需要这张表：实测 DSH 0.2.0-rc.2 会把注册项的 `registrant` 与 `locale`
     * 一律置为 null —— **连我们自己在 register() 里传的 `locale` 也变成 null**。
     * 也就是说光看元数据，DSH 自带的 composer 和第三方插件长得一模一样。
     *
     * 我们又明确拒绝调用别人的 `select()` 来问「你接不接」（v0.5.0 起）
     * —— 那是不可预测性的源头。所以剩下的办法只有这张显式名单。
     *
     * ⚠️ DSH 以后新增自带组件时，需要往这里补一行。
     *    启动日志里的 `slot.roster` 会打印完整名单，补之前先看一眼它。
     */
    const DSH_BUILTIN_COMPONENTS = new Set([
      'SubagentReadOnlyComposer',
      'QuestionComposer',
    ])

    /** 是不是「我们自己」或官方自带的条目（这些不算冲突）。 */
    function isSelfOrOfficial(entry) {
      const options = entry?.options ?? {}
      const locale = String(options.locale ?? '').trim()
      const registrant = String(options.registrant ?? '').trim()
      if (locale && MY_REGISTRANTS.has(locale)) return true
      if (registrant && MY_REGISTRANTS.has(registrant)) return true
      if (entry?.component === ComposerEntry) return true
      if (entry?.component === ReviewChipEntry) return true
      if (registrant && OFFICIAL_REGISTRANT.test(registrant)) return true
      if (locale && OFFICIAL_REGISTRANT.test(locale)) return true
      // component 可能是函数，也可能已是字符串
      const comp = entry?.component
      const compName = typeof comp === 'function' ? comp.name : typeof comp === 'string' ? comp.trim() : ''
      if (compName && DSH_BUILTIN_COMPONENTS.has(compName)) return true
      return false
    }

    /** 给冲突项起一个能看懂的显示名（拿不到真名就退回占位）。 */
    function rivalLabelOf(entry) {
      const options = entry?.options ?? {}
      const registrant = String(options.registrant ?? '').trim()
      if (registrant) return registrant
      // component 既可能是函数（取 .name），也可能是已被字符串化的名字，两种都要认。
      const component = entry?.component
      const name = typeof component === 'function' ? component.name : typeof component === 'string' ? component.trim() : ''
      if (name) return name
      return `第三方插件(priority=${options.priority ?? '?'})`
    }

    let conflictScanDone = false

    /**
     * 只读冲突扫描，**整个客户端生命周期只跑一次**。
     * @returns {string[]} 冲突项的显示名（已去重、已截断）
     */
    function scanSlotConflictsOnce(slots) {
      if (conflictScanDone) return uiPrefs.rivals
      conflictScanDone = true
      try {
        // 注意：这里只调 entries() 拿元数据；**一个 select() 都不会调**。
        const entries = slots && typeof slots.entries === 'function' ? slots.entries('conversation.composer') : []
        const list = Array.isArray(entries) ? entries : []
        // 完整名单记一条，方便在「DSH 以后新增自带组件」时对照补名单
        try {
          note('slot.roster', {
            items: list.map((e) => {
              const o = e?.options ?? {}
              const comp = e?.component
              return {
                priority: o.priority ?? null,
                registrant: o.registrant ?? null,
                locale: o.locale ?? null,
                component: typeof comp === 'function' ? comp.name || '(anon)' : typeof comp === 'string' ? comp : null,
              }
            }),
          })
        } catch {
          /* 只读诊断，失败无所谓 */
        }
        const found = []
        const seen = new Set()
        for (const entry of list) {
          if (isSelfOrOfficial(entry)) continue
          const label = rivalLabelOf(entry)
          if (!label || seen.has(label)) continue
          seen.add(label)
          found.push(label)
          if (found.length >= 10) break
        }
        uiPrefs.rivals = found
        note('slot.scan', { count: found.length, rivals: found })
        return found
      } catch (error) {
        /* 读不到就当没有冲突：绝不阻塞审批 */
        uiPrefs.rivals = []
        return []
      }
    }

    /**
     * 模式切换的唯一出口：写配置 + 记住已选择，之后不再询问。
     * @param {'takeover'|'overlay'|'off'} mode
     */
    async function chooseSlotMode(mode) {
      const next = ['takeover', 'overlay', 'off'].includes(mode) ? mode : 'takeover'
      uiPrefs.slotMode = next
      uiPrefs.conflictResolved = true
      try {
        await api('settings', { method: 'POST', body: { ui: { slotMode: next, conflictResolved: true } } })
        note('slot.choice', { mode: next })
      } catch (error) {
        /* 写不进去也先按新模式走，不阻塞界面 */
      }
      return next
    }

    /** 需要问用户吗：有冲突，且用户还没选过。 */
    function needsConflictChoice() {
      return uiPrefs.loaded && uiPrefs.conflictResolved !== true && uiPrefs.rivals.length > 0
    }
    /** 通道 A 面板默认折叠：只有用户选了本地、或检测到已装 Ollama 时才自动展开。 */
    function showOllamaPanel(settings, ollama) {
      if (!settings) return false
      if (settings.engine === 'ollama' || settings.engine === 'local-first') return true
      if (settings.ui && settings.ui.onboarded !== true) return false
      return Boolean(ollama && ollama.status === 'green')
    }

    /**
     * 槽位当前状态的一句话（v0.5.0：只报「当前模式」与「是否检测到冲突」，
     * 不再报任何自动判定的结论 —— 因为 v0.5.0 已经没有判定了）。
     */
    function slotStateText(status, tt) {
      const mode = uiPrefs.slotMode || 'takeover'
      if (mode === 'off') return tt('slotModeOff')
      if (mode === 'overlay') return tt('slotModeOverlay')
      const rivals = (status && status.slot && Array.isArray(status.slot.rivals) ? status.slot.rivals : uiPrefs.rivals) || []
      if (rivals.length > 0) return interpolate(tt('slotModeConflict'), { names: rivals.join('、') })
      return tt('slotModeTakeover')
    }

    /** 设备档位 → 状态灯颜色（绿/黄/红）。 */
    function deviceTierLightState(payload) {
      const tier = payload && payload.device ? payload.device.tier : 'unknown'
      if (tier === 'good') return 'green'
      if (tier === 'marginal') return 'yellow'
      return 'red'
    }

    function deviceTierLabel(payload, tt) {
      const tier = payload && payload.device ? payload.device.tier : 'unknown'
      if (tier === 'good') return tt('sDeviceTierGood')
      if (tier === 'marginal') return tt('sDeviceTierMarginal')
      if (tier === 'unusable') return tt('sDeviceTierUnusable')
      return tt('sDeviceTierUnknown')
    }

    function riskClass(risk) {      if (risk === '危险') return 'pap_riskDanger'
      if (risk === '注意') return 'pap_riskWarn'
      return 'pap_riskSafe'
    }

    function engineLabelOf(result, tt) {
      if (!result || !result.engine) return tt('engineRule')
      if (result.engine === 'ollama') return tt('engineLocal')
      if (result.engine === 'deepseek') return tt('engineApi')
      return tt('engineRule')
    }

    /**
     * 折叠区要显示的段落（v0.7.0）。
     * 标题已在首屏、风险和建议也已合并进首屏，这里只剩「想细看才看」的三段：
     * 为什么 / 碰什么（含读写）/ 如果允许（含后果与收益）。
     * 旧的「读还是写」不再单独成段 —— 已在后端并进 touch 文案里。
     */
    const SECTION_KEYS = ['why', 'touch', 'outcome']
    function localizedSections(tt, sections) {
      const rows = []
      for (const key of SECTION_KEYS) {
        // 模型可能没给某段（旧数据 / 解析降级），空着不显示 —— 空着比废话好。
        if (!(sections && sections[key])) continue
        rows.push([tt('label.' + key), key])
      }
      return rows
    }

    /* -------------------------------------------------------------- */
    /* 审批卡片                                                        */
    /* -------------------------------------------------------------- */

    function SectionRow({ label, value }) {
      return h(
        'div',
        { className: 'pap_row' },
        h('div', { className: 'pap_rowLabel' }, label),
        h('div', { className: 'pap_rowValue' }, value),
      )
    }

    function ApprovalCard(props) {
      const pending = props.matched
      const tt = makeTT(props)
      const colors = uiPrefs
      React.useEffect(() => {
        if (!uiPrefs.loaded) refreshPrefs()
      }, [])
      const [result, setResult] = React.useState(() =>
        (pending && pending.displayReason && pending.displayReason['plain-approval']) || null,
      )
      const [phase, setPhase] = React.useState('loading')
      const [error, setError] = React.useState(null)
      const [confirmPaid, setConfirmPaid] = React.useState(false)
      // v0.6.0：手动升级到 L2
      const [upgrading, setUpgrading] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [done, setDone] = React.useState(false)
      const [granting, setGranting] = React.useState(false)
      const [grantNote, setGrantNote] = React.useState(null)
      const busy = React.useRef(false)
      const alive = React.useRef(true)
      const abortRef = React.useRef(null)
      const composing = React.useRef(false)
      const compositionEnded = React.useRef(false)

      const toolArgs = toolCallOf(props.useChat, pending ? pending.callId : undefined)
      const extracted = argsOf(toolArgs, pending ? pending.toolName : undefined)
      // 需求（稳定性）：客户端取不到命令时，退回 Host 从会话里取到的那一份
      const hostQuick = pending && pending.displayReason && pending.displayReason['plain-approval']
      const hostCommand = hostQuick && hostQuick.command && typeof hostQuick.command.text === 'string' ? hostQuick.command.text : ''
      const command = extracted.command || hostCommand || ''
      const toolName = extracted.toolName || (pending ? pending.toolName : undefined)
      const pendingCallId = pending ? pending.callId : undefined

      /* v0.4.6-safe：这里曾经是一句裸的 api('note') —— 直接写在渲染函数体里。
         后果：只要客户端取不到命令（正是审批卡片刚出现的那一瞬），
         每渲染一次就发一次 POST，渲染 → 上报 → 宿主写日志 → 触发的连锁反应
         会把渲染进程在几秒内撑到 GB 级。这正是本次事故的同类放大路径。
         现在：渲染函数体**只算值、不做副作用**；上报交给下面的 effect，且每个
         callId 最多报一次，外加 note() 的进程级限流兜底。 */
      const noCommandReported = React.useRef(false)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
          // 需求 28：用户在翻译完成前点了允许/拒绝 → 立刻取消，不再展示翻译结果
          try {
            abortRef.current?.abort()
          } catch (error) {
            /* 忽略 */
          }
        }
      }, [])

      /* 切换到新的审批请求时，允许再报一次「取不到命令」。 */
      React.useEffect(() => {
        noCommandReported.current = false
      }, [pendingCallId])

      /* 诊断上报（渲染期副作用已移出渲染函数体，每个 callId 只发一次）。 */
      React.useEffect(() => {
        if (command || hostQuick) return
        if (noCommandReported.current) return
        noCommandReported.current = true
        note('card.no-command', { tool: String(toolName ?? ''), callId: String(pendingCallId ?? '') })
      }, [command, hostQuick, toolName, pendingCallId])

      const runTranslate = React.useCallback(
        async (confirm, forceDepth) => {
          try {
            abortRef.current?.abort()
          } catch (error) {
            /* 忽略 */
          }
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          abortRef.current = controller
          const timer = setTimeout(() => {
            try {
              controller?.abort()
            } catch (error) {
              /* 忽略 */
            }
          }, FETCH_TIMEOUT_MS)
          setPhase('loading')
          setError(null)
          try {
            const data = await api('translate', {
              method: 'POST',
              body: {
                command,
                toolName,
                reason: pending ? pending.reason : undefined,
                callId: pending ? pending.callId : undefined,
                confirmPaid: confirm === true,
                // v0.6.0：用户点了「升级到 L2」就带上这个标记，宿主侧强制走模型
                forceDepth: forceDepth === 'l2' ? 'l2' : undefined,
              },
              signal: controller ? controller.signal : undefined,
            })
            if (!alive.current) return
            setResult(data)
            setConfirmPaid(data.status === 'needs-confirm')
            setPhase('ready')
          } catch (err) {
            if (!alive.current) return
            if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
              setPhase(result ? 'ready' : 'timeout')
              return
            }
            setError(err && err.message ? err.message : String(err))
            setPhase(result ? 'ready' : 'error')
          } finally {
            clearTimeout(timer)
          }
        },
        [command, toolName, pending],
      )

      React.useEffect(() => {
        // v0.5.8：宿主在审批时已经算过一次完整翻译并回填到挂起条目（pending.full）。
        // 有它就直接用，**不再发一次 /translate** —— 以前同一个审批要调两次模型，
        // 用户得多等一轮 6~20 秒。宿主还在算（full 为 null）才走接口。
        const pre = pending && pending.full
        if (pre && pre.sections) {
          if (alive.current) {
            setResult(pre)
            setConfirmPaid(pre.status === 'needs-confirm')
            setPhase('ready')
          }
          return undefined
        }
        // 本地规则结果已经在手时，先把它显示出来，再去取模型结果（需求 27）
        runTranslate(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [command, pending ? pending.key : undefined])

      // v0.6.0：手动升级到 L2。L1 的结果已经能看了，这一步只是换成更深的解释。
      const upgradeToL2 = async () => {
        if (upgrading) return
        setUpgrading(true)
        try {
          await runTranslate(false, 'l2')
        } finally {
          if (alive.current) setUpgrading(false)
        }
      }

      const answer = (outcome) => {
        if (busy.current || !pending || !pending.answerable) return
        busy.current = true
        setDone(true)
        try {
          abortRef.current?.abort()
        } catch (error) {
          /* 忽略 */
        }
        try {
          Promise.resolve(pending.answer(outcome)).catch(() => {
            if (!alive.current) return
            busy.current = false
            setDone(false)
          })
        } catch (error) {
          busy.current = false
          setDone(false)
        }
      }

      const onKeyDown = (event) => {
        try {
          const element = event.target
          const current = event.currentTarget
          if (event.defaultPrevented) return
          if (!current || !element || !current.contains(document.activeElement)) return
          if (element.closest && element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null) return
          if (event.key !== 'Enter' && event.key !== 'Escape') return
          if (event.key === 'Enter' && element.closest && element.closest('button, a[href], [role="button"]') !== null) return
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
          event.preventDefault()
          event.stopPropagation()
          if (event.repeat || composing.current || compositionEnded.current || (event.nativeEvent && event.nativeEvent.isComposing) || event.keyCode === 229) return
          answer(event.key === 'Enter' ? 'allowed-once' : 'rejected')
        } catch (error) {
          /* 键盘处理永不抛出 */
        }
      }

      const copy = async () => {
        try {
          const text = (result && result.text && result.text.zh) || ''
          if (!text) return
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text)
          else {
            const area = document.createElement('textarea')
            area.value = text
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
          }
          setCopied(true)
          setTimeout(() => {
            if (alive.current) setCopied(false)
          }, 1600)
        } catch (error) {
          /* 复制失败不影响审批 */
        }
      }

      /**
       * 长期同意（v0.3）：只有「安全」命令才提供这个按钮。
       * 真正的把关在 Host（会重新跑一遍规则），这里只是不让用户白点。
       */
      const grantForever = async () => {
        if (!command || granting) return
        const risk = sections && sections.risk
        if (risk !== '安全') {
          setGrantNote(tt('grantOnlySafe'))
          return
        }
        setGranting(true)
        setGrantNote(null)
        try {
          await api('grants/add', { method: 'POST', body: { command, toolName } })
          setGrantNote(tt('granted'))
          // 本条也立即放行
          setTimeout(() => answer('allowed-once'), 350)
        } catch (err) {
          setGrantNote((err && err.message ? err.message : String(err)) || tt('grantFailed'))
        } finally {
          setGranting(false)
        }
      }

      const sections = result && result.sections ? result.sections : null
      const unavailable = result && (result.status === 'unavailable' || result.status === 'needs-confirm')
      const isEmpty = result && result.status === 'empty'
      // v0.6.2：详情默认展开与否，由风险决定（危险/注意自动展开，安全折叠）
      const detailOpen = Boolean(sections && (sections.risk === '危险' || sections.risk === '注意'))

      const blockTitleText = isEmpty ? tt('emptyCommand') : unavailable ? tt('unavailable') : tt('translationTitle')
      // v0.5.9：翻译不可用时，区块标题和 result.headline 是同一句话，
      // 页面上会出现两遍一模一样的「翻译不可用，请自行判断」。这里按内容去重。
      const headlineText = result && result.headline && result.headline !== blockTitleText ? result.headline : null
      const showCost = result && result.cost && result.cost.costText
      const canGrantForever = Boolean(sections && sections.risk === '安全' && command)

      return h(
        'div',
        {
          className: 'pap_root',
          'data-plain-approval': 'card',
          'aria-busy': done,
          onKeyDown,
          onKeyUpCapture: () => {
            compositionEnded.current = false
          },
          onCompositionStartCapture: () => {
            composing.current = true
          },
          onCompositionEndCapture: () => {
            composing.current = false
            compositionEnded.current = true
          },
        },
        h(
          'div',
          { className: 'pap_card' },
          h(
            'div',
            { className: 'pap_strip' },
            h('span', { className: 'pap_dot' }),
            tt('waiting'),
            sections ? h('span', { className: 'pap_badge ' + (colors.colors ? riskClass(sections.risk) : 'pap_riskPlain') }, (tt('risk') || {})[sections.risk] || sections.risk) : null,
            phase === 'loading' ? h('span', { className: 'pap_note' }, ' · ' + tt('translating')) : null,
          ),
          h(
            'div',
            { className: 'pap_body', 'data-approval-scroll': '', tabIndex: 0, role: 'group', 'aria-label': tt('detailAria') },
            // ---- 说人话（永远在原始命令上方）----
            h(
              'div',
              { className: 'pap_block' },
              h(
                'div',
                { className: 'pap_blockHead' },
                h('span', { className: 'pap_blockTitle' }, blockTitleText),
                h(
                  'button',
                  { type: 'button', className: 'pap_link', onClick: copy, disabled: !(result && result.text) },
                  copied ? tt('copied') : tt('copy'),
                ),
              ),
              !result && phase === 'loading' ? h('div', { className: 'pap_skeleton' }, tt('translating')) : null,
              headlineText ? h('div', { className: 'pap_headline pap_headlineWarn' }, headlineText) : null,
              // ---- v0.7.0：第一屏 ----
              // 用户心里的问题依次是：①发生了什么事 ②我需要担心吗 ③我该怎么做 ④想细看。
              // 所以顺序固定为：标题（答①）→ 风险+建议（答②③，合并一行）→ 按钮。
              // 「如果允许」和原始命令都挪进下面的折叠区，第一屏只留决策必需项。
              sections
                ? h(
                    'div',
                    { className: 'pap_verdict' + (sections.risk === '危险' ? ' pap_verdictDanger' : '') },
                    h('div', { className: 'pap_verdictTitle' }, String(sections.title || sections.intent || '')),
                    h(
                      'div',
                      { className: 'pap_verdictTop' },
                      h('span', { className: 'pap_verdictRisk ' + (colors.colors ? riskClass(sections.risk) : 'pap_riskPlain') }, (tt('risk') || {})[sections.risk] || sections.risk),
                      h('span', { className: 'pap_verdictAdvice' }, (tt('advice') || {})[sections.advice] || sections.advice),
                    ),
                  )
                : null,
              // ---- 次要信息：按风险决定是否默认展开 ----
              sections
                ? h(
                    'details',
                    { className: 'pap_more', open: detailOpen },
                    h('summary', null, `${tt('showMore')}${sections.risk === '安全' ? '' : '（建议展开）'}`),
                    h(
                      'div',
                      { className: 'pap_grid' },
                      localizedSections(tt, sections)
                        .filter(([, key]) => key !== 'title')
                        .map(([label, key]) =>
                          h(SectionRow, {
                            key,
                            label,
                            value: h('span', null, sections[key]),
                          }),
                        ),
                    ),
                  )
                : null,
              sections && sections.parts && sections.parts.length
                ? h(
                  'div',
                  { className: 'pap_parts' },
                  h('div', { className: 'pap_partsTitle' }, tt('parts')),
                  sections.parts.map((p, i) => h('div', { className: 'pap_part', key: i }, h('b', null, p.label + '：'), p.text)),
                )
                : null,
              unavailable ? h('div', { className: 'pap_note' }, tt('unavailableHint')) : null,
              result && result.degradeNote ? h('div', { className: 'pap_note' }, result.degradeNote) : null,
              result && result.notes && result.notes.length
                ? h(
                  'div',
                  { className: 'pap_notes' },
                  h('div', { className: 'pap_notesTitle' }, tt('notes')),
                  result.notes.map((n, i) => h('div', { className: 'pap_note', key: i }, '· ' + n)),
                )
                : null,
              result && result.formatWarning
                ? h(
                  'div',
                  { className: 'pap_notes' },
                  h('div', { className: 'pap_notesTitle' }, tt('formatWarn')),
                  h('pre', { className: 'pap_pre' }, result.formatWarning.raw),
                )
                : null,
              error ? h('div', { className: 'pap_error' }, error) : null,
            ),

            // ---- 原始命令：保留原文，放在翻译下方，有技术背景的人可以复查 ----
            command
              ? h(
                'div',
                { className: 'pap_block' },
                h('div', { className: 'pap_blockHead' }, h('span', { className: 'pap_blockTitle' }, tt('original'))),
                // v0.6.2：原始命令一个字都不隐藏，但把**真正触发风险判定的那几个 token** 高亮出来。
                // 高亮位置来自 rules.spans（与风险判定同一批正则），不会自相矛盾。
                h('pre', { className: 'pap_command' }, highlightSpans(command, result?.spans)),
              )
              : null,

            // ---- 费用透明 ----
            h(
              'div',
              { className: 'pap_footer' },
              h('div', { className: 'pap_engine' }, interpolate(tt('engineLine'), { engine: engineLabelOf(result, tt) })),
              showCost
                ? h(
                  'div',
                  { className: 'pap_cost' },
                  interpolate(tt('costLine'), { tokens: result.cost.totalTokens, cost: result.cost.costText }),
                )
                : null,
              showCost && result.daily ? h('div', { className: 'pap_cost pap_costDim' }, interpolate(tt('dailyLine'), { text: String(result.daily).replace('当日累计：', '') })) : null,
              result && result.cached ? h('div', { className: 'pap_cost pap_costDim' }, tt('cached')) : null,
              // ---- v0.6.0：成本透明（本次分析深度 / 耗时 / 费用）+ 手动升级 ----
              h(
                'div',
                { className: 'pap_depth' },
                h('span', { className: 'pap_depthLabel' }, tt('sDepthNow') + ' ' + String(result?.depthLabel ?? '')),
                typeof result?.elapsedMs === 'number'
                  ? h('span', { className: 'pap_depthMeta' }, `${tt('sDepthElapsed')} ${(result.elapsedMs / 1000).toFixed(1)}s`)
                  : null,
                result?.cost?.costText
                  ? h('span', { className: 'pap_depthMeta' }, `${tt('sDepthCost')} ${result.cost.costText}`)
                  : null,
                result?.canUpgrade === true
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'pap_link',
                        disabled: upgrading,
                        onClick: () => upgradeToL2(),
                      },
                      upgrading ? tt('sDepthUpgrading') : tt('sDepthUpgrade'),
                    )
                  : null,
              ),
            ),

            // ---- 付费确认（需求 12）----
            confirmPaid
              ? h(
                'div',
                { className: 'pap_confirm' },
                h('div', { className: 'pap_confirmTitle' }, tt('confirmPaidTitle')),
                h('div', { className: 'pap_confirmBody' }, tt('confirmPaidBody')),
                h('div', { className: 'pap_privacy' }, tt('privacyB')),
                h(
                  'div',
                  { className: 'pap_confirmActions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pap_btn pap_btnPrimary',
                      onClick: () => {
                        setConfirmPaid(false)
                        runTranslate(true)
                      },
                    },
                    tt('confirmPaidOk'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pap_btn',
                      onClick: () => {
                        setConfirmPaid(false)
                        setPhase('ready')
                      },
                    },
                    tt('confirmPaidCancel'),
                  ),
                ),
              )
              : null,
          ),
          h(
            'div',
            { className: 'pap_actions' },
            grantNote ? h('span', { className: 'pap_grantNote' }, grantNote) : null,
            phase !== 'loading' && !result
              ? h(
                'button',
                { type: 'button', className: 'pap_btn', onClick: () => runTranslate(false) },
                tt('retry'),
              )
              : null,
            h(
              'button',
              { type: 'button', className: 'pap_btn pap_btnReject', disabled: done, onClick: () => answer('rejected') },
              tt('reject'),
            ),
            canGrantForever
              ? h(
                'button',
                {
                  type: 'button',
                  className: 'pap_btn',
                  disabled: done || granting,
                  title: tt('grantForeverHint'),
                  onClick: grantForever,
                },
                granting ? '…' : tt('grantForever'),
              )
              : null,
            h(
              'button',
              { type: 'button', className: 'pap_btn pap_btnPrimary', disabled: done, onClick: () => answer('allowed-once') },
              tt('allowOnce'),
            ),
          ),
        ),
      )
    }

    /** 最小可用面板：卡片渲染异常时仍能审批。 */
    function FallbackCard({ pending, t }) {
      const [done, setDone] = React.useState(false)
      const busy = React.useRef(false)
      const tt = t
      const answer = (outcome) => {
        if (busy.current || !pending || !pending.answerable) return
        busy.current = true
        setDone(true)
        try {
          Promise.resolve(pending.answer(outcome)).catch(() => {
            busy.current = false
            setDone(false)
          })
        } catch (error) {
          busy.current = false
          setDone(false)
        }
      }
      return h(
        'div',
        { className: 'pap_root', 'data-plain-approval': 'fallback' },
        h(
          'div',
          { className: 'pap_card' },
          h('div', { className: 'pap_strip' }, h('span', { className: 'pap_dot' }), tt('waiting')),
          h(
            'div',
            { className: 'pap_body' },
            h('div', { className: 'pap_headline' }, String((pending && pending.reason) || tt('waiting'))),
          ),
          h(
            'div',
            { className: 'pap_actions' },
            h('button', { type: 'button', className: 'pap_btn pap_btnReject', disabled: done, onClick: () => answer('rejected') }, tt('reject')),
            h('button', { type: 'button', className: 'pap_btn pap_btnPrimary', disabled: done, onClick: () => answer('allowed-once') }, tt('allowOnce')),
          ),
        ),
      )
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error, info) {
        try {
          console.error('[plain-approval] 审批卡片渲染异常，已降级：', error)
        } catch (ignored) {
          /* 控制台不可用也无所谓 */
        }
        // 同 PluginBoundary：渲染异常必须落盘，否则事后无从查起。
        try {
          const stack = String((error && error.stack) || '')
          note('render.error', {
            boundaryText: 'approval-card',
            errName: String((error && error.name) || ''),
            errMessage: String((error && error.message) || ''),
            stack,
            componentStack: (info && info.componentStack) ? String(info.componentStack) : '',
          })
        } catch (ignored) {
          /* 上报失败也绝不二次抛出 */
        }
      }
      render() {
        if (this.state.failed) return h(FallbackCard, { pending: this.props.pending, t: this.props.t })
        return this.props.children
      }
    }

    function ComposerEntry(props) {
      // v0.4.5：整张白话卡片外面再包一层渲染兜底 —— 卡片渲染炸了也只是少一块 UI，
      // 绝不让 DSH 的输入区/整个界面跟着崩。
      return h(
        PluginBoundary,
        { text: '说人话暂不可用（卡片渲染异常），请直接看原始命令', silent: false },
        h(Boundary, { pending: props.matched, t: makeTT(props) }, h(ApprovalCard, props)),
      )
    }

    /* -------------------------------------------------------------- */
    /* 让位浮层（v0.2）：槽位让给别人，翻译不消失                          */
    /* -------------------------------------------------------------- */

    /** 七段 + 原始命令 + 引擎/费用的只读渲染，卡片与浮层共用。 */
    function PlainResult({ result, tt, colors, showCost, stacked }) {
      if (!result) return null
      const sections = result.sections || null
      if (!sections) return null
      return h(
        'div',
        { className: 'pap_plain' + (stacked ? ' pap_plainWide' : '') },
        result.headline ? h('div', { className: 'pap_headline pap_headlineWarn' }, result.headline) : null,
        // v0.7.0：浮窗也要有「标题 + 风险·建议」这一行。
        // 之前只把它加在了审批卡片的 pap_verdict 里，结果浮窗模式
        // （不接管卡片，只在右下角显示）**既没有风险等级也没有建议** ——
        // 浮窗恰恰是「不接管」时用户的唯一信息来源，漏掉它等于把决策依据拿走了。
        h('div', { className: 'pap_verdictTitle' }, String(sections.title || sections.intent || '')),
        h(
          'div',
          { className: 'pap_verdictTop' },
          h('span', { className: 'pap_verdictRisk ' + (colors?.colors ? riskClass(sections.risk) : 'pap_riskPlain') }, (tt('risk') || {})[sections.risk] || sections.risk),
          h('span', { className: 'pap_verdictAdvice' }, (tt('advice') || {})[sections.advice] || sections.advice),
        ),
        h(
          'div',
          { className: stacked ? 'pap_paper' : 'pap_grid' },
          localizedSections(tt, sections).map(([label, key]) => {
            if (!stacked) return h(SectionRow, { key, label, value: h('span', null, sections[key]) })
            return h(
              'div',
              { key, className: 'pap_paperRow' },
              h('div', { className: 'pap_paperLabel' }, label),
              h('div', { className: 'pap_paperValue' }, sections[key]),
            )
          }),
        ),
        sections.parts && sections.parts.length
          ? h(
            'div',
            { className: 'pap_parts' },
            h('div', { className: 'pap_partsTitle' }, tt('parts')),
            sections.parts.map((p, i) => h('div', { className: 'pap_part', key: i }, h('b', null, p.label + '：'), p.text)),
          )
          : null,
        result.notes && result.notes.length
          ? h(
            'div',
            { className: 'pap_notes' },
            h('div', { className: 'pap_notesTitle' }, tt('notes')),
            result.notes.map((n, i) => h('div', { className: 'pap_note', key: i }, '· ' + n)),
          )
          : null,
        result.command && result.command.text
          ? h(
            'div',
            { className: 'pap_block' },
            h('div', { className: 'pap_blockHead' }, h('span', { className: 'pap_blockTitle' }, tt('original'))),
            h('pre', { className: 'pap_command' }, result.command.text),
          )
          : null,
        h(
          'div',
          { className: 'pap_footer' },
          h('div', { className: 'pap_engine' }, interpolate(tt('engineLine'), { engine: engineLabelOf(result, tt) })),
          showCost && result.cost
            ? h('div', { className: 'pap_cost' }, interpolate(tt('costLine'), { tokens: result.cost.totalTokens, cost: result.cost.costText }))
            : null,
        ),
      )
    }

    /**
     * 让位浮层：注册在 `shell.overlay`（frame-wide、可点击穿透的附加层），
     * 只在「已让位 + 有挂起审批」时出现，显示一个「查看说人话」的小条。
     * 点开才触发模型翻译 —— 不点就不花钱。
     */
    /**
     * 向导提交失败时怎么收场（v0.4.1）。
     * 宿主版本旧（404/405）也必须能关掉向导并告诉用户重启，绝不能把用户卡在起始页。
     */
    function onboardFailureOutcome(err, tt) {
      const status = err && err.status
      if (status === 404 || status === 405) {
        return { close: true, notice: { level: 'warn', text: tt('wizardHostOld') } }
      }
      return { close: false, error: (err && err.message) ? err.message : String(err) }
    }

    /* -------------------------------------------------------------- */
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
     * - 可由用户折叠成一行「说人话 · 点击展开」；
     * - 位置固定（CSS `right/bottom`），没有拖动，也就没有位置状态、没有全局监听器。
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
      const needsOnboarding = uiPrefs.loaded && uiPrefs.onboarded !== true && uiPrefs.slotMode !== 'off'
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
          setResults((prev) => withResult(prev, item.key, prev[item.key] || item.quick))
        }
        // 已经拿到过完整结果就不再重复请求
        if (results[item.key] && results[item.key].status === 'ok') return
        setBusy(true)
        try {
          const data = await api('translate', {
            method: 'POST',
            body: { command: item.command, toolName: item.toolName, reason: item.reason, callId: item.key, confirmPaid: false },
          })
          if (alive.current) setResults((prev) => withResult(prev, item.key, data))
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
              h('button', { type: 'button', className: 'pap_iconBtn', title: tt('chipCollapse'), onClick: () => setCollapsed(true) }, '\u25be'),
              h('button', { type: 'button', className: 'pap_iconBtn', title: tt('close'), onClick: () => setOpenKey(null) }, '\u2715'),
            ),
          ),
          h(
            'div',
            { className: 'pap_chipNote' },
            interpolate(tt('chipOverlay'), { names: uiPrefs.rivals.join('\u3001') || '\u5176\u5b83\u63d2\u4ef6' }),
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

    /**
     * 通用渲染兜底（v0.4.5）。
     * 任何子树的渲染异常都只降级成一行小字，**绝不让整个 DSH 界面挂掉**。
     */
    class PluginBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error, info) {
        try {
          console.error('[plain-approval] 渲染异常，已降级为安全占位：', error)
        } catch (ignored) {
          /* 忽略 */
        }
        // 诊断上报：渲染异常只进 console 的话，事后什么都查不到
        // （DSH 的 renderer 日志不落盘），只能靠猜。这里走 note 端点写进
        // plain-approval.jsonl，下次崩了直接看堆栈。
        // 注意 sanitize 会把 `text` 键哈希化，所以边界文案改用 boundaryText。
        try {
          const stack = String((error && error.stack) || '')
          note('render.error', {
            boundaryText: String(this.props.text || ''),
            boundarySilent: this.props.silent === true,
            errName: String((error && error.name) || ''),
            errMessage: String((error && error.message) || ''),
            stack,
            componentStack: (info && info.componentStack) ? String(info.componentStack) : '',
          })
        } catch (ignored) {
          /* 上报失败也绝不二次抛出 */
        }
      }
      render() {
        if (!this.state.failed) return this.props.children
        if (this.props.silent === true) return null
        let text = '说人话暂不可用'
        try {
          text = this.props.text || text
        } catch (ignored) {
          /* 忽略 */
        }
        return h('div', { className: 'pap_boundaryFallback', 'data-plain-approval': 'fallback' }, text)
      }
    }

    function ChipBoundary(props) {
      return h(PluginBoundary, { text: '说人话暂不可用（浮窗渲染异常）', ...props })
    }

    function ReviewChipEntry(props) {
      return h(ChipBoundary, null, h(ReviewChip, props))
    }

    /** 设置页的渲染兜底（v0.4.5）：设置页挂了也只显示一行提示。 */
    function SettingsEntry(props) {
      return h(PluginBoundary, { text: '说人话设置页暂不可用（渲染异常）' }, h(SettingsSection, props))
    }

    /**
     * v0.5.1：冲突处理的入口闸门。
     *
     * 优先用 **DSH 标准用户提问机制**（宿主侧 ctx.userQuestions.ask()，
     * 由已连接的 Client 或其它提供方回答）；只有在**不可用或失败**时，
     * 才降级为 v0.5.0 的自绘三选一。
     *
     * 为什么不直接问：ask() 会阻塞到有人回答为止，宿主侧已经加了
     * 5 分钟 AbortSignal 超时；这里也只问**一次**（ref 守卫），
     * 重复挂载不会反复打扰用户。
     */
    let standardAskTried = false

    function ConflictGate(props) {
      const { tt, reviewChip } = props
      const [asking, setAsking] = React.useState(false)
      const [standardUnavailable, setStandardUnavailable] = React.useState(false)
      const tried = React.useRef(false)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        if (!needsConflictChoice()) return
        if (tried.current || standardAskTried) return
        tried.current = true
        standardAskTried = true
        let aborted = false
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = setTimeout(() => {
          try {
            controller?.abort()
          } catch {
            /* ignore */
          }
        }, 180000)
        setAsking(true)
        api('ask-conflict', {
          method: 'POST',
          body: { rivals: uiPrefs.rivals.slice() },
          signal: controller ? controller.signal : undefined,
        })
          .then((data) => {
            if (aborted || !alive.current) return
            if (data && data.supported === true && data.mode) {
              // 标准机制直接给出了选择，落盘即可
              chooseSlotMode(data.mode).then(() => refreshPrefs())
              return
            }
            // 不可用或失败：记一条原因，然后降级为自绘
            const reason = (data && (data.reason || data.detail)) || 'unknown'
            note('user-questions.fallback', { reason: String(reason) })
            setStandardUnavailable(true)
          })
          .catch((error) => {
            if (aborted || !alive.current) return
            note('user-questions.fallback', { reason: oneLineText(error?.message, 120) })
            setStandardUnavailable(true)
          })
          .finally(() => {
            clearTimeout(timer)
            if (!aborted && alive.current) setAsking(false)
          })
        return () => {
          aborted = true
          clearTimeout(timer)
        }
      }, [])

      if (!needsConflictChoice()) return reviewChip(props)
      // 标准机制正在问：什么都不画，避免闪一下自绘面板又被撤掉
      if (asking && !standardUnavailable) return null
      if (!standardUnavailable) return null
      return h(ChipBoundary, null, h(ConflictPrompt, { t: tt, rivals: uiPrefs.rivals, onChoose: () => refreshPrefs() }))
    }

    /**
     * v0.5.3：审批历史弹窗。
     *
     * 设计约束：
     *   · 纯 React，挂在设置页内部；**不注册任何全局事件监听**，
     *     不往 document.body 插节点，不用 MutationObserver —— 与本项目既有红线一致；
     *   · 数据全部走 HTTP 路由读，历史文件只写在本机；
     *   · 列表默认只显示哈希前 8 位；原文只有用户在设置里显式开启才会有。
     */
    function HistoryModal({ t, onClose }) {
      const tt = t
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [decision, setDecision] = React.useState('all')
      const [range, setRange] = React.useState('all')
      const [q, setQ] = React.useState('')
      const [openKey, setOpenKey] = React.useState(null)
      const [note, setNote] = React.useState('')
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = React.useCallback(async (next) => {
        const params = new URLSearchParams({
          decision: (next?.decision ?? decision).trim(),
          range: (next?.range ?? range).trim(),
          q: (next?.q ?? q).trim(),
        })
        setLoading(true)
        try {
          const res = await api('history?' + params.toString())
          if (alive.current) setData(res)
        } catch (error) {
          if (alive.current) setNote(oneLineText(error?.message, 120))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [decision, range, q])

      React.useEffect(() => {
        load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const doExport = async (redact) => {
        try {
          const res = await api('history/export' + (redact ? '?redact=1' : ''))
          const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'dsh-approval-history.json'
          document.body.appendChild(a)
          a.click()
          a.remove()
          URL.revokeObjectURL(url)
        } catch (error) {
          if (alive.current) setNote(oneLineText(error?.message, 120))
        }
      }

      const doClear = async () => {
        // eslint-disable-next-line no-alert
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(tt('sHistoryClearConfirm'))) return
        try {
          const res = await api('history/clear', { method: 'POST', body: {} })
          if (alive.current) setNote(interpolate(tt('sHistoryCleared'), { n: res?.removed ?? 0 }))
          load()
        } catch (error) {
          if (alive.current) setNote(oneLineText(error?.message, 120))
        }
      }

      const items = (data && data.items) || []
      const stats = (data && data.stats) || null
      const labels = (data && data.decisionLabels) || {}
      const RANGE_LABEL = { today: 'sHistoryToday', week: 'sHistoryWeek', month: 'sHistoryMonth', all: 'sHistoryAll' }
      const DECISION_ORDER = ['auto-allowed', 'allowed-once', 'allowed-always', 'rejected', 'other']

      return h(
        'div',
        { className: 'pap_historyMask', 'data-plain-approval': 'history-modal', onClick: (e) => { if (e.target === e.currentTarget && onClose) onClose() } },
        h(
          'div',
          { className: 'pap_historyModal', role: 'dialog', 'aria-label': tt('sHistory') },
          h(
            'div',
            { className: 'pap_historyHead' },
            h('span', { className: 'pap_historyTitle' }, tt('sHistory')),
            h('button', { type: 'button', className: 'pap_iconBtn', onClick: onClose, 'aria-label': tt('close') }, '✕'),
          ),
          h(
            'div',
            { className: 'pap_historyFilters' },
            h(
              'label',
              { className: 'pap_fieldLabel' },
              tt('sHistoryFilterDecision'),
              h(
                'select',
                { className: 'pap_input', value: decision, onChange: (e) => { setDecision(e.target.value); load({ decision: e.target.value }) } },
                h('option', { value: 'all' }, tt('sHistoryAll')),
                DECISION_ORDER.map((k) => h('option', { value: k, key: k }, labels[k] || k)),
              ),
            ),
            h(
              'label',
              { className: 'pap_fieldLabel' },
              tt('sHistoryFilterRange'),
              h(
                'select',
                { className: 'pap_input', value: range, onChange: (e) => { setRange(e.target.value); load({ range: e.target.value }) } },
                ['today', 'week', 'month', 'all'].map((k) => h('option', { value: k, key: k }, tt(RANGE_LABEL[k]))),
              ),
            ),
            h(
              'label',
              { className: 'pap_fieldLabel' },
              tt('sHistorySearch'),
              h('input', {
                className: 'pap_input',
                placeholder: 'e.g. 96bbe7c7',
                value: q,
                onChange: (e) => setQ(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') load() },
              }),
            ),
            h('button', { type: 'button', className: 'pap_btn', onClick: () => load(), disabled: loading }, loading ? '…' : tt('sHistoryFilterDecision')),
          ),
          note ? h('div', { className: 'pap_error' }, note) : null,
          items.length === 0 && !loading
            ? h('div', { className: 'pap_historyEmpty' }, tt('sHistoryEmpty'))
            : h(
                'div',
                { className: 'pap_historyList' },
                items.map((row) => {
                  const key = `${row.at}:${row.hash8}:${row.decision}`
                  const open = openKey === key
                  return h(
                    'div',
                    { className: 'pap_historyRow' + (open ? ' pap_historyRowOpen' : ''), key },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pap_historyRowHead',
                        onClick: () => setOpenKey(open ? null : key),
                        'aria-expanded': open ? 'true' : 'false',
                      },
                      h('span', { className: 'pap_historyTime' }, String(row.at ?? '').replace('T', ' ').slice(0, 19)),
                      h('span', { className: 'pap_historyMode' }, String(row.mode ?? '-')),
                      h('span', { className: 'pap_risk ' + riskClass(row.risk) }, String(row.risk ?? '-')),
                      h('span', { className: 'pap_historyDecision' + (row.decision === 'rejected' ? ' pap_historyReject' : '') }, labels[row.decision] || row.decision),
                      h('span', { className: 'pap_historyHash' }, row.hash8 || '········'),
                    ),
                    open
                      ? h(
                          'div',
                          { className: 'pap_historyBody' },
                          h('div', { className: 'pap_historyCmd' }, row.command ? String(row.command) : tt('sHistoryNoCommand')),
                          h('div', { className: 'pap_historyGrant' }, row.grantId ? `grant: ${row.grantId}` : ''),
                          row.sections && row.sections.intent
                            ? h(
                                'div',
                                { className: 'pap_plain pap_plainWide' },
                                // 直接遍历 localizedSections 返回的 [标签, 键] 对，
                                // 不要用 SECTION_KEYS 的下标反查 —— 它可能在前面多插一行 background。
                                localizedSections(tt, row.sections).map(([label, sk]) =>
                                  h(
                                    'div',
                                    { className: 'pap_paperRow', key: sk },
                                    h('div', { className: 'pap_paperLabel' }, label),
                                    h('div', { className: 'pap_paperValue' + (sk === 'risk' ? ' ' + riskClass(row.sections.risk) : '') }, row.sections[sk] ?? ''),
                                  ),
                                ),
                              )
                            : null,
                        )
                      : null,
                  )
                }),
              ),
          h(
            'div',
            { className: 'pap_historyFoot' },
            h('div', { className: 'pap_note' }, stats ? interpolate(tt('sHistoryStats'), { n: stats.total, last: stats.newest ? String(stats.newest).replace('T', ' ').slice(0, 19) : '-' }) : ''),
            h(
              'div',
              { className: 'pap_toolbar' },
              h('button', { type: 'button', className: 'pap_btn', onClick: () => doExport(false) }, tt('sHistoryExport')),
              h('button', { type: 'button', className: 'pap_btn', onClick: () => doExport(true) }, tt('sHistoryExportRedact')),
              h('button', { type: 'button', className: 'pap_btn pap_btnReject', onClick: doClear }, tt('sHistoryClear')),
            ),
          ),
        ),
      )
    }

    /**
     * v0.5.0-stable：槽位冲突的**一次性**选择提示（自绘降级方案）。
     *
     * 设计约束（来自事故复盘）：
     *   · 只在「检测到冲突」且「用户还没选过」时出现，选完写 conflictResolved，永不再问；
     *   · 纯 React，通过 DSH 的 shell.overlay 槽位渲染 —— **不画自己的浮层 DOM、
     *     不往 document.body 插节点、不注册任何全局监听器、不用 MutationObserver**；
     *   · 三个选项直接对应 ui.slotMode 的三个取值，没有隐藏的第四种行为；
     *   · 它只是**提示**，不做任何自动判定：点之前插件不会改变接管行为。
     */
    function ConflictPrompt({ t, rivals, onChoose }) {
      const tt = t
      const [busy, setBusy] = React.useState(false)
      const pick = async (mode) => {
        if (busy) return
        setBusy(true)
        try {
          await chooseSlotMode(mode)
          if (typeof onChoose === 'function') onChoose(mode)
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pap_chipRoot', 'data-plain-approval': 'conflict' },
        h(
          'div',
          { className: 'pap_chip pap_chipWide', role: 'dialog', 'aria-label': tt('conflictTitle') },
          h('div', { className: 'pap_chipHead pap_chipHeadStatic' }, h('span', { className: 'pap_chipTitle' }, tt('conflictTitle'))),
          h('div', { className: 'pap_chipBody' }, h('div', { className: 'pap_note' }, interpolate(tt('conflictBody'), { names: rivals.join('、') }))),
          h(
            'div',
            { className: 'pap_actions' },
            h('button', { type: 'button', className: 'pap_btn pap_btnPrimary', disabled: busy, onClick: () => pick('takeover') }, tt('conflictPickA')),
            h('button', { type: 'button', className: 'pap_btn', disabled: busy, onClick: () => pick('overlay') }, tt('conflictPickB')),
            h('button', { type: 'button', className: 'pap_btn pap_btnReject', disabled: busy, onClick: () => pick('off') }, tt('conflictPickC')),
          ),
          h('div', { className: 'pap_chipBody' }, h('div', { className: 'pap_note' }, tt('conflictFoot'))),
        ),
      )
    }

    /**
     * 首次启用向导（v0.4 任务三）：真正「弹一次」——用浮层实现，
     * 不抢任何功能层插件的槽位；选完写 ui.onboarded=true，之后不再出现。
     *
     * v0.4.1 修复：
     *  - 只有真·硬件不达标（localRisk==='hard'）才要求勾风险确认；
     *  - 硬件信息缺失 / 一般偏低 → 只给一句「建议用 API」，不拦人；
     *  - 本地通道探测为绿（Ollama 在跑且模型在）→ 完全不弹警告；
     *  - 一定有「稍后设置」出口，绝不会卡死；
     *  - 提交失败会显示明确错误；如果是宿主版本旧（404），也能关掉向导并告诉用户重启。
     */
    function OnboardPrompt({ t, onDone }) {
      const tt = t
      const [choice, setChoice] = React.useState('auto')
      const [risk, setRisk] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [payload, setPayload] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)

      React.useEffect(() => {
        let alive = true
        Promise.allSettled([api('device'), api('status')]).then(([d, s]) => {
          if (!alive) return
          setPayload(d.status === 'fulfilled' ? d.value : null)
          setStatus(s.status === 'fulfilled' ? s.value : null)
          setLoading(false)
        })
        return () => {
          alive = false
        }
      }, [])

      const tier = payload && payload.device ? payload.device.tier : 'unknown'
      const localRisk = payload && payload.localRisk ? payload.localRisk : (tier === 'good' ? 'none' : 'soft')
      const ollamaGreen = Boolean(payload && payload.ollama && payload.ollama.status === 'green')
      const deepseek = status ? status.deepseek : null
      const apiUnavailable = Boolean(status) && !(deepseek && deepseek.status === 'green')

      const finish = async (value, skipped) => {
        setBusy(true)
        setError(null)
        try {
          await api('onboard', { method: 'POST', body: { choice: value, engine: value, acceptRisk: risk, skipped: skipped === true } })
          uiPrefs.onboarded = true
          if (typeof onDone === 'function') onDone(value, null)
        } catch (err) {
          const outcome = onboardFailureOutcome(err, tt)
          if (outcome.close) {
            // 宿主还是旧版（客户端已更新、Node 侧没重启）：不能把用户卡在这里
            uiPrefs.onboarded = true
            if (typeof onDone === 'function') onDone(value, outcome.notice)
          } else {
            setError(outcome.error)
          }
        } finally {
          setBusy(false)
        }
      }

      const option = (value, label) =>
        h(
          'label',
          { className: 'pap_choice' + (value === 'auto' && apiUnavailable ? ' pap_choiceDim' : '') },
          h('input', {
            type: 'radio',
            name: 'pap-onboard',
            checked: choice === value,
            disabled: value === 'auto' && apiUnavailable,
            onChange: () => setChoice(value),
          }),
          h('span', null, label),
        )

      return h(
        'div',
        { className: 'pap_chipRoot', 'data-plain-approval': 'onboard' },
        h(
          'div',
          { className: 'pap_chip pap_wizard' },
          h('div', { className: 'pap_cardTitle pap_chipHeadStatic' }, tt('wizardTitle')),
          h(
            'div',
            { className: 'pap_chipBody' },
            h('div', { className: 'pap_note' }, tt('wizardDesc')),

            loading
              ? h('div', { className: 'pap_skeleton' }, tt('wizardChecking'))
              : null,

            option('auto', tt('wizardA')),
            apiUnavailable ? h('div', { className: 'pap_note pap_warnNote' }, tt('wizardAUnavailable')) : null,

            option('local-first', tt('wizardB')),
            !loading && choice === 'local-first' && localRisk !== 'none'
              ? h('div', { className: 'pap_note pap_warnNote' }, tier === 'unknown' ? tt('wizardUnknownHardware') : tt('wizardLocalWarn'))
              : null,
            !loading && choice === 'local-first' && localRisk === 'none'
              ? h('div', { className: 'pap_note pap_okNote' }, ollamaGreen ? tt('wizardOllamaReady') : tt('wizardLocalOk'))
              : null,
            !loading && choice === 'local-first' && localRisk === 'hard'
              ? h(
                'label',
                { className: 'pap_check' },
                h('input', { type: 'checkbox', checked: risk, onChange: (e) => setRisk(e.target.checked) }),
                h('span', null, tt('wizardLocalRisk')),
              )
              : null,

            option('deepseek', tt('wizardC')),

            error ? h('div', { className: 'pap_error' }, error) : null,
            h(
              'div',
              { className: 'pap_toolbar' },
              h(
                'button',
                { type: 'button', className: 'pap_btn pap_btnPrimary', disabled: busy, onClick: () => finish(choice) },
                busy ? tt('sSaving') : tt('wizardNext'),
              ),
              h('button', { type: 'button', className: 'pap_btn', disabled: busy, onClick: () => finish('auto', true) }, tt('wizardSkip')),
            ),
          ),
        ),
      )
    }

    /* -------------------------------------------------------------- */
    /* 设置页                                                          */
    /* -------------------------------------------------------------- */

    function Light({ state, label, detail, t }) {
      const cls = state === 'green' ? 'pap_lightGreen' : state === 'yellow' ? 'pap_lightYellow' : 'pap_lightRed'
      const text = state === 'green' ? t('sGreen') : state === 'yellow' ? t('sYellow') : t('sRed')
      return h(
        'div',
        { className: 'pap_light' },
        h('span', { className: 'pap_lightDot ' + cls }),
        h(
          'div',
          { className: 'pap_lightBody' },
          h('div', { className: 'pap_lightTitle' }, label, h('span', { className: 'pap_lightState ' + cls }, text)),
          h('div', { className: 'pap_note' }, detail || ''),
        ),
      )
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { className: 'pap_field' },
        h('span', { className: 'pap_fieldLabel' }, label),
        children,
        hint ? h('span', { className: 'pap_note' }, hint) : null,
      )
    }

    function Check({ label, checked, onChange }) {
      return h(
        'label',
        { className: 'pap_check' },
        h('input', { type: 'checkbox', checked: checked === true, onChange: (e) => onChange(e.target.checked) }),
        h('span', null, label),
      )
    }

    function SettingsSection(props) {
      const tt = makeTT(props)
      const [settings, setSettings] = React.useState(null)
      const [raw, setRaw] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [testing, setTesting] = React.useState(false)
      const [testResult, setTestResult] = React.useState(null)
      const [blacklistText, setBlacklistText] = React.useState('')
      const [caretakerText, setCaretakerText] = React.useState('')
      const [diag, setDiag] = React.useState(null)
      const [diagBusy, setDiagBusy] = React.useState(false)
      const [grantList, setGrantList] = React.useState(null)
      const [auditList, setAuditList] = React.useState(null)
      const [device, setDevice] = React.useState(null)
      const [wizardChoice, setWizardChoice] = React.useState('auto')
      const [wizardRisk, setWizardRisk] = React.useState(false)
      const [wizardOpen, setWizardOpen] = React.useState(false)
      const [ollamaOpen, setOllamaOpen] = React.useState(false)
      const [donateOpen, setDonateOpen] = React.useState(false)
      const [historyOpen, setHistoryOpen] = React.useState(false)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const data = await api('status')
          if (!alive.current) return
          setStatus(data)
          const s = data.settings
          setSettings(s)
          setBlacklistText((s.blacklist || []).join('\n'))
          setCaretakerText((s.caretakerPlugins || []).join('\n'))
          setWizardOpen(s.ui && s.ui.onboarded !== true)
          setOllamaOpen(showOllamaPanel(s, data.ollama))
          loadGrants()
          loadAudit()
          loadDevice()
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const patch = (mutator) => {
        setSettings((current) => {
          const next = JSON.parse(JSON.stringify(current || {}))
          mutator(next)
          return next
        })
      }

      // v0.5.3：审批历史设置。host 的 normalizeSettings 已经有默认值，
      // 这里只是给「设置对象缺 history 段」的旧配置兜底。
      const historySettings = {
        enabled: settings?.ui?.history?.enabled !== false,
        keepCommands: settings?.ui?.history?.keepCommands === true,
        retentionDays: Number(settings?.ui?.history?.retentionDays) || 90,
      }
      const setHistorySetting = (key, value) => patch((s) => {
        s.ui = s.ui || {}
        s.ui.history = s.ui.history || {}
        s.ui.history[key] = value
      })

      const save = async () => {
        setSaving(true)
        setMessage(null)
        setError(null)
        try {
          const body = JSON.parse(JSON.stringify(settings || {}))
          body.blacklist = blacklistText.split('\n').map((l) => l.trim()).filter((l) => l !== '')
          body.caretakerPlugins = caretakerText.split('\n').map((l) => l.trim()).filter((l) => l !== '')
          const data = await api('settings', { method: 'POST', body })
          if (!alive.current) return
          setSettings(data.settings)
          setRaw(data.raw || {})
          setMessage(tt('sSaved'))
          refreshPrefs()
          load()
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        } finally {
          if (alive.current) setSaving(false)
        }
      }

      const runTest = async () => {
        setTesting(true)
        setTestResult(null)
        try {
          const data = await api('selftest', { method: 'POST', body: {} })
          if (alive.current) setTestResult(data)
        } catch (err) {
          if (alive.current) setTestResult({ error: err && err.message ? err.message : String(err) })
        } finally {
          if (alive.current) setTesting(false)
        }
      }

      const clearCache = async () => {
        try {
          await api('clearcache', { method: 'POST', body: {} })
          if (alive.current) setMessage(tt('sCleared'))
          load()
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const loadDevice = async (force) => {
        try {
          const data = await api('device' + (force === true ? '?force=1' : ''))
          if (alive.current) {
            setDevice(data)
            return data
          }
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
        return null
      }

      const saveOnboard = async (choice, acceptRisk, skipped) => {
        try {
          setError(null)
          await api('onboard', { method: 'POST', body: { choice, engine: choice, acceptRisk: acceptRisk === true, skipped: skipped === true } })
          if (!alive.current) return
          setWizardOpen(false)
          setMessage(skipped === true
            ? '已跳过向导，当前用「自动」；之后随时可在设置里改。'
            : choice === 'local-first'
              ? '已切换到本地 Ollama（需要先安装并拉取模型）'
              : choice === 'deepseek'
                ? '已切换为只用你自己的 API Key'
                : '已选择「自动」：用 DSH 的 AI 翻译')
          refreshPrefs()
          await load()
        } catch (err) {
          if (!alive.current) return
          const outcome = onboardFailureOutcome(err, tt)
          if (outcome.close) {
            // 宿主还是旧版：关掉向导 + 提示重启，不把用户卡在向导里
            setWizardOpen(false)
            setMessage(outcome.notice.text)
          } else {
            setError(outcome.error)
          }
        }
      }

      const setDeviceFlags = async (patch, message) => {
        try {
          await api('settings', { method: 'POST', body: { device: patch } })
          if (alive.current) {
            setMessage(message ?? null)
            await load()
            await loadDevice(true)
          }
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const resetLocal = async () => {
        try {
          await api('reset-local', { method: 'POST', body: {} })
          if (alive.current) {
            setMessage('本地通道已恢复；若 Ollama 仍不可用会再次自动降级。')
            await load()
            await loadDevice()
          }
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const hideDonate = async () => {
        try {
          await api('settings', { method: 'POST', body: { ui: { hideDonate: true } } })
          if (alive.current) {
            setSettings((prev) => ({ ...(prev || {}), ui: { ...((prev || {}).ui || {}), hideDonate: true } }))
            setMessage(tt('donateHidden'))
          }
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const runDiag = async () => {        setDiagBusy(true)
        try {
          const data = await api('diag')
          if (alive.current) setDiag(data)
        } catch (err) {
          if (alive.current) setDiag({ error: err && err.message ? err.message : String(err) })
        } finally {
          if (alive.current) setDiagBusy(false)
        }
      }

      const loadGrants = async () => {
        try {
          const data = await api('grants')
          // 在**源头**保证 items 一定是数组。渲染处有多处直接 `grantList.items.length`
          // / `.map()`，只判了外层 grantList 没判内层 items —— 后端少给一个字段，
          // 设置页就会在渲染期抛错、被 PluginBoundary 兜成「设置页暂不可用」，
          // 连带捐款入口、分析深度、引擎选择**整页**都看不见。
          if (alive.current) setGrantList({ ...data, items: Array.isArray(data?.items) ? data.items : [] })
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const revokeGrant = async (id) => {
        try {
          const data = await api('grants/remove', { method: 'POST', body: { id } })
          if (alive.current) setGrantList((prev) => ({ ...(prev || {}), items: data.items }))
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const clearGrants = async () => {
        try {
          await api('grants/clear', { method: 'POST', body: {} })
          if (alive.current) {
            setGrantList((prev) => ({ ...(prev || {}), items: [] }))
            setMessage(tt('sGrantCleared'))
          }
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const loadAudit = async () => {
        try {
          const data = await api('audit')
          // 同 loadGrants：渲染处直接 `auditList.entries.length` / `.slice()`，
          // 这里在源头把 entries 钉成数组，杜绝同类崩溃。
          if (alive.current) setAuditList({ ...data, entries: Array.isArray(data?.entries) ? data.entries : [] })
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const exportAudit = async () => {
        try {
          const response = await fetch(API + 'audit?download=1', {
            headers: { accept: 'application/json', 'x-plain-approval': '1' },
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const text = await response.text()
          const blob = new Blob([text], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = 'dsh-plain-approval-audit.json'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      const exportLogs = async () => {
        // 注意：不能用 window.open —— 浏览器导航带不了自定义头，会被 403。
        try {
          const response = await fetch(API + 'logs?download=1', {
            headers: { accept: 'application/json', 'x-plain-approval': '1' },
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const text = await response.text()
          const blob = new Blob([text], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = 'dsh-plain-approval-diagnostic.json'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }

      /**
       * v0.7.3：设置页的槽位模式选择器 —— 手动选过一次就必须记下来。
       *
       * 之前这个下拉框直接 patch `ui.slotMode`，**从不写 `conflictResolved`**，
       * 而 `needsConflictChoice()` 判的是 `conflictResolved !== true`。
       * 结果就是「设置里明明选了接管，实际仍然让位给原生卡片」，
       * 用户还找不到原因 —— 因为下拉框显示的就是「接管」。
       *
       * 现在两条路统一，都会写 slotMode + conflictResolved：
       *   · 设置页下拉框 → applySlotMode
       *   · 审批时的冲突提示按钮 → chooseSlotMode（本来就写）
       */
      const applySlotMode = async (mode) => {
        const next = ['takeover', 'overlay', 'off'].includes(mode) ? mode : 'takeover'
        setSettings((prev) => ({ ...prev, ui: { ...(prev?.ui || {}), slotMode: next, conflictResolved: true } }))
        uiPrefs.conflictResolved = true
        await chooseSlotMode(next)
      }

      if (loading && !settings) {
        return h(
          'div',
          { className: 'pap_settings' },
          h('h3', { className: 'pap_h3' }, tt('sTitle')),
          h('div', { className: 'pap_note' }, tt('translating')),
        )
      }

      if (!settings) {
        return h(
          'div',
          { className: 'pap_settings' },
          h('h3', { className: 'pap_h3' }, tt('sTitle')),
          h('div', { className: 'pap_error' }, error || '加载失败'),
        )
      }

      const ollama = status ? status.ollama : null
      const deepseek = status ? status.deepseek : null
      // v0.4 任务三：DSH 没配 Key 时，向导里的「自动」置灰
      const apiUnavailable = !(deepseek && deepseek.status === 'green')
      // v0.4.1：风险档位由后端统一算（Ollama 绿 → none；硬件未知 → soft；真不达标 → hard）
      const deviceInput = device && device.device ? device.device : null
      const deviceRisk = device && device.localRisk
        ? device.localRisk
        : (deviceInput && deviceInput.tier === 'good' ? 'none' : 'soft')
      const ollamaGreen = Boolean(ollama && ollama.status === 'green') || Boolean(device && device.ollama && device.ollama.status === 'green')

      return h(
        'div',
        { className: 'pap_settings' },
        h('h3', { className: 'pap_h3' }, tt('sTitle')),
        h('p', { className: 'pap_sub' }, tt('sDesc')),
        error ? h('div', { className: 'pap_error' }, error) : null,
        message ? h('div', { className: 'pap_ok' }, message) : null,

        // ---- 初始向导（v0.4 任务三）：首次启用弹一次，默认选中 A ----
        wizardOpen || !settings.ui.onboarded
          ? h(
            'div',
            { className: 'pap_card2 pap_wizard' },
            h('div', { className: 'pap_cardTitle' }, tt('wizardTitle')),
            h('div', { className: 'pap_note' }, tt('wizardDesc')),
            h(
              'label',
              { className: 'pap_choice' + (apiUnavailable && wizardChoice === 'auto' ? ' pap_choiceDim' : '') },
              h('input', {
                type: 'radio',
                name: 'pap-wizard',
                checked: wizardChoice === 'auto',
                disabled: apiUnavailable,
                onChange: () => setWizardChoice('auto'),
              }),
              h('span', null, tt('wizardA')),
            ),
            apiUnavailable ? h('div', { className: 'pap_note pap_warnNote' }, tt('wizardAUnavailable')) : null,
            h(
              'label',
              { className: 'pap_choice' },
              h('input', { type: 'radio', name: 'pap-wizard', checked: wizardChoice === 'local-first', onChange: () => setWizardChoice('local-first') }),
              h('span', null, tt('wizardB')),
            ),
            wizardChoice === 'local-first' && deviceRisk !== 'none'
              ? h('div', { className: 'pap_note pap_warnNote' }, deviceInput && deviceInput.tier === 'unknown' ? tt('wizardUnknownHardware') : tt('wizardLocalWarn'))
              : null,
            wizardChoice === 'local-first' && deviceRisk === 'none'
              ? h('div', { className: 'pap_note pap_okNote' }, ollamaGreen ? tt('wizardOllamaReady') : tt('wizardLocalOk'))
              : null,
            wizardChoice === 'local-first' && deviceRisk === 'hard'
              ? h(Check, { label: tt('wizardLocalRisk'), checked: wizardRisk, onChange: setWizardRisk })
              : null,
            h(
              'label',
              { className: 'pap_choice' },
              h('input', { type: 'radio', name: 'pap-wizard', checked: wizardChoice === 'deepseek', onChange: () => setWizardChoice('deepseek') }),
              h('span', null, tt('wizardC')),
            ),
            h(
              'div',
              { className: 'pap_toolbar' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'pap_btn pap_btnPrimary',
                  disabled: saving,
                  onClick: () => {
                    // A 不可用时不再偷偷切成别项，而是明确告诉用户怎么选
                    if (apiUnavailable && wizardChoice === 'auto') {
                      setError(tt('wizardAUnavailable'))
                      return
                    }
                    saveOnboard(wizardChoice, wizardRisk)
                  },
                },
                tt('wizardNext'),
              ),
              h('button', { type: 'button', className: 'pap_btn', disabled: saving, onClick: () => saveOnboard('auto', false, true) }, tt('wizardSkip')),
              settings.ui.onboarded
                ? h('button', { type: 'button', className: 'pap_btn', onClick: () => setWizardOpen(false) }, tt('close'))
                : null,
            ),
          )
          : null,

        // ---- 本机能力检测（v0.4 任务二）----
        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sDevice')),
          h(Light, {
            state: deviceTierLightState(device),
            label: deviceTierLabel(device, tt),
            detail: device && device.device ? device.device.note : '',
            t: tt,
          }),
          device && device.device
            ? h(
              'div',
              { className: 'pap_diag' },
              h('div', { className: 'pap_note' }, `${tt('sDeviceGpu')}：${device.device.gpu ? `${device.device.gpu.name}（${tt('sDeviceVram')} ${device.device.gpu.vramTotalGB ?? '—'}GB${device.device.gpu.vramFreeGB !== null && device.device.gpu.vramFreeGB !== undefined ? `，空闲 ${device.device.gpu.vramFreeGB}GB` : ''}）` : '未检测到'}`),
              h('div', { className: 'pap_note' }, `${tt('sDeviceMem')}：${device.device.memory?.totalGB ?? '—'}GB　·　${tt('sDeviceFree')}：${device.device.memory?.freeGB ?? '—'}GB`),
              h('div', { className: 'pap_note' }, `${tt('deviceNote')}：${device.device.note}`),
            )
            : null,
          device && device.settings && device.settings.device && device.settings.device.localDisabledUntil > Date.now()
            ? h(
              'div',
              { className: 'pap_note pap_warnNote' },
              interpolate(tt('sDeviceDisabled'), {
                reason: device.settings.device.localDisabledReason || '连续失败',
                mins: Math.ceil((device.settings.device.localDisabledUntil - Date.now()) / 60000),
              }),
            )
            : null,
          device && device.settings && device.settings.device && device.settings.device.allowUnusableLocal
            ? h('div', { className: 'pap_note pap_warnNote' }, tt('sDeviceForcedNotice'))
            : null,
          device && device.ollamaGuard && device.ollamaGuard.breaker && device.ollamaGuard.breaker.open
            ? h(
              'div',
              { className: 'pap_note pap_warnNote' },
              interpolate(tt('sOomBreaker'), {
                reason: device.ollamaGuard.breaker.reason || '连续失败',
                sec: Math.ceil((device.ollamaGuard.breaker.remainingMs || 0) / 1000),
              }),
            )
            : null,
          // 读不到显卡时的手动兜底（v0.4.1）：把决定权交还给用户
          h(Field, {
            label: tt('sManualVram'),
            hint: tt('sManualVramHint'),
            children: h('input', {
              className: 'pap_input',
              type: 'number',
              min: 0,
              step: '0.5',
              value: settings.device.manualVramGB,
              onChange: (e) => patch((s) => (s.device.manualVramGB = Number(e.target.value))),
            }),
          }),
          h(Field, {
            label: tt('sManualGpuName'),
            children: h('input', {
              className: 'pap_input',
              value: settings.device.manualGpuName,
              onChange: (e) => patch((s) => (s.device.manualGpuName = e.target.value)),
            }),
          }),
          h(
            'div',
            { className: 'pap_toolbar' },
            h('button', { type: 'button', className: 'pap_btn', onClick: loadDevice }, tt('sDeviceDetect')),
            settings.device.allowUnusableLocal
              ? h('button', { type: 'button', className: 'pap_btn', onClick: () => setDeviceFlags({ allowUnusableLocal: false }, '已改回自动使用 API') }, tt('sDeviceForceOff'))
              : h(
                'button',
                {
                  type: 'button',
                  className: 'pap_btn',
                  title: tt('sDeviceRiskList'),
                  onClick: () => setDeviceFlags({ allowUnusableLocal: true }, '已强行启用本地通道（请留意系统卡顿）'),
                },
                tt('sDeviceForceOn'),
              ),
            h('button', { type: 'button', className: 'pap_btn', onClick: resetLocal }, tt('sDeviceRestore')),
          ),
          h('div', { className: 'pap_note' }, tt('sDeviceRiskList')),
        ),

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sStatus')),
          h(Light, { state: ollama ? ollama.status : 'red', label: tt('sLightA'), detail: ollama ? ollama.detail : '', t: tt }),
          h('div', { className: 'pap_divider' }),
          h(Light, { state: deepseek ? deepseek.status : 'red', label: tt('sLightB'), detail: deepseek ? deepseek.detail : '', t: tt }),
          h('div', { className: 'pap_note' }, tt('sCache') + '：' + (status && status.cache ? status.cache.driver : '') + (status && status.cache && status.cache.stats ? ` · ${status.cache.stats.count} 条` : '')),
          h('div', { className: 'pap_note' }, tt('sDataDir') + '：' + ((status && status.dataDir) || '')),
          h(
            'div',
            { className: 'pap_toolbar' },
            h('button', { type: 'button', className: 'pap_btn pap_btnPrimary', onClick: runTest, disabled: testing }, testing ? tt('sTesting') : tt('sTest')),
            h('button', { type: 'button', className: 'pap_btn', onClick: exportLogs }, tt('sExport')),
            h('button', { type: 'button', className: 'pap_btn', onClick: clearCache }, tt('sClearCache')),
            h('button', { type: 'button', className: 'pap_btn', onClick: load }, '刷新'),
          ),
          testResult
            ? h(
              'div',
              { className: 'pap_testResult' },
              ['ollama', 'deepseek'].map((key) => {
                const row = testResult.channels ? testResult.channels[key] : null
                const label = key === 'ollama' ? tt('sTestA') : tt('sTestB')
                if (!row) return h('div', { className: 'pap_note', key }, `${label}：—`)
                return h(
                  'div',
                  { className: row.ok ? 'pap_testOk' : 'pap_testFail', key },
                  h('b', null, `${label}：${row.ok ? tt('ok') : tt('fail')}`),
                  row.ms !== undefined ? `（${interpolate(tt('ms'), { ms: row.ms })}）` : '',
                  row.message ? h('div', { className: 'pap_note' }, row.message) : null,
                  row.preview ? h('div', { className: 'pap_note' }, row.preview) : null,
                )
              }),
            )
            : null,
        ),

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sEngine')),
          h(Field, { label: '', children: h(
            'select',
            {
              className: 'pap_input',
              value: settings.engine,
              onChange: (e) => patch((s) => (s.engine = e.target.value)),
            },
            h('option', { value: 'auto' }, tt('sEngineAuto')),
            h('option', { value: 'ollama' }, tt('sEngineOllama')),
            h('option', { value: 'deepseek' }, tt('sEngineDeepseek')),
          ) }),
          h('div', { className: 'pap_note' }, tt('sPrivacy')),
        ),

        // ---- 长期同意（v0.3）----
        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sGrants') + (grantList ? '（' + interpolate(tt('sGrantsCount'), { n: grantList.items.length }) + '）' : '')),
          h('div', { className: 'pap_note' }, tt('sGrantsDesc')),
          grantList && grantList.workspace
            ? h('div', { className: 'pap_note' }, tt('sGrantWorkspace') + '：' + grantList.workspace)
            : null,
          h(
            'div',
            { className: 'pap_toolbar' },
            h('button', { type: 'button', className: 'pap_btn', onClick: loadGrants }, '刷新列表'),
            grantList && grantList.items.length
              ? h('button', { type: 'button', className: 'pap_btn', onClick: clearGrants }, tt('sGrantClear'))
              : null,
          ),
          grantList
            ? grantList.items.length === 0
              ? h('div', { className: 'pap_note' }, tt('sGrantsEmpty'))
              : h(
                'div',
                { className: 'pap_grantList' },
                grantList.items.map((item) =>
                  h(
                    'div',
                    { className: 'pap_grantRow', key: item.id },
                    h(
                      'div',
                      { className: 'pap_grantMain' },
                      h('code', { className: 'pap_grantCmd' }, item.preview || item.hash.slice(0, 16)),
                      h(
                        'div',
                        { className: 'pap_note' },
                        `${interpolate(tt('sGrantUses'), { n: item.uses || 0 })} · ${tt('sGrantCreated')} ${String(item.createdAt).slice(0, 19).replace('T', ' ')} · #${item.id}`,
                      ),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'pap_btn pap_btnReject', onClick: () => revokeGrant(item.id) },
                      tt('sGrantRevoke'),
                    ),
                  ),
                ),
              )
            : h('div', { className: 'pap_note' }, '点「刷新列表」加载'),
        ),

        // ---- 审计日志（v0.3）----
        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sAudit') + (auditList && auditList.summary ? `（${auditList.summary.lines} 条）` : '')),
          h('div', { className: 'pap_note' }, tt('sAuditDesc')),
          h(
            'div',
            { className: 'pap_toolbar' },
            h('button', { type: 'button', className: 'pap_btn', onClick: loadAudit }, tt('sAuditView')),
            h('button', { type: 'button', className: 'pap_btn', onClick: exportAudit }, tt('sAuditExport')),
          ),
          auditList
            ? h(
              'div',
              { className: 'pap_grantList' },
              auditList.entries.length === 0
                ? h('div', { className: 'pap_note' }, tt('sAuditEmpty'))
                : auditList.entries.slice(-10).reverse().map((row, i) =>
                  h(
                    'div',
                    { className: 'pap_grantRow', key: i },
                    h(
                      'div',
                      { className: 'pap_grantMain' },
                      h('code', { className: 'pap_grantCmd' }, `${row.event} · ${String(row.hash).slice(0, 16)} · rule=${row.ruleId}`),
                      h('div', { className: 'pap_note' }, `${String(row.t).slice(0, 19).replace('T', ' ')} · 风险=${row.result?.risk} · 建议=${row.result?.advice}`),
                      h('div', { className: 'pap_note' }, `${row.result?.what ?? ''} / ${row.result?.consequence ?? ''}`),
                    ),
                  ),
                ),
            )
            : null,
        ),

        // ---- 通道 A（Ollama）：默认折叠，除非用户选了本地或检测到已装 Ollama ----
        h(
          'details',
          {
            className: 'pap_detailsBlock',
            open: ollamaOpen,
            onToggle: (e) => setOllamaOpen(e.target.open === true),
          },
          h('summary', { className: 'pap_summary' }, tt('sOllama') + (ollama && ollama.status === 'green' ? ' · 已就绪' : ' · 需要自己安装')),
          h(
            'div',
            { className: 'pap_card2 pap_cardInset' },
            h(Light, { state: ollama ? ollama.status : 'red', label: tt('sLightA'), detail: ollama ? ollama.detail : '', t: tt }),
            h(Field, { label: tt('sBaseUrl'), children: h('input', { className: 'pap_input', value: settings.ollama.baseUrl, onChange: (e) => patch((s) => (s.ollama.baseUrl = e.target.value)) }) }),
            h(Field, { label: tt('sModel'), hint: interpolate(tt('sPull'), { model: settings.ollama.model }), children: h('input', { className: 'pap_input', value: settings.ollama.model, onChange: (e) => patch((s) => (s.ollama.model = e.target.value)) }) }),
            h(Field, { label: tt('sTimeout'), children: h('input', { className: 'pap_input', type: 'number', value: settings.ollama.timeoutMs, onChange: (e) => patch((s) => (s.ollama.timeoutMs = Number(e.target.value))) }) }),

            h('div', { className: 'pap_cardTitle pap_mt' }, tt('sOom')),
            h('div', { className: 'pap_note' }, interpolate(tt('sOomHint'), { n: settings.ollama.breakerFailures, m: settings.ollama.breakerMinutes })),
            h(
              'div',
              { className: 'pap_grid3' },
              h(Field, { label: tt('sOomMaxChars'), children: h('input', { className: 'pap_input', type: 'number', value: settings.ollama.maxCommandChars, onChange: (e) => patch((s) => (s.ollama.maxCommandChars = Number(e.target.value))) }) }),
              h(Field, { label: tt('sOomNumCtx'), children: h('input', { className: 'pap_input', type: 'number', value: settings.ollama.numCtx, onChange: (e) => patch((s) => (s.ollama.numCtx = Number(e.target.value))) }) }),
              h(Field, { label: tt('sOomNumPredict'), children: h('input', { className: 'pap_input', type: 'number', value: settings.ollama.numPredict, onChange: (e) => patch((s) => (s.ollama.numPredict = Number(e.target.value))) }) }),
              h(Field, { label: tt('sOomConcurrency'), children: h('input', { className: 'pap_input', type: 'number', min: 1, max: 2, value: settings.ollama.maxConcurrency, onChange: (e) => patch((s) => (s.ollama.maxConcurrency = Number(e.target.value))) }) }),
              h(Field, { label: tt('sOomMaxQueue'), children: h('input', { className: 'pap_input', type: 'number', value: settings.ollama.maxQueue, onChange: (e) => patch((s) => (s.ollama.maxQueue = Number(e.target.value))) }) }),
              h(Field, { label: tt('sOomMinMem'), children: h('input', { className: 'pap_input', type: 'number', step: '0.5', value: settings.ollama.minFreeMemoryGB, onChange: (e) => patch((s) => (s.ollama.minFreeMemoryGB = Number(e.target.value))) }) }),
            ),
            h(Check, { label: tt('sOomKeepAlive'), checked: settings.ollama.keepAlive, onChange: (v) => patch((s) => (s.ollama.keepAlive = v)) }),
            device && device.ollamaGuard
              ? h(
                'div',
                { className: 'pap_note' },
                interpolate(tt('sOomStats'), {
                  ms: device.ollamaGuard.avgMs ?? '—',
                  queued: device.ollamaGuard.queued ?? 0,
                  running: device.ollamaGuard.running ?? 0,
                }),
              )
              : null,
          ),
        ),

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sDeepseek')),
          h(Field, { label: tt('sDsTimeout'), children: h('input', { className: 'pap_input', type: 'number', value: settings.deepseek.timeoutMs, onChange: (e) => patch((s) => (s.deepseek.timeoutMs = Number(e.target.value))) }) }),
          h(Check, { label: tt('sAsk'), checked: settings.deepseek.askBeforeCall, onChange: (v) => patch((s) => (s.deepseek.askBeforeCall = v)) }),

          // 通道 B 目标：留空 = 自动从 DSH 配置解析，不硬编码
          h('div', { className: 'pap_cardTitle pap_mt' }, tt('sEndpoint')),
          h('div', { className: 'pap_note' }, tt('sEndpointHint')),
          h(
            'div',
            { className: 'pap_grid3' },
            h(Field, {
              label: 'baseUrl',
              hint: status && status.deepseek && status.deepseek.baseUrl ? `解析结果：${status.deepseek.baseUrl}` : '',
              children: h('input', {
                className: 'pap_input',
                placeholder: '(自动)',
                value: settings.deepseek.baseUrl || '',
                onChange: (e) => patch((s) => (s.deepseek.baseUrl = e.target.value)),
              }),
            }),
            h(Field, {
              label: 'model',
              hint: status && status.deepseek && status.deepseek.model ? `解析结果：${status.deepseek.model}` : '',
              children: h('input', {
                className: 'pap_input',
                placeholder: '(自动)',
                value: settings.deepseek.model || '',
                onChange: (e) => patch((s) => (s.deepseek.model = e.target.value)),
              }),
            }),
            h(Field, {
              label: 'apiStyle',
              children: h(
                'select',
                { className: 'pap_input', value: settings.deepseek.apiStyle, onChange: (e) => patch((s) => (s.deepseek.apiStyle = e.target.value)) },
                h('option', { value: 'auto' }, 'auto（按 baseUrl 判断）'),
                h('option', { value: 'openai' }, 'openai（/chat/completions）'),
                h('option', { value: 'anthropic' }, 'anthropic（/v1/messages）'),
              ),
            }),
          ),

          // API Key：始终可见（不再折叠），因为 DSH 复用失败时这是唯一出路
          h('div', { className: 'pap_cardTitle pap_mt' }, tt('sAdvanced')),
          h(Field, {
            label: tt('sApiKey'),
            hint: settings.deepseek.apiKeyConfigured ? '当前已由 DSH 提供（无需填写）' : '留空 = 复用 DSH 的 Key；如果复用失败，请在这里手填一次（和 DSH 用的是同一个 Key）',
            children: h('input', {
              className: 'pap_input',
              type: 'password',
              placeholder: settings.deepseek.apiKeyConfigured ? '（已由 DSH 提供，无需填写）' : 'sk-…',
              value: settings.deepseek.apiKey || '',
              onChange: (e) => patch((s) => (s.deepseek.apiKey = e.target.value)),
            }),
          }),

          h('div', { className: 'pap_cardTitle pap_mt' }, tt('sPricing')),
          h(
            'div',
            { className: 'pap_grid3' },
            h(Field, { label: tt('sPriceMiss'), children: h('input', { className: 'pap_input', type: 'number', step: '0.0001', value: settings.pricing.inputMissPerMillion, onChange: (e) => patch((s) => (s.pricing.inputMissPerMillion = Number(e.target.value))) }) }),
            h(Field, { label: tt('sPriceHit'), children: h('input', { className: 'pap_input', type: 'number', step: '0.0001', value: settings.pricing.inputHitPerMillion, onChange: (e) => patch((s) => (s.pricing.inputHitPerMillion = Number(e.target.value))) }) }),
            h(Field, { label: tt('sPriceOut'), children: h('input', { className: 'pap_input', type: 'number', step: '0.0001', value: settings.pricing.outputPerMillion, onChange: (e) => patch((s) => (s.pricing.outputPerMillion = Number(e.target.value))) }) }),
          ),
        ),

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sSlot')),
          h('div', { className: 'pap_note' }, tt('sSlotHint')),
          // v0.5.0-stable：只有三个固定选项，**没有 auto**。
          // 插件不做任何自动判定，是否接管完全由用户在这里显式选择。
          //
          // v0.7.3 修：这里以前是
          //   onChange: (e) => patch((s) => (s.ui.slotMode = e.target.value))
          // —— 只改 slotMode，**从不写 conflictResolved**。于是用户明明在设置页选了
          // 「接管」，needsConflictChoice() 仍然为真，ComposerEntry 一直走让位分支，
          // 卡片还是原生的。冲突提示 ConflictPrompt 里那个按钮走的是 chooseSlotMode
          // （会写 conflictResolved），但设置页这个下拉框走的是另一条路，两边不一致。
          // 现在两条路都走 applySlotMode（见上方定义）。
          h(Field, {
            label: '',
            children: h(
              'select',
              {
                className: 'pap_input',
                value: settings.ui.slotMode,
                onChange: (e) => applySlotMode(e.target.value),
                // ★ 重新点同一个选项也算一次显式确认。
                // <select> 的 onChange 只在**值变化**时触发，用户当前已经是「接管」
                // 再点一次不会有任何反应 —— 而「我就是要接管」这个意图必须被记下来。
                onClick: () => applySlotMode(settings.ui.slotMode),
              },
              h('option', { value: 'takeover' }, tt('sSlotTakeover')),
              h('option', { value: 'overlay' }, tt('sSlotOverlay')),
              h('option', { value: 'off' }, tt('sSlotOff')),
            ),
          }),
          h(
            'div',
            { className: 'pap_note pap_slotState' },
            slotStateText(status, tt),
          ),
          // 冲突提示：只读扫描到的结果，仅展示，不驱动任何行为
          //
          // v0.7.4 修：以前只看 `rivals.length > 0`，**没看 conflictResolved**。
          // 于是用户手动选过模式之后（conflictResolved=true，卡片已经接管了），
          // 这条黄色警告还一直挂在设置页上 —— 典型���显示层滞后：
          // 状态早就变了，提示没跟上，用户会以为还有问题没解决。
          //
          // 现在：已明确选过模式 → 不再显示黄色警告（问题已处理），
          // 只留一行中性说明，信息不丢但不再制造「还没搞定」的错觉。
          uiPrefs.rivals.length > 0 && uiPrefs.conflictResolved !== true
            ? h('div', { className: 'pap_note pap_warnNote' }, interpolate(tt('sSlotRivals'), { names: uiPrefs.rivals.join('、'), mode: settings.ui.slotMode }))
            : uiPrefs.rivals.length > 0
              ? h('div', { className: 'pap_note' }, interpolate(tt('sSlotRivalsDone'), { names: uiPrefs.rivals.join('、'), mode: settings.ui.slotMode }))
              : null,
          h(Field, {
            label: tt('sCaretakers'),
            hint: tt('sCaretakersHint'),
            children: h('textarea', {
              className: 'pap_textarea',
              rows: 4,
              spellCheck: false,
              value: caretakerText,
              onChange: (e) => setCaretakerText(e.target.value),
            }),
          }),
          // v0.4.3：卡片内摘要开关（默认关闭）+ 浮窗位置复位
          h(Check, {
            label: tt('sInlineSummary'),
            checked: settings.ui.showInlineSummary === true,
            onChange: (v) => patch((s) => (s.ui.showInlineSummary = v)),
          }),
          h('div', { className: 'pap_note' }, tt('sInlineSummaryHint')),
          // v0.7.0：思考过程开关（默认开）+ 隐私说明
          h(Check, {
            label: tt('sUseReasoning'),
            checked: settings.ui.useReasoning !== false,
            onChange: (v) => patch((s) => (s.ui.useReasoning = v)),
          }),
          h('div', { className: 'pap_note' }, tt('sUseReasoningHint')),
          h('div', { className: 'pap_note' }, tt(settings.ui.useReasoning !== false ? 'sUseReasoningOn' : 'sUseReasoningOff')),
        ),

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sDiag')),
          h(
            'div',
            { className: 'pap_toolbar' },
            h('button', { type: 'button', className: 'pap_btn', onClick: runDiag, disabled: diagBusy }, diagBusy ? tt('sDiagRunning') : tt('sDiagRun')),
          ),
          diag && diag.error ? h('div', { className: 'pap_error' }, diag.error) : null,
          diag && diag.checks
            ? h(
              'div',
              { className: 'pap_diag' },
              ['llm', 'agentDefaultModel', 'credentials', 'endpoint'].map((key) => {
                const item = diag.checks[key]
                if (!item) return null
                const label = key === 'llm' ? tt('diagLlm') : key === 'agentDefaultModel' ? tt('diagModel') : key === 'credentials' ? tt('diagCred') : tt('diagEndpoint')
                const ok = key === 'endpoint' ? true : item.available === true
                return h(
                  'div',
                  { className: 'pap_diagRow', key },
                  h('b', { className: ok ? 'pap_ok' : 'pap_error' }, label + '：' + (ok ? '可用' : '不可用')),
                  h('div', { className: 'pap_note' }, item.conclusion || item.summary || ''),
                  item.methods && item.methods.length ? h('div', { className: 'pap_note' }, '方法：' + item.methods.join(', ')) : null,
                )
              }),
            )
            : null,
        ),

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sCache')),
          h(Check, { label: tt('sCacheOn'), checked: settings.cache.enabled, onChange: (v) => patch((s) => (s.cache.enabled = v)) }),
          h(Field, { label: tt('sCacheTtl'), children: h('input', { className: 'pap_input', type: 'number', value: settings.cache.ttlDays, onChange: (e) => patch((s) => (s.cache.ttlDays = Number(e.target.value))) }) }),
        ),

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sUi')),
          h(Check, { label: tt('sColors'), checked: settings.ui.colors, onChange: (v) => patch((s) => (s.ui.colors = v)) }),
          h(Check, { label: tt('sShowCost'), checked: settings.ui.showCost, onChange: (v) => patch((s) => (s.ui.showCost = v)) }),
          h(Check, { label: tt('sDeny'), checked: settings.denyOnFailure, onChange: (v) => patch((s) => (s.denyOnFailure = v)) }),
        ),

        // ---- v0.6.0：分析深度 ----
        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sDepth')),
          h('div', { className: 'pap_note' }, tt('sDepthHint')),
          h(Field, {
            label: '',
            children: h(
              'select',
              {
                className: 'pap_input',
                value: settings.ui.analysisDepth || 'auto',
                onChange: (e) => patch((s) => { s.ui = s.ui || {}; s.ui.analysisDepth = e.target.value }),
              },
              h('option', { value: 'auto' }, tt('sDepthAuto')),
              h('option', { value: 'l1' }, tt('sDepthL1')),
              h('option', { value: 'l2' }, tt('sDepthL2')),
            ),
          }),
          h(Check, {
            label: tt('sDepthAllow'),
            checked: settings.ui.allowUpgrade !== false,
            onChange: (v) => patch((s) => { s.ui = s.ui || {}; s.ui.allowUpgrade = v }),
          }),
        ),

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sHistory')),
          h('div', { className: 'pap_note' }, tt('sHistoryHint')),
          h(Check, { label: tt('sHistoryEnabled'), checked: historySettings.enabled, onChange: (v) => setHistorySetting('enabled', v) }),
          h(Check, { label: tt('sHistoryKeepCmd'), checked: historySettings.keepCommands, onChange: (v) => setHistorySetting('keepCommands', v) }),
          h('div', { className: 'pap_note pap_slotState' }, tt('sHistoryKeepCmdHint')),
          h(Field, {
            label: tt('sHistoryRetention'),
            children: h('input', {
              className: 'pap_input',
              type: 'number',
              min: 1,
              max: 3650,
              value: historySettings.retentionDays,
              onChange: (e) => setHistorySetting('retentionDays', Number(e.target.value)),
            }),
          }),
          h(
            'div',
            { className: 'pap_toolbar' },
            h('button', { type: 'button', className: 'pap_btn pap_btnPrimary', onClick: () => setHistoryOpen(true) }, tt('sHistoryOpen')),
          ),
        ),
        historyOpen
          ? h(HistoryModal, { t: tt, onClose: () => setHistoryOpen(false) })
          : null,

        h(
          'div',
          { className: 'pap_card2' },
          h('div', { className: 'pap_cardTitle' }, tt('sBlacklist')),
          h('div', { className: 'pap_note' }, tt('sBlacklistHint')),
          h('textarea', {
            className: 'pap_textarea',
            rows: 5,
            value: blacklistText,
            spellCheck: false,
            onChange: (e) => setBlacklistText(e.target.value),
          }),
        ),

        // ---- 捐款入口（v0.5.1）：一行常显小字，点击才展开 ----
        // 位置要求：黑名单下面、保存/关闭按钮上面。
        // 不弹窗、不显示红点、不闪烁；用户点过「不再显示」就整行不再出现。
        settings.ui && settings.ui.hideDonate
          ? null
          : h(
              'div',
              { className: 'pap_donate', 'data-plain-approval': 'donate' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'pap_donateLine',
                  onClick: () => setDonateOpen((v) => !v),
                  'aria-expanded': donateOpen ? 'true' : 'false',
                },
                h('span', null, tt('donateTitle')),
                h('span', { className: 'pap_donateArrow' }, donateOpen ? '▾' : '▸'),
              ),
              donateOpen
                ? h(
                    'div',
                    { className: 'pap_donateBody' },
                    h('div', { className: 'pap_note' }, tt('donateBody')),
                    h(
                      'div',
                      { className: 'pap_donateGrid' },
                      h(DonateSlot, { label: tt('donateWechat'), tt }),
                      h(DonateSlot, { label: tt('donateAlipay'), tt }),
                      h(
                        'a',
                        { className: 'pap_donateLink', href: tt('donateAfdianUrl'), target: '_blank', rel: 'noreferrer noopener' },
                        tt('donateAfdian'),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'pap_toolbar' },
                      h('button', { type: 'button', className: 'pap_btn', onClick: hideDonate }, tt('donateHide')),
                    ),
                  )
                : null,
            ),

        h(
          'div',
          { className: 'pap_toolbar pap_toolbarSticky' },
          h('button', { type: 'button', className: 'pap_btn pap_btnPrimary', onClick: save, disabled: saving }, saving ? tt('sSaving') : tt('sSave')),
          h('button', { type: 'button', className: 'pap_btn', onClick: () => props.close && props.close() }, tt('close')),
        ),
      )
    }

    /**
     * v0.5.1：收款码占位。
     * 现在是一个灰色方块 + 「收款码待填」。用户后续把真实二维码放进
     * assets/ 并把下面的占位换成 <img src={API + 'asset/xxx.png'} /> 即可，结构不用动。
     */
    function DonateSlot({ label, tt }) {
      // ⚠️ tt 必须由调用方传入：DonateSlot 定义在 SettingsSection **外面**，
      //   而 tt 是 SettingsSection 里的局部 const（makeTT(props)）。
      //   v0.6.3 之前这里直接写 tt('donateQrPending') → ReferenceError: tt is not defined
      //   → 设置页整体崩成「暂不可用（渲染异常）」，连同一层的爱发电链接也一起消失
      //   （DonateSlot 排在它前面，先抛错，整个子树都不渲染）。
      const text = typeof tt === 'function' ? tt('donateQrPending') : '收款码待填'
      return h(
        'div',
        { className: 'pap_donateSlot' },
        h('div', { className: 'pap_donateQr', role: 'img', 'aria-label': label }, h('span', null, text)),
        h('div', { className: 'pap_donateSlotLabel' }, label),
      )
    }

    /* -------------------------------------------------------------- */
    /* 样式                                                            */
    /* -------------------------------------------------------------- */

    const CSS = [
      '.pap_root{padding:8px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 12px;flex-direction:column;align-items:center;display:flex}',
      '.pap_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);overflow:hidden}',
      '.pap_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex;flex-wrap:wrap}',
      '.pap_dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}',
      '.pap_badge{border-radius:999px;padding:1px 8px;font-size:12px;border:1px solid currentColor}',
      '.pap_body{box-sizing:border-box;max-height:var(--dsh-composer-text-max-height);flex-direction:column;gap:10px;padding:12px 16px 0;display:flex;overflow-y:auto}',
      '.pap_block{border:1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.28));border-radius:var(--dsw-radius-m,8px);padding:10px 12px}',
      '.pap_blockHead{align-items:center;justify-content:space-between;gap:8px;display:flex;margin-bottom:6px}',
      '.pap_blockTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}',
      '.pap_headline{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}',
      '.pap_headlineWarn{color:var(--dsw-alias-state-warn-primary)}',
      '.pap_grid{flex-direction:column;gap:4px;display:flex}',
      '.pap_row{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:20px}',
      '.pap_rowLabel{color:var(--dsw-alias-label-tertiary);flex:0 0 68px}',
      '.pap_rowValue{color:var(--dsw-alias-label-primary);flex:1 1 auto;word-break:break-word;white-space:pre-wrap}',
      '.pap_risk{font-weight:600}',
      '.pap_riskSafe{color:#1a9f5a}',
      '.pap_riskWarn{color:#c07d00}',
      '.pap_riskDanger{color:#d92d20}',
      '.pap_riskPlain{color:inherit}',
      '.pap_command{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);word-break:break-all;white-space:pre-wrap;font-size:13px;line-height:20px;margin:0;max-height:180px;overflow:auto}',
      '.pap_pre{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);white-space:pre-wrap;word-break:break-all;font-size:12px;margin:4px 0 0}',
      '.pap_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.pap_background{color:var(--dsw-alias-label-secondary);font-style:normal}',
      '.pap_warnNote{color:var(--dsw-alias-state-warn-primary)}',
      '.pap_wizard{border-color:var(--dsw-alias-state-business-primary,#1a6dff)}',
      '.pap_choice{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:20px;cursor:pointer}',
      '.pap_choiceDim{opacity:.5}',
      '.pap_check{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-state-warn-primary)}',
      '.pap_okNote{color:var(--dsw-alias-state-success-primary,#1a9f5a)}',
      '.pap_toast{margin-bottom:8px}',
      '.pap_toastWarn{border-color:var(--dsw-alias-state-warn-secondary)}',
      '.pap_detailsBlock{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:var(--dsw-radius-m,8px);padding:8px 12px}',
      '.pap_summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.pap_cardInset{margin-top:8px;border:none;padding:0}',
      '.pap_slotState{color:var(--dsw-alias-label-secondary)}',
      '.pap_donate{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      // v0.5.1：一行常显小字 + 点击展开。不弹窗、不显示红点、不闪烁。
      '.pap_donateLine{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;font-family:inherit;font-size:12px;line-height:18px;padding:6px 0;border:none;border-top:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-align:left}',
      '.pap_donateLine:hover{color:var(--dsw-alias-label-primary)}',
      '.pap_donateArrow{flex:none;font-size:11px;line-height:1}',
      '.pap_donateBody{display:flex;flex-direction:column;gap:8px;padding:10px 0 4px}',
      '.pap_donateGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;align-items:end}',
      '.pap_donateSlot{display:flex;flex-direction:column;align-items:center;gap:4px}',
      '.pap_donateQr{width:104px;height:104px;border-radius:6px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.12));border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.4));display:flex;align-items:center;justify-content:center}',
      '.pap_donateQr span{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:0 6px}',
      '.pap_donateSlotLabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.pap_donateLink{font-size:12px;color:var(--dsw-alias-interactive-bg-primary,#1a6dff);align-self:center;padding:6px 0}',
      // v0.5.3：审批历史弹窗。纯 CSS 定位，不注册全局监听、不往 body 插节点。
      '.pap_historyMask{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.pap_historyModal{background:var(--dsw-alias-bg-base,#fff);border-radius:var(--dsw-radius-l,12px);width:min(920px,96vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.25));color:var(--dsw-alias-label-primary)}',
      '.pap_historyHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22))}',
      '.pap_historyTitle{font-size:15px;font-weight:600}',
      '.pap_historyFilters{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22))}',
      '.pap_historyFilters .pap_fieldLabel{flex:1 1 150px;min-width:130px}',
      '.pap_historyEmpty{padding:28px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}',
      '.pap_historyList{overflow-y:auto;flex:1 1 auto;padding:4px 8px}',
      '.pap_historyRow{border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.14))}',
      '.pap_historyRowHead{width:100%;display:flex;align-items:center;gap:10px;padding:8px;font-family:inherit;font-size:12px;background:transparent;border:none;color:inherit;cursor:pointer;text-align:left;flex-wrap:wrap}',
      '.pap_historyRowHead:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08))}',
      '.pap_historyTime{color:var(--dsw-alias-label-tertiary);flex:0 0 auto;font-variant-numeric:tabular-nums}',
      '.pap_historyMode{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
      '.pap_historyDecision{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
      '.pap_historyReject{color:#d92d20}',
      '.pap_historyHash{margin-left:auto;flex:0 0 auto;font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary)}',
      '.pap_historyBody{padding:4px 12px 14px;display:flex;flex-direction:column;gap:8px}',
      '.pap_historyCmd{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08));max-height:160px;overflow:auto}',
      '.pap_historyGrant{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code)}',
      '.pap_historyFoot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.06))}',
      '.pap_notes{margin-top:2px}',
      '.pap_notesTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;margin-bottom:2px}',
      '.pap_parts{margin-top:6px}',
      '.pap_partsTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;margin-bottom:2px}',
      '.pap_part{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.pap_skeleton{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:4px 0}',
      '.pap_footer{border-top:1px dashed var(--dsw-alias-border-secondary, rgba(127,127,127,.28));padding-top:6px;margin-top:2px}',
      '.pap_engine{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.pap_cost{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.pap_costDim{opacity:.85}',
      // ---- v0.6.2：三行决策 + 折叠 + 高亮 ----
      '.pap_verdict{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.05))}',
      '.pap_verdictDanger{border-color:var(--dsw-alias-state-error-primary,#d92d20);background:rgba(217,45,32,.06)}',
      // v0.7.0：标题是卡片第一行，字号最大、颜色最重。
      // 颜色一律走 --dsw-alias-* 变量：DSH 换主题时会跟着换，深浅色都不会糊。
      '.pap_verdictTitle{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);margin-bottom:6px;word-break:break-word}',
      '.pap_verdictTop{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}',
      '.pap_verdictRisk{font-size:15px;font-weight:700;line-height:22px}',
      '.pap_verdictAdvice{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.pap_verdictIntent{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);margin-bottom:2px}',
      '.pap_verdictConsequence{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.pap_more{margin:6px 0 10px}',
      '.pap_more>summary{cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:4px 0;list-style:none}',
      '.pap_more>summary::-webkit-details-marker{display:none}',
      '.pap_more>summary::before{content:"▸ ";display:inline-block;transition:transform .12s ease}',
      '.pap_more[open]>summary::before{content:"▾ "}',
      '.pap_more>summary:hover{color:var(--dsw-alias-label-primary)}',
      // 原始命令里的危险片段高亮 —— 原文一字不删，只给视觉落点
      '.pap_hot{background:rgba(217,45,32,.16);color:inherit;border-radius:3px;padding:0 2px;font-weight:600;box-shadow:inset 0 -1px 0 rgba(217,45,32,.55)}',
      '.pap_hot_network{background:rgba(192,125,0,.16);box-shadow:inset 0 -1px 0 rgba(192,125,0,.55)}',
      '.pap_hot_registry{background:rgba(217,45,32,.16);box-shadow:inset 0 -1px 0 rgba(217,45,32,.55)}',
      '.pap_hot_permission{background:rgba(192,125,0,.16);box-shadow:inset 0 -1px 0 rgba(192,125,0,.55)}',
      // v0.6.0：成本透明行
      '.pap_depth{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.22));font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.pap_depthLabel{color:var(--dsw-alias-label-secondary)}',
      '.pap_depthMeta{color:var(--dsw-alias-label-tertiary)}',
      '.pap_error{color:var(--dsw-alias-state-error-primary,#d92d20);font-size:12px;line-height:18px}',
      '.pap_ok{color:#1a9f5a;font-size:12px;line-height:18px}',
      '.pap_confirm{border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-m,8px);padding:10px 12px;margin-top:8px}',
      '.pap_confirmTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.pap_confirmBody{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.pap_privacy{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);margin-top:4px}',
      '.pap_confirmActions{display:flex;gap:8px;margin-top:8px}',
      '.pap_actions{justify-content:flex-end;gap:8px;padding:14px 16px;display:flex;flex-wrap:wrap}',
      '.pap_btn{cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;padding:5px 14px;border-radius:var(--dsw-radius-m,8px);border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-primary)}',
      '.pap_btn:disabled{opacity:.5;cursor:default}',
      '.pap_btnReject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}',
      '.pap_btnPrimary{background:var(--dsw-alias-interactive-bg-primary,#1a6dff);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.pap_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-primary-hover,#1660e0)}',
      '.pap_link{cursor:pointer;background:none;border:none;color:var(--dsw-alias-interactive-bg-primary,#1a6dff);font-size:12px;padding:0}',
      '.pap_link:disabled{opacity:.5;cursor:default}',
      '.pap_settings{padding:16px;max-width:760px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}',
      '.pap_h3{font-size:16px;margin:0}',
      '.pap_sub{font-size:13px;color:var(--dsw-alias-label-secondary);margin:0;line-height:20px}',
      '.pap_card2{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:var(--dsw-radius-m,8px);padding:12px;display:flex;flex-direction:column;gap:8px}',
      '.pap_cardTitle{font-size:13px;font-weight:600}',
      '.pap_mt{margin-top:6px}',
      '.pap_divider{height:1px;background:var(--dsw-alias-border-secondary,rgba(127,127,127,.22))}',
      '.pap_field{display:flex;flex-direction:column;gap:4px;font-size:13px}',
      '.pap_fieldLabel{color:var(--dsw-alias-label-secondary)}',
      '.pap_input,.pap_textarea{font-family:inherit;font-size:13px;padding:5px 8px;border-radius:var(--dsw-radius-s,6px);border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.35));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);width:100%;box-sizing:border-box}',
      '.pap_textarea{font-family:var(--ds-font-family-code);resize:vertical}',
      '.pap_check{display:flex;align-items:center;gap:8px;font-size:13px}',
      '.pap_grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}',
      '.pap_light{display:flex;gap:8px;align-items:flex-start}',
      '.pap_lightDot{width:10px;height:10px;border-radius:50%;margin-top:4px;flex:none}',
      '.pap_lightGreen{background:#1a9f5a;color:#1a9f5a}',
      '.pap_lightYellow{background:#c07d00;color:#c07d00}',
      '.pap_lightRed{background:#d92d20;color:#d92d20}',
      '.pap_lightBody{flex:1 1 auto}',
      '.pap_lightTitle{font-size:13px;font-weight:600}',
      '.pap_lightState{margin-left:8px;font-size:12px;font-weight:400}',
      '.pap_toolbar{display:flex;gap:8px;flex-wrap:wrap}',
      '.pap_toolbarSticky{position:sticky;bottom:0;padding:8px 0;background:var(--dsw-alias-bg-base,transparent)}',
      '.pap_testResult{display:flex;flex-direction:column;gap:4px;font-size:12px}',
      '.pap_testOk{color:#1a9f5a}',
      '.pap_testFail{color:#d92d20}',
      '.pap_details{font-size:13px}',
      '.pap_details summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.pap_plain{display:flex;flex-direction:column;gap:8px}',
      '.pap_diag{display:flex;flex-direction:column;gap:8px}',
      '.pap_diagRow{border-left:2px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.3));padding-left:8px}',
      // 让位浮层：固定右下、可点击（上层是整层 click-through，条目自己 opt-in 指针事件）
      // v0.4.5：位置**永远固定**（不再有拖动，因此也没有 left/top 内联样式与 .pap_chipFixed）
      '.pap_chipRoot{position:fixed;right:20px;bottom:120px;z-index:60;pointer-events:auto;max-width:min(560px,92vw)}',
      // 需求：浮窗宽度不超过屏幕宽度的 40%；窄屏兜底放宽，避免完全不可读
      '.pap_chipWide{max-width:40vw}',
      '@media (max-width:760px){.pap_chipWide{max-width:min(92vw,420px)}}',
      '.pap_whale{flex:none;border-radius:4px;display:block}',
      '.pap_boundaryFallback{padding:8px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.pap_chipHeadStatic{padding:10px 12px 4px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}',
      '.pap_chipHeadBtns{margin-left:auto;display:flex;gap:2px;align-items:center;flex:none}',
      '.pap_iconBtn{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;padding:4px 6px;border-radius:4px;white-space:nowrap;font-family:inherit}',
      '.pap_iconBtn:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary)}',
      '.pap_chipMini{display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.3));background:var(--dsw-specific-input-major);border-radius:999px}',
      '.pap_chipScroll{max-height:52vh;overflow:auto}',
      '.pap_btnWide{width:100%}',
      // 纸张式排版：每段一块，左对齐，段间留空行
      '.pap_plainWide{text-align:left}',
      '.pap_paper{display:flex;flex-direction:column;text-align:left}',
      '.pap_paperRow{margin:0 0 12px;text-align:left}',
      '.pap_paperLabel{font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}',
      '.pap_paperValue{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}',
      '.pap_chip{border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);overflow:hidden}',
      '.pap_chipHead{display:flex;align-items:center;gap:8px;width:100%;cursor:pointer;background:0 0;border:none;padding:8px 12px;color:var(--dsw-alias-label-primary);font-family:inherit;text-align:left}',
      '.pap_chipDot{width:8px;height:8px;border-radius:50%;flex:none;background:currentColor}',
      '.pap_chipTitle{font-size:13px;font-weight:600;flex:none}',
      '.pap_chipText{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pap_chipAction{font-size:12px;color:var(--dsw-alias-interactive-bg-primary,#1a6dff);flex:none}',
      '.pap_chipNote{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:0 12px 8px}',
      '.pap_chipHeadStatic{padding:10px 12px 4px;font-size:13px;font-weight:600}',
      '.pap_chipBody{padding:0 12px 12px;max-height:50vh;overflow:auto}',
      '.pap_grantList{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto}',
      '.pap_grantRow{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.24));border-radius:var(--dsw-radius-s,6px);padding:6px 8px}',
      '.pap_grantMain{flex:1 1 auto;min-width:0}',
      '.pap_grantCmd{display:block;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-all;white-space:pre-wrap}',
      '.pap_grantNote{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);margin-right:auto}',
    ].join('')

    return {
      inject: ['slots', 'locale'],
      // 供离线自检复用纯逻辑（浏览器运行时忽略这些额外键）。
      __internal: {
        // v0.5.0-stable：自动让位判定（findComposerRivals / computeSlotDecision）已删除。
        // 剩下的槽位相关导出全部是「只读扫描」与「用户显式选择」。
        scanSlotConflictsOnce,
        isSelfOrOfficial,
        rivalLabelOf,
        chooseSlotMode,
        needsConflictChoice,
        shouldShowOverlay,
        onboardFailureOutcome,
        // v0.4.6-safe：诊断限流闸门与结果缓存上限（供离线自检断言放大路径已被钉死）
        note,
        withResult,
        NOTE_WINDOW_MS,
        NOTE_MAX_PER_WINDOW,
        MAX_CACHED_RESULTS,
        noteStats: () => ({ stamps: noteStamps.slice(), dropped: noteDropped }),
        // v0.4.5：浮窗只有固定位置，没有拖动 / 观察者 / DOM 注入
        WHALE_URL,
        whaleIcon,
        showOllamaPanel,
        slotStateText,
        deviceTierLightState,
        ConflictPrompt,
        ConflictGate,
        ComposerEntry,
        ReviewChipEntry,
        SettingsEntry,
        PluginBoundary,
        ChipBoundary,
        ReviewChip,
        uiPrefs,
        riskClass,
        argsOf,
        interpolate,
        engineLabelOf,
        OFFICIAL_REGISTRANT,
        MY_REGISTRANTS,
        PRIORITY,
        API,
      },
      apply(ctx) {
        refreshPrefs().then(() => {
          // v0.5.0-stable：偏好拿到之后做**一次**只读冲突扫描。
          // 这里只读元数据，不调任何人的 select()，不改任何东西。
          try {
            scanSlotConflictsOnce(ctx.slots)
          } catch (error) {
            /* 扫描失败等于「没冲突」，绝不阻塞 */
          }
        })
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ': dictionaries')
        } catch (error) {
          console.error('[plain-approval] locale 注册失败：', error)
        }
        try {
          ctx.effect(() => {
            const tagId = 'dsh-plain-approval/styles.css'
            if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return () => {}
            const tag = document.createElement('style')
            tag.dataset.plugin = 'dsh-plain-approval'
            tag.dataset.pluginCss = tagId
            tag.textContent = CSS
            document.head.appendChild(tag)
            return () => {
              try {
                tag.remove()
              } catch (ignored) {
                /* 已随文档卸载 */
              }
            }
          }, NS + ': styles')
        } catch (error) {
          console.error('[plain-approval] 样式注入失败：', error)
        }

        // 设置页
        let bindT = (key) => zh[key] ?? key
        try {
          if (ctx.locale && typeof ctx.locale.bind === 'function') bindT = ctx.locale.bind(NS)
        } catch (error) {
          /* 退回内置中文 */
        }
        const navLabel = () => {
          try {
            const value = bindT('settingsNav')
            if (typeof value === 'string' && value !== '') return value
          } catch (error) {
            /* 忽略 */
          }
          return zh.settingsNav
        }
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'plain-approval',
                order: 80,
                label: navLabel,
                locale: NS,
              },
              SettingsEntry,
            ),
          )
        } catch (error) {
          console.error('[plain-approval] 设置页注册失败：', error)
        }

        // 审批卡片接管（自适应：select() 里决定让不让位）
        try {
          ctx.slots.inject('conversation.composer', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer',
                priority: PRIORITY,
                locale: NS,
                select: (owner) => {
                  // v0.5.0-stable：**没有任何判定**。
                  // 这个回调只回答一个问题：「按用户设的模式，我现在要不要接？」
                  // 不探测别人装了什么，不调别人的 select()，不翻任何状态。
                  // 任何异常都不能让选择器冒泡：DSH 会按「declined」处理。
                  try {
                    if (uiPrefs.slotMode !== 'takeover') return null
                    const pending = owner && owner.pendingInteraction
                    return pending && pending.kind === 'approval' ? pending : null
                  } catch (error) {
                    try {
                      console.error('[plain-approval] slot selector failed:', error)
                    } catch (ignored) {
                      /* 忽略 */
                    }
                    const pending = owner && owner.pendingInteraction
                    return pending && pending.kind === 'approval' ? pending : null
                  }
                },
                inject: () => ({
                  resolveReason: (reason) => {
                    try {
                      return ctx.locale.resolveText(reason)
                    } catch (error) {
                      return reason
                    }
                  },
                }),
              },
              ComposerEntry,
            ),
          )
        } catch (error) {
          console.error('[plain-approval] 审批卡片注册失败：', error)
        }

        // 右下角浮层：只在 overlay 模式下出现（v0.5.0 由 ui.slotMode 决定，没有自动翻转）。
        // 另挂一个「一次性冲突选择」提示：只在检测到冲突且用户还没选过时出现。
        try {
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'plain-approval-chip',
                order: 40,
                locale: NS,
              },
              (props) => h(ConflictGate, { tt: makeTT(props), reviewChip: (p) => h(ReviewChipEntry, p) }),
            ),
          )
        } catch (error) {
          console.error('[plain-approval] 让位浮层注册失败：', error)
        }
      },
    }
  },
})