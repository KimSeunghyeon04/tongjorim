import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { passages, qaPort, queries } from './retrieval-fixture.mjs'
import { defaultEmbeddingModel } from '../public/retrieval.mjs'

const log = join(tmpdir(), 'relay-openrouter-qa.ndjson')
writeFileSync(log, '')
console.log(`Mock OpenRouter request log: ${log}`)
const upstream = 'https://openrouter.ai/api/v1'
const qaApiKey = 'relay-qa-key'
const qaManagementKey = 'relay-qa-management-key'
const otherEmbeddingModel = 'qa/another-embedding'
const answerKeys = ['fox', 'elevator', 'sailor']
const models = ['write', 'memory', 'revise', 'plan'].map(name => ({
  id: `qa/${name}`, name: `QA ${name}`, architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  context_length: 8192, top_provider: { context_length: 6144, max_completion_tokens: 4096 },
  reasoning: { supported_efforts: ['high', 'medium', 'low'] },
  pricing: { prompt: '0.000002', completion: '0.000003', request: '0.0001' },
}))

const streamEndings = {
  'qa/filtered': { finish_reason: 'content_filter' },
  'qa/choice-error': { error: { code: 502, message: 'Mock choice failed' } },
  'qa/truncated': { finish_reason: 'length' },
}

const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (typeof url !== 'string' || !url.startsWith(upstream)) return originalFetch(url, options)
  const path = url.slice(upstream.length)
  if (path === '/models') return Response.json({ data: models })
  if (path === '/key') {
    if (options?.headers?.Authorization !== `Bearer ${qaApiKey}`) return Response.json({}, { status: 401 })
    return Response.json({ data: {
      usage: 12.75, usage_daily: 0.42, usage_monthly: 5.75,
      limit: 10, limit_remaining: 4.25, limit_reset: 'monthly',
    } })
  }
  if (path === '/credits') {
    return options?.headers?.Authorization === `Bearer ${qaManagementKey}`
      ? Response.json({ data: { total_credits: 32.5, total_usage: 14.75 } })
      : Response.json({}, { status: 403 })
  }
  if (path === '/embeddings/models') return Response.json({ data: [defaultEmbeddingModel, otherEmbeddingModel, 'qa/failed-embedding']
    .map(id => ({ id, name: id, pricing: { prompt: '0.000001' } })) })
  const body = JSON.parse(options.body)
  appendFileSync(log, JSON.stringify({ path, body }) + '\n')
  if (path === '/embeddings') {
    if (body.model === 'qa/failed-embedding') return Response.json({ error: { message: 'Mock embeddings unavailable' } }, { status: 502 })
    const data = body.input.map((text, index) => {
      const match = queries.find(row => text.startsWith(row.text))
      const key = match?.answer ?? answerKeys.find(candidate => passages[candidate] === text)
      const embedding = [0, 0, 0, 0, 0]
      const axis = match?.kind === 'unrelated' ? embedding.length - 1 : Math.max(0, answerKeys.indexOf(key) + 1)
      embedding[axis] = 1
      return { index, embedding }
    }).reverse()
    return Response.json({ data, usage: { prompt_tokens: 31, total_tokens: 31, cost: 0.000031 } })
  }
  let text = { 'qa/write': '나래는 마지막 표를 접어 두었다.', 'qa/memory': '나래가 마지막 표를 접어 두었다.', 'qa/revise': '나래는 수정된 표를 손에 쥐었다.' }[body.model]
  const ending = Object.hasOwn(streamEndings, body.model) ? streamEndings[body.model] : undefined
  if (ending) text = '나래는 마지막 표를...'
  if (body.model === 'qa/plan') {
    const { card, mode, noteAction, request } = JSON.parse(body.messages.at(-1).content)
    const reply = mode === 'draft' ? '작품 설정을 토대로 초안을 만들었어요.' : `요청을 검토했어요. ${request}`
    const draft = card ? { ...card, name: card.name || '안개역', description: '안개가 내리는 밤에만 열리는 역.' }
      : noteAction === 'replace' ? '나래는 마지막 표의 행선지를 찾아 새벽 기차에 오른다.' : '나래는 마지막 표가 어디로 이어지는지 알아낸다.'
    text = JSON.stringify({ reply, draft: mode === 'draft' ? draft : null })
  }
  if (!text) return Response.json({ error: { message: 'Unexpected model' } }, { status: 400 })
  const events = [
    { model: body.model, choices: [{ delta: { content: text }, ...(ending ? {} : { finish_reason: 'stop' }) }] },
    ...(ending ? [{ model: body.model, choices: [{ delta: { content: '' }, ...ending }] }] : []),
    { model: body.model, choices: [], usage: body.model === 'qa/revise' ? {} :
      { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132, cost: 0.00123 } },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

process.env.OPENROUTER_API_KEY = qaApiKey
if (process.env.OPENROUTER_MANAGE !== qaManagementKey) process.env.OPENROUTER_MANAGE = ''
process.env.PORT ??= qaPort
process.env.TONGJORIM_DB_PATH ??= ':memory:'
await import('../server.mjs')
