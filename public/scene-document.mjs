import { sceneSplitRanges, sceneTitle } from './manuscript-scenes.mjs'

const whitespace = value => typeof value === 'string' && /^[ \n\t]*$/.test(value)
const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value)
const validText = value => typeof value === 'string' && !value.includes('\r')
const newId = () => globalThis.crypto.randomUUID()

function newScene(text, source, origins = []) {
  return {
    id: newId(), text, accepted: 0, origins,
    versions: [{ text, direction: '', parent: null, source }],
  }
}

export function createSceneDocument(text = '') {
  const scene = newScene(text, 'registered')
  return { order: [{ id: scene.id, before: '' }], scenes: { [scene.id]: scene }, past: [], future: [] }
}

const projections = new WeakMap()
export function projectSceneDocument(document) {
  if (projections.has(document)) return projections.get(document)
  let offset = 0
  const parts = []
  const savedScenes = document.order.map(({ id, before }) => {
    const scene = document.scenes[id]
    const start = offset + before.length
    offset = start + scene.text.length
    parts.push(before, scene.text)
    return { ...scene, title: sceneTitle(scene.text), range: { start, end: offset } }
  })
  const projection = { manuscript: parts.join(''), savedScenes }
  projections.set(document, projection)
  return projection
}

export function attachSceneDocument(project) {
  for (const key of ['manuscript', 'savedScenes']) {
    Object.defineProperty(project, key, {
      configurable: true, enumerable: false,
      get() { return projectSceneDocument(this.sceneDocument)[key] },
    })
  }
  return project
}

export function validSceneDocument(document) {
  if (!document || !document.scenes || Array.isArray(document.scenes) || typeof document.scenes !== 'object') return false
  const { order, scenes, past, future } = document
  const hasScene = id => validId(id) && Object.hasOwn(scenes, id)
  const hasVersion = (id, version) => hasScene(id) && Number.isInteger(version) && Boolean(scenes[id]?.versions?.[version])
  const validSlots = slots => Array.isArray(slots) &&
    slots.every(slot => slot && hasScene(slot.id) && whitespace(slot.before)) &&
    new Set(slots.map(slot => slot.id)).size === slots.length
  const validCheckpoint = checkpoints => Array.isArray(checkpoints) &&
    checkpoints.every(entry => entry && hasVersion(entry.id, entry.version))
  const validHistory = history => Array.isArray(history) && history.every(entry => entry &&
    ['add', 'split', 'merge', 'delete'].includes(entry.kind) &&
    Number.isSafeInteger(entry.index) && entry.index >= 0 &&
    validSlots(entry.before) && validSlots(entry.after) && validCheckpoint(entry.sources) && validCheckpoint(entry.results))
  return Object.entries(scenes).every(([id, scene]) => scene?.id === id && validId(id) && validText(scene.text) &&
    Array.isArray(scene.versions) && hasVersion(id, scene.accepted) &&
    scene.versions.every((version, index) => version && validText(version.text) &&
      typeof version.direction === 'string' && (index === 0 ? version.parent === null :
        Number.isInteger(version.parent) && version.parent >= 0 && version.parent < index)) &&
    validCheckpoint(scene.origins)) && validSlots(order) && order.length > 0 && validHistory(past) && validHistory(future)
}

export function checkpointScene(scene) {
  if (scene.versions[scene.accepted].text === scene.text) return scene
  const accepted = scene.versions.length
  return {
    ...scene, accepted,
    versions: [...scene.versions, { text: scene.text, direction: '', parent: scene.accepted, source: 'manual' }],
  }
}

export function editSceneDocument(document, id, text) {
  const scene = document.scenes[id]
  return scene && scene.text !== text ? { ...document, scenes: { ...document.scenes, [id]: { ...scene, text } } } : document
}

export function saveSceneVersion(document, id, text, versions, selected, current = document.scenes[id].accepted) {
  const scene = document.scenes[id]
  if (selected < scene.versions.length) {
    versions = [...versions, { text, direction: '', parent: current, source: 'restored' }]
    selected = versions.length - 1
  }
  return { ...document, scenes: { ...document.scenes, [id]: { ...scene, text, versions, accepted: selected } } }
}

function recordStructure(document, kind, order, sourceIds, created) {
  const sources = sourceIds.map(id => checkpointScene(document.scenes[id]))
  const results = created.map(scene => ({ ...scene, origins: sources.map(({ id, accepted }) => ({ id, version: accepted })) }))
  const scenes = { ...document.scenes }
  for (const scene of [...sources, ...results]) scenes[scene.id] = scene
  let index = 0
  let oldEnd = document.order.length
  let newEnd = order.length
  while (index < Math.min(oldEnd, newEnd) && document.order[index] === order[index]) index++
  while (oldEnd > index && newEnd > index && document.order[oldEnd - 1] === order[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const entry = {
    kind, index, before: document.order.slice(index, oldEnd), after: order.slice(index, newEnd),
    sources: sources.map(({ id, accepted }) => ({ id, version: accepted })),
    results: results.map(({ id, accepted }) => ({ id, version: accepted })),
  }
  return { ...document, order, scenes, past: [...document.past, entry], future: [] }
}

export function insertScene(document, beforeId) {
  const index = beforeId ? document.order.findIndex(slot => slot.id === beforeId) : document.order.length
  if (index < 0) return null
  const scene = newScene('', 'registered')
  const order = document.order.slice()
  const next = order[index]
  order.splice(index, 1, { id: scene.id, before: next?.before || (index ? '\n\n' : '') },
    ...(next ? [{ ...next, before: '\n\n' }] : []))
  return { document: recordStructure(document, 'add', order, [], [scene]), focus: scene.id }
}

export function appendWrittenScene(document, text, versions, selected, before) {
  const scene = { ...newScene(text, 'registered'), versions, accepted: selected }
  const order = [...document.order, { id: scene.id, before }]
  return { document: recordStructure(document, 'add', order, [], [scene]), focus: scene.id }
}

export function splitScene(document, id, offset) {
  const index = document.order.findIndex(slot => slot.id === id)
  const scene = document.scenes[id]
  if (index < 0 || !sceneSplitRanges(scene.text, { start: 0, end: scene.text.length }, offset)) return null
  const left = newScene(scene.text.slice(0, offset), 'split')
  const right = newScene(scene.text.slice(offset), 'split')
  const order = document.order.slice()
  order.splice(index, 1, { id: left.id, before: order[index].before }, { id: right.id, before: '' })
  return { document: recordStructure(document, 'split', order, [id], [left, right]), focus: right.id }
}

export function consecutiveScenes(document, ids) {
  const selected = document.order.filter(slot => ids.has(slot.id))
  return selected.length >= 2 && selected.length === ids.size &&
    document.order.indexOf(selected.at(-1)) - document.order.indexOf(selected[0]) === selected.length - 1 ? selected : []
}

export function mergeScenes(document, ids) {
  const selected = consecutiveScenes(document, ids)
  if (!selected.length) return null
  const text = selected.map(({ id, before }, index) => (index ? before : '') + document.scenes[id].text).join('')
  const merged = newScene(text, 'merge')
  const order = document.order.slice()
  order.splice(order.indexOf(selected[0]), selected.length, { id: merged.id, before: selected[0].before })
  return { document: recordStructure(document, 'merge', order, selected.map(slot => slot.id), [merged]), focus: merged.id }
}

export function removeScenes(document, ids) {
  const first = document.order.findIndex(slot => ids.has(slot.id))
  if (first < 0) return null
  const order = document.order.filter(slot => !ids.has(slot.id))
  const created = []
  if (!order.length) {
    created.push(newScene('', 'registered'))
    order.push({ id: created[0].id, before: '' })
  } else if (first === 0) {
    order[0] = { ...order[0], before: '' }
  }
  return {
    document: recordStructure(document, 'delete', order, document.order.filter(slot => ids.has(slot.id)).map(slot => slot.id), created),
    focus: order[Math.min(first, order.length - 1)].id,
  }
}

export function moveSceneStructure(document, direction) {
  const undo = direction === 'undo'
  const entry = (undo ? document.past : document.future).at(-1)
  if (!entry) return null
  const { index, before, after, sources, results } = entry
  const from = undo ? after : before
  const leaving = undo ? results : sources
  if (index + from.length > document.order.length ||
      from.some(({ id, before }, position) => {
        const slot = document.order[index + position]
        return id !== slot.id || before !== slot.before
      }) ||
      leaving.some(({ id, version }) => document.scenes[id].text !== document.scenes[id].versions[version].text)) return null
  const order = document.order.slice()
  order.splice(index, from.length, ...(undo ? before : after))
  if (!order.length) return null
  const entering = undo ? sources : results
  const focusId = entering[0]?.id ?? order[Math.min(index, order.length - 1)].id
  const past = undo ? document.past.slice(0, -1) : [...document.past, entry]
  const future = undo ? [...document.future, entry] : document.future.slice(0, -1)
  return { document: { ...document, order, past, future }, focus: focusId }
}

// The native textarea is a view of the manuscript. An edit can replace text
// within one scene body, including trailing newlines, but never a separator.
export function sceneForEdit(scenes, { start, end }, preferred) {
  const contains = ({ range }) => range.start <= start && end <= range.end
  return scenes.find(scene => scene.id === preferred && contains(scene)) ?? scenes.findLast(contains)
}
