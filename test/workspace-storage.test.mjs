import { editSceneDocument } from '../public/scene-document.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readWorkspace } from '../public/writing-workspace.mjs'
import { openTongjorimStore } from '../tongjorim-store.mjs'

async function saveSnapshot(storage, snapshot) {
  const { saved } = await storage.cacheWorkspace(() => snapshot)
  return saved
}

function storageGlobals(t, localStorage) {
  const globals = { window: new EventTarget(), document: new EventTarget(), localStorage }
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else delete globalThis[name]
    })
  }
}

test('브라우저 저장 공간이 부족해도 서버에 저장하고 충돌 시 편집본을 보존한다', async t => {
  const initial = readWorkspace(null)
  let remote = { revision: 7, snapshot: JSON.stringify(initial) }
  storageGlobals(t, {
    getItem: () => null,
    setItem() { throw new DOMException('Quota exceeded', 'QuotaExceededError') },
  })
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/workspace')
    if (options.method !== 'POST') return Response.json(remote)
    const { revision, snapshot } = JSON.parse(options.body)
    if (revision !== remote.revision) return Response.json({ ...remote, conflict: true }, { status: 409 })
    remote = { revision: revision + 1, snapshot }
    return Response.json({ revision: remote.revision })
  })

  const storage = await import('../public/workspace-storage.mjs')
  await storage.openWorkspaceStorage()
  assert.equal(storage.readCachedWorkspace(), remote.snapshot)
  initial.projects[0].sceneDocument = editSceneDocument(initial.projects[0].sceneDocument, initial.projects[0].savedScenes[0].id, '디스크에 저장할 원고')
  const snapshot = JSON.stringify(initial)
  assert.equal(await saveSnapshot(storage, snapshot), true)
  assert.deepEqual(remote, { revision: 8, snapshot })

  const newer = JSON.stringify({ ...initial, projects: [{ ...initial.projects[0], manuscript: '다른 탭의 최신 원고' }] })
  remote = { revision: 9, snapshot: newer }
  initial.projects[0].sceneDocument = editSceneDocument(initial.projects[0].sceneDocument, initial.projects[0].savedScenes[0].id, '이 탭에서 편집 중인 원고')
  const unsaved = JSON.stringify(initial)
  assert.equal(await saveSnapshot(storage, unsaved), false)
  assert.equal(storage.readCachedWorkspace(), unsaved)
  assert.deepEqual(remote, { revision: 9, snapshot: newer })
  assert.match(storage.workspaceStorageStatus().warning, /서버에 더 최근/)
})

test('새 탭을 여는 동안 다른 탭이 저장하면 늦게 도착한 조회로 편집본을 되돌리지 않는다', async t => {
  const initial = readWorkspace(null)
  const older = { revision: 7, snapshot: JSON.stringify(initial), pending: false }
  initial.projects[0].sceneDocument = editSceneDocument(initial.projects[0].sceneDocument, initial.projects[0].savedScenes[0].id, '첫 조회 도중 다른 탭에서 저장한 원고')
  const newer = { revision: 8, snapshot: JSON.stringify(initial), pending: false }
  let cache = JSON.stringify(older)
  storageGlobals(t, { getItem: () => cache, setItem(_key, value) { cache = value } })
  const response = Promise.withResolvers()
  const started = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', () => {
    started.resolve()
    return response.promise
  })
  const storage = await import('../public/workspace-storage.mjs?delayed-open')
  const opened = storage.openWorkspaceStorage()
  await started.promise
  cache = JSON.stringify(newer)
  response.resolve(Response.json({ revision: 7, snapshot: older.snapshot }))
  await opened
  assert.deepEqual(JSON.parse(cache), newer)
  assert.equal(storage.readCachedWorkspace(), newer.snapshot)
})

test('다른 탭의 새 저장이 없으면 서버에서 다시 읽은 작업공간을 사용한다', async t => {
  const initial = readWorkspace(null)
  const remote = { revision: 1, snapshot: JSON.stringify(initial) }
  initial.projects[0].sceneDocument = editSceneDocument(initial.projects[0].sceneDocument, initial.projects[0].savedScenes[0].id, '교체하기 전 DB에서 사용하던 원고')
  let cache = JSON.stringify({ revision: 7, snapshot: JSON.stringify(initial), pending: false })
  storageGlobals(t, { getItem: () => cache, setItem(_key, value) { cache = value } })
  t.mock.method(globalThis, 'fetch', () => Response.json(remote))
  const storage = await import('../public/workspace-storage.mjs?replaced-database')
  await storage.openWorkspaceStorage()
  assert.deepEqual(JSON.parse(cache), { ...remote, pending: false })
  assert.equal(storage.readCachedWorkspace(), remote.snapshot)
})

test('앞선 저장이 SQLite에 반영되고 응답만 끊겨도 다시 연 탭에서 후속 편집을 저장한다', async t => {
  const store = openTongjorimStore(':memory:')
  t.after(() => store.close())
  const workspace = readWorkspace(null)
  const original = JSON.stringify(workspace)
  store.saveWorkspace(null, original)
  workspace.projects[0].sceneDocument = editSceneDocument(workspace.projects[0].sceneDocument, workspace.projects[0].savedScenes[0].id, '앞선 저장')
  const first = JSON.stringify(workspace)
  workspace.projects[0].sceneDocument = editSceneDocument(workspace.projects[0].sceneDocument, workspace.projects[0].savedScenes[0].id, '응답을 기다리는 동안 이어 쓴 원고')
  const later = JSON.stringify(workspace)
  let cache = null
  storageGlobals(t, { getItem: () => cache, setItem(_key, value) { cache = value } })
  const committed = Promise.withResolvers()
  const lostReply = Promise.withResolvers()
  let drop = true
  t.mock.method(globalThis, 'fetch', (_path, options) => {
    if (options.method !== 'POST') return Response.json(store.readWorkspace())
    const { revision, snapshot, attempt } = JSON.parse(options.body)
    const result = store.saveWorkspace(revision, snapshot, attempt)
    if (drop) {
      drop = false
      committed.resolve()
      return lostReply.promise
    }
    return Response.json(result, { status: result.conflict ? 409 : 200 })
  })
  const storage = await import('../public/workspace-storage.mjs?lost-ack')
  await storage.openWorkspaceStorage()
  const { saved: saving } = await storage.cacheWorkspace(() => first)
  await committed.promise
  assert.deepEqual({ ...store.readWorkspace() }, { revision: 2, snapshot: first })
  const { saved: following } = await storage.cacheWorkspace(() => later)
  lostReply.reject(new TypeError('Connection closed while reading the response'))
  assert.equal(await saving, false)
  assert.equal(await following, false)
  assert.equal(storage.readCachedWorkspace(), later)

  const reopened = await import('../public/workspace-storage.mjs?lost-ack-reopen')
  await reopened.openWorkspaceStorage()
  assert.equal(await saveSnapshot(reopened, later), true)
  assert.deepEqual({ ...store.readWorkspace() }, { revision: 3, snapshot: later })
  assert.equal(JSON.parse(cache).pending, false)
})

test('예약 전에 캐시가 바뀌면 현재 스냅샷을 바탕으로 편집을 검토한다', async t => {
  const initial = readWorkspace(null)
  const expected = JSON.stringify(initial)
  let cache
  storageGlobals(t, { getItem: () => cache ?? null, setItem(_key, value) { cache = value } })
  const fetch = t.mock.method(globalThis, 'fetch', () => Response.json({ revision: 1, snapshot: expected }))
  const storage = await import('../public/workspace-storage.mjs?changed-baseline')
  await storage.openWorkspaceStorage()
  initial.projects[0].sceneDocument = editSceneDocument(initial.projects[0].sceneDocument, initial.projects[0].savedScenes[0].id, '다른 탭의 새 원고')
  const latest = JSON.stringify(initial)
  cache = JSON.stringify({ revision: 2, snapshot: latest, pending: false })
  initial.projects[0].sceneDocument = editSceneDocument(initial.projects[0].sceneDocument, initial.projects[0].savedScenes[0].id, '이전 스냅샷을 바탕으로 편집한 원고')
  const conflict = new Error('다른 탭에서 작품이 바뀌어')
  await assert.rejects(storage.cacheWorkspace(current => {
    assert.equal(current, latest)
    throw conflict
  }), conflict)
  assert.deepEqual(JSON.parse(cache), { revision: 2, snapshot: latest, pending: false })
  assert.equal(fetch.mock.callCount(), 1)
})
