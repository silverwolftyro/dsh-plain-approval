/**
 * v0.4.5：把测试里已删除功能（内嵌按钮 / 拖动）的用例整段替换为
 * 「卡死根因回归 + 完整渲染生命周期 + 无事件监听器泄漏 + 渲染兜底」。
 *
 * 用法: node splice-tests.mjs <run-tests.mjs> <newtests.txt>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = process.argv[2]
const NEW_FILE = process.argv[3]
if (!FILE || !NEW_FILE) throw new Error('用法: node splice-tests.mjs <run-tests.mjs> <newtests.txt>')

const src = readFileSync(FILE, 'utf8')
const NEW = readFileSync(NEW_FILE, 'utf8')

const START = src.indexOf("group('附加（v0.4.2）：原生卡片内嵌")
const END = src.indexOf("group('附加（v0.4.2）：鲸鱼娘头像资源")
if (START < 0) throw new Error('找不到起点锚点')
if (END < 0) throw new Error('找不到终点锚点')
if (END <= START) throw new Error('锚点顺序不对')

// 起点前面那段「/* ==== */ 标题注释」也一并替换掉
let cut = START
const sep = src.lastIndexOf('/* ================================================================== */', START)
if (sep >= 0 && START - sep < 400) cut = sep

const out = src.slice(0, cut) + NEW + src.slice(END)
writeFileSync(FILE, out, 'utf8')
console.log('测试文件已替换，字节', src.length, '→', out.length)
