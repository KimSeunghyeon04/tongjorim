import assert from 'node:assert/strict'
import { cosine, defaultEmbeddingModel, embeddingBatchSize, retrievalInput, searchPast } from '../public/retrieval.mjs'
import { manuscript, passages, qaPort, queries } from './retrieval-fixture.mjs'

const origin = 'http://127.0.0.1:' + (process.argv[2] ?? process.env.PORT ?? qaPort)
async function api(path, body) {
  const res = await fetch(origin + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {})
  const data = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${data.error}`)
  return data
}

const model = defaultEmbeddingModel
const { models } = await api('/api/embeddings/models')
assert(models.some(item => item.id === model), `${model} missing`)
const { chunks } = retrievalInput(manuscript, '', true)
const unique = [...new Set(chunks.map(chunk => chunk.text))]
const vectorsByText = new Map()
for (let start = 0; start < unique.length; start += embeddingBatchSize) {
  const input = unique.slice(start, start + embeddingBatchSize)
  const { vectors } = await api('/api/embeddings', { model, kind: 'document', input })
  input.forEach((value, index) => vectorsByText.set(value, vectors[index]))
}
const vectors = chunks.map(chunk => vectorsByText.get(chunk.text))
function id(chunk) {
  return Object.keys(passages).find(key => passages[key] === chunk.text) ?? 'filler'
}
const results = []
for (const row of queries) {
  const { query, intent } = retrievalInput(manuscript, row.text, true)
  const { vectors: [queryVector] } = await api('/api/embeddings', { model, kind: 'query', input: [query] })
  const withEmbedding = searchPast(chunks, query, { query: queryVector, vectors }, intent).map(id)
  const keyword = searchPast(chunks, query, null, intent).map(id)
  const inverted = searchPast(chunks, query, { query: queryVector.map(value => -value), vectors }, intent).map(id)
  const top = [...new Map(chunks.map((chunk, i) => [id(chunk), cosine(queryVector, vectors[i])]))]
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, score]) => [label, +score.toFixed(3)])
  console.log(JSON.stringify({ ...row, withEmbedding, keyword, inverted, top }))
  results.push({ ...row, withEmbedding, keyword, inverted })
}
for (const row of results.filter(row => row.kind === 'exact')) {
  assert(row.keyword.includes(row.answer), `keyword missed ${row.answer}`)
  assert(row.withEmbedding.includes(row.answer), `hybrid missed ${row.answer}`)
}
assert(results.filter(row => row.kind === 'semantic' && row.withEmbedding.includes(row.answer)).length >= 2)
assert(results.filter(row => row.kind === 'semantic' && row.keyword.includes(row.answer)).length < 2)
assert(results.filter(row => row.kind === 'semantic' && row.inverted.includes(row.answer)).length < 2)
for (const row of results.filter(row => row.kind === 'unrelated')) {
  assert.equal(row.keyword.length, 0)
  assert.equal(row.withEmbedding.length, 0)
}
