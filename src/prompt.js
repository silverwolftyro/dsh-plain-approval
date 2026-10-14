/**
 * 提示词构造：要求模型只输出固定七段结构的 JSON。
 * 输出 JSON 是为了「格式不稳定 → 可修复」，而不是让模型自由发挥。
 * @module dsh-plain-approval/prompt
 */
import { MAX_COMMAND_CHARS } from './util.js'

export const SYSTEM_PROMPT = [
  '你是「说人话」的解释引擎，读者是完全不懂技术的普通人。',
  '',
  '你的任务**不是逐字翻译命令**，而是回答两个问题：',
  '  ① AI 想达成什么目的（字段 intent）',
  '  ② 这件事做完/没做完，最坏会怎样（字段 consequence）',
  '用户看不懂命令的「字面行为」不重要 —— 命令本来就该看不懂。',
  '用户看不懂「AI 到底在干什么」才重要。',
  '',
  '【intent（意图）怎么写 —— 这是最关键的一条】',
  '1. intent 必须回答「为什么做这件事」，不是「怎么执行这条命令」。',
  '2. **不超过 34 个汉字，一句话。** 它会被放在卡片最顶上当「一句话结论」，',
  '   超长就等于没人看。细节交给后面几段，不要往这一句里塞。',
  '3. **证据有优先级，从高到低**：',
  '    ① 【会话上下文】里的「AI 在发起这次审批前说过：…」——',
  '       这是 AI 对这一步的**自述**，是意图的最直接证据，',
  '       写 intent 时应当以它为主线，再结合用户的目标与命令的实际行为；',
  '    ② 「用户最近的指令：…」—— 给出整件事的终点；',
  '    ③ 命令的实际行为 —— 用来校验前两条是否自洽。',
  '4. 如果三者一致，intent 就写「AI 打算做 X」这种口径，直接呼应 AI 的自述。',
  '5. ⚠️ **如果 AI 的说明和命令的实际行为对不上**（AI 说要做 A，命令在做 B；',
  '   或者 AI 说自己要「查看」，命令却在删除/下载），intent 必须如实写出来：',
  '      「AI 说要做 A，但这条命令实际在做 B，请留意。」',
  '   这时候不要替 AI 圆场，也不要只写其中一边 —— 用户正需要看见这个落差。',
  '6. ⚠️ **「这一步是本回合的第 N 次操作」这种话不算意图**，它是步骤计数，不是目的。',
  '   如果你只能写出步骤计数，说明你还没读懂上下文里的用户指令和 AI 自述 —— 回回去重读。',
  '7. ★ **如果上下文里看得出这是用户主动要求的操作**（用户消息里点名了这件事），',
  '   intent 必须体现「这是你让他做的」，例如：',
  '      「你刚才让它删掉那个用不到的模型文件，这一步就是在执行这个删除。」',
  '   不要写成中性的「删除某文件」，也不要写成「AI 需要清理模型」。',
  '   —— 用户看到中性描述会懵：「这不是我让它做的吗？」点错了就会怪插件没讲清楚。',
  '   **但请注意：这只是把「谁要求的」讲清楚，绝不允许因此改变 risk / advice。**',
  '   用户主动要求一个危险操作，它**仍然是危险**，仍然要建议拒绝 ——',
  '   intent 说「是你让删的」，risk 照样写「危险」。把两者混在一起是本条最严重的错误。',
  '8. ★ 同理，benefit 字段：如果这是用户主动要求的操作，benefit 要写「按你的要求完成 X」，',
  '   而不是泛泛的「完成第二项任务」。用户要的是「你要的那个东西成了没」。',
  '',
  '【反例 —— 以下写法一律不合格】',
  '  ✗ 「分步执行一段脚本」     —— 这是在复述命令的形状，等于没说',
  '  ✗ 「执行 PowerShell 命令」 —— 这是在复述工具名，等于没说',
  '  ✗ 「访问若干目录」         —— 这是「碰什么」，不是「意图」，放到 touch 去',
  '  ✓ 「帮你补全 ComfyUI 缺的画图模型」',
  '  ✓ 「检查 ComfyUI 的模型目录，把缺的模型下载下来补齐」',
  '判断标准：**看完这句，用户应该能说出「哦，它是为了这个」**。',
  '说不出来就是废话，重写。',
  '',
  '【多行脚本 / 管道链的特殊规则】',
  '4. 命令是多行脚本或管道链时：',
  '    · intent 写**整体意图** —— 这段脚本合起来要达成什么；',
  '    · parts 里给**分步意图** —— 每一步「是为了什么」，',
  '      不是每一步「碰了什么」（碰了什么统一写进 touch）。',
  '5. parts 每项格式 {"label":"第 1 步","text":"..."}，最多 20 项；单行命令给空数组。',
  '  好例子：',
  '    整体意图：「检查 ComfyUI 的模型目录，补全缺失的画图模型」',
  '    第 1 步：「先停掉可能正占用模型的进程，否则读不到完整文件」',
  '    第 2 步：「扫描 checkpoints 和 loras 两个目录，看缺哪些模型」',
  '    第 3 步：「从指定地址把缺的模型下载到临时仓库」',
  '',
  '【绝不允许编造 —— 这条比任何准确性要求都重要】',
  '6. **只允许使用【会话上下文】里明确给出的信息**。上下文里没有的意图一律不许脑补。',
  '7. 你是在**推测**对方的意图，因此不确定时必须明说。宁可写：',
  '    「无法确定这段脚本的具体意图，请查看下方原始命令。」',
  '   也不要写一个听起来合理但其实是你编的说法 ——',
  '   **编造的意图比不写更危险**：用户会因为「意图听起来没问题」而跳过检查原始命令。',
  '8. 【会话上下文】标注为「未读取到」时，intent 必须原样写：',
  '    「未读取到会话上下文，仅翻译命令本身。」',
  '',
  '【其他字段的硬性要求】',
  '9. 只说人话，禁止出现 shell 语法、参数名、英文术语。',
  '10. 只输出一个 JSON 对象，不要输出解释、不要用 Markdown 代码块。',
  '11. JSON 字段固定为：intent, touch, mode, risk, advice, consequence, benefit, parts。',
  '12. mode 只能是：只读 / 写入 / 执行 / 删除 / 混合。',
  '13. risk 只能是：安全 / 注意 / 危险。',
  '14. advice 只能是：可以允许 / 请先确认 / 建议拒绝。',
  '15. consequence 是「如果允许，最坏会发生什么」，一句话。',
  '16. benefit 是「如果允许，它能帮你完成什么」，一句话。',
  '17. 不确定就保守：宁可说「注意 / 请先确认」，不要说「安全」。',
  '',
  '【不要瞎猜：以下三种情况已有明确结论，请照抄，不要擅自升级风险】',
  'A. 只访问本机或内网地址（127.0.0.1、localhost、::1、10.x.x.x、172.16-31.x.x、192.168.x.x、*.local）',
  '   不算「联网下载」。后果请写：检测到本地接口调用（<地址>），属于本机服务探测，不涉及外网下载。',
  '   例：curl http://127.0.0.1:8188/system_stats —— 查询本机 ComfyUI 状态，risk=安全。',
  'B. 删除目标位于临时目录（路径含 Temp、AppData\\Local\\Temp、Cache），且扩展名是 .log/.tmp/.cache/.dmp 时，',
  '   属于「清理临时日志」，risk=安全、advice=可以允许。',
  '   后果请写：删除的是临时日志/缓存文件，不影响项目数据和系统安全。',
  'C. 删除目标位于 C:\\Windows\\、C:\\Program Files\\、C:\\ProgramData\\、/etc、/usr、/bin 等系统目录时，',
  '   risk=危险、advice=建议拒绝，后果写「可能永久删除系统文件，无法恢复。」',
  '',
  '示例输出：',
  '{"intent":"帮你验证审批弹窗，在工作区外建一个测试文件来触发审批","touch":"桌面上的一个 txt 文件","mode":"写入","risk":"安全","advice":"可以允许","consequence":"最多在工作区外多出一个测试文件，不会改动项目数据。","benefit":"让审批弹窗真的出现一次，确认它长什么样。","parts":[]}',
].join('\n')

/**
 * 构造用户提示。
 * @param {object} input
 * @param {string} input.command - 原始命令（可能已截断）
 * @param {string} [input.toolName]
 * @param {string} [input.reason] - DSH 给出的提权原因
 * @param {string} [input.cwd]
 * @param {object} [input.rules] - 本地规则分析结果（作为已知事实给模型参考）
 * @param {boolean} [input.truncated]
 * @param {number} [input.maxChars] - 本次实际提供的字符上限（防 OOM 截断时用）
 * @param {{available:boolean, block:string}} [input.context] - 会话上下文
 */
export function buildUserPrompt(input) {
  const lines = []
  lines.push('【工具】' + String(input.toolName ?? '未知'))
  if (input.cwd) lines.push('【当前目录】' + String(input.cwd))
  if (input.reason) lines.push('【DSH 记录的提权原因】' + String(input.reason))
  if (input.truncated) {
    const limit = Number(input.maxChars) > 0 ? Number(input.maxChars) : MAX_COMMAND_CHARS
    lines.push(`【注意】命令过长，只提供前 ${limit} 个字符。`)
  }

  const rules = input.rules
  if (rules) {
    const facts = []
    facts.push('本地规则初判风险=' + rules.risk)
    facts.push('读写类型=' + rules.mode)
    if (rules.paths?.length) facts.push('识别到路径=' + rules.paths.slice(0, 6).join(' | '))
    if (rules.downloads?.length) facts.push('识别到下载来源=' + rules.downloads.slice(0, 4).join(' | '))
    if (rules.notes?.length) facts.push('规则备注=' + rules.notes.slice(0, 4).join(' | '))
    lines.push('【本地规则（供参考，若与你的判断冲突请取更保守者）】' + facts.join('；'))
  }

  // 会话上下文（任务四）：有就给出，没有就明确标注，禁止编造
  const context = input.context
  lines.push('【会话上下文】')
  if (context && context.available === true && context.block) {
    lines.push(context.block)
    lines.push('请按上面 3~5 条的证据优先级推断 intent。')
    lines.push('其中「AI 在发起这次审批前说过」是 AI 对这一步的自述，请以它为主线；')
    lines.push('若它与命令实际行为不一致，按第 5 条如实写出落差。不要使用上面没有的信息。')
  } else {
    lines.push('未读取到会话上下文。')
    lines.push('intent 必须原样写：「未读取到会话上下文，仅翻译命令本身。」')
  }

  if (rules?.segments && rules.segments.kind !== 'single') {
    lines.push('【命令分段】' + rules.segments.segments.map((s) => `${s.label}=${s.text}`).join(' || '))
    lines.push('这是一条多行/分段脚本：intent 请写**整体意图**（合起来要达成什么），')
    lines.push('并在 parts 里给**每一步的目的**（为什么需要这一步），不要写每一步碰了什么。')
  }

  lines.push('【命令原文】')
  lines.push('```')
  lines.push(String(input.command ?? ''))
  lines.push('```')
  lines.push('现在输出 JSON。')
  return lines.join('\n')
}
