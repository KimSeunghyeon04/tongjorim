import { normalizeLineEndings, writingFields } from './writing-config.mjs'

export function sceneTitle(text) {
  return text.trimStart().split(/[\n.!?。！？]/, 1)[0].trim().slice(0, 36).toWellFormed() || '제목 없는 장면'
}

export function sceneRange(manuscript, start, end) {
  const raw = manuscript.slice(start, end)
  const text = raw.trim()
  if (!text) return null
  start += raw.length - raw.trimStart().length
  return { start, end: start + text.length }
}

export function sceneSplitRanges(manuscript, range, offset) {
  if (!range || !Number.isSafeInteger(offset) || offset <= range.start || offset >= range.end) return null
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(manuscript.slice(offset - 1, offset + 1))) return null
  if (!sceneRange(manuscript, range.start, offset) || !sceneRange(manuscript, offset, range.end)) return null
  return [{ start: range.start, end: offset }, { start: offset, end: range.end }]
}

export function savedScenesInManuscriptOrder(scenes = []) {
  return scenes.toSorted((a, b) => (a.range?.start ?? Infinity) - (b.range?.start ?? Infinity))
}

export function emptyScene(id, start, source = 'registered') {
  return { id, title: sceneTitle(''), range: { start, end: start }, accepted: 0,
    versions: [{ text: '', direction: '', parent: null, source }] }
}

function legacyImplicitScene(scenes) {
  const ids = new Set(scenes.map(scene => scene.id))
  let index = 1
  while (ids.has(`first-scene-${index}`)) index++
  return emptyScene(`first-scene-${index}`, 0, 'implicit')
}

export function coverSceneRanges(scenes, length) {
  const located = savedScenesInManuscriptOrder(scenes).filter(scene => scene.range)
  if (!located.length) {
    const first = emptyScene(crypto.randomUUID(), 0, 'implicit')
    return [...scenes, { ...first, range: { start: 0, end: length } }]
  }
  // A scene owns the text up to the next scene's starting position.
  const ranges = new Map(located.map((scene, index) => [scene.id, {
    start: index === 0 ? 0 : scene.range.start, end: located[index + 1]?.range.start ?? length,
  }]))
  return scenes.map(scene => {
    const range = ranges.get(scene.id)
    return !range || sameRange(scene.range, range) ? scene : { ...scene, range }
  })
}

export function sceneAtOffset(scenes, offset) {
  return scenes?.reduce((found, scene) => scene.range && scene.range.start <= offset &&
    (!found || found.range.start <= scene.range.start) ? scene : found, undefined)
}

export function sceneDisplayTitle(scene, manuscript) {
  return scene.versions[0].text || scene.versions.length > 1 || !scene.range
    ? scene.title : sceneTitle(manuscript.slice(scene.range.start, scene.range.end))
}

// Prefer the browser's edit position when repeated prose admits multiple matching diffs.
export function manuscriptEdit(before, after, selection) {
  if (before === after) return null
  if (selection) {
    const { start, end, caret } = selection
    const delta = after.length - before.length
    const exactStart = Math.min(start, caret)
    const exactEnd = Math.max(end, exactStart - delta)
    const newEnd = exactEnd + delta
    if (newEnd >= exactStart && before.slice(0, exactStart) === after.slice(0, exactStart) &&
        before.slice(exactEnd) === after.slice(newEnd)) {
      return { start: exactStart, end: exactEnd, inserted: after.slice(exactStart, newEnd) }
    }
  }

  let start = 0
  const limit = Math.min(before.length, after.length)
  while (start < limit && before[start] === after[start]) start++
  let suffix = 0
  while (suffix < limit && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  const earliest = Math.min(start, limit - suffix)
  const end = before.length - Math.min(suffix, limit - start)
  return { start, end, inserted: after.slice(start, end + after.length - before.length), earliest }
}

export function moveSavedScenes(scenes, edit, manuscript) {
  if (!scenes?.length || !edit) return scenes
  const { start, end, inserted, earliest = start } = edit
  const delta = inserted.length - (end - start)
  const moved = scenes.map(scene => {
    if (!scene.range) return scene
    const range = scene.range
    const boundary = range.start
    const uncertain = boundary > 0 && earliest < start && earliest <= boundary && boundary <= end
    const erased = start < end && boundary < range.end && start <= boundary && range.end <= end &&
      (boundary > start || !inserted.trim())
    if (uncertain || erased) return { ...scene, range: null }
    // At a shared boundary, insertion belongs to the scene starting there.
    if (boundary <= start) return scene
    return { ...scene, range: { ...range, start: boundary >= end ? boundary + delta : start + inserted.length } }
  })
  return coverSceneRanges(moved, manuscript.length)
}

const sameRange = (left, right) => left?.start === right?.start && left?.end === right?.end
const touchesStart = (edit, range) => edit.start <= range.start && range.start <= edit.end
const sceneUndoBudget = 16 * 1024 * 1024

export const isSceneHistoryEdit = inputType => inputType === 'historyUndo' || inputType === 'historyRedo'

export function sceneHistoryReplay(history, before, after, inputType) {
  if (!isSceneHistoryEdit(inputType)) return undefined
  const undo = inputType === 'historyUndo'
  const first = undo ? history.findLastIndex(item => !item.undone) : history.findIndex(item => item.undone)
  const steps = []
  let manuscript = before
  // One browser undo unit can contain several input events.
  for (let index = first; index >= 0 && index < history.length; index += undo ? -1 : 1) {
    const record = history[index]
    const { edit: forward, removed } = record
    const { start } = forward
    const outgoing = undo ? forward.inserted : removed
    const end = start + outgoing.length
    if (end > manuscript.length || manuscript.slice(start, end) !== outgoing) break
    const edit = undo ? { start, end, inserted: removed, earliest: forward.earliest } : forward
    manuscript = manuscript.slice(0, start) + edit.inserted + manuscript.slice(end)
    steps.push({ record, edit, manuscript })
    if (manuscript === after) return { steps, edit: steps.length === 1 ? edit : undefined }
  }
  return undefined
}

function recordSceneEdit(history, before, prior, scenes, edit, undone = false) {
  if (history.at(-1)?.undone) history.splice(history.findIndex(record => record.undone))
  const { start, end, inserted, earliest = start } = edit
  const deletion = start < end && !inserted.trim()
  // Repeated text can make the exact deletion position ambiguous.
  const earliestEnd = end - (start - earliest)
  const deleted = new Set()
  const current = new Map(scenes.map(scene => [scene.id, scene]))
  const changes = prior.flatMap((scene, index) => {
    const { id, range } = scene
    if (!range) return []
    const next = current.get(id)?.range
    if (deletion && range.start < range.end && start <= range.start && range.end <= earliestEnd) {
      deleted.add(id)
      return [{ id, before: range, deleted: scene, index }]
    }
    return !next || touchesStart(edit, range) ? [{ id, before: range, after: next }] : []
  })
  const priorIds = new Set(prior.map(scene => scene.id))
  const created = scenes.filter(scene => !priorIds.has(scene.id))
  // Account for per-edit metadata so long sequences of small deletions fit the same budget.
  const cost = end - start + inserted.length + 128 + changes.length * 32 + created.length * 32
  const from = history.at(-1)?.through ?? 0
  const through = from + cost
  history.push({ edit, removed: before.slice(start, end), changes, created, undone, from, through })
  let expires = 0
  while (expires < history.length - 1 && through - history[expires].from > sceneUndoBudget) expires++
  if (expires) history.splice(0, expires)
  return deleted.size ? scenes.filter(scene => !deleted.has(scene.id)) : scenes
}

function restoreSceneEdit(prior, scenes, length, record, undo) {
  const previous = new Map(prior.map(scene => [scene.id, scene]))
  const restore = new Map()
  const remove = new Set(record.created.map(scene => scene.id))
  // Moving the text may synthesize a first scene before the recorded scene is restored.
  for (const scene of scenes) {
    if (!previous.has(scene.id)) remove.add(scene.id)
  }
  for (const change of record.changes) {
    const old = previous.get(change.id)
    if (change.deleted) {
      if (undo && !old) restore.set(change.id, change)
      if (!undo && old) {
        remove.add(change.id)
        change.deleted = old
      }
    } else if (old && old.range?.start === (undo ? change.after : change.before)?.start) {
      restore.set(change.id, change)
    }
  }
  const updated = scenes.filter(scene => !remove.has(scene.id))
  for (const [id, change] of restore) {
    const range = undo ? change.before : change.after
    if (change.deleted) {
      updated.splice(change.index, 0, { ...change.deleted, range })
    } else {
      const index = updated.findIndex(scene => scene.id === id)
      if (index !== -1) updated[index] = { ...previous.get(id), range }
    }
  }
  if (!undo) updated.push(...record.created)
  return coverSceneRanges(updated, length)
}

export function rememberUndoneComposition(history, before, composing, scenes = [], selection) {
  if (!scenes.length && !history.length) return
  const edit = manuscriptEdit(before, composing, selection)
  if (edit) recordSceneEdit(history, before, scenes, moveSavedScenes(scenes, edit, composing), edit, true)
}

export function reconcileSceneUndo(history, before, after, prior = [], scenes = [], inputType, edit, replay) {
  if ((!prior.length && !history.length) || before === after) return scenes
  if (!isSceneHistoryEdit(inputType)) return edit ? recordSceneEdit(history, before, prior, scenes, edit) : scenes
  if (!replay) {
    history.length = 0
    return scenes
  }
  const undo = inputType === 'historyUndo'
  let current = prior
  for (const step of replay.steps) {
    const moved = replay.steps.length === 1 ? scenes : moveSavedScenes(current, step.edit, step.manuscript)
    step.record.undone = undo
    current = restoreSceneEdit(current, moved, step.manuscript.length, step.record, undo)
  }
  return current
}

export function forgetSceneUndo(history, id) {
  for (const record of history) {
    record.changes = record.changes.filter(change => change.id !== id)
    record.created = record.created.filter(scene => scene.id !== id)
  }
}

export function sceneVersions(versions) {
  return versions.map(({ text, direction, parent, source, truncated }) => ({
    text, direction, parent, ...(source ? { source } : {}), ...(truncated === undefined ? {} : { truncated }),
  }))
}

export function* sceneVersionPath(versions, selected) {
  for (let version = selected; version !== null; version = versions[version].parent) yield version
}

export function validSavedScenes(scenes, manuscript) {
  if (!Array.isArray(scenes)) return false
  const ids = new Set()
  const ranges = []
  for (const scene of scenes) {
    if (!scene || typeof scene.id !== 'string' || !scene.id || scene.id.length > 100 || ids.has(scene.id) ||
        typeof scene.title !== 'string' || !scene.title.trim() || scene.title.length > 120 ||
        !Array.isArray(scene.versions) || !Number.isSafeInteger(scene.accepted) ||
        scene.accepted < 0 || scene.accepted >= scene.versions.length) return false
    ids.add(scene.id)
    if (scene.range !== null) {
      const { start, end } = scene.range ?? {}
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
          end > manuscript.length) return false
      ranges.push(scene.range)
    }
    let root = 0
    if (!scene.versions.every((version, index) => {
      if (!version || typeof version.text !== 'string' ||
          typeof version.direction !== 'string' || version.direction.length > writingFields.direction ||
          (version.truncated !== undefined && typeof version.truncated !== 'boolean')) return false
      if (index === 0) return version.parent === null &&
        (version.source === 'registered' || version.source === 'implicit' || version.source === undefined && Boolean(version.text.trim()))
      if (!version.text.trim()) return false
      if (version.source === 'split' && version.parent === null) {
        root = index
        return true
      }
      return Number.isSafeInteger(version.parent) && version.parent >= root && version.parent < index &&
        (version.source === undefined || version.source === 'manual')
    }) || scene.accepted < root) return false
  }
  ranges.sort((a, b) => a.start - b.start)
  return ranges.every((range, index) => index === 0 || ranges[index - 1].end <= range.start)
}

export function normalizeSavedScenes(scenes = [], manuscript, normalized) {
  const offset = manuscript === normalized ? index => index : index => normalizeLineEndings(manuscript.slice(0, index)).length
  const normalizedScenes = scenes.map(scene => {
    const start = scene.range && offset(scene.range.start)
    const end = scene.range && offset(scene.range.end)
    return {
      id: scene.id, title: scene.title, range: scene.range ? { start, end } : null, accepted: scene.accepted,
      versions: sceneVersions(scene.versions).map(version => ({
        ...version, text: normalizeLineEndings(version.text), direction: normalizeLineEndings(version.direction),
      })),
    }
  })
  const first = savedScenesInManuscriptOrder(normalizedScenes).find(scene => scene.range)
  // Settings tabs may normalize the same legacy snapshot independently.
  if (!first || normalized.slice(0, first.range.start).trim()) normalizedScenes.push(legacyImplicitScene(normalizedScenes))
  return coverSceneRanges(normalizedScenes, normalized.length)
}
