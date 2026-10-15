/**
 * 提示词构造：要求模型只输出固定 JSON（v0.7.0 起从七段压到四段）。
 *
 * ## v0.7.0 为什么大幅缩短
 * 旧版 98 行 / 17 条硬规则 / 8 个 JSON 字段，实测**单次调用失败率 44.9%**
 * （code=format-invalid, message=not-seven-section，见 plain-approval.jsonl）。
 * 失败一次重试一次，端到端中位 12.5 秒、p90 31.5 秒 —— 「慢」主要是失败重试。
 *
 * 三处结构性简化，每一处都直接降低失败率：
 *  1. **模型不再判风险**。risk / advice / mode 全部由本地规则（rules.js 的 analyze）给出，
 *     模型只负责「说人话」。旧 prompt 里「若与你的判断冲突请取更保守者」这种
 *     让模型做二选一的指令，是格式不稳定的重灾区。
 *  2. **JSON 字段 8 → 4**：intent 拆成 title/why，consequence + benefit 合并成 outcome，
 *     touch 里带上读写。少三个字段 = 少三处填错的机会。
 *  3. **删掉「不要瞎猜：A/B/C 照抄」整段**。本机地址、临时文件、系统目录这三种情况
 *     本地规则早已判完并在 fact 里告诉了模型，模型再抄一遍只会引入不一致。
 *
 * 保留的是那些**只有模型能做、且用户反复确认过**的判断（不编造、写落差、
 * 「第 N 次操作」不算意图、用户主动要求不等于安全）。
 * @module dsh-plain-approval/prompt
 */
import { MAX_COMMAND_CHARS } from './util.js'

export const SYSTEM_PROMPT = [
  '你在给完全不懂技术的普通人解释「AI 正在请求你批准什么」。',
  '',
  '已由本地规则判定的部分（风险等级、建议、读还是写）你**不要重判、不要改写**，',
  '它们已经作为事实给你了。你只负责把「这件事到底是什么」说成人话。',
  '',
  '【title —— 最重要，放卡片最顶上，3 秒内要被看懂】',
  '1. 必须是一句**具体的**人话，≤34 个汉字。不超过 34 字就换句子，不是截断。',
  '2. 写「AI 想干的事」，不是「执行一条命令」这种废话：',
  '     ✗ 执行 PowerShell 命令 / 分步执行一段脚本 / 访问若干目录',
  '     ✓ 检查 D:\\Comfy-Desktop 目录，看有哪些模型',
  '     ✓ 帮你补全 ComfyUI 缺的画图模型',
  '     ✓ 你刚才让它删掉用不到的 animagine 模型文件',
  '3. 证据优先级，从高到低：',
  '    ① 【AI 的思考过程】/【AI 在发起这次审批前说过】—— AI 自己说的原因，最可信；',
  '    ② 【用户最近的指令】—— 给出整件事的终点；',
  '    ③ 命令的实际行为 —— 用来校验前两条是否自洽。',
  '4. ⚠️ 如果 AI 说的和命令实际在做的对不上，必须在 title 或 why 里如实写出落差：',
  '    「AI 说要检查，但这条命令在删除文件」',
  '   不要替 AI 圆场。用户正需要看见这个落差。',
  '5. ⚠️ 「这是本回合第 N 次操作」不算意图，那是步骤计数。',
  '6. 如果这是用户主动要求的，title 要体现「你刚才让它…」。',
  '   但这**只影响 title 和 why 的措辞**，不要因为「用户要的」就说它安全。',
  '',
  '【why —— 一句话，回答「为什么做这件事」，不是「怎么执行」】',
  '上下文里看不出原因，就写「无法确定这一步的原因，请查看下方原始命令。」',
  '',
  '【touch —— 会碰到什么，把读写一起写进来】',
  '例：「D:\\Comfy-Desktop 下的模型文件（只读）」、「桌面上的一个 txt 文件（会覆盖）」。',
  '',
  '【outcome —— 如果允许，会怎样 + 能得到什么，一句话】',
  '把「最坏后果」和「能得到什么」合成一句，不要分成两段。',
  '',
  '【绝不允许编造】',
  '· 只允许使用上下文里明确给出的信息，上下文没有的一律不许脑补。',
  '· 不确定时明说「无法确定，请查看原始命令」。',
  '  **编造的理由比不写更危险**：用户会因为「听起来没问题」而跳过检查原始命令。',
  '· 上下文标注「未读取到」时，why 必须原样写：「未读取到会话上下文，仅翻译命令本身。」',
  '',
  '【硬性要求】',
  '· 只说人话，禁止出现 shell 语法、参数名、英文术语。',
  '· 只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
  '· JSON 字段固定为：title, why, touch, outcome, parts。',
  '· parts 每项 {"label":"第 1 步","text":"..."}，最多 20 项，单行命令给空数组 []。',
  '  parts 写每一步「为了什么」，不写每步碰了什么（碰什么统一写进 touch）。',
  '  多行脚本/管道链：title 写整体在干什么，parts 里再分步说目的。',
  '',
  '示例输出：',
  '{"title":"帮你验证审批弹窗的实际效果","why":"你在调试这个插件，想亲眼看一次审批弹窗长什么样",' +
  '"touch":"桌面上的一个测试 txt 文件（会新建）","outcome":"桌面多一个 txt 文件，可以随时删掉；换来的是确认弹窗真的能用",' +
  '"parts":[]}',
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

  // v0.7.0：本地规则的结论**明确标成「已判定，不要改」**。
  // 旧版只写「供参考，若冲突请取更保守者」，模型会去重新判断，格式和结论都不稳。
  const rules = input.rules
  if (rules) {
    lines.push('【本地规则已判定（不要改写、不要重新评估）】')
    lines.push(`风险等级=${rules.risk}　建议=${rules.advice}　读还是写=${rules.mode}`)
    const facts = []
    if (rules.paths?.length) facts.push('路径=' + rules.paths.slice(0, 6).join(' | '))
    if (rules.downloads?.length) facts.push('外联地址=' + rules.downloads.slice(0, 4).join(' | '))
    if (rules.touch) facts.push('碰到的对象=' + rules.touch)
    if (facts.length) lines.push(facts.join('　'))
  }

  // 会话上下文：有就给出，没有就明确标注，禁止编造
  const context = input.context
  lines.push('【会话上下文】')
  if (context && context.available === true && context.block) {
    lines.push(context.block)
    lines.push('请**以 AI 自述为主线**推断 title 与 why，用户指令给终点，命令实际行为用来校验三者是否自洽。')
    lines.push('若「AI 说的」与「命令实际在做的」不一致，按第 4 条如实写出落差。不要使用上面没有的信息。')
  } else {
    lines.push('未读取到会话上下文。')
    lines.push('why 必须原样写：「未读取到会话上下文，仅翻译命令本身。」')
  }

  if (rules?.segments && rules.segments.kind !== 'single') {
    lines.push('【命令分段】' + rules.segments.segments.map((s) => `${s.label}=${s.text}`).join(' || '))
    lines.push('这是一条多行/分段脚本：title 写**整体在干什么**，parts 里写每一步「为了什么」。')
  }

  lines.push('【命令原文】')
  lines.push('```')
  lines.push(String(input.command ?? ''))
  lines.push('```')
  lines.push('现在输出 JSON。')
  return lines.join('\n')
}
