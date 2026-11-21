import { loreKinds, loreLimits } from './retrieval.mjs'
import { validModelOptionProfiles } from './model-options.mjs'
import { defaultReferences, maxSourceLimits, normalizeLineEndings, noteKinds, optionalProjectModels, systemPromptLimit, validModelId, validSourceLimit, writingFields, writingTokenLimits } from './writing-config.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const optional = (value, validate) => value === undefined || validate(value)
const limited = (value, max) => typeof value === 'string' && value.length <= max
const validPrompt = value => limited(value, systemPromptLimit)
const validMode = value => ['once', 'persistent'].includes(value)
const validBoolean = value => typeof value === 'boolean'
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const promptKeys = ['systemPrompt', 'notePrompts', 'references', 'authorMode']
const projectKeys = [
  'title', 'synopsis', 'characterNotes', 'worldNotes', 'model', 'maxTokens', 'manuscript', 'direction', 'legacySceneNotes',
  'manuscriptMemory', 'autoMemory', 'lorebook', 'search', 'sourceLimits', 'modelOptions', ...optionalProjectModels, ...promptKeys,
]
const loreCardFieldKeys = ['name', 'aliases', 'kind', 'description', 'priority', 'always']
const cardKeys = ['id', ...loreCardFieldKeys]
export const loreCardFields = card => pick(card, loreCardFieldKeys)

export function defaultReferenceSettings() {
  return defaultReferences.map(key => ({ key, enabled: true }))
}

function validReferences(refs) {
  return Array.isArray(refs) && refs.length === defaultReferences.length &&
    new Set(refs.map(entry => entry?.key)).size === defaultReferences.length && refs.every(entry =>
      defaultReferences.includes(entry?.key) && validBoolean(entry.enabled))
}

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
  return Array.isArray(cards) && cards.length <= loreLimits.cards && cards.every(validLoreCard) &&
    new Set(cards.map(card => card.id)).size === cards.length
}

function validPrompts(source) {
  const { systemPrompt, notePrompts, references, authorMode } = source
  return optional(systemPrompt, validPrompt) && optional(references, validReferences) && optional(authorMode, validMode) &&
    optional(notePrompts, prompts => record(prompts) && Object.entries(prompts).every(([key, text]) =>
      (['memory', 'revision', 'lore'].includes(key) || Object.hasOwn(noteKinds, key)) && validPrompt(text)))
}

export function hasSceneNote(note) {
  return typeof note?.title === 'string' && typeof note.direction === 'string'
}

export function validProjectBase(project) {
  return record(project) && limited(project.id, 100) && Boolean(project.id) && validModelId(project.model) &&
    writingTokenLimits.includes(project.maxTokens) && ['title', 'synopsis', 'worldNotes'].every(key =>
      typeof project[key] === 'string') && optional(project.characterNotes, value => typeof value === 'string') &&
    validPrompts(project)
}

export function validProject(project) {
  if (!validProjectBase(project) || typeof project.manuscript !== 'string' || typeof project.direction !== 'string') return false
  return optional(project.autoMemory, validBoolean) && optional(project.lorebook, validLore) &&
    optional(project.modelOptions, validModelOptionProfiles) &&
    optional(project.sourceLimits, limits => record(limits) &&
      Object.keys(maxSourceLimits).every(field => validSourceLimit(field, limits[field]))) &&
    optionalProjectModels.every(key => optional(project[key], validModelId)) &&
    optional(project.search, value => record(value) && validBoolean(value.enabled) && validModelId(value.model)) &&
    optional(project.legacySceneNotes, notes => Array.isArray(notes) && notes.every(hasSceneNote)) &&
    optional(project.manuscriptMemory, memo => record(memo) && limited(memo.text, writingFields.manuscriptMemory) &&
      validBoolean(memo.stale) && Number.isSafeInteger(memo.through) && memo.through >= 0 &&
      (memo.stale || memo.through <= project.manuscript.length))
}

export function normalizeProjectManuscript(project) {
  const manuscript = normalizeLineEndings(project.manuscript)
  if (manuscript !== project.manuscript) {
    const memory = project.manuscriptMemory
    if (memory && !memory.stale) {
      memory.through = normalizeLineEndings(project.manuscript.slice(0, memory.through)).length
    }
    project.manuscript = manuscript
  }
  return project
}

function clean(source, keys) {
  const result = structuredClone(pick(source, keys))
  if (result.lorebook) result.lorebook = result.lorebook.map(card => pick(card, cardKeys))
  if (result.references) result.references = result.references.map(ref => pick(ref, ['key', 'enabled']))
  if (result.search) result.search = pick(result.search, ['enabled', 'model'])
  if (result.sourceLimits) result.sourceLimits = pick(result.sourceLimits, Object.keys(maxSourceLimits))
  if (result.manuscriptMemory) result.manuscriptMemory = pick(result.manuscriptMemory, ['text', 'through', 'stale'])
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
  const file = readVersion(text, 'relay-project')
  const data = { ...file.project, id: crypto.randomUUID() }
  if (!validProject(data)) throw new Error('원고나 작품 설정의 형식이 올바르지 않아요.')
  return normalizeProjectManuscript({ ...clean(data, projectKeys), id: data.id })
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
