import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { passages, qaPort, queries } from './retrieval-fixture.mjs'
import { defaultEmbeddingModel } from '../public/retrieval.mjs'

const log = join(tmpdir(), 'relay-openrouter-qa.ndjson')
writeFileSync(log, '')
console.log(`Mock OpenRouter request log: ${log}`)
const upstream = 'https://openrouter.ai/api/v1'
const otherEmbeddingModel = 'qa/another-embedding'
const answerKeys = ['fox', 'elevator', 'sailor']
const models = ['write', 'memory', 'revise'].map(name => ({
  id: `qa/${name}`, name: `QA ${name}`, architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  context_length: 8192, top_provider: { context_length: 6144, max_completion_tokens: 4096 },
  pricing: { prompt: '0.000002', completion: '0.000003', request: '0.0001' },
}))

const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (typeof url !== 'string' || !url.startsWith(upstream)) return originalFetch(url, options)
  const path = url.slice(upstream.length)
  if (path === '/models') return Response.json({ data: models })
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
  const text = { 'qa/write': '나래는 마지막 표를 접어 두었다.', 'qa/memory': '나래가 마지막 표를 접어 두었다.', 'qa/revise': '나래는 수정된 표를 손에 쥐었다.' }[body.model]
  if (!text) return Response.json({ error: { message: 'Unexpected model' } }, { status: 400 })
  const events = [
    { model: body.model, choices: [{ delta: { content: text }, finish_reason: 'stop' }] },
    { model: body.model, choices: [], usage: body.model === 'qa/revise' ? {} :
      { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132, cost: 0.00123 } },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

process.env.OPENROUTER_API_KEY = 'relay-qa-key'
process.env.PORT ??= qaPort
await import('../server.mjs')
