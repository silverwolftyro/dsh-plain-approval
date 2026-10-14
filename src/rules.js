/**
 * 本地规则引擎：不联网、不等模型，先把「危险不危险」判断出来。
 *
 * 三条硬规矩：
 *  1. 破坏性关键词命中时，默认「危险 / 建议拒绝」（不依赖模型）。
 *  2. **本地地址不算联网下载**：URL 只指向 127.0.0.1 / localhost / ::1 /
 *     内网段时，判定为「本机服务调用」，后果栏写清楚，并且这一判断**优先于模型**。
 *  3. **清理临时文件不算危险**：删除目标全部落在临时目录且扩展名是
 *     .log/.tmp/.cache/.dmp 时，降为「安全 / 可以允许」；但目标含系统目录则保持危险。
 *
 * 规则给出的「权威结论」（`overrides.force`）会覆盖模型的判断，见 mergeSections。
 * @module dsh-plain-approval/rules
 */
import { oneLine } from './util.js'
import { DEFAULT_BLACKLIST } from './config.js'

/** 破坏性关键词：命中即「危险」。 */
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/iu,
  /\brm\s+-r\b/iu,
  /\brmdir\s+\/s/iu,
  /\brd\s+\/s/iu,
  /\bdel\s+\/[fsq]/iu,
  /\bRemove-Item\b/iu,
  /\bformat\s+[a-z]:/iu,
  /\bdiskpart\b/iu,
  /\bmkfs(\.\w+)?\b/iu,
  /\bdd\s+if=/iu,
  /\breg\s+delete\b/iu,
  /\bbcdedit\b/iu,
  /\bvssadmin\s+delete\b/iu,
  /\bshutdown\s+\//iu,
  /\bcipher\s+\/w/iu,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/u,
]

/** 网络下载 / 外联工具（是否真的「联网」还要看 URL 指向哪里）。 */
const NETWORK = [
  { re: /\bcurl\b/iu, label: 'curl 请求' },
  { re: /\bwget\b/iu, label: 'wget 下载' },
  { re: /\bInvoke-WebRequest\b/iu, label: 'PowerShell 请求(Invoke-WebRequest)' },
  { re: /\biwr\b/iu, label: 'PowerShell 请求(iwr)' },
  { re: /\bInvoke-RestMethod\b/iu, label: 'PowerShell 请求(Invoke-RestMethod)' },
  { re: /\bStart-BitsTransfer\b/iu, label: '后台下载(Start-BitsTransfer)' },
  { re: /\bgit\s+clone\b/iu, label: 'git 克隆远程仓库' },
  { re: /\bnpm\s+(install|i|add)\b/iu, label: 'npm 安装远程包' },
  { re: /\bpip\s+install\b/iu, label: 'pip 安装远程包' },
  { re: /\bscp\b/iu, label: 'scp 远程拷贝' },
  { re: /\brsync\b/iu, label: 'rsync 远程同步' },
  { re: /\bssh\b/iu, label: 'ssh 远程登录' },
  { re: /\bTest-NetConnection\b/iu, label: '网络连通性测试' },
  { re: /\bping\b/iu, label: 'ping 探测' },
]

/** 权限变更。 */
const PERMISSION = [
  { re: /\bchmod\b/iu, label: 'chmod 修改文件权限' },
  { re: /\bchown\b/iu, label: 'chown 修改文件归属' },
  { re: /\bicacls\b/iu, label: 'icacls 修改 Windows 权限' },
  { re: /\btakeown\b/iu, label: 'takeown 夺取文件所有权' },
  { re: /\bSetNamedSecurityInfo\b/iu, label: '修改安全描述符' },
  { re: /\bcacls\b/iu, label: 'cacls 修改 Windows 权限' },
  { re: /\battrib\s+(-r|\/r)/iu, label: 'attrib 修改只读属性' },
]

/** 注册表修改。 */
const REGISTRY = [
  { re: /\breg\s+(add|delete|import|restore)\b/iu, label: '修改注册表(reg)' },
  { re: /\b(New|Set|Remove)-ItemProperty\b[^\n]*HK(LM|CU|CR|U|CC)/iu, label: '修改注册表(PowerShell)' },
  { re: /\bHKEY_(LOCAL_MACHINE|CURRENT_USER)\b/iu, label: '直接操作注册表路径' },
  { re: /\bregedit\b/iu, label: '调用注册表编辑器' },
]

/** 提权。 */
const ELEVATE = [
  { re: /\bsudo\b/iu, label: 'sudo 提权' },
  { re: /\brunas\b/iu, label: 'runas 切换用户' },
  { re: /\bgsudo\b/iu, label: 'gsudo 提权' },
  { re: /-Verb\s+RunAs/iu, label: '以管理员身份启动' },
  { re: /\bStart-Process\b[^\n]*-Verb\s+RunAs/iu, label: '以管理员身份启动' },
]

/** 疑似编码 / 混淆。 */
const ENCODED = [
  { re: /\bbase64\b/iu, label: 'base64 编码内容' },
  { re: /\bFromBase64String\b/iu, label: 'PowerShell Base64 解码' },
  { re: /\bcertutil\b[^\n]*-decode/iu, label: 'certutil 解码' },
  { re: /-enc(odedcommand)?\b/iu, label: 'PowerShell 编码命令' },
  { re: /\\x[0-9a-f]{2}\\x[0-9a-f]{2}/iu, label: '十六进制转义串' },
  { re: /\beval\b/iu, label: 'eval 动态执行' },
  { re: /\bInvoke-Expression\b/iu, label: 'Invoke-Expression 动态执行' },
  { re: /\biex\b/iu, label: 'iex 动态执行' },
]

/** 只读类命令前缀（用于「读还是写」判断）。 */
const READ_ONLY = [
  /^\s*(ls|dir|cat|type|head|tail|less|more|find|grep|rg|fd|pwd|cd|whoami|hostname|date|echo|env|printenv|Get-ChildItem|Get-Content|Get-Item|Get-Location|Get-Process|Get-Service|Test-Path|Test-NetConnection|Select-String|Select-Object|Where-Object|Sort-Object|Measure-Object|Write-Output|Write-Host|Invoke-RestMethod|Invoke-WebRequest|iwr|curl)\b/iu,
]

/** 写入类命令。 */
const WRITE_LIKE = [
  /\b(cp|copy|xcopy|robocopy|mv|move|mkdir|md|new-item|touch|tee|Out-File|Set-Content|Add-Content|New-Item|echo\s+.*>|>)/iu,
  // v0.5.4：extractCommand 给**非 shell 工具**（write/edit/read…）合成的中文前缀。
  // 没有这两条，write 工具的「写入/修改文件：…」两边都不匹配，会被误判成「执行」。
  /^写入\/修改文件[:：]/u,
  /^读写路径[:：]/u,
]

/**
 * v0.5.4：非 shell 工具的操作类型（工具名比合成出来的命令文本更可信）。
 *
 * 只收录「语义明确」的文件类工具；**故意不含 bash / shell / task** ——
 * 那类工具的命令文本本身就是真命令，应该让 READ_ONLY / WRITE_LIKE 去判断。
 */
const TOOL_MODE_DECISIVE = {
  read: '只读',
  glob: '只读',
  grep: '只读',
  search: '只读',
  notebookread: '只读',
  ls: '只读',
  write: '写入',
  edit: '写入',
  multiedit: '写入',
  create: '写入',
  mkdir: '写入',
}

/* ------------------------------------------------------------------ */
/* 地址分类                                                            */
/* ------------------------------------------------------------------ */

/** 本机 / 内网地址判定。 */
export function isLocalHost(hostname) {
  const host = String(hostname ?? '').trim().replace(/^\[|\]$/gu, '').toLowerCase()
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u)
  if (!v4) return false
  const a = Number(v4[1])
  const b = Number(v4[2])
  const nums = [a, Number(v4[3]), Number(v4[4])]
  if ([a, b, ...nums].some((n) => n > 255)) return false
  if (a === 127) return true // 回环
  if (a === 10) return true // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // 链路本地
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

/** https?:// 形式的 URL。 */
const URL_RE = /https?:\/\/[^\s"';|&>)\]]+/giu

/**
 * 把命令里的 URL 分成「本机/内网」与「外部」两类。
 * @returns {{ local: string[], external: string[], hostNames: string[] }}
 */
export function classifyUrls(command) {
  const text = String(command ?? '')
  const local = []
  const external = []
  const hostNames = []
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]
    let hostname = ''
    try {
      hostname = new URL(raw).hostname
    } catch {
      continue
    }
    if (isLocalHost(hostname)) {
      local.push(raw)
      if (!hostNames.includes(hostname)) hostNames.push(hostname)
    } else {
      external.push(raw)
    }
  }
  return { local, external, hostNames }
}

/* ------------------------------------------------------------------ */
/* 路径分类                                                            */
/* ------------------------------------------------------------------ */

/** 临时目录（大小写不敏感）。 */
const TEMP_DIR_RE = /(^|[\\/])(Temp|tmp|Cache|cache)([\\/]|$)/u
const TEMP_DIR_ALT_RE = /AppData[\\/]Local[\\/]Temp/iu
/**
 * 临时文件扩展名。
 *
 * v0.5.10 扩了一截：原来只有 log/tmp/cache/dmp，
 * 于是「删掉临时目录里一张旧截图」（.png）这种明显安全的清理也会报危险。
 * 这条只在**已经确认位于临时目录**之后才生效（isTempTarget 先判目录再判扩展名），
 * 所以放宽的是「临时目录里可以放心删哪些文件」，不是「哪些目录算临时」——
 * 后者一个字没动。
 */
const TEMP_EXT_RE = /\.(log|tmp|cache|dmp|bak|old|png|jpe?g|gif|webp|svg|txt|json|xml|html?|csv|mp4|webm)$/iu

/** 目标是不是「临时日志/缓存文件」。 */
export function isTempTarget(path) {
  const value = String(path ?? '')
  const dirOk = TEMP_DIR_RE.test(value) || TEMP_DIR_ALT_RE.test(value)
  if (!dirOk) return false
  return TEMP_EXT_RE.test(value)
}

/**
 * v0.5.10：解析「删除类动词真正作用的目标」，而不是命令里出现过的所有路径。
 *
 * 真机误报案例（用 Edge headless 截图）：
 *
 *     $png = "$env:TEMP\site-shot\test-old.png"
 *     Remove-Item $png -ErrorAction SilentlyContinue
 *     & 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless --screenshot=...
 *
 * 删除目标只有一个，就是那个临时目录下的旧截图。
 * 但旧逻辑拿**整条命令里所有路径**去判断「有没有系统目录」，
 * 于是 Edge 的可执行文件路径把判定带偏了 → 明明是清临时截图，报成「永久删除文件」。
 *
 * 这里的做法：找到 Remove-Item / del / rm / rd / rmdir 后面**紧跟的参数**，
 * 再顺着脚本里的 `$var = ...` 赋值把它解析回真实值。
 *
 * ⚠️ 安全取舍：解析不出来时（动态路径、跨脚本变量等）**返回 resolved:false**，
 *    调用方继续沿用「所有路径」的保守判定 —— 宁可多报一次危险，不能漏掉一次真删除。
 */
const DELETE_VERB_RE = /\b(?:Remove-Item|remove-item|del|erase|rm|rmdir|rd)\b(?![-\w])/giu
const ASSIGN_RE = /(?:^|[\n;])\s*\$(\w+)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;]+))/gu
/** 不带值的布尔开关（-Force / -Recurse / -WhatIf …）。 */
const DELETE_BOOL_FLAG_RE = /^-(?:r|rf|fr|force|recurse|whatif|confirm|con|sc|s|silentlycontinue|silent)$/iu
/** 带值但**值不是目标**的开关（-ErrorAction Stop …），连值一起跳过。 */
const DELETE_SKIP_VALUE_FLAG_RE = /^-(?:ea|erroraction|filter|include|exclude)$/iu
/** 带值且**值就是目标**的开关（-Path a,b / -LiteralPath $x）。 */
const DELETE_PATH_FLAG_RE = /^-(?:path|literalpath)$/iu

/** 展开 $env:TEMP / %TEMP% 之类。解析不了就原样保留。 */
function expandEnvVars(value) {
  return String(value ?? '').replace(
    /\$env:([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/gu,
    (m, a, b) => {
      const v = process.env?.[a || b]
      return typeof v === 'string' && v !== '' ? v : m
    },
  )
}

/**
 * @returns {{ targets: string[], unresolved: number, resolved: boolean }}
 *   targets   —— 解析后的删除目标（能解析多少算多少）
 *   unresolved —— 没能解析的变量个数
 *   resolved  —— 是否**全部**解析成功；false 时调用方应退回保守判定
 */
export function extractDeleteTargets(command) {
  const text = String(command ?? '')
  if (text === '') return { targets: [], unresolved: 0, resolved: false }

  // 1) 脚本内的简单赋值：$name = 'x' / $name = "x" / $name = x
  const vars = new Map()
  for (const m of text.matchAll(ASSIGN_RE)) {
    vars.set(String(m[1]).toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '')
  }

  // 2) 删除动词后面**同一条语句**里的参数 —— 遇到换行 / 分号 / 管道就停。
  //    （早先的版本一口吃 240 字符，会跨行把下一条命令的 Edge 路径也当成删除目标。）
  const rawTargets = []
  for (const vm of text.matchAll(DELETE_VERB_RE)) {
    const start = vm.index + String(vm[0]).length
    const window = text.slice(start, start + 300)
    const stop = window.search(/[\n;|]/u)
    const tail = stop >= 0 ? window.slice(0, stop) : window

    const tokens = tail.match(/"[^"]*"|'[^']*'|\$\{[^}]+\}|\$\w+|[^\s]+/gu) ?? []
    const unquote = (s) => String(s).replace(/^["']|["']$/gu, '')
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = String(tokens[i])
      // 顺序要紧：
      //   · 路径类开关（-Path / -LiteralPath）的值**就是目标**，要收下来，
      //     而且可能是逗号分隔的多个：`-LiteralPath $out,$err`；
      //   · 选项类开关（-ErrorAction / -EA）的值不是目标，连值一起跳过 ——
      //     不跳过的话 `SilentlyContinue` 会被当成删除目标（v0.5.10 修过一次的坑）；
      //   · 布尔开关（-Force / -Recurse）没有值。
      if (DELETE_PATH_FLAG_RE.test(tok)) {
        const next = tokens[i + 1]
        if (next === undefined) break
        i += 1
        for (const part of unquote(next).split(',')) {
          const p = part.trim()
          if (p !== '') rawTargets.push(p)
        }
        continue
      }
      if (DELETE_SKIP_VALUE_FLAG_RE.test(tok)) { i += 1; continue }
      if (DELETE_BOOL_FLAG_RE.test(tok)) continue
      if (tok.startsWith('-')) continue
      // 同样按逗号拆：token 正则会把 `$out,$err` 切成 `$out` 和 `,$err` 两个 token，
      // 后者带着前导逗号，不拆就会被当成一个奇怪的「目标」。
      for (const part of unquote(tok).split(',')) {
        const p = part.trim()
        if (p !== '') rawTargets.push(p)
      }
      if (rawTargets.length >= 16) break
    }
    if (rawTargets.length >= 16) break
  }
  if (rawTargets.length === 0) return { targets: [], unresolved: 0, resolved: false }

  // 3) 顺着赋值把变量解析回真实值。
  //    注意变量只占标识符那一段：`$out\test-old.png` 里的变量是 `out`，
  //    后面的 `\test-old.png` 是路径后缀，必须原样接回去。
  const targets = []
  let unresolved = 0
  for (const t of rawTargets) {
    let value = t
    let hops = 0
    while (hops < 6) {
      if (/^\$env:/iu.test(value)) {
        value = expandEnvVars(value)
        break
      }
      const m = /^\$\{?(\w+)\}?(.*)$/u.exec(value)
      if (!m) break
      const assigned = vars.get(String(m[1]).toLowerCase())
      if (assigned === undefined) break
      value = String(assigned) + String(m[2] ?? '')
      hops += 1
    }
    value = expandEnvVars(value)
    if (/^\$/.test(value)) {
      unresolved += 1
      continue
    }
    targets.push(value)
  }
  return { targets, unresolved, resolved: unresolved === 0 && targets.length > 0 }
}

/** 目标是不是「系统目录/程序目录」。 */
export function isSystemTarget(path) {
  const value = String(path ?? '').trim().replace(/^["']|["']$/gu, '')
  if (value === '') return false
  if (/^[A-Za-z]:[\\/]?$/u.test(value)) return true // 盘根
  if (/^[A-Za-z]:[\\/](Windows|Program Files( \(x86\))?|ProgramData|System32)([\\/]|$)/iu.test(value)) return true
  if (/^[\\/]+Windows([\\/]|$)/iu.test(value)) return true
  if (/^\/(etc|usr|bin|sbin|lib|lib64|boot|System|Library|var\/lib|var\/log)(\/|$)/u.test(value)) return true
  if (value === '/' || value === 'C:\\' || value === 'C:/') return true
  return false
}

/** 从命令里粗略提取路径（排除 URL）。 */
export function extractPaths(command) {
  const text = String(command ?? '')
  const found = new Set()
  for (const m of text.matchAll(/[A-Za-z]:\\[^\s"';|&>)\]]*/gu)) found.add(m[0])
  for (const m of text.matchAll(/\\\\[^\s"';|&>)\]]+/gu)) found.add(m[0])
  for (const m of text.matchAll(/(?:^|[\s"'=])(\/[A-Za-z0-9_.\-/]+)/gu)) found.add(m[1])
  for (const m of text.matchAll(/(?:^|[\s"'=])(\.{1,2}\/[A-Za-z0-9_.\-/*]+)/gu)) found.add(m[1])
  // 没有盘符的 Windows 路径（含 $env:VAR\... 形式），例如
  // "$env:LOCALAPPDATA\MyApp\Cache\a.tmp"
  for (const m of text.matchAll(/(?:^|[\s"'=(,])([^"'\s|&>]*[\\/][^"'\s|&>]+)/gu)) found.add(m[1])
  return [...found]
    .map((p) => p.replace(/^["']|["']$/gu, ''))
    .filter((p) => p.length > 1 && !/^https?:\/\//iu.test(p) && p !== '//')
    .slice(0, 20)
}

/** 从命令里提取「外部」下载来源（本地地址不算）。 */
export function extractDownloads(command) {
  const text = String(command ?? '')
  const { external } = classifyUrls(text)
  const out = [...external]
  const clone = text.match(/\bgit\s+clone\s+(\S+)/iu)
  if (clone && !/^https?:\/\//iu.test(clone[1])) out.push(clone[1])
  const npm = text.match(/\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\s+([^\s&|;]+)/iu)
  if (npm) out.push('npm 包 ' + npm[1])
  const pip = text.match(/\bpip(?:3)?\s+install\s+([^\s&|;]+)/iu)
  if (pip) out.push('pip 包 ' + pip[1])
  return [...new Set(out)].slice(0, 6)
}

/** 简单的命令分段：管道链按 | 拆，多行脚本按行拆。 */
export function splitSegments(command) {
  const text = String(command ?? '').replace(/\r\n/gu, '\n')
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (lines.length > 1) {
    return { kind: 'lines', segments: lines.map((line, i) => ({ label: `第 ${i + 1} 行`, text: line })) }
  }
  const single = lines[0] ?? ''
  const parts = splitPipeline(single)
  if (parts.length > 1) {
    return { kind: 'pipeline', segments: parts.map((part, i) => ({ label: `第 ${i + 1} 段`, text: part })) }
  }
  return { kind: 'single', segments: [{ label: '命令', text: single }] }
}

/** 按未加引号的 | 拆分段。 */
function splitPipeline(text) {
  const parts = []
  let buf = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '|') {
      parts.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  parts.push(buf.trim())
  return parts.filter((p) => p !== '')
}

/** 空命令 / 纯空白。 */
export function isEmptyCommand(command) {
  return String(command ?? '').trim() === ''
}

function hits(patterns, text) {
  const out = []
  for (const p of patterns) {
    if (p instanceof RegExp) {
      if (p.test(text)) out.push(String(p))
    } else if (p.re.test(text)) {
      out.push(p.label)
    }
  }
  return out
}

/**
 * 剥掉字符串字面量与注释里的内容（保留长度，便于定位），只留下「真正会被执行的命令」。
 *
 * v0.5.9 修：网络关键词（curl / wget / 联网下载…）是**日常词汇**，
 * 经常出现在展示文案里。真实误报案例：
 *
 *     Write-Host "=== curl processes alive? ==="      ← 这是在打印状态
 *     Get-CimInstance Win32_Process | ? Name -like '*curl*'   ← 这是在查下载进程
 *
 * 整段命令其实全是本地操作（复制 D:\Comfy-Desktop 下的目录做备份），
 * 却因为 echo 文案里出现了 "curl" 被判成「会联网下载并可能带入恶意程序」。
 * **把本地备份说成联网下载，会直接把用户吓退** —— 这是误报里危害最大的一类。
 *
 * 只用于 NETWORK（网络类）判定：
 *   · 网络词的误报毫无安全价值，只会制造恐慌；
 *   · 删除/权限/注册表类的关键词误报**故意保留** —— 宁可多warn一次，
 *     也不能漏掉一次真正的删除。在安全类别上「宁可误报」是刻意的取舍。
 */
function stripLiterals(text) {
  return String(text)
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''")
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/#[^\n]*/gu, ' ')
}

/**
 * 分析一条命令的规则面。
 * @param {string} command
 * @param {{ blacklist?: string[], toolName?: string }} [options]
 */
export function analyzeCommand(command, options = {}) {
  const text = String(command ?? '')
  const blacklist = Array.isArray(options.blacklist) ? options.blacklist : []
  const custom = blacklist
    .map((k) => String(k).trim())
    .filter((k) => k !== '')
    .map((k) => ({ re: new RegExp(escapeRegExp(k), 'iu'), label: `自定义黑名单：${k}` }))

  const destructive = hits(DESTRUCTIVE, text).map(() => '破坏性删除/格式化命令')
  const customHits = hits(custom, text)
  // v0.5.9：网络词只在「真正会被执行的命令」里找 —— 见 stripLiterals 的说明。
  // URL 仍然从原文提取（classifyUrls 用的就是完整 text），所以引号里的地址照样算数。
  const execText = stripLiterals(text)
  const networkTools = hits(NETWORK, execText)
  const permission = hits(PERMISSION, text)
  const registry = hits(REGISTRY, text)
  const elevate = hits(ELEVATE, text)
  const encoded = hits(ENCODED, text)
  const urls = classifyUrls(text)
  const paths = extractPaths(text)
  const downloads = extractDownloads(text)
  const segments = splitSegments(text)

  // ---- 本地接口 vs 外网 -------------------------------------------------
  const localOnly = urls.local.length > 0 && urls.external.length === 0
  const hasExternalNetwork = urls.external.length > 0 || (networkTools.length > 0 && !localOnly)
  const network = localOnly ? [] : networkTools

  // ---- 删除目标分类 -----------------------------------------------------
  // v0.5.10：优先只看「删除动词真正作用的目标」，而不是命令里出现过的所有路径。
  // 解析不出来就退回旧的保守做法（宁可多报一次危险，也不漏掉一次真删除）。
  const del = extractDeleteTargets(text)
  const scopePaths = del.resolved ? del.targets : paths
  const tempTargets = scopePaths.filter((p) => isTempTarget(p))
  const systemTargets = scopePaths.filter((p) => isSystemTarget(p))
  const allTargetsTemp = scopePaths.length > 0 && tempTargets.length === scopePaths.length && systemTargets.length === 0
  const tempCleanup = destructive.length > 0 && allTargetsTemp
  const systemDelete = destructive.length > 0 && systemTargets.length > 0

  const danger = [...destructive, ...customHits]

  // ---- 风险等级（先只按「非本地接口」的因素算）--------------------------
  let risk = '安全'
  let advice = '可以允许'
  let consequence = '这条命令没有明显的破坏性动作，一般不会造成不可恢复的损失。'
  if (danger.length > 0) {
    risk = '危险'
    advice = '建议拒绝'
    consequence = '可能永久删除文件，无法恢复。'
  } else if (encoded.length > 0) {
    risk = '危险'
    advice = '建议拒绝'
    consequence = '命令内容被编码/混淆，无法可靠判断它真正要做什么，可能隐藏危险操作。'
  } else if (hasExternalNetwork || permission.length > 0 || registry.length > 0 || elevate.length > 0) {
    risk = '注意'
    advice = '请先确认'
    if (hasExternalNetwork) consequence = '会联网下载内容并在本机执行或落盘，来源不可信时可能带入恶意程序。'
    else if (registry.length > 0) consequence = '会修改系统注册表，可能导致某些程序或系统功能异常。'
    else if (permission.length > 0) consequence = '会修改文件权限或归属，可能让别的程序获得或失去访问权。'
    else consequence = '会要求管理员权限执行，影响范围可能超出当前工作目录。'
  }

  // ---- 权威覆盖（本地规则说了算，模型不能推翻）--------------------------
  const overrides = { force: false }
  const notes = []

  if (blacklist.length > 0 && customHits.length > 0) {
    overrides.force = true
    overrides.risk = '危险'
    overrides.advice = '建议拒绝'
    overrides.consequence = '命中了你自己设置的黑名单关键词，可能造成不可恢复的损失。'
    risk = overrides.risk
    advice = overrides.advice
    consequence = overrides.consequence
  }

  if (systemDelete) {
    overrides.force = true
    overrides.risk = '危险'
    overrides.advice = '建议拒绝'
    overrides.consequence = '删除目标包含系统目录或程序目录，可能永久删除系统文件，无法恢复。'
    risk = overrides.risk
    advice = overrides.advice
    consequence = overrides.consequence
    notes.push('删除目标命中系统目录：' + systemTargets.slice(0, 3).join('、'))
  } else if (tempCleanup) {
    overrides.force = true
    overrides.risk = '安全'
    overrides.advice = '可以允许'
    overrides.consequence = '删除的是临时日志/缓存文件，不影响项目数据和系统安全。'
    risk = overrides.risk
    advice = overrides.advice
    consequence = overrides.consequence
    notes.push('目标全部是临时文件（' + tempTargets.slice(0, 3).join('、') + '），按「清理临时日志」白名单放行')
  } else if (destructive.length > 0 && tempTargets.length > 0 && systemTargets.length === 0) {
    // v0.6.0 修既有漏报（D4b）：这里原本只降到「注意」。
    // 但只要**有任何一��删除目标不是临时的**，就是在删用户数据 —— 不可逆。
    // 「顺带清了临时文件」不构成降低风险等级的理由。
    const nonTemp = scopePaths.filter((p) => !isTempTarget(p))
    if (nonTemp.length > 0) {
      overrides.force = true
      overrides.risk = '危险'
      overrides.advice = '建议拒绝'
      overrides.consequence = '除了临时文件，这条命令还要删除不可恢复的文件（' + nonTemp.slice(0, 3).join('、') + '）。'
      risk = '危险'
      advice = '建议拒绝'
      consequence = overrides.consequence
      notes.push('删除目标里混有非临时文件（' + nonTemp.slice(0, 3).join('、') + '），按危险处理')
    } else {
      // 全是临时目标但没能降级（例如路径没解析出来）：保守给「注意」
      overrides.force = false
      risk = '注意'
      advice = '请先确认'
      consequence = '包含临时文件的清理，但也涉及其它路径，请展开原始命令确认后再决定。'
    }
  }

  // 需求：本地接口不能被判成「联网下载」，且这一判断优先于模型
  if (localOnly && !systemDelete && !tempCleanup) {
    const host = urls.hostNames[0] ?? '127.0.0.1'
    const localConsequence = `检测到本地接口调用（${host}），属于本机服务探测，不涉及外网下载。`
    if (danger.length === 0 && encoded.length === 0) {
      overrides.force = true
      // 本地调用本身不升风险；如果因为权限/注册表/提权已经是「注意」，保持「注意」
      if (risk === '安全') {
        overrides.risk = '安全'
        overrides.advice = '可以允许'
      } else {
        overrides.risk = risk
        overrides.advice = advice
      }
      overrides.consequence = localConsequence
      consequence = localConsequence
      notes.push('访问的是本机/内网地址：' + urls.local.slice(0, 3).join('、') + '，不算联网下载')
    }
  }

  // ---- 读/写/执行 -------------------------------------------------------
  let mode = '执行'
  // v0.5.4：非 shell 工具以**工具名**为准（命令文本是 extractCommand 合成出来的，
  // 不是用户真正敲的东西）；shell 类工具不在表里，继续由文本正则判断。
  const toolKey = String(options.toolName ?? '').trim().toLowerCase()
  const toolMode = Object.prototype.hasOwnProperty.call(TOOL_MODE_DECISIVE, toolKey) ? TOOL_MODE_DECISIVE[toolKey] : null
  if (destructive.length > 0) mode = '删除'
  else if (segments.kind !== 'single') mode = '混合'
  else if (toolMode) mode = toolMode
  else if (READ_ONLY.some((re) => re.test(text))) mode = '只读'
  else if (WRITE_LIKE.some((re) => re.test(text))) mode = '写入'

  // ---- 碰什么 -----------------------------------------------------------
  const touchParts = []
  if (paths.length > 0) touchParts.push(paths.slice(0, 4).join('、') + (paths.length > 4 ? ` 等 ${paths.length} 处` : ''))
  if (downloads.length > 0) touchParts.push('下载来源：' + downloads.join('、'))
  if (localOnly) touchParts.push('本机服务：' + urls.local.slice(0, 3).join('、'))
  if (touchParts.length === 0) touchParts.push('暂未能自动识别具体路径，请看下方原始命令。')

  // ---- 收益 -------------------------------------------------------------
  let benefit = '帮你完成你刚才交给它的这项操作。'
  if (tempCleanup) benefit = '清理掉临时日志，避免临时目录越堆越大。'
  else if (localOnly) benefit = '读取本机服务的状态或数据，不会联网、不会改动外部内容。'
  else if (mode === '只读') benefit = '让你看到当前目录或文件的内容，不会改动任何东西。'
  else if (hasExternalNetwork) benefit = '联网获取需要的文件或数据，省去手动下载。'
  else if (permission.length > 0) benefit = '调整文件权限，解决「没有权限访问」这类问题。'
  else if (mode === '删除') benefit = '清理掉你指定的文件或目录（如果不确定，建议先拒绝）。'

  // ---- 备注 -------------------------------------------------------------
  if (hasExternalNetwork) notes.push('检测到网络下载：' + network.join('、') + (downloads.length ? '，来源 ' + downloads.join('、') : ''))
  if (permission.length > 0) notes.push('修改文件权限，注意——' + permission.join('、'))
  if (registry.length > 0) notes.push('修改注册表，注意——' + registry.join('、'))
  if (elevate.length > 0) notes.push('要求管理员权限——' + elevate.join('、'))
  if (encoded.length > 0) notes.push('检测到疑似编码内容（' + encoded.join('、') + '），无法可靠解释，建议拒绝')
  if (danger.length > 0 && !tempCleanup) notes.push('命中危险关键词：' + danger.join('、'))
  if (destructive.length > 0 && paths.length === 0) notes.push('无法从命令里识别删除目标（可能是变量），请展开原始命令确认。')

  return {
    risk,
    advice,
    mode,
    consequence,
    benefit,
    notes,
    overrides,
    danger,
    network,
    networkTools,
    permission,
    registry,
    elevate,
    encoded,
    paths,
    downloads,
    localUrls: urls.local,
    externalUrls: urls.external,
    localOnly,
    hasExternalNetwork,
    tempCleanup,
    systemDelete,
    segments,
    touch: touchParts.join('；'),
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 供设置页展示的「内置黑名单」。 */
export function builtinBlacklist() {
  return [...DEFAULT_BLACKLIST]
}

/** 把规则结果压成一句「干什么」的兜底（模型不可用时使用）。 */
export function ruleSummary(command, rules, toolName) {
  const tool = toolZh(toolName)
  const head = oneLine(String(command ?? '').split('\n')[0], 60)
  if (rules.tempCleanup) return `清理临时日志/缓存文件（${tool}）`
  if (rules.localOnly) return `调用本机服务查询状态（${tool}）`
  if (rules.mode === '删除') return `删除文件或目录（${tool}）`
  if (rules.mode === '只读') return `查看内容，不改动任何文件（${tool}）`
  if (rules.mode === '写入') return `写入或修改文件（${tool}）`
  if (rules.mode === '混合') return `分多步执行一段脚本（${tool}）`
  return head ? `执行一条命令：${head}` : `执行${tool}`
}

/** 工具名 → 人话。 */
export function toolZh(toolName) {
  const map = {
    pwsh: 'PowerShell 命令',
    bash: '命令行命令',
    write: '写文件',
    edit: '改文件',
    read: '读文件',
    read_image: '读图片',
    glob: '查找文件',
    grep: '搜索内容',
    web_fetch: '抓网页',
    web_search: '联网搜索',
    terminal_open: '打开终端',
    terminal_read: '读终端输出',
    subagent: '子代理',
    workflow: '工作流',
  }
  const key = String(toolName ?? '').trim()
  return map[key] || key || '工具'
}
