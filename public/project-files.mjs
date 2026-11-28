import { chunkManuscript, loreKinds, loreLimits, paragraphRanges } from './retrieval.mjs'
import { validModelOptionProfiles } from './model-options.mjs'
import { normalizeSavedScenes, validSavedScenes } from './manuscript-scenes.mjs'
import { attachSceneDocument, projectSceneDocument, validSceneDocument } from './scene-document.mjs'
import { memoryWithKnowledge, validKnowledge } from './memory-knowledge.mjs'
import { validSceneReviews } from './scene-review.mjs'
import { defaultReferences, maxSourceLimits, normalizeLineEndings, noteKinds, optionalProjectModels, systemPromptLimit, validModelId, validSourceLimit, validWritingTokenLimit, writingFields } from './writing-config.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const optional = (value, validate) => value === undefined || validate(value)
const limited = (value, max) => typeof value === 'string' && value.length <= max
const validPrompt = value => limited(value, systemPromptLimit)
const validMode = value => ['once', 'persistent'].includes(value)
const validBoolean = value => typeof value === 'boolean'
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const promptKeys = ['systemPrompt', 'notePrompts', 'references', 'authorMode']
const legacyNoteKinds = { characterNotes: 'character', worldNotes: 'world' }
const legacyNoteLimit = 12_000
const legacyReferences = ['synopsis', ...Object.keys(legacyNoteKinds), ...defaultReferences]
const projectKeys = [
  'title', 'synopsis', 'model', 'maxTokens', 'manuscript', 'direction', 'sceneLength', 'legacySceneNotes',
  'manuscriptMemory', 'autoMemory', 'lorebook', 'search', 'sourceLimits', 'modelOptions', 'savedScenes', 'sceneReviews', 'sceneDocument',
  ...optionalProjectModels, ...promptKeys,
]
const loreCardFieldKeys = ['name', 'aliases', 'kind', 'description', 'priority', 'always']
const cardKeys = ['id', ...loreCardFieldKeys]
export const loreCardFields = card => pick(card, loreCardFieldKeys)

export function defaultReferenceSettings() {
  return defaultReferences.map(key => ({ key, enabled: true }))
}

export const referenceSettingsFor = project => project.references ?? defaultReferenceSettings()

function validReferences(refs) {
  if (!Array.isArray(refs)) return false
  const keys = refs.length === defaultReferences.length ? defaultReferences : legacyReferences
  return refs.length === keys.length && new Set(refs.map(entry => entry?.key)).size === keys.length &&
    refs.every(entry => keys.includes(entry?.key) && validBoolean(entry.enabled))
}

const currentReferences = refs => refs.filter(ref => defaultReferences.includes(ref.key)).map(ref => pick(ref, ['key', 'enabled']))

export function validLoreCard(card) {
  return record(card) && limited(card.id, 100) && Boolean(card.id) && validLoreCardFields(card)
}

export function validLoreCardFields(card, { allowIncomplete = false } = {}) {
  return record(card) && limited(card.name, loreLimits.names) && (allowIncomplete || Boolean(card.name.trim())) &&
    Array.isArray(card.aliases) && card.aliases.length <= loreLimits.aliases &&
    card.aliases.every(alias => limited(alias, loreLimits.names) && Boolean(alias.trim())) &&
    typeof card.kind === 'string' && Object.hasOwn(loreKinds, card.kind) && limited(card.description, loreLimits.description) &&
    (allowIncomplete || Boolean(card.description.trim())) &&
    Number.isInteger(card.priority) && card.priority >= -100 && card.priority <= 100 && validBoolean(card.always)
}

function validLore(cards) {
  return Array.isArray(cards) && cards.every(validLoreCard) &&
    new Set(cards.map(card => card.id)).size === cards.length
}

function validPrompts(source) {
  const { systemPrompt, notePrompts, references, authorMode } = source
  return optional(systemPrompt, validPrompt) && optional(references, validReferences) && optional(authorMode, validMode) &&
    optional(notePrompts, prompts => record(prompts) && Object.entries(prompts).every(([key, text]) =>
      (['memory', 'revision', 'lore'].includes(key) || Object.hasOwn(noteKinds, key) || Object.hasOwn(legacyNoteKinds, key)) &&
        validPrompt(text)))
}

function validNotePins(pins) {
  return record(pins) && Object.entries(pins).every(([key, paragraphs]) =>
    (Object.hasOwn(noteKinds, key) || Object.hasOwn(legacyNoteKinds, key)) && Array.isArray(paragraphs) &&
    paragraphs.every(text => typeof text === 'string' && Boolean(text.trim())) &&
    new Set(paragraphs).size === paragraphs.length &&
    paragraphs.join('\n\n').length <= (key === 'synopsis' ? writingFields.synopsis : legacyNoteLimit))
}

export function hasSceneNote(note) {
  return typeof note?.title === 'string' && typeof note.direction === 'string'
}

export function validProjectBase(project) {
  return record(project) && limited(project.id, 100) && Boolean(project.id) && validModelId(project.model) &&
    validWritingTokenLimit(project.maxTokens) && typeof project.title === 'string' && typeof project.synopsis === 'string' &&
    Object.keys(legacyNoteKinds).every(key => optional(project[key], value => typeof value === 'string')) &&
    validPrompts(project) && optional(project.pinnedNoteParagraphs, validNotePins)
}

export function validProject(project) {
  if (!validProjectBase(project) || typeof project.direction !== 'string') return false
  const canonical = project.sceneDocument !== undefined
  if (canonical && !validSceneDocument(project.sceneDocument)) return false
  const manuscript = canonical ? projectSceneDocument(project.sceneDocument).manuscript : project.manuscript
  if (typeof manuscript !== 'string') return false
  return optional(project.sceneLength, value => limited(value, writingFields.sceneLength)) &&
    optional(project.autoMemory, validBoolean) && optional(project.lorebook, validLore) &&
    optional(project.modelOptions, validModelOptionProfiles) &&
    optional(project.sourceLimits, limits => record(limits) &&
      Object.keys(maxSourceLimits).every(field => validSourceLimit(field, limits[field]))) &&
    optionalProjectModels.every(key => optional(project[key], validModelId)) &&
    optional(project.search, value => record(value) && validBoolean(value.enabled) && validModelId(value.model)) &&
    optional(project.legacySceneNotes, notes => Array.isArray(notes) && notes.every(hasSceneNote)) &&
    (canonical || optional(project.savedScenes, scenes => validSavedScenes(scenes, manuscript))) &&
    optional(project.sceneReviews, validSceneReviews) &&
    optional(project.manuscriptMemory, memo => record(memo) && limited(memo.text, writingFields.manuscriptMemory) &&
      optional(memo.knowledge, knowledge => validKnowledge(knowledge) &&
        memoryWithKnowledge(memo.text, knowledge).length <= writingFields.manuscriptMemory) &&
      validBoolean(memo.stale) && Number.isSafeInteger(memo.through) && memo.through >= 0 &&
      (memo.stale || memo.through <= manuscript.length))
}

function noteSections(text) {
  const headings = [...text.matchAll(/^(?:#{1,6}[ \t]+([^\n]+)|([^\n:：]{1,100})[:：])/gm)]
  if (headings[0]?.index !== 0) headings.unshift({ index: 0 })
  return headings.map((heading, index) => ({
    title: (heading[1] ?? heading[2] ?? '').trim(),
    text: text.slice(heading.index, headings[index + 1]?.index).trim(),
  }))
}

function migrateProjectNotes(project) {
  if (project.references) project.references = currentReferences(project.references)
  if (!Object.keys(legacyNoteKinds).some(key => Object.hasOwn(project, key))) {
    delete project.pinnedNoteParagraphs
    return
  }
  const cards = project.lorebook ?? []
  const ids = new Set(cards.map(card => card.id))
  for (const [key, kind] of Object.entries(legacyNoteKinds)) {
    let index = 0
    let sequence = 0
    const pins = new Set(project.pinnedNoteParagraphs?.[key]?.map(normalizeLineEndings))
    for (const paragraph of paragraphRanges(normalizeLineEndings(project[key] ?? ''))) {
      const always = pins.has(paragraph.text)
      for (const section of noteSections(paragraph.text)) {
        const title = (section.title || `${loreKinds[kind]} 메모 ${++sequence}`).slice(0, loreLimits.names).toWellFormed()
        const pieces = section.text.length <= loreLimits.description ? [section.text]
          : chunkManuscript(section.text).map(piece => piece.text).filter(text => text.trim())
        for (const [part, description] of pieces.entries()) {
          let id
          do { id = `legacy-${kind}-${++index}` } while (ids.has(id))
          ids.add(id)
          const suffix = part ? ` (${part + 1})` : ''
          const name = title.slice(0, loreLimits.names - suffix.length).toWellFormed() + suffix
          cards.push({ id, kind, name, aliases: part ? [title] : [], description, priority: 0, always })
        }
      }
    }
    delete project[key]
  }
  if (cards.length) project.lorebook = cards
  delete project.pinnedNoteParagraphs
}

export function normalizeProject(project) {
  if (project.sceneDocument) {
    migrateProjectNotes(project)
    return attachSceneDocument(project)
  }
  const manuscript = normalizeLineEndings(project.manuscript)
  project.savedScenes = normalizeSavedScenes(project.savedScenes, project.manuscript, manuscript)
  if (manuscript !== project.manuscript) {
    const memory = project.manuscriptMemory
    if (memory && !memory.stale) {
      memory.through = normalizeLineEndings(project.manuscript.slice(0, memory.through)).length
    }
    if (project.sceneReviews) {
      const normalizeEvidence = entry => ({
        ...entry, evidence: Array.isArray(entry.evidence)
          ? entry.evidence.map(item => ({ ...item, text: normalizeLineEndings(item.text) }))
          : normalizeLineEndings(entry.evidence),
      })
      project.sceneReviews = project.sceneReviews.map(review => ({
        ...review, progress: review.progress.map(normalizeEvidence), lore: review.lore.map(normalizeEvidence),
        planChange: review.planChange && normalizeEvidence(review.planChange),
      }))
    }
    project.manuscript = manuscript
  }
  migrateProjectNotes(project)
  return project
}

function clean(source, keys) {
  const storedKeys = source.sceneDocument ? keys.filter(key => key !== 'manuscript' && key !== 'savedScenes') : keys
  const result = structuredClone(pick(source, storedKeys))
  if (result.lorebook) result.lorebook = result.lorebook.map(card => pick(card, cardKeys))
  if (result.references) result.references = currentReferences(result.references)
  if (result.search) result.search = pick(result.search, ['enabled', 'model'])
  if (result.sourceLimits) result.sourceLimits = pick(result.sourceLimits, Object.keys(maxSourceLimits))
  if (result.manuscriptMemory) {
    result.manuscriptMemory = pick(result.manuscriptMemory, ['text', 'through', 'stale', 'knowledge'])
    if (result.manuscriptMemory.knowledge) result.manuscriptMemory.knowledge = result.manuscriptMemory.knowledge
      .map(item => pick(item, ['fact', 'knows', 'unaware', 'exclusive']))
  }
  const reviewEntry = (entry, fields) => {
    const cleaned = pick(entry, [...fields, 'evidence'])
    if (Array.isArray(cleaned.evidence)) cleaned.evidence = cleaned.evidence.map(ref => pick(ref, ['text', 'occurrence']))
    return cleaned
  }
  if (result.sceneReviews) result.sceneReviews = result.sceneReviews.map(review => ({
    ...pick(review, ['sceneId', 'version', 'pending', 'reviewedText']),
    progress: review.progress.map(item => reviewEntry(item, ['milestone'])),
    planChange: review.planChange && reviewEntry(review.planChange, ['before', 'after']),
    lore: review.lore.map(item => reviewEntry(item, ['id', 'targetId', 'kind', 'name', 'before', 'description', 'conflict'])),
  }))
  if (result.legacySceneNotes) result.legacySceneNotes = result.legacySceneNotes.map(note => pick(note, ['title', 'direction']))
  return result
}

function readVersion(text, kind) {
  let file
  try { file = JSON.parse(text) } catch { throw new Error('유효한 JSON 파일을 선택해 주세요.') }
  if (file?.kind !== kind) throw new Error('선택한 파일의 종류가 맞지 않아요.')
  if (file.version !== 1) throw new Error('이 파일의 버전은 지원하지 않아요.')
  return file
}

export function exportProject(project) {
  return { kind: 'relay-project', version: 1, project: clean(project, projectKeys) }
}

export function readProject(text) {
  return restoreProject(readVersion(text, 'relay-project').project)
}

export function restoreProject(source) {
  const data = { ...source, id: crypto.randomUUID() }
  if (!validProject(data)) throw new Error('원고나 작품 설정의 형식이 올바르지 않아요.')
  const project = { ...clean(normalizeProject(data), projectKeys), id: data.id }
  return project.sceneDocument ? attachSceneDocument(project) : project
}

export function exportPack(project, { lorebook, prompts }) {
  if (!lorebook && !prompts) throw new Error('로어북이나 프롬프트를 하나 이상 선택해 주세요.')
  const settings = {}
  if (lorebook) settings.lorebook = clean({ lorebook: project.lorebook ?? [] }, ['lorebook']).lorebook
  if (prompts) settings.prompts = clean(project, promptKeys)
  return { kind: 'relay-settings', version: 1, settings }
}

export function readPack(text, { lorebook, prompts }) {
  const { settings } = readVersion(text, 'relay-settings')
  if (!record(settings) || (!Object.hasOwn(settings, 'lorebook') && !Object.hasOwn(settings, 'prompts')) ||
      !optional(settings.lorebook, validLore) || !optional(settings.prompts, value => record(value) && validPrompts(value))) {
    throw new Error('로어북 또는 프롬프트 설정의 형식이 올바르지 않아요.')
  }
  const selectedLore = lorebook && settings.lorebook !== undefined
  const selectedPrompts = prompts && settings.prompts !== undefined
  if (!selectedLore && !selectedPrompts) throw new Error('이 파일에 선택한 항목이 들어 있지 않아요.')
  const promptSettings = selectedPrompts ? clean(settings.prompts, promptKeys) : null
  return {
    ...(selectedLore ? clean(settings, ['lorebook']) : {}),
    ...(promptSettings ? Object.fromEntries(promptKeys.map(key => [key, promptSettings[key]])) : {}),
  }
}
