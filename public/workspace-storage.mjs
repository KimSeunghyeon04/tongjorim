import { readWorkspace, storageKey as legacyStorageKey, workspaceInflatedBytes, workspaceRequestBytes } from './writing-workspace.mjs'

export const storageKey = 'relay.workspace.sqlite.v1'
export const workspaceStatusEvent = 'relay:workspace-status'
export const workspaceChangeEvent = 'relay:workspace-change'
export const storageConflictMessage = '다른 탭에서 작품이 바뀌어 이 탭의 변경을 저장할 수 없어요.'
const snapshotOrderKey = `${storageKey}:snapshot-order`
const notifications = typeof window.BroadcastChannel === 'function' ? new window.BroadcastChannel(storageKey) : null
const conflictMessage = '서버에 더 최근의 작업공간이 있어요. 편집본을 백업한 뒤 서버 사본을 열 수 있어요.'
const unavailableMessage = '서버에 저장할 수 없어요. 통조림 서버 연결을 확인해 주세요.'
const sizeMessage = '작업공간이 서버 저장 한도를 넘었어요. 현재 작품을 JSON으로 백업해 주세요.'
let opening
let cacheDatabase
let flushing
let queueing = 0
let warning = ''
let cachedEntry = null
let memoryOnly = false

function readCache() {
  if (!memoryOnly) {
    try {
      const entry = JSON.parse(localStorage.getItem(storageKey))
      if ((entry?.cacheOrder ?? 0) >= (cachedEntry?.cacheOrder ?? 0)) cachedEntry = entry
    } catch { memoryOnly = true }
  }
  return cachedEntry
}

function writeCache(entry, durable = false) {
  if (!memoryOnly || durable) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(entry))
      memoryOnly = false
    } catch {
      if (durable) throw new Error('서버 사본을 브라우저에 저장할 수 없어요.')
      memoryOnly = true
    }
  }
  cachedEntry = entry
}

function openCacheDatabase() {
  if (!globalThis.indexedDB) return null
  return new Promise(resolve => {
    const request = indexedDB.open(storageKey, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('workspace')
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => { database.close(); cacheDatabase = undefined }
      resolve(database)
    }
  }).catch(() => null)
}

async function changeCache(action, { durable = false } = {}) {
  const database = await (cacheDatabase ??= openCacheDatabase())
  if (!database) {
    const apply = async () => action(readCache(), entry => writeCache(entry, durable))
    return navigator.locks ? navigator.locks.request(`${storageKey}:cache`, apply) : apply()
  }
  // localStorage can still expose an older value after a Web Lock passes to another renderer.
  // Use one transaction for the shared queue; keep localStorage as the recovery copy.
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('workspace', 'readwrite')
    const store = transaction.objectStore('workspace')
    const request = store.get(storageKey)
    let result
    let committed
    let notify = false
    transaction.onabort = () => reject(transaction.error ?? new Error(unavailableMessage))
    transaction.oncomplete = () => {
      if (committed?.cacheOrder > (readCache()?.cacheOrder ?? 0)) writeCache(committed)
      if (notify) notifications?.postMessage(committed.snapshotOrder)
      resolve(result)
    }
    request.onsuccess = () => {
      try {
        const previous = request.result ?? readCache()
        committed = previous
        result = action(previous, entry => {
          const cacheOrder = (previous?.cacheOrder ?? 0) + 1
          const snapshotOrder = previous?.snapshot === entry.snapshot ? previous?.snapshotOrder ?? cacheOrder : cacheOrder
          committed = { ...entry, cacheOrder, snapshotOrder }
          store.put(committed, storageKey)
          if (snapshotOrder !== previous?.snapshotOrder) {
            store.put(snapshotOrder, snapshotOrderKey)
            notify = true
          }
        })
      } catch (error) {
        transaction.abort()
        reject(error)
      }
    }
  })
}

function readLegacyWorkspace() {
  try { return localStorage.getItem(legacyStorageKey) } catch { return null }
}

function publish() {
  document.dispatchEvent(new Event(workspaceStatusEvent))
}

async function workspaceUpload(entry) {
  const headers = { 'Content-Type': 'application/json' }
  let body = JSON.stringify({ revision: entry.revision, snapshot: entry.snapshot, attempt: entry.attempt })
  // Small strings are guaranteed to fit. Larger strings need their actual UTF-8 size.
  if (body.length * 3 > workspaceRequestBytes) {
    const json = new Blob([body])
    if (json.size > workspaceRequestBytes) {
      if (json.size > workspaceInflatedBytes || !globalThis.CompressionStream) throw new Error(sizeMessage)
      body = await new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob()
      if (body.size > workspaceRequestBytes) throw new Error(sizeMessage)
      headers['Content-Encoding'] = 'gzip'
    }
  }
  return { method: 'POST', headers, body }
}

async function requestWorkspace(entry) {
  const upload = entry ? await workspaceUpload(entry) : undefined
  const response = await fetch('/api/workspace', { ...upload, signal: AbortSignal.timeout(8000) })
  if (response.status === 413) throw new Error(sizeMessage)
  if (!response.ok && response.status !== 409) throw new Error(unavailableMessage)
  return response.json()
}

async function loadCache() {
  try {
    const startingRevision = (await changeCache(entry => entry))?.revision
    const remote = await requestWorkspace()
    await changeCache((local, update) => {
      // An existing tab can finish a save while this tab waits for its first GET.
      const superseded = local?.revision != null && local.revision !== startingRevision &&
        (remote.revision === null || remote.revision < local.revision)
      if (superseded) return
      const needsSave = local?.pending && local.snapshot !== remote.snapshot
      if (needsSave) {
        if (remote.revision === null && local.revision !== null) {
          update({ revision: null, snapshot: local.snapshot, pending: true })
        }
      } else if (remote.snapshot !== null) {
        update({ revision: remote.revision, snapshot: remote.snapshot, pending: false })
      } else {
        const legacy = local?.revision != null ? local.snapshot : readLegacyWorkspace()
        const snapshot = JSON.stringify(readWorkspace(legacy ?? local?.snapshot ?? null))
        update({ revision: null, snapshot, pending: legacy !== null })
      }
    })
    warning = ''
  } catch {
    warning = '서버 작업공간을 열지 못했어요. 현재 브라우저에 남아 있는 작품을 표시해요.'
  }
  if (!warning && readCache()?.pending) void flushWorkspace()
}

export function openWorkspaceStorage() {
  return opening ??= loadCache()
}

export function readCachedWorkspace() {
  return readCache()?.snapshot ?? readLegacyWorkspace()
}

export async function readLatestWorkspace({ full = false } = {}) {
  const database = await (cacheDatabase ??= openCacheDatabase())
  if (!database) {
    const snapshot = readCachedWorkspace()
    if (memoryOnly) throw new Error('다른 탭의 최신 작품 설정을 확인할 수 없어요.')
    return snapshot
  }
  const cached = cachedEntry
  const latest = await new Promise((resolve, reject) => {
    const transaction = database.transaction('workspace', 'readonly')
    const store = transaction.objectStore('workspace')
    let entry
    transaction.onabort = () => reject(transaction.error ?? new Error(unavailableMessage))
    transaction.oncomplete = () => resolve(entry)
    const readEntry = () => {
      const request = store.get(storageKey)
      request.onsuccess = () => { entry = request.result }
    }
    if (full) readEntry()
    else {
      const request = store.get(snapshotOrderKey)
      request.onsuccess = () => {
        if (request.result !== undefined && request.result === cached?.snapshotOrder) entry = cached
        else readEntry()
      }
    }
  })
  if (latest && (!cachedEntry || (latest.cacheOrder ?? 0) > (cachedEntry.cacheOrder ?? 0))) cachedEntry = latest
  return cachedEntry?.snapshot ?? readLegacyWorkspace()
}

export async function cacheWorkspace(prepare) {
  queueing++
  try {
    await changeCache((previous, update) => {
      const snapshot = prepare(previous?.snapshot ?? readLegacyWorkspace())
      if (previous?.snapshot !== snapshot) {
        update({ revision: previous?.revision ?? null, snapshot, pending: true, attempt: previous?.attempt ?? crypto.randomUUID() })
      }
    })
    return { saved: flushWorkspace() }
  } finally {
    queueing--
  }
}

export async function recoverWorkspace(snapshot, verifyLocal) {
  async function recover() {
    const before = await changeCache(entry => entry)
    if (!before?.pending || before.snapshot !== snapshot) {
      throw new Error('현재 충돌한 편집본과 같은 백업 파일을 선택해 주세요.')
    }
    const remote = await requestWorkspace()
    if (!Number.isSafeInteger(remote.revision) || remote.revision < 1 || typeof remote.snapshot !== 'string') {
      throw new Error('서버 사본을 열 수 없어요.')
    }
    try { readWorkspace(remote.snapshot) } catch { throw new Error('서버 사본을 열 수 없어요.') }
    await changeCache((latest, update) => {
      if (!latest?.pending || latest.revision !== before.revision || latest.attempt !== before.attempt ||
          latest.snapshot !== snapshot) {
        throw new Error('복구하는 동안 편집본이 바뀌었어요. 다시 백업해 주세요.')
      }
      verifyLocal?.()
      update({ revision: remote.revision, snapshot: remote.snapshot, pending: false })
    }, { durable: true })
    warning = ''
    publish()
  }
  return navigator.locks ? navigator.locks.request(storageKey, recover) : recover()
}

function pendingSave(entry, update) {
  if (!entry?.pending) return
  if (entry.attempt) return entry
  const sent = { ...entry, attempt: crypto.randomUUID() }
  update(sent)
  return sent
}

async function flushCache() {
  let sent
  while ((sent = await changeCache(pendingSave))) {
    const saved = await requestWorkspace(sent)
    await changeCache((latest, update) => {
      if (!latest || latest.revision !== sent.revision || latest.attempt !== sent.attempt) return
      if (saved.conflict && saved.snapshot !== sent.snapshot && !saved.committedAttempt) throw new Error(conflictMessage)
      // A lost response may leave an earlier snapshot from the same attempt on disk.
      const committed = saved.conflict ? saved.snapshot : sent.snapshot
      update({ revision: saved.revision, snapshot: latest.snapshot, pending: latest.snapshot !== committed })
    })
  }
}

function flushWorkspace() {
  if (flushing) return flushing
  // Tabs on the same origin share one browser copy. SQLite rejects stale writes from other origins.
  flushing = (navigator.locks ? navigator.locks.request(storageKey, flushCache) : flushCache())
    .then(() => {
      warning = ''
      flushing = undefined
      if (readCache()?.pending) return flushWorkspace()
      publish()
      return true
    }, error => {
      warning = [conflictMessage, sizeMessage].includes(error.message) ? error.message : unavailableMessage
      flushing = undefined
      publish()
      return false
    })
  publish()
  return flushing
}

export function workspaceStorageStatus() {
  return { warning, conflict: warning === conflictMessage, saving: Boolean(flushing), persisted: cachedEntry?.revision != null }
}

function retryPendingWorkspace() {
  if (!opening) return
  try { if (readCache()?.pending) void flushWorkspace() } catch { /* The workspace view reports browser storage failures. */ }
}

window.addEventListener('online', retryPendingWorkspace)
window.addEventListener('focus', retryPendingWorkspace)

async function notifyWorkspaceChange(full) {
  if (!opening) return
  try { await readLatestWorkspace({ full }) } catch { return }
  document.dispatchEvent(new Event(workspaceChangeEvent))
  retryPendingWorkspace()
}

notifications?.addEventListener('message', () => { void notifyWorkspaceChange(false) })
window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) void notifyWorkspaceChange(true)
})
window.addEventListener('beforeunload', event => {
  try {
    if (queueing || readCache()?.pending) {
      event.preventDefault()
      event.returnValue = true
    }
  } catch { /* Browser storage is already unavailable. */ }
})
