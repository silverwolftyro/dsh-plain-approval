/**
 * 模拟一个「DeepSeek 兼容」的 HTTP 服务：用于离线、可重复、不花额度的测试。
 * 支持：
 *   - 正常返回（OpenAI /chat/completions 形状，带 usage 与缓存命中字段）
 *   - 可配置延迟（测「不阻塞」）
 *   - 前 N 次返回 429（测指数退避重试一次）
 *   - 返回非法内容（测「翻译格式异常」）
 *   - 返回空内容（测降级）
 */
import { createServer } from 'node:http'

export function startMockDeepSeek(options = {}) {
  const state = {
    calls: 0,
    mode: options.mode || 'ok', // ok | malformed | empty | always429 | rate-limit-once | delay
    delayMs: options.delayMs || 0,
    rateLimitFirst: options.rateLimitFirst || 0,
    lastBody: null,
    lastHeaders: null,
  }

  const good = JSON.stringify({
    what: '查看当前文件夹里所有文件的详细清单',
    touch: '当前目录下的文件',
    mode: '只读',
    risk: '安全',
    advice: '可以允许',
    consequence: '最多暴露本机文件的名字和大小，不会改动任何文件。',
    benefit: '让你看到文件夹里有哪些文件、多大、什么时候改的。',
    parts: [],
  })

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      state.calls += 1
      state.lastHeaders = req.headers
      try {
        state.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        state.lastBody = null
      }
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs))

      if (state.mode === 'always429' || (state.rateLimitFirst > 0 && state.calls <= state.rateLimitFirst)) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"rate limited"}}')
        return
      }
      if (state.mode === 'empty') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } }))
        return
      }
      if (state.mode === 'malformed') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '这条命令看起来没什么问题吧？' } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }))
        return
      }
      if (state.mode === 'misjudge') {
        // 故意误判：把本机接口说成「联网下载」——本地规则必须把它覆盖掉
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                what: '联网查询服务状态',
                touch: '远程服务器',
                mode: '只读',
                risk: '注意',
                advice: '请先确认',
                consequence: '会联网下载内容并在本机执行或落盘，来源不可信时可能带入恶意程序。',
                benefit: '获取服务状态。',
                parts: [],
              }),
            },
          }],
          usage: { prompt_tokens: 300, completion_tokens: 80, total_tokens: 380 },
        }))
        return
      }
      const content = state.mode === 'pipeline'
        ? JSON.stringify({
          what: '分三段查看日志并筛选关键词',
          touch: '日志文件与筛选结果',
          mode: '只读',
          risk: '安全',
          advice: '可以允许',
          consequence: '只会读取日志内容，不会修改任何文件。',
          benefit: '帮你快速找到日志里的关键词。',
          parts: [
            { label: '第 1 段', text: '读取日志文件' },
            { label: '第 2 段', text: '筛选关键词' },
            { label: '第 3 段', text: '显示前 20 行' },
          ],
        })
        : good
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'mock',
          model: 'deepseek-chat',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 412,
            completion_tokens: 96,
            total_tokens: 508,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 412,
          },
        }),
      )
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
