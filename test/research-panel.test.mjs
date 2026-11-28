import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupResearch } from '../public/research-panel.mjs'
import { defaultEmbeddingModel } from '../public/retrieval.mjs'

function memoryIndex() {
  const records = new Map()
  const key = (...parts) => JSON.stringify(parts)
  return {
    open() {
      const request = {}
      request.result = {
        transaction() {
          const transaction = { objectStore: () => ({
            index: () => ({
              getAll(projectId) {
                const read = { result: [...records.values()].filter(row => row.projectId === projectId) }
                queueMicrotask(() => read.onsuccess())
                return read
              },
            }),
            put(row) {
              records.set(key(row.projectId, row.model, row.hash), row)
              queueMicrotask(() => transaction.oncomplete())
            },
            delete(parts) { records.delete(key(...parts)) },
          }) }
          return transaction
        },
      }
      queueMicrotask(() => request.onsuccess())
      return request
    },
  }
}

test('장면 미리보기와 생성은 같은 검색을 재사용하며 장면 본문이 바뀌면 다시 찾는다', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'indexedDB', { value: memoryIndex(), configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original)
    else delete globalThis.indexedDB
  })
  const first = 'Ancient bronze lantern.'
  const second = 'Docked vessel in rain.'
  const preceding = [first, second].join('\n\n')
  const project = {
    id: 'scene-search', title: '시험 원고', synopsis: '', direction: '', model: 'qa/write', maxTokens: 128,
    manuscript: preceding + '\n\n현재 장면.', search: { enabled: true, model: defaultEmbeddingModel },
    sourceLimits: { manuscript: 18, pastPassages: 1000 },
  }
  const elements = new Map()
  const research = setupResearch({
    get(id) {
      if (!elements.has(id)) elements.set(id, new EventTarget())
      return elements.get(id)
    },
    currentProject: () => project, addedLoreCards: () => undefined, assertWorkspaceCurrent: async () => {},
  })
  const queries = []
  let documentBatches = 0
  let failQuery = false
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    if (path === '/api/embeddings/models') return Response.json({ models: [{ id: defaultEmbeddingModel }] })
    assert.equal(path, '/api/embeddings')
    const { kind, input } = JSON.parse(options.body)
    if (kind === 'document') {
      documentBatches++
      return Response.json({ vectors: input.map(text => text === first ? [1, 0] : [0, 1]) })
    }
    queries.push(input[0])
    if (failQuery) return Response.json({ error: '일시 오류' }, { status: 503 })
    return Response.json({ vectors: [input[0].endsWith('별빛이 비쳤다.') ? [0, 1] : [1, 0]] })
  })
  const call = (text = '천둥이 울렸다.') => ({
    source: { ...project, manuscript: preceding },
    sceneRevision: { text, direction: '제비꽃 변화', precedingLimit: 0 },
  })
  const { signal } = new AbortController()
  assert.equal(research.preview(project, undefined, call()).semanticPending, true)
  const refreshed = await research.prepare(project, undefined, signal, { ...call(), retry: true })
  const reopened = research.preview(project, undefined, call())
  const generated = await research.prepare(project, undefined, signal, call())
  for (const result of [refreshed, reopened, generated]) {
    assert.equal(result.semanticPending, false)
    assert.deepEqual(result.hits.map(hit => hit.text), [first])
  }
  assert.deepEqual(queries, ['제비꽃 변화\n천둥이 울렸다.'])
  assert.equal(research.preview(project, undefined, call('별빛이 비쳤다.')).semanticPending, true)
  const changed = await research.prepare(project, undefined, signal, call('별빛이 비쳤다.'))
  assert.deepEqual(changed.hits.map(hit => hit.text), [second])
  assert.deepEqual(queries, ['제비꽃 변화\n천둥이 울렸다.', '제비꽃 변화\n별빛이 비쳤다.'])

  failQuery = true
  const failed = await research.prepare(project, undefined, signal, { ...call(), retry: true })
  assert.equal(failed.semanticFailed, true)
  assert.equal(research.preview(project, undefined, call()).semanticFailed, true)
  failQuery = false
  const recovered = await research.prepare(project, undefined, signal, call())
  assert.deepEqual(recovered.hits.map(hit => hit.text), [first])
  assert.deepEqual(queries.slice(2), Array(2).fill('제비꽃 변화\n천둥이 울렸다.'))
  assert.equal(documentBatches, 1)
})
