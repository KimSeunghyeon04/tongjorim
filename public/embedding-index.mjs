import { combineUsage, estimateUsage, jsonRequest } from './request-tools.mjs'
import { embeddingBatchSize } from './retrieval.mjs'

let database

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

export async function embedPast(projectId, { model: modelId, modelOptions, routeKey }, chunks, query, signal, onEstimate, onUsage) {
  const catalog = await jsonRequest('/api/embeddings/models', { signal })
  const model = catalog.models.find(item => item.id === modelId)
  if (!model) throw new Error('이 임베딩 모델이 현재 OpenRouter 모델 목록에 없어요.')
  const texts = [...new Set(chunks.map(chunk => chunk.text))]
  const hashes = await Promise.all(texts.map(hashText))
  const db = await openIndex()
  const stored = await recordsFor(db, projectId)
  const desired = new Map(hashes.map((hash, index) => [hash, texts[index]]))
  const records = new Map(stored.filter(entry => entry.model === routeKey && desired.has(entry.hash))
    .map(entry => [entry.hash, entry.vector]))
  const removals = stored.filter(entry => entry.model !== routeKey || !desired.has(entry.hash))
  const missing = [...desired].filter(([hash]) => !records.has(hash))
  onEstimate(estimateUsage([...missing.map(([, value]) => value), query], 0, model,
    Math.ceil(missing.length / embeddingBatchSize) + 1))
  let usage
  async function embed(kind, input) {
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
  const hashesByText = new Map(hashes.map((hash, index) => [texts[index], hash]))
  const vectors = chunks.map(chunk => records.get(hashesByText.get(chunk.text)))
  if (vectors.some(vector => vector.length !== queryVector.length)) {
    // A provider can replace a model with one that emits a different number of dimensions.
    const incompatible = [...desired.keys()].map(hash => ({ projectId, model: routeKey, hash }))
    await writeIndex(db, signal, { removals: incompatible })
    throw new Error('모델의 벡터 길이가 바뀌었어요. 다시 검색하면 새로 색인해요.')
  }
  return { query: queryVector, vectors }
}
