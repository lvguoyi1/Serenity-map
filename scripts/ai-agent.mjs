// Server-side AI reasoning for Serenity. Never expose the API key to the browser.
const SYSTEM = `你是 Serenity 知识画布协作 Agent。你将收到用户请求及完整结构化画布（节点、边、选中节点）。
只输出 JSON 对象，格式为 {"explanation":"简短解释推理依据","patch":{"version":1,"intent":"意图","operations":[...]}}。
允许的操作：addNode(id,title,summary,body,tags,status,x,y,connectFromId,edgeKind,edgeLabel), updateNode(id,title,summary,body,tags,status), connectNodes(fromId,toId,kind,label), disconnectNodes(id 或 fromId/toId), moveNode(id,x,y), deleteNode(id)。
关系 kind 仅允许 extends,contains,causes,contrasts,questions,supports,blocks,related；status 仅允许 seed,exploring,verified,question,archived。
如输入包含 otherPages，可以参考其他页面内容，所有 Patch 操作只针对当前页 nodes 和 edges。关系只能在同一页内创建。已有节点必须使用输入中的准确 id。新节点 id 使用 node-ai- 开头的唯一字符串。优先提出非破坏性增量修改，默认不删除已有节点。发现跨主题关联时说明推理依据，不要捏造事实。无必要操作时 operations 为空数组。不要输出 Markdown 代码围栏。`

function send(response, code, payload) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(payload))
}
function parseOutput(text) {
  const cleaned = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')
  return JSON.parse(cleaned)
}
export const defaultAiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
}

function environmentConfig() {
  return {
    baseUrl: process.env.SERENITY_AI_BASE_URL || defaultAiConfig.baseUrl,
    model: process.env.SERENITY_AI_MODEL || defaultAiConfig.model,
    apiKey: process.env.SERENITY_AI_API_KEY,
  }
}

export async function handleAiRequest(request, response, readJsonBody, getConfig = environmentConfig) {
  const { apiKey: key, baseUrl, model } = await getConfig()
  if (!key) return send(response, 503, { ok: false, error: '请先配置 AI API Key。' })
  let input
  try { input = await readJsonBody(request) } catch { return send(response, 400, { ok: false, error: '请求 JSON 无效。' }) }
  if (typeof input?.prompt !== 'string' || !input.prompt.trim() || !input.context || !Array.isArray(input.context.nodes) || !Array.isArray(input.context.edges)) {
    return send(response, 400, { ok: false, error: '需要 prompt 与完整画布 context。' })
  }
  const otherPages = input.context.otherPages ?? []
  if (!Array.isArray(otherPages) || otherPages.some((page) => !Array.isArray(page?.nodes) || !Array.isArray(page?.edges))) {
    return send(response, 400, { ok: false, error: '画布页面格式无效。' })
  }
  const nodeCount = otherPages.reduce((total, page) => total + page.nodes.length, input.context.nodes.length)
  const edgeCount = otherPages.reduce((total, page) => total + page.edges.length, input.context.edges.length)
  if (input.prompt.length > 8000 || nodeCount > 1000 || edgeCount > 3000) {
    return send(response, 413, { ok: false, error: '输入过大，请缩小画布范围。' })
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)
  try {
    const upstream = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.3,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ prompt: input.prompt, context: input.context }) }],
        response_format: { type: 'json_object' },
      }),
    })
    if (!upstream.ok) return send(response, 502, { ok: false, error: '模型服务请求失败（HTTP ' + upstream.status + '）。' })
    const data = await upstream.json()
    const output = parseOutput(data.choices?.[0]?.message?.content || '')
    if (!output.patch || output.patch.version !== 1 || !Array.isArray(output.patch.operations)) {
      return send(response, 502, { ok: false, error: '模型未返回有效 Patch。' })
    }
    if (output.patch.operations.length > 40) return send(response, 422, { ok: false, error: 'AI 单次修改超过 40 项。' })
    return send(response, 200, { ok: true, explanation: String(output.explanation || ''), patch: output.patch })
  } catch (error) {
    return send(response, 502, { ok: false, error: error?.name === 'AbortError' ? '模型响应超时。' : '模型响应解析失败或网络异常。' })
  } finally {
    clearTimeout(timeout)
  }
}
