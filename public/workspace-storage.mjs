import { readWorkspace, storageKey as legacyStorageKey } from './writing-workspace.mjs'

export const storageKey = 'relay.workspace.sqlite.v1'
export const workspaceStatusEvent = 'relay:workspace-status'
const conflictMessage = '서버에 더 최근의 작업공간이 있어요. 이 탭의 작업을 JSON으로 백업해 주세요.'
const unavailableMessage = '서버에 저장할 수 없어요. 통조림 서버 연결을 확인해 주세요.'
let opening
let flushing
let warning = ''
let cachedEntry = null
let memoryOnly = false

function readCache() {
  if (!memoryOnly) {
    try { cachedEntry = JSON.parse(localStorage.getItem(storageKey)) } catch { memoryOnly = true }
  }
  return cachedEntry
}

function writeCache(entry) {
  cachedEntry = entry
  if (!memoryOnly) {
    try { localStorage.setItem(storageKey, JSON.stringify(entry)) } catch { memoryOnly = true }
  }
}

function readLegacyWorkspace() {
  try { return localStorage.getItem(legacyStorageKey) } catch { return null }
}

function publish() {
  document.dispatchEvent(new Event(workspaceStatusEvent))
}

async function requestWorkspace(entry) {
  const signal = AbortSignal.timeout(8000)
  const response = await fetch('/api/workspace', entry ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: entry.revision, snapshot: entry.snapshot }), signal,
  } : { signal })
  if (!response.ok && response.status !== 409) throw new Error(unavailableMessage)
  return response.json()
}

async function loadCache() {
  try {
    const remote = await requestWorkspace()
    const local = readCache()
    const needsSave = local?.pending && local.snapshot !== remote.snapshot
    if (needsSave) {
      if (remote.revision === null) writeCache({ ...local, revision: null })
    } else if (remote.snapshot !== null) {
      writeCache({ revision: remote.revision, snapshot: remote.snapshot, pending: false })
    } else {
      const legacy = local?.revision != null ? local.snapshot : readLegacyWorkspace()
      const snapshot = JSON.stringify(readWorkspace(legacy ?? local?.snapshot ?? null))
      writeCache({ revision: null, snapshot, pending: legacy !== null })
    }
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

export function cacheWorkspace(snapshot) {
  const previous = readCache()
  if (previous?.snapshot !== snapshot) writeCache({ revision: previous?.revision ?? null, snapshot, pending: true })
  return flushWorkspace()
}

async function flushCache() {
  let sent
  while ((sent = readCache())?.pending) {
    const saved = await requestWorkspace(sent)
    const latest = readCache()
    if (!latest || latest.revision !== sent.revision) continue
    if (saved.conflict && saved.snapshot !== sent.snapshot) throw new Error(conflictMessage)
    writeCache({ revision: saved.revision, snapshot: latest.snapshot, pending: latest.snapshot !== sent.snapshot })
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
      warning = error.message === conflictMessage ? conflictMessage : unavailableMessage
      flushing = undefined
      publish()
      return false
    })
  publish()
  return flushing
}

export function workspaceStorageStatus() {
  return { warning, saving: Boolean(flushing), persisted: cachedEntry?.revision != null }
}

function retryPendingWorkspace() {
  if (!opening) return
  try { if (readCache()?.pending) void flushWorkspace() } catch { /* The workspace view reports browser storage failures. */ }
}

window.addEventListener('online', retryPendingWorkspace)
window.addEventListener('focus', retryPendingWorkspace)
window.addEventListener('storage', event => {
  if (event.key === storageKey) retryPendingWorkspace()
})
window.addEventListener('beforeunload', event => {
  try {
    if (readCache()?.pending) {
      event.preventDefault()
      event.returnValue = true
    }
  } catch { /* Browser storage is already unavailable. */ }
})
