import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readWorkspace } from '../public/writing-workspace.mjs'

test('브라우저 저장 공간이 부족해도 서버에 저장하고 충돌 시 편집본을 보존한다', async t => {
  const initial = readWorkspace(null)
  let remote = { revision: 7, snapshot: JSON.stringify(initial) }
  const globals = {
    window: new EventTarget(), document: new EventTarget(), localStorage: {
      getItem: () => null,
      setItem() { throw new DOMException('Quota exceeded', 'QuotaExceededError') },
    },
  }
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else delete globalThis[name]
    })
  }
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
  initial.projects[0].manuscript = '디스크에 저장할 원고'
  const snapshot = JSON.stringify(initial)
  assert.equal(await storage.cacheWorkspace(snapshot), true)
  assert.deepEqual(remote, { revision: 8, snapshot })

  const newer = JSON.stringify({ ...initial, projects: [{ ...initial.projects[0], manuscript: '다른 탭의 최신 원고' }] })
  remote = { revision: 9, snapshot: newer }
  initial.projects[0].manuscript = '이 탭에서 편집 중인 원고'
  const unsaved = JSON.stringify(initial)
  assert.equal(await storage.cacheWorkspace(unsaved), false)
  assert.equal(storage.readCachedWorkspace(), unsaved)
  assert.deepEqual(remote, { revision: 9, snapshot: newer })
  assert.match(storage.workspaceStorageStatus().warning, /서버에 더 최근/)
})
