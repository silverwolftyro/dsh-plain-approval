/**
 * dsh-plain-approval —— 说人话 (Host 半边入口)
 *
 * 「让每一条提权命令，都先说人话。」
 *
 * 被 DSH 加载时会走这里；真正的实现按职责拆在 ./src 下：
 *   plugin.js   接线（审批水位线 + HTTP 路由）
 *   translate.js 编排（规则 → 缓存 → 双通道 → 降级）
 *   engines/    通道 A 本地 Ollama / 通道 B DeepSeek API
 *   rules.js    本地危险关键词与读写判断（不联网）
 *   cache.js    翻译缓存（SQLite，回落 JSON）
 *   cost.js     token → 人民币估算
 *   store.js    用户数据目录下的设置 / 日志 / 当日费用
 *   server.js   客户端调用的 HTTP 接口
 */
export { name, apply, extractCommand } from './src/plugin.js'
export * as internal from './src/internal.js'
