import { normalizeLineEndings, writingFields } from './writing-config.mjs'

export function sceneTitle(text) {
  return text.split(/[\n.!?。！？]/, 1)[0].trim().slice(0, 36).toWellFormed() || '제목 없는 장면'
}

export function sceneRange(manuscript, start, end) {
  const raw = manuscript.slice(start, end)
  const text = raw.trim()
  if (!text) return null
  start += raw.length - raw.trimStart().length
  return { start, end: start + text.length }
}

export function sceneRangeAvailable(scenes, range, exceptId) {
  return range && !scenes?.some(({ id, range: other }) =>
    id !== exceptId && other && range.start < other.end && other.start < range.end)
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
  const insertion = start === end
  const sharedLine = insertion && !inserted.includes('\n') &&
    scenes.some(scene => scene.range?.start === start) && scenes.some(scene => scene.range?.end === start)
  return scenes.map(scene => {
    if (!scene.range) return scene
    const range = scene.range
    let next = range
    if (earliest < start && [range.start, range.end].some(boundary => earliest <= boundary && boundary <= end)) {
      next = null
    } else if (sharedLine && (range.start === start || range.end === start)) {
      next = null
    } else if (insertion && start === range.start) {
      next = { start: start + inserted.lastIndexOf('\n') + 1, end: range.end + delta }
    } else if (insertion && start === range.end) {
      const inline = inserted.split('\n', 1)[0]
      if (inline.length) next = { start: range.start, end: range.end + inline.length }
    } else if (end <= range.start) {
      next = { start: range.start + delta, end: range.end + delta }
    } else if (start < range.end) {
      next = start >= range.start && end <= range.end
        ? { start: range.start, end: range.end + delta } : null
    }
    if (next && (next.start === next.end || !manuscript.slice(next.start, next.end).trim())) next = null
    return next === range ? scene : { ...scene, range: next }
  })
}

const sameRange = (left, right) => left?.start === right?.start && left?.end === right?.end
const touchesBoundary = (edit, range) => edit && [range.start, range.end].some(offset => edit.start <= offset && offset <= edit.end)
const sceneUndoTextBudget = 16 * 1024 * 1024

export const isSceneHistoryEdit = inputType => inputType === 'historyUndo' || inputType === 'historyRedo'

export function sceneHistoryReplay(history, before, after, inputType) {
  if (!isSceneHistoryEdit(inputType)) return undefined
  const undo = inputType === 'historyUndo'
  const record = undo ? history.findLast(item => !item.undone) : history.find(item => item.undone)
  if (!record) return undefined
  const { edit: forward, removed } = record
  const { start } = forward
  const outgoing = undo ? forward.inserted : removed
  const inserted = undo ? removed : forward.inserted
  const end = start + outgoing.length
  if (before.slice(start, end) !== outgoing || after.slice(start, start + inserted.length) !== inserted ||
      before.slice(0, start) !== after.slice(0, start) || before.slice(end) !== after.slice(start + inserted.length)) return undefined
  const edit = undo ? { start, end, inserted, earliest: forward.earliest } : forward
  return { record, edit }
}

function recordSceneEdit(history, before, prior, scenes, edit, undone = false) {
  const redoStart = history.findIndex(record => record.undone)
  if (redoStart >= 0) history.splice(redoStart)
  const changes = prior.flatMap(({ id, range }, index) => range && (!scenes[index].range || touchesBoundary(edit, range))
    ? [{ id, before: range, after: scenes[index].range }] : [])
  history.push({ edit, removed: before.slice(edit.start, edit.end), changes, undone })
  let remaining = sceneUndoTextBudget
  for (let index = history.length - 1; index >= 0; index--) {
    remaining -= history[index].removed.length + history[index].edit.inserted.length
    if (remaining < 0 || history.length - index > 128) {
      history.splice(0, Math.min(index + 1, history.length - 1))
      break
    }
  }
}

export function rememberUndoneComposition(history, before, composing, scenes, selection) {
  if (!scenes?.length) return
  const edit = manuscriptEdit(before, composing, selection)
  if (edit) recordSceneEdit(history, before, scenes, moveSavedScenes(scenes, edit, composing), edit, true)
}

export function reconcileSceneUndo(history, before, after, prior, scenes, inputType, edit, replay) {
  if (!prior?.length || before === after) return scenes
  if (isSceneHistoryEdit(inputType)) {
    const restore = new Map()
    if (replay) {
      const undo = inputType === 'historyUndo'
      replay.record.undone = undo
      for (const change of replay.record.changes) {
        if (prior.some(scene => scene.id === change.id && sameRange(scene.range, undo ? change.after : change.before))) {
          restore.set(change.id, undo ? change.before : change.after)
        }
      }
    } else history.length = 0
    // A match for one scene does not establish the ownership of restored text in other scenes.
    scenes = scenes.map((scene, index) => {
      const old = prior[index].range
      const absorbs = edit?.inserted && old && scene.range && touchesBoundary(edit, old) &&
        scene.range.start < edit.start + edit.inserted.length && edit.start < scene.range.end
      return restore.has(scene.id) || absorbs ? { ...scene, range: null } : scene
    })
    for (const [id, range] of restore) {
      if (sceneRangeAvailable(scenes, range, id)) scenes = scenes.map(scene => scene.id === id ? { ...scene, range } : scene)
    }
    return scenes
  }
  if (edit) recordSceneEdit(history, before, prior, scenes, edit)
  return scenes
}

export function forgetSceneUndo(history, id) {
  for (const record of history) record.changes = record.changes.filter(change => change.id !== id)
}

export function sceneVersions(versions) {
  return versions.map(({ text, direction, parent, source, truncated }) => ({
    text, direction, parent, ...(source ? { source } : {}), ...(truncated === undefined ? {} : { truncated }),
  }))
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
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
          end > manuscript.length || !manuscript.slice(start, end).trim()) return false
      ranges.push(scene.range)
    }
    if (!scene.versions.every((version, index) => version && typeof version.text === 'string' && version.text.trim() &&
        typeof version.direction === 'string' && version.direction.length <= writingFields.direction &&
        (version.truncated === undefined || typeof version.truncated === 'boolean') &&
        (index === 0 ? version.parent === null : Number.isSafeInteger(version.parent) && version.parent >= 0 && version.parent < index) &&
        (version.source === undefined || version.source === (index === 0 ? 'registered' : 'manual')))) return false
  }
  ranges.sort((a, b) => a.start - b.start)
  return ranges.every((range, index) => index === 0 || ranges[index - 1].end <= range.start)
}

export function normalizeSavedScenes(scenes, manuscript, normalized) {
  const offset = manuscript === normalized ? index => index : index => normalizeLineEndings(manuscript.slice(0, index)).length
  return scenes.map(scene => {
    const start = scene.range && offset(scene.range.start)
    const end = scene.range && offset(scene.range.end)
    return {
      id: scene.id, title: scene.title, range: start < end ? { start, end } : null, accepted: scene.accepted,
      versions: sceneVersions(scene.versions).map(version => ({
        ...version, text: normalizeLineEndings(version.text), direction: normalizeLineEndings(version.direction),
      })),
    }
  })
}
