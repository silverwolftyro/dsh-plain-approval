/**
 * 设备能力检测（v0.4 任务二）。
 *
 * 目的：与其让用户「装完 Ollama 一调用就卡死」，不如启动时就把话说清楚。
 *
 * 检测项：GPU 型号 / 显存总量、系统内存总量、当前空闲内存/显存。
 * 三档判定（阈值可在设置页改）：
 *   - 显存 < 6GB 或 内存 < 8GB      → 'unusable'（本地 LLM 不可用）
 *   - 6GB ≤ 显存 < 8GB              → 'marginal'（勉强可用，不推荐）
 *   - 显存 ≥ 8GB 且 内存 ≥ 16GB     → 'good'（本地 LLM 可用）
 *
 * 检测不引入任何依赖：nvidia-smi → wmic → PowerShell CIM，逐级降级；
 * 拿不到就如实报告 gpuDetected=false，不猜。
 * @module dsh-plain-approval/device
 */
import { execFile } from 'node:child_process'
import os from 'node:os'

export const TIERS = {
  good: { level: 3, label: '本地 LLM 可用' },
  marginal: { level: 2, label: '本地 LLM 勉强可用，不推荐' },
  unusable: { level: 1, label: '本地 LLM 不可用' },
  unknown: { level: 0, label: '未检测到具体硬件信息' },
}

const CACHE_MS = 60 * 1000

function run(command, args, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 256 }, (error, stdout) => {
        if (error) resolve(null)
        else resolve(String(stdout ?? ''))
      })
    } catch {
      resolve(null)
    }
  })
}

/** nvidia-smi：最准，直接给显存总量/空闲。PATH 里找不到就走绝对路径兜底。 */
async function probeNvidiaSmi() {
  const args = ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']
  let out = await run('nvidia-smi', args)
  if (!out && process.platform === 'win32') {
    // Electron/服务进程里的 PATH 可能缺少 System32，直接点名
    out = await run('C:\\Windows\\System32\\nvidia-smi.exe', args)
  }
  if (!out) return null
  const first = out.split('\n').map((l) => l.trim()).filter((l) => l !== '')[0]
  if (!first) return null
  const parts = first.split(',').map((s) => s.trim())
  const totalMb = Number(parts[1])
  const freeMb = Number(parts[2])
  if (!Number.isFinite(totalMb) || totalMb <= 0) return null
  return {
    vendor: 'nvidia',
    name: parts[0] || 'NVIDIA GPU',
    vramTotalGB: round1(totalMb / 1024),
    vramFreeGB: Number.isFinite(freeMb) ? round1(freeMb / 1024) : null,
    source: 'nvidia-smi',
  }
}

/** wmic（老 Windows）兜底：只有 AdapterRAM，且 >4GB 会溢出，仅供参考。 */
async function probeWmic() {
  const out = await run('wmic', ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:csv'])
  if (!out) return null
  const rows = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && l.includes(','))
  const parsed = []
  for (const row of rows) {
    const cells = row.split(',').map((s) => s.trim())
    const ram = Number(cells[cells.length - 1])
    const name = cells[cells.length - 2]
    if (!name) continue
    parsed.push({ name, vramTotalGB: Number.isFinite(ram) && ram > 0 ? round1(ram / 1024 ** 3) : null })
  }
  if (parsed.length === 0) return null
  // 取显存最大的那块
  parsed.sort((a, b) => (b.vramTotalGB ?? 0) - (a.vramTotalGB ?? 0))
  return { vendor: 'unknown', name: parsed[0].name, vramTotalGB: parsed[0].vramTotalGB, vramFreeGB: null, source: 'wmic' }
}

/** PowerShell CIM 兜底（拿不到显存就只报型号）。 */
async function probePowerShell() {
  const out = await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_VideoController | Select-Object -First 3 Name,AdapterRAM | ConvertTo-Json -Compress',
  ], 4000)
  if (!out) return null
  let data = null
  try {
    data = JSON.parse(out.trim())
  } catch {
    return null
  }
  const list = Array.isArray(data) ? data : [data]
  const parsed = list
    .filter((x) => x && x.Name)
    .map((x) => ({ name: String(x.Name), vramTotalGB: Number(x.AdapterRAM) > 0 ? round1(Number(x.AdapterRAM) / 1024 ** 3) : null }))
  if (parsed.length === 0) return null
  parsed.sort((a, b) => (b.vramTotalGB ?? 0) - (a.vramTotalGB ?? 0))
  return { vendor: 'unknown', name: parsed[0].name, vramTotalGB: parsed[0].vramTotalGB, vramFreeGB: null, source: 'powershell' }
}

function round1(n) {
  return Math.round(n * 10) / 10
}

/**
 * Windows/Linux 都会给硬件保留一部分内存：装 16GB 的机器 `os.totalmem()` 通常
 * 只有 15.4–15.9GB。比较内存阈值时必须给容差，否则「16GB 内存」永远够不到 16GB
 * 的线 —— v0.4.0 就是栽在这里（RTX 5070 12GB + 16GB 被判成「配置偏低」）。
 */
export const MEM_TOLERANCE_GB = 1

/** 根据显存/内存归档。 */
export function tierOf(vramTotalGB, totalMemGB, thresholds = {}) {
  const unusableVram = Number(thresholds.tierUnusableVramGB ?? 6)
  const unusableMem = Number(thresholds.tierUnusableMemGB ?? 8)
  const goodVram = Number(thresholds.tierGoodVramGB ?? 8)
  const goodMem = Number(thresholds.tierGoodMemGB ?? 16)
  const vram = Number(vramTotalGB) || 0
  const mem = Number(totalMemGB) || 0
  const memOk = (target) => mem + MEM_TOLERANCE_GB >= target

  // 完全没探测到 GPU：不判「不可用」恐吓用户，降级为「未检测到具体硬件信息」
  if (vram <= 0) {
    if (memOk(unusableMem)) return 'unknown'
    return 'unusable'
  }
  if (vram < unusableVram || !memOk(unusableMem)) return 'unusable'
  if (vram >= goodVram && memOk(goodMem)) return 'good'
  return 'marginal'
}

/**
 * 本地通道的风险档位（决定要不要弹警告、要不要强制勾确认）。
 *   'none'  —— 直接可用，不打扰用户
 *   'soft'  —— 提示一句「建议用 API」，但不拦人、不强制勾选
 *   'hard'  —— 确实不达标，必须勾「我明白风险」才能启用
 *
 * 关键规则（v0.4.1 修复）：
 *  1. Ollama 已经在跑且模型存在 → 就是可用，不弹任何风险警告；
 *  2. 硬件信息缺失（unknown）→ 只给 soft 提示，绝不恐吓；
 *  3. 只有真·检测到硬件不达标（unusable）才 hard。
 * @param {{tier?:string}|null} device
 * @param {{status?:string}|null} ollamaStatus
 */
export function localRisk(device, ollamaStatus) {
  if (ollamaStatus && ollamaStatus.status === 'green') return 'none'
  const tier = device?.tier ?? 'unknown'
  if (tier === 'good') return 'none'
  if (tier === 'unusable') return 'hard'
  return 'soft'
}


/**
 * @param {object} [options]
 * @param {object} [options.thresholds]
 * @param {boolean} [options.force] - 忽略缓存
 */
export async function detectDevice({ thresholds = {}, force = false, now = () => Date.now() } = {}) {
  const manualVram = Number(thresholds.manualVramGB) || 0
  const cached = detectDevice._cache
  // 手动填的显存变了要立刻重算，不能被 60 秒缓存挡住
  if (!force && cached && cached.manualVram === manualVram && now() - cached.at < CACHE_MS) return cached.value

  let gpu = null
  for (const probe of [probeNvidiaSmi, probeWmic, probePowerShell]) {
    try {
      gpu = await probe()
    } catch {
      gpu = null
    }
    if (gpu) break
  }
  // 用户手填的显存优先于「读不到」（task 2.3：把决定权交还给用户）
  if (manualVram > 0) {
    gpu = {
      vendor: gpu?.vendor ?? 'manual',
      name: String(thresholds.manualGpuName ?? '') || gpu?.name || '手动填写的 GPU',
      vramTotalGB: round1(manualVram),
      vramFreeGB: gpu?.vramFreeGB ?? null,
      source: 'manual',
    }
  }

  const totalMemGB = round1(os.totalmem() / 1024 ** 3)
  const freeMemGB = round1(os.freemem() / 1024 ** 3)
  const vramTotalGB = gpu?.vramTotalGB ?? 0
  const tier = tierOf(vramTotalGB, totalMemGB, thresholds)

  const value = {
    at: new Date().toISOString(),
    platform: process.platform,
    gpuDetected: Boolean(gpu),
    gpu: gpu
      ? { name: gpu.name, vendor: gpu.vendor, vramTotalGB: gpu.vramTotalGB, vramFreeGB: gpu.vramFreeGB, source: gpu.source }
      : null,
    memory: { totalGB: totalMemGB, freeGB: freeMemGB },
    tier,
    tierLabel: TIERS[tier]?.label ?? tier,
    thresholds: {
      tierUnusableVramGB: Number(thresholds.tierUnusableVramGB ?? 6),
      tierUnusableMemGB: Number(thresholds.tierUnusableMemGB ?? 8),
      tierGoodVramGB: Number(thresholds.tierGoodVramGB ?? 8),
      tierGoodMemGB: Number(thresholds.tierGoodMemGB ?? 16),
    },
    note: gpu
      ? `${gpu.name}（显存 ${vramTotalGB}GB${gpu.source === 'manual' ? '，手动填写' : ''}）· 内存 ${totalMemGB}GB（空闲 ${freeMemGB}GB）`
      : `未检测到具体硬件信息（没读到 GPU 型号/显存）· 内存 ${totalMemGB}GB（空闲 ${freeMemGB}GB）。建议使用 API 翻译；也可以在下面手动填一下显存，插件不会拦你。`,
    manualVramGB: manualVram,
  }
  detectDevice._cache = { at: now(), value, manualVram: manualVram }
  return value
}

/** 当前空闲内存（GB）——每次调用 Ollama 前复查用。 */
export function freeMemoryGB() {
  return round1(os.freemem() / 1024 ** 3)
}

/** 测试用：清掉缓存。 */
export function clearDeviceCache() {
  detectDevice._cache = null
}
