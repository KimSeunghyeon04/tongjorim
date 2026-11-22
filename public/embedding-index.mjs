import { combineUsage, estimateUsage, jsonRequest } from './request-tools.mjs'
import { embeddingBatchSize } from './retrieval.mjs'

let database
const corpusHashes = new WeakMap()

function openIndex() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('relay.writing.embeddings', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('vectors', { keyPath: ['projectId', 'model', 'hash'] })
      store.createIndex('projectId', 'projectId')
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        database = undefined
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  }).catch(error => {
    database = undefined
    throw error
  })
  return database
}

async function hashText(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function hashesFor(corpus) {
  if (!corpusHashes.has(corpus)) {
    const texts = [...new Set(corpus.map(chunk => chunk.text))]
    const pending = Promise.all(texts.map(async text => [text, await hashText(text)]))
      .then(entries => new Map(entries))
      .catch(error => {
        corpusHashes.delete(corpus)
        throw error
      })
    corpusHashes.set(corpus, pending)
  }
  return corpusHashes.get(corpus)
}

function recordsFor(db, projectId) {
  return new Promise((resolve, reject) => {
    const request = db.transaction('vectors').objectStore('vectors').index('projectId').getAll(projectId)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function writeIndex(db, signal, { additions = [], removals = [] }) {
  signal.throwIfAborted()
  if (!additions.length && !removals.length) return
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('vectors', 'readwrite')
    const abort = () => transaction.abort()
    const store = transaction.objectStore('vectors')
    signal.addEventListener('abort', abort, { once: true })
    transaction.oncomplete = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    transaction.onabort = () => {
      signal.removeEventListener('abort', abort)
      reject(transaction.error ?? signal.reason ?? new Error('검색 색인을 저장할 수 없어요.'))
    }
    for (const { projectId, model, hash } of removals) store.delete([projectId, model, hash])
    for (const record of additions) store.put(record)
  })
}

export async function embedPast(projectId, { model: modelId, modelOptions, routeKey },
  { corpus, chunks, query }, signal, onEstimate, onUsage, { prune = true, assertCurrent } = {}) {
  await assertCurrent?.()
  signal.throwIfAborted()
  const catalog = await jsonRequest('/api/embeddings/models', { signal })
  const model = catalog.models.find(item => item.id === modelId)
  if (!model) throw new Error('이 임베딩 모델이 현재 OpenRouter 모델 목록에 없어요.')
  const hashes = await hashesFor(corpus)
  const db = await openIndex()
  const stored = await recordsFor(db, projectId)
  const desired = new Map(chunks.map(({ text }) => [hashes.get(text), text]))
  const records = new Map(stored.filter(entry => entry.model === routeKey && desired.has(entry.hash))
    .map(entry => [entry.hash, entry.vector]))
  const retained = new Set(hashes.values())
  const removals = prune ? stored.filter(entry => entry.model !== routeKey || !retained.has(entry.hash)) : []
  const missing = [...desired].filter(([hash]) => !records.has(hash))
  onEstimate(estimateUsage([...missing.map(([, value]) => value), query], 0, model,
    Math.ceil(missing.length / embeddingBatchSize) + 1))
  let usage
  async function embed(kind, input) {
    await assertCurrent?.()
    signal.throwIfAborted()
    const data = await jsonRequest('/api/embeddings', { body: { model: modelId, input, kind, modelOptions }, signal })
    usage = combineUsage(usage, data.usage)
    onUsage(usage)
    if (!Array.isArray(data.vectors) || data.vectors.length !== input.length) throw new Error('검색 벡터를 읽지 못했어요.')
    return data.vectors.map(vector => Float32Array.from(vector))
  }

  for (let start = 0; start < missing.length; start += embeddingBatchSize) {
    const batch = missing.slice(start, start + embeddingBatchSize)
    const vectors = await embed('document', batch.map(([, value]) => value))
    await writeIndex(db, signal, { additions: batch.map(([hash], index) => ({
      projectId, model: routeKey, hash, vector: vectors[index],
    })) })
    batch.forEach(([hash], index) => records.set(hash, vectors[index]))
  }
  await writeIndex(db, signal, { removals })
  const [queryVector] = await embed('query', [query])
  const vectors = chunks.map(chunk => records.get(hashes.get(chunk.text)))
  if (vectors.some(vector => vector.length !== queryVector.length)) {
    // A provider can replace a model with one that emits a different number of dimensions.
    const incompatible = [...retained].map(hash => ({ projectId, model: routeKey, hash }))
    await writeIndex(db, signal, { removals: incompatible })
    throw new Error('모델의 벡터 길이가 바뀌었어요. 다시 검색하면 새로 색인해요.')
  }
  return { query: queryVector, vectors }
}
