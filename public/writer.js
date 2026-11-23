import { freeModel, requestCompletion, settingsChangeEvent } from './completion.js'
import { withModelOptions } from './model-options.mjs'
import {
  appendParagraphs, completionPayload, defaultLoreSystemPrompt, defaultMemoryPrompt, defaultNoteSystemPrompt, defaultRevisionPrompt, defaultSystemPrompt,
  effectiveSystemPrompt, modelFor, normalizeLineEndings, noteDraftActions, noteKinds,
  sceneDraftLimit, systemPromptLimit, writingFieldPrefix, writingFields,
} from './writing-config.mjs'
import { assistantMessageLimit, assistantNoteDraftLimit, assistantProjectContext, createWritingAssistant, projectNotesLimitHint } from './writing-assistant.mjs'
import { memoryForPrompt, memoryReadThrough, memoryRequest, setManuscriptText, updateManuscriptMemory } from './manuscript-memory.mjs'
import { manuscriptMemoryPayload } from './memory-knowledge.mjs'
import {
  forgetSceneUndo, isSceneHistoryEdit, manuscriptEdit, reconcileSceneUndo, rememberUndoneComposition,
  savedScenesInManuscriptOrder, sceneHistoryReplay, sceneRange, sceneRangeAvailable, sceneTitle, sceneVersionPath, sceneVersions,
} from './manuscript-scenes.mjs'
import { sceneRevisionHistory, setupDraftChanges } from './draft-changes.mjs'
import { exportPack, exportProject, readPack, readProject, referenceSettingsFor } from './project-files.mjs'
import { currentProjectOf, makeProject, mergeModelSettings, projectName, readWorkspace, workspaceMatchesSnapshot } from './writing-workspace.mjs'
import { cacheWorkspace, openWorkspaceStorage, readCachedWorkspace, readLatestWorkspace, storageConflictMessage, storageKey, workspaceChangeEvent, workspaceStatusEvent, workspaceStorageStatus } from './workspace-storage.mjs'
import { setupResearch } from './research-panel.mjs'
import { setupLorebook } from './lorebook-panel.mjs'
import { setupLoreReviews } from './lore-review-panel.mjs'
import { setupPlanProgress } from './plan-progress.mjs'
import { markSceneForReview } from './scene-review.mjs'
import { setupSceneReviewJobs } from './scene-review-jobs.mjs'
import { setupSourcePanel } from './source-panel.mjs'
import { paragraphRanges } from './retrieval.mjs'
import { combineUsage, completionEstimate, estimateLabel, jsonRequest, usageLabel } from './request-tools.mjs'

const get = id => document.getElementById(id)

const projectSelect = get('project-select')
const manuscript = get('manuscript')
const manuscriptInner = manuscript.closest('.manuscript-inner')
const manuscriptEditor = manuscript.closest('.manuscript-editor')
const manuscriptLines = get('manuscript-lines')
const manuscriptSceneMarks = get('manuscript-scene-marks')
const svgNamespace = 'http://www.w3.org/2000/svg'
const revisionLine = get('revision-line')
const projectTitle = get('project-title')
const projectTitleDialog = get('project-title-dialog')
const promptTarget = get('prompt-target')
const systemPrompt = get('system-prompt')
const resetSystemPrompt = get('reset-system-prompt')
const promptDialog = get('prompt-dialog')
let promptEditorMode = 'manuscript'
const projectNoteDialog = get('project-note-dialog')
const projectNoteContent = get('project-note-content')
const projectNoteSections = [...projectNoteContent.querySelectorAll('[data-project-note]')]
const generate = get('generate')
const stopWriting = get('stop-writing')
const writingStatus = get('writing-status')
const continuationHistory = get('continuation-history')
const continuationDirection = get('continuation-direction')
const continuationPrevious = get('continuation-previous')
const renderDraftChanges = setupDraftChanges(get)
const continuationRewrite = get('continuation-rewrite')
const continuationStop = get('continuation-stop')
const continuationAccept = get('continuation-accept')
const continuationDiscard = get('continuation-discard')
const scenesPanel = get('scenes-panel')
const savedSceneList = get('saved-scene-list')
const sceneRewrite = get('saved-scene-rewrite')
const sceneRegister = get('scene-register')
const sceneConfirmRange = get('scene-confirm-range')
const revisionProposal = {
  section: get('revision-proposal'),
  title: get('revision-proposal-title'),
  model: get('revision-proposal-model'),
  status: get('revision-proposal-status'),
  usage: get('revision-proposal-usage'),
  body: get('revision-proposal-body'),
  stop: get('revision-proposal-stop'),
  discard: get('revision-proposal-discard'),
  accept: get('revision-proposal-accept'),
}
const notePlanner = get('note-planner')
const manuscriptTab = get('manuscript-tab')
const noteWorkspaceTab = get('note-workspace-tab')
const loreWorkspaceTab = get('lore-workspace-tab')
const workspaceTabs = [manuscriptTab, noteWorkspaceTab, loreWorkspaceTab]
let activeWorkspaceTab = manuscriptTab
const writingTools = get('writing-tools')
const toolButtons = [...writingTools.querySelectorAll('[data-panel]')]
let manuscriptPanel = 'tools'
const planStatus = get('plan-status')
const planAction = get('plan-action')
const planIdea = get('plan-idea')
const planGenerate = get('plan-generate')
const planSend = get('plan-send')
const planStop = get('plan-stop')
const planReset = get('plan-reset')
const planTranscript = get('plan-transcript')
const planDraftText = get('note-draft-text')
const planAccept = get('plan-accept')
const planUndoReplacement = get('plan-undo-replacement')
const memoryPanel = get('manuscript-memory')
const memoryAuto = get('memory-auto')
const memoryRefresh = get('memory-refresh')
const memoryStop = get('memory-stop')
const memoryStatus = get('memory-status')
const memoryText = get('memory-text')
const formatNumber = new Intl.NumberFormat('ko-KR')
let revisionDraft
const continuations = new Map()
const writingContextChanged = '원고나 참고 설정이 바뀌었어요. 현재 설정에서 다시 요청해 주세요.'
const selectedScenes = new WeakMap()
const sceneMessages = new WeakMap()
const sceneUndo = []
let manuscriptSelectionBeforeEdit
let manuscriptComposition
const composingManuscript = () => manuscriptComposition && manuscript.value !== manuscriptComposition.project.manuscript
const plans = new WeakMap()
const memoryJobs = new WeakMap()
let models = [freeModel]
let activeRequest
const manuscriptCommitPending = () => ['continuation-save', 'scene-registration'].includes(activeRequest?.kind)
let activePreview
let previewOrigin
const addedLoreCards = new WeakMap()
let revisionSelection
let indexedManuscript
let manuscriptLineStarts = [0]
let manuscriptMarksFrame
let pendingContinuationStart
let savedVersion
let storageReadable = true
let storageWarning = ''

function loadWorkspace() {
  try {
    savedVersion = readCachedWorkspace()
    return readWorkspace(savedVersion)
  } catch {
    storageReadable = false
    storageWarning = '저장된 작업 공간을 열 수 없어요.'
    const project = makeProject()
    return { activeProjectId: project.id, projects: [project] }
  }
}

await openWorkspaceStorage()
const workspace = loadWorkspace()
const openedSnapshot = storageReadable && savedVersion != null ? savedVersion : JSON.stringify(workspace)
const currentProject = () => currentProjectOf(workspace)
const currentContinuation = () => continuations.get(currentProject())
const planAssistant = createWritingAssistant({
  transcript: planTranscript,
  scrollport: get('plan-conversation'),
  status: planStatus,
  onChange: syncControls,
  onReply({ draft, truncated }, { noteAction, target, context }) {
    if (noteAction === 'replace' && truncated) {
      planStatus.textContent = currentPlanEntry().drafts.replace
        ? '새 수정안이 출력 한도에 걸렸어요. 화면에는 직전 수정안이 표시돼요.'
        : '수정안이 출력 한도에 걸렸어요. 더 짧게 요청하거나 생성 한도를 올려 주세요.'
      return
    }
    if (draft === null) return
    currentPlanEntry().drafts[noteAction] = { text: draft, original: context[target] }
    renderPlanDraft()
  },
})

function showStorageStatus() {
  activeRequest?.cancelPreparation?.()
  const status = workspaceStorageStatus()
  const warning = storageWarning || status.warning
  get('storage-error').hidden = !warning
  const message = get('storage-error-message')
  if (message.textContent !== warning) message.textContent = warning
  const label = warning ? '저장 상태 확인' : status.saving ? '서버에 저장 중…'
    : status.persisted ? '서버에 저장됨' : '저장 전'
  if (get('save-status').textContent !== label) get('save-status').textContent = label
}

const hasUnsavedWorkspace = () => !workspaceMatchesSnapshot(workspace, storageReadable ? savedVersion ?? openedSnapshot : openedSnapshot)

function syncSavedWorkspace(latest) {
  if (!storageReadable) return false
  let changed
  if (latest !== savedVersion) {
    try {
      changed = mergeModelSettings(workspace, savedVersion, latest)
    } catch {
      return false
    }
    if (!changed) return false
    savedVersion = latest
  }
  // A recovered snapshot does not recover an edit that was rejected in this tab.
  if (storageWarning === storageConflictMessage && !hasUnsavedWorkspace()) storageWarning = ''
  if (changed?.has(currentProject().id)) writingInputsChanged()
  return true
}

async function saveWorkspace(change) {
  if (storageReadable) {
    let previousVersion
    let nextVersion
    let rollback
    try {
      await cacheWorkspace(latest => {
        if (!syncSavedWorkspace(latest)) throw new Error(storageConflictMessage)
        previousVersion = savedVersion
        rollback = change?.()
        nextVersion = JSON.stringify(workspace)
        savedVersion = nextVersion
        return nextVersion
      })
      storageWarning = ''
    } catch (error) {
      if (nextVersion !== undefined && savedVersion === nextVersion) {
        rollback?.()
        savedVersion = previousVersion
      }
      storageWarning = error.message === storageConflictMessage ? storageConflictMessage : '브라우저에 저장할 수 없어요.'
    }
  }
  showStorageStatus()
  return !storageWarning
}

function renderProjectSelect() {
  projectSelect.replaceChildren(...workspace.projects.map(project => new Option(projectName(project), project.id)))
  projectSelect.value = currentProject().id
  get('active-project-name').textContent = projectName(currentProject())
}

function renderLegacySceneNotes(notes = []) {
  get('open-legacy-notes').hidden = !notes.length
  get('legacy-notes-list').replaceChildren(...notes.map(note => {
    const row = document.createElement('li')
    const title = document.createElement('strong')
    title.textContent = note.title
    row.append(title)
    if (note.direction) {
      const direction = document.createElement('p')
      direction.className = 'field-hint'
      direction.textContent = note.direction
      row.append(direction)
    }
    return row
  }))
}

function switchPanel(name = manuscriptPanel) {
  if (name === 'continuation' && get('continuation-tab').hidden) {
    name = currentContinuation()?.previousPanel ?? 'tools'
  }
  if (notePlanner.hidden) manuscriptPanel = name
  const panel = notePlanner.hidden ? manuscriptPanel : 'notes'
  for (const button of toolButtons) {
    const selected = button.dataset.panel === panel
    button.setAttribute('aria-pressed', String(selected))
    get(button.getAttribute('aria-controls')).hidden = !selected
  }
  writingTools.scrollTop = 0
  syncSceneControls()
}

function selectProjectNote(key) {
  for (const section of projectNoteSections) {
    section.hidden = section.dataset.projectNote !== key
  }
}

function renderSidebarContext() {
  const onNote = !notePlanner.hidden
  writingTools.dataset.workspace = onNote ? 'note' : 'manuscript'
  writingTools.setAttribute('aria-label', onNote ? '줄거리 편집' : '집필 도구')
  const host = get(onNote ? 'notes-panel' : 'project-note-body')
  if (projectNoteContent.parentElement !== host) host.append(projectNoteContent)
  if (onNote) selectProjectNote('synopsis')
}

function updateCharacterCount() {
  get('character-count').textContent = `${formatNumber.format(manuscript.value.length)}자`
  renderManuscriptLines()
}

function syncManuscriptGutter() {
  manuscriptLines.style.width = `${manuscript.clientWidth}px`
  const translate = `0 ${-manuscript.scrollTop}px`
  manuscriptLines.style.translate = translate
  manuscriptSceneMarks.style.translate = translate
  syncSelectedSceneViewportEdges()
}

function syncSelectedSceneViewportEdges() {
  const edges = get('manuscript-selected-scene-viewport-edges')
  if (!edges) return
  const top = manuscript.scrollTop + 1
  const bottom = manuscript.scrollTop + manuscript.clientHeight - 1
  const right = manuscript.offsetLeft + manuscript.clientWidth
  edges.setAttribute('d', `M 0 ${top} H ${right} M 0 ${bottom} H ${right}`)
}

function renderManuscriptLines() {
  const text = manuscript.value
  if (text === indexedManuscript) return
  indexedManuscript = text
  const lines = text.split('\n')
  manuscriptLineStarts = []
  let offset = 0
  const pending = document.createDocumentFragment()
  lines.forEach((line, index) => {
    manuscriptLineStarts.push(offset)
    offset += line.length + 1
    const row = manuscriptLines.children[index] ?? pending.appendChild(document.createElement('div'))
    const content = line || '\u200b'
    if (row.textContent !== content) row.textContent = content
  })
  while (manuscriptLines.children.length > lines.length) manuscriptLines.lastElementChild.remove()
  manuscriptLines.append(pending)
  manuscriptInner.style.setProperty('--line-number-digits', String(lines.length).length)
  revisionLine.max = lines.length
  revisionLine.setCustomValidity('')
  syncManuscriptGutter()
}

function manuscriptLineAt(offset) {
  let first = 1
  let last = manuscriptLineStarts.length
  while (first < last) {
    const middle = Math.floor((first + last) / 2)
    if (manuscriptLineStarts[middle] <= offset) first = middle + 1
    else last = middle
  }
  return first
}

function manuscriptOffsetRect(start) {
  const line = manuscriptLineAt(start) - 1
  const node = manuscriptLines.children[line].firstChild
  const offset = start - manuscriptLineStarts[line]
  const length = node.data.codePointAt(offset) > 0xffff ? 2 : 1
  const range = document.createRange()
  range.setStart(node, offset)
  range.setEnd(node, Math.min(node.length, offset + length))
  return range.getBoundingClientRect()
}

function sameManuscriptRow(first, last, rowHeight) {
  return Math.abs(first.top - last.top) < rowHeight / 2
}

function createSceneOutline(bounds, first, last, endsWithinRow) {
  const { left, right, textLeft, mirrorLeft, top, rowHeight } = bounds
  const firstX = Math.round(first.left - mirrorLeft)
  const startX = firstX > 0 ? Math.min(right - 1, textLeft + firstX + 1) : left
  const endX = endsWithinRow ? Math.min(right, textLeft + Math.round(last.right - mirrorLeft) - 1) : right
  const startY = first.top - top - 3
  const endY = last.bottom - top + 3
  if (sameManuscriptRow(first, last, rowHeight) || (startX === left && endX === right)) {
    const box = document.createElementNS(svgNamespace, 'rect')
    box.setAttribute('x', startX)
    box.setAttribute('y', startY)
    box.setAttribute('width', Math.max(1, endX - startX))
    box.setAttribute('height', endY - startY)
    box.setAttribute('rx', 5)
    return box
  }
  // Only the edge row narrows when an adjacent passage shares it.
  const middle = (first.bottom + last.top) / 2 - top
  const firstRowEnd = Math.min(first.bottom - top + 2, middle - 1)
  const lastRowStart = Math.max(last.top - top - 2, middle + 1)
  const outline = document.createElementNS(svgNamespace, 'path')
  outline.setAttribute('d', [
    `M ${startX} ${startY} H ${right} V ${lastRowStart} H ${endX}`,
    `V ${endY} H ${left} V ${firstRowEnd} H ${startX} Z`,
  ].join(' '))
  return outline
}

function appendSelectedSceneViewportEdges(outlines, selectedOutline) {
  selectedOutline.id = 'manuscript-selected-scene-outline'
  const clip = document.createElementNS(svgNamespace, 'clipPath')
  clip.id = 'manuscript-selected-scene-clip'
  const silhouette = document.createElementNS(svgNamespace, 'use')
  silhouette.setAttribute('href', '#manuscript-selected-scene-outline')
  clip.append(silhouette)

  // The viewport edges should cover only the visible slice of the selected scene.
  const group = document.createElementNS(svgNamespace, 'g')
  group.setAttribute('class', 'manuscript-scene-viewport-edges')
  group.setAttribute('clip-path', 'url(#manuscript-selected-scene-clip)')
  const edges = document.createElementNS(svgNamespace, 'path')
  edges.id = 'manuscript-selected-scene-viewport-edges'
  group.append(edges)
  outlines.append(clip, group)
}

function renderManuscriptSceneMarks() {
  const project = currentProject()
  const { manuscript: text, savedScenes } = project
  const selectedId = selectedScenes.get(project)
  const scenes = savedScenes?.filter(scene => scene.range) ?? []
  manuscriptEditor.classList.toggle('has-scene-marks', scenes.length > 0)
  if (!scenes.length) {
    manuscriptSceneMarks.replaceChildren()
    return
  }
  if (!manuscript.clientWidth) return
  syncManuscriptGutter()

  const textLeft = manuscript.offsetLeft
  const bounds = {
    left: textLeft - 6,
    right: textLeft + manuscript.clientWidth - 2,
    textLeft,
    mirrorLeft: manuscriptLines.getBoundingClientRect().left,
    top: manuscriptLines.firstElementChild.getBoundingClientRect().top,
    rowHeight: Number.parseFloat(getComputedStyle(manuscriptLines).lineHeight),
  }
  const labeledRows = new Map()
  const marks = document.createDocumentFragment()
  const outlines = document.createElementNS(svgNamespace, 'svg')
  outlines.setAttribute('class', 'manuscript-scene-outlines')
  marks.append(outlines)
  for (const { id, range } of scenes) {
    const first = manuscriptOffsetRect(range.start)
    const last = manuscriptOffsetRect(range.end - 1)
    let next = range.end
    while (/[^\S\n]/u.test(text[next] ?? '')) next++
    const endsWithinRow = next < text.length && text[next] !== '\n' &&
      sameManuscriptRow(last, manuscriptOffsetRect(next), bounds.rowHeight)
    const outline = createSceneOutline(bounds, first, last, endsWithinRow)
    const selected = id === selectedId
    outline.classList.toggle('is-selected', selected)
    outlines.append(outline)
    const top = Math.round(first.top - bounds.top)
    let mark = labeledRows.get(top)
    if (!mark) {
      mark = document.createElement('span')
      mark.className = 'manuscript-scene-mark'
      mark.textContent = '장면'
      mark.style.insetBlockStart = `${top}px`
      marks.append(mark)
      labeledRows.set(top, mark)
    }
    if (selected) mark.classList.add('is-selected')
  }
  const selectedOutline = outlines.querySelector('.is-selected')
  if (selectedOutline) appendSelectedSceneViewportEdges(outlines, selectedOutline)
  manuscriptSceneMarks.replaceChildren(marks)
  syncSelectedSceneViewportEdges()
}

function scheduleManuscriptSceneMarks() {
  if (manuscriptMarksFrame !== undefined) return
  manuscriptMarksFrame = requestAnimationFrame(() => {
    manuscriptMarksFrame = undefined
    renderManuscriptSceneMarks()
  })
}

function showContinuationStart() {
  if (pendingContinuationStart === undefined || !manuscript.clientHeight) return
  const start = pendingContinuationStart
  pendingContinuationStart = undefined
  scrollManuscriptTo(start)
}

function manuscriptLineRange({ start, end }) {
  const first = manuscriptLineAt(start)
  const last = manuscriptLineAt(Math.max(start, end - 1))
  return first === last ? `${formatNumber.format(first)}줄` :
    `${formatNumber.format(first)}–${formatNumber.format(last)}줄`
}

const passagePosition = range => `원고 ${manuscriptLineRange(range)}`

function selectedScene(project = currentProject()) {
  return project.savedScenes?.find(scene => scene.id === selectedScenes.get(project))
}

function selectedManuscriptRange(project) {
  if (get('manuscript-paper').hidden || activeWorkspaceTab !== manuscriptTab || composingManuscript()) return null
  return sceneRange(project.manuscript, manuscript.selectionStart, manuscript.selectionEnd)
}

function renderSavedScenes() {
  const project = currentProject()
  const scenes = savedScenesInManuscriptOrder(project.savedScenes)
  savedSceneList.replaceChildren(...scenes.map(scene => {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'outline-button saved-scene-choice'
    button.dataset.scene = scene.id
    const title = document.createElement('strong')
    title.textContent = scene.title
    const position = document.createElement('span')
    position.className = 'field-hint'
    position.textContent = scene.range ? manuscriptLineRange(scene.range) : '위치 확인 필요'
    button.append(title, position)
    item.append(button)
    return item
  }))
  scheduleManuscriptSceneMarks()
  syncSceneControls()
}

function syncSceneControls() {
  if (scenesPanel.hidden) return
  const project = currentProject()
  const scene = selectedScene(project)
  for (const button of savedSceneList.querySelectorAll('button')) {
    button.disabled = manuscriptCommitPending()
    button.setAttribute('aria-pressed', String(button.dataset.scene === scene?.id))
  }
  const range = selectedManuscriptRange(project)
  const busy = Boolean(activeRequest || planAssistant.busy || currentContinuation())
  const canRegister = sceneRangeAvailable(project.savedScenes, range)
  sceneRewrite.hidden = !scene?.range
  sceneRewrite.disabled = busy
  sceneConfirmRange.hidden = !scene || Boolean(scene.range)
  sceneConfirmRange.disabled = busy || !sceneRangeAvailable(project.savedScenes, range, scene?.id)
  sceneRegister.hidden = !sceneConfirmRange.hidden
  sceneRegister.disabled = busy || !canRegister
  const hint = get('scene-range-hint')
  const message = sceneMessages.get(project) ?? (busy && currentContinuation()
    ? '열려 있는 초안 작업을 마치면 장면을 수정하거나 등록할 수 있어요.'
    : scene && !scene.range ? '원고에서 이 장면의 범위를 다시 선택해 주세요.'
      : canRegister ? `${manuscriptLineRange(range)} 선택됨`
        : '원고에서 새 범위를 선택하면 장면으로 등록할 수 있어요.')
  if (hint.textContent !== message) hint.textContent = message
  hint.hidden = !message
}

async function saveSceneRange(scene) {
  const project = currentProject()
  const original = project.manuscript
  const range = selectedManuscriptRange(project)
  if (activeRequest || planAssistant.busy || currentContinuation() ||
      !sceneRangeAvailable(project.savedScenes, range, scene?.id)) return
  const text = original.slice(range.start, range.end)
  const savedScene = scene ? { ...scene, range } : {
    id: crypto.randomUUID(), title: sceneTitle(text), range, accepted: 0,
    versions: [{ text, direction: '', parent: null, source: 'registered' }],
  }
  activeRequest = { kind: 'scene-registration' }
  syncControls()
  const saved = await saveWorkspace(() => {
    if (project !== currentProject() || project.manuscript !== original) throw new Error('원고의 선택 범위가 바뀌었어요.')
    const previous = project.savedScenes
    if (scene && !previous.some(item => item.id === scene.id && !item.range)) throw new Error('장면 위치가 바뀌었어요.')
    const updated = scene ? previous.map(item => item.id === scene.id ? savedScene : item) : [...(previous ?? []), savedScene]
    project.savedScenes = updated
    const undoReview = markSceneForReview(project, savedScene)
    return () => {
      undoReview()
      if (project.savedScenes !== updated) return
      if (previous) project.savedScenes = previous
      else delete project.savedScenes
    }
  })
  activeRequest = undefined
  if (saved) {
    selectedScenes.set(project, savedScene.id)
    forgetSceneUndo(sceneUndo, savedScene.id)
    sceneReviewJobs.start(project, { retry: true })
    refreshMemoryAfterScene(project)
    writingInputsChanged()
  }
  sceneMessages.set(project, saved ? (scene ? '장면 위치를 확인했어요.' : '선택 범위를 장면으로 등록했어요.')
    : '장면을 저장하지 못했어요. 저장 상태를 확인해 주세요.')
  renderSavedScenes()
  syncControls()
  if (saved && !scenesPanel.hidden) sceneRewrite.focus({ preventScroll: true })
}

function openSavedScene() {
  const project = currentProject()
  const scene = selectedScene(project)
  if (sceneRewrite.disabled || !scene?.range) return
  const original = project.manuscript
  const { start, end } = scene.range
  const before = original.slice(0, start)
  const after = original.slice(end)
  const text = original.slice(start, end)
  const versions = [...scene.versions]
  let selected = scene.accepted
  if (versions[selected].text !== text) {
    versions.push({ text, direction: '', parent: selected, source: 'manual' })
    selected = versions.length - 1
  }
  continuations.set(project, {
    original, tail: paragraphRanges(before).at(-1)?.text ?? '', following: paragraphRanges(after)[0]?.text ?? '',
    scene, previousPanel: 'scenes', versions, selected, currentVersion: selected, direction: '', feedback: '',
  })
  renderContinuation()
  switchPanel('continuation')
  syncControls()
  continuationDirection.focus({ preventScroll: true })
}

function renderWorkspace() {
  const project = currentProject()
  closeRequestPreview()
  revisionSelection = undefined
  manuscriptSelectionBeforeEdit = undefined
  manuscriptComposition = undefined
  sceneUndo.length = 0
  pendingContinuationStart = undefined
  revisionLine.value = ''
  revisionLine.setCustomValidity('')
  get('revision-direction').value = ''
  renderProjectSelect()
  manuscript.value = project.manuscript
  manuscript.scrollTop = manuscript.scrollHeight
  get('direction').value = project.direction
  get('scene-length').value = project.sceneLength ?? ''
  get('author-mode').value = project.authorMode ?? 'persistent'
  get('synopsis').value = project.synopsis
  showNoteStatus('synopsis')
  renderLegacySceneNotes(project.legacySceneNotes)
  updateCharacterCount()
  writingStatus.textContent = ''
  renderPlanner()
  renderMemory()
  lorebook.render()
  loreReviews.render()
  research.render()
  renderEstimates()
  renderSavedScenes()
  sceneReviewJobs.start(project)
  renderContinuation()
  if (currentContinuation() && activeWorkspaceTab === manuscriptTab && !currentContinuation().showManuscript) {
    switchPanel('continuation')
  }
  syncControls()
}

function syncControls() {
  const busy = Boolean(activeRequest || planAssistant.busy)
  for (const element of [generate, projectSelect, get('add-project'), get('open-files')]) {
    element.disabled = busy
  }
  for (const id of ['preview-request', 'preview-semantic-search', 'retry-search']) {
    get(id).disabled = busy || Boolean(activePreview)
  }
  get('lore-preview-fields').disabled = busy || Boolean(activePreview)
  get('lore-quick-list').disabled = busy || Boolean(activePreview)
  const writing = activeRequest?.kind === 'continuation'
  manuscript.readOnly = manuscriptCommitPending()
  generate.hidden = writing
  stopWriting.hidden = !writing
  get('generate-revision').disabled = busy || !get('continuation-paper').hidden || !selectedRevision()
  syncContinuationControls(busy)
  syncSceneControls()
  updatePlanControls()
}

function renderRevisionProposal(preview) {
  const view = revisionProposal
  view.model.textContent = preview.model
  view.usage.hidden = !preview.usage
  view.usage.textContent = preview.usage ? usageLabel(preview.usage) : ''
  if (view.body.textContent !== preview.text) view.body.textContent = preview.text
  const changed = currentProject().manuscript !== preview.original
  const pending = activeRequest?.kind === 'paragraph-revision'
  const status = changed ? '생성 요청 후 원고가 바뀌었어요. 다시 요청해 주세요.' : preview.status
  if (view.status.textContent !== status) view.status.textContent = status
  view.accept.disabled = pending || changed || !preview.text.trim() || !preview.complete
  view.stop.hidden = !pending
}

function closeRevisionProposal() {
  if (activeRequest?.kind === 'paragraph-revision') activeRequest.controller.abort()
  revisionDraft = undefined
  revisionProposal.section.close()
  manuscript.focus()
}

async function loadCatalog() {
  const label = get('connection-label')
  const reload = get('refresh-catalog')
  reload.hidden = true
  label.textContent = '모델 목록 확인 중'
  get('connection-dot').dataset.state = 'loading'
  try {
    const response = await fetch('/api/models')
    if (!response.ok) throw new Error('Catalog request failed')
    const data = await response.json()
    if (!Array.isArray(data.models)) throw new Error('Catalog is invalid')
    models = data.models
    renderEstimates()
    if (!data.catalogAvailable) throw new Error('Catalog unavailable')
    label.textContent = data.keyConfigured ? '모델 목록 연결됨' : 'API 키 설정 필요'
    get('connection-dot').dataset.state = data.keyConfigured ? 'online' : 'offline'
  } catch {
    label.textContent = '모델 목록 연결 실패'
    get('connection-dot').dataset.state = 'offline'
    reload.hidden = false
  }
}

function selectedRevision() {
  return revisionSelection?.original === currentProject().manuscript ? revisionSelection : undefined
}

function updateRevision() {
  const start = manuscript.selectionStart
  const end = manuscript.selectionEnd
  const paragraph = start < end && paragraphRanges(manuscript.value).find(item => start < item.end && end > item.start &&
    !manuscript.value.slice(Math.min(start, item.start), item.start).trim() &&
    !manuscript.value.slice(item.end, Math.max(end, item.end)).trim())
  revisionSelection = paragraph ? { ...paragraph, original: manuscript.value } : undefined
  renderEstimates()
  syncControls()
}

function revisionBody(project, paragraph) {
  return {
    model: modelFor(project, 'revision'), maxTokens: project.maxTokens, paragraph: paragraph.text,
    direction: get('revision-direction').value, systemPrompt: project.notePrompts?.revision,
  }
}

function estimate(payload) {
  return estimateLabel(completionEstimate(payload, models.find(model => model.id === payload.model)))
}

function renderEstimates() {
  const project = currentProject()
  const writingModel = catalogModel(project.model)
  get('writing-model-name').textContent = writingModel?.name ?? project.model
  const { saved, pastPending, semanticPending } = sourcePanel.render() ?? research.inspect(project, writingModel, undefined, { onlyCached: true })
  const { draft } = saved.body
  const pending = pastPending ? ' · 과거 원문 반영 전' : semanticPending ? ' · 의미 검색 반영 전' : ''
  get('writing-estimate').textContent = estimateLabel(saved.usage) + pending
  const limitedFields = [
    ['projectTitle', project.title, '작품 제목'], ['direction', project.direction, '작가의 노트'],
  ].filter(([key, text]) => Object.hasOwn(draft, key) && text?.length > draft[key].length).map(([, , label]) => label)
  const limitNotice = get('writing-context-limit')
  const limitNotes = []
  if (limitedFields.length) limitNotes.push(`요청 한도에 맞춰 ${limitedFields.join(', ')}의 앞부분을 보냅니다.`)
  if (saved.remaining < 0) limitNotes.push('모델 컨텍스트가 부족해요. 프롬프트, 참고 자료나 출력 한도를 줄여 주세요.')
  if (saved.recentWarning) limitNotes.push(saved.recentWarning)
  else if (saved.recentReduced || saved.pastReduced) limitNotes.push('한도에 맞춰 전송할 원문 범위를 조정했어요.')
  limitNotice.hidden = !limitNotes.length
  limitNotice.textContent = limitNotes.join(' ')

  const paragraph = selectedRevision()
  const status = get('revision-selection')
  status.textContent = paragraph ? `${passagePosition(paragraph)} · 선택한 문단 전체를 다듬어요.`
    : '줄 번호를 입력하거나 원고에서 한 문단의 일부를 선택해 주세요.'
  if (paragraph) {
    const { model, maxTokens, systemPrompt, ...context } = revisionBody(project, paragraph)
    get('revision-estimate').textContent = estimate(completionPayload(model, maxTokens,
      effectiveSystemPrompt(systemPrompt, defaultRevisionPrompt), context))
  } else {
    get('revision-estimate').textContent = ''
  }
  const memory = memoryRequest(project, project.manuscript.slice(0, memoryTarget(project)))
  get('memory-estimate').textContent = memory.excerpt.trim() ? estimate(manuscriptMemoryPayload(memory)) + ' · 다음 메모 요청' : ''
}

function closeRequestPreview() {
  activePreview?.abort()
  activePreview = undefined
  previewOrigin = undefined
  get('request-preview').hidden = true
  get('request-json-details').open = false
  get('preview-request').setAttribute('aria-expanded', 'false')
}

function writingInputsChanged() {
  activeRequest?.cancelPreparation?.()
  closeRequestPreview()
  lorebook.renderContext()
  loreReviews.render()
  if (activeWorkspaceTab === noteWorkspaceTab) planProgress.render()
  research.renderState()
  renderEstimates()
  syncControls()
}

function revealManuscript() {
  const draft = currentContinuation()
  if (draft && !draft.showManuscript) {
    draft.showManuscript = true
    renderContinuation()
    syncControls()
  }
  setWorkspaceTab(manuscriptTab)
}

function scrollManuscriptTo(start) {
  syncManuscriptGutter()
  const top = manuscriptOffsetRect(start).top - manuscriptLines.getBoundingClientRect().top
  manuscript.scrollTop = top - Math.floor(manuscript.clientHeight / 3)
  syncManuscriptGutter()
}

function goToPassage({ start, end, text }) {
  if (manuscriptCommitPending() || manuscript.value.slice(start, end) !== text) return
  revealManuscript()
  manuscript.focus()
  manuscript.setSelectionRange(start, end)
  scrollManuscriptTo(start)
}

function goToSavedScene(scene) {
  if (scene.range) revealManuscript()
  const choice = savedSceneList.querySelector(`[data-scene="${CSS.escape(scene.id)}"]`)
  const focusTarget = scenesPanel.hidden ? manuscriptTab : choice
  const caret = manuscript.selectionEnd
  if (scene.range && caret !== manuscript.selectionStart) {
    // Collapsing a blurred textarea's selection can leave the previous range cached by the browser.
    manuscript.focus({ preventScroll: true })
    manuscript.setSelectionRange(caret, caret)
    updateRevision()
  }
  focusTarget?.focus({ preventScroll: true })
  if (scene.range) scrollManuscriptTo(scene.range.start)
}

function selectSavedScene(scene, { navigate = true } = {}) {
  const project = currentProject()
  if (scene) selectedScenes.set(project, scene.id)
  else selectedScenes.delete(project)
  sceneMessages.delete(project)
  if (scene && navigate) goToSavedScene(scene)
  scheduleManuscriptSceneMarks()
  syncSceneControls()
}

function selectSceneAtManuscriptCaret() {
  const offset = manuscript.selectionStart
  if (document.activeElement !== manuscript || offset !== manuscript.selectionEnd ||
      manuscriptComposition || manuscriptCommitPending()) return
  const project = currentProject()
  const selected = selectedScene(project)
  const scenes = project.savedScenes ?? []
  // A scene starting at the caret wins over a scene ending at the same offset.
  const scene = scenes.find(({ range }) => range && range.start <= offset && offset < range.end) ??
    scenes.find(({ range }) => range?.end === offset)
  if (!scene && selected && !selected.range) return
  if (scene?.id !== selected?.id) selectSavedScene(scene, { navigate: false })
}

const research = setupResearch({
  get, currentProject, saveWorkspace, goToPassage, passagePosition,
  async assertWorkspaceCurrent(project) {
    await verifyWorkspaceForRequest()
    if (!workspace.projects.some(item => item.id === project.id)) throw new DOMException(writingContextChanged, 'AbortError')
  },
  onChange() {
    writingInputsChanged()
    lorebook.renderQuick()
  },
  addedLoreCards: project => addedLoreCards.get(project),
  onSelectLoreCard: (id, selected) => selectLoreCard(id, selected, { preview: true }),
})
const lorebook = setupLorebook({
  get, currentProject, saveWorkspace, onChange: writingInputsChanged,
  addedLoreCards: project => addedLoreCards.get(project), onSelectLoreCard: selectLoreCard,
})
const planProgress = setupPlanProgress({
  get, currentProject, saveWorkspace, goToPassage,
  onChange(project) {
    if (project !== currentProject()) return
    get('synopsis').value = project.synopsis
    writingInputsChanged()
    renderPlanContextLimit()
    updatePlanControls()
  },
})
const sceneReviewJobs = setupSceneReviewJobs({
  hasProject: project => workspace.projects.includes(project), saveWorkspace,
  onChange(project) {
    if (project !== currentProject()) return
    loreReviews.render()
    if (activeWorkspaceTab === noteWorkspaceTab) planProgress.render()
  },
})
const loreReviews = setupLoreReviews({
  get, currentProject, saveWorkspace, goToPassage, jobError: sceneReviewJobs.visibleError,
  onOpen: () => setWorkspaceTab(loreWorkspaceTab),
  onChange(project, cardsChanged) {
    if (project !== currentProject() || !cardsChanged) return
    lorebook.render()
    writingInputsChanged()
  },
})
get('retry-scene-review').addEventListener('click', () => sceneReviewJobs.start(currentProject(), { retry: true }))
get('dismiss-scene-review-error').addEventListener('click', () => {
  sceneReviewJobs.dismissError(currentProject())
  const focusTarget = generate.disabled ? manuscript : generate
  focusTarget.focus({ preventScroll: true })
})
const catalogModel = id => models.find(model => model.id === id)
const sourcePanel = setupSourcePanel({
  get, currentProject, getModel: catalogModel, research, saveWorkspace, onSave: writingInputsChanged,
  onSearch: renderEstimates, goToPassage, passagePosition,
})

function selectLoreCard(id, selected, { preview = false } = {}) {
  const project = currentProject()
  const cards = new Set(addedLoreCards.get(project))
  if (selected) cards.add(id)
  else cards.delete(id)
  addedLoreCards.set(project, cards)
  if (preview) lorebook.renderQuick()
  else closeRequestPreview()
  renderEstimates()
  if (preview) showRequestPreview({ loreFocus: id })
}

async function showRequestPreview({ refreshSemantic = false, origin, loreFocus } = {}) {
  if (activePreview || activeRequest || planAssistant.busy) return
  if (origin) previewOrigin = { button: origin, panel: manuscriptPanel }
  switchPanel('tools')
  const project = currentProject()
  const controller = new AbortController()
  activePreview = controller
  syncControls()
  const status = get('request-preview-status')
  const data = get('request-preview-data')
  const semanticAction = get('preview-semantic-action')
  get('request-preview').hidden = false
  get('preview-request').setAttribute('aria-expanded', 'true')
  if (!loreFocus) data.hidden = true
  semanticAction.hidden = true
  status.textContent = refreshSemantic ? '참고 원문을 다시 찾는 중이에요.' : '미리보기를 준비하는 중이에요.'
  if (!loreFocus) get('request-preview-title').focus()
  try {
    const model = catalogModel(project.model)
    const prepared = refreshSemantic
      ? await research.prepare(project, model, controller.signal, { retry: true })
      : research.preview(project, model)
    const payload = await jsonRequest('/api/write/preview', {
      body: withModelOptions(project, prepared.body), signal: controller.signal,
    })
    controller.signal.throwIfAborted()
    const recent = prepared.body.draft.manuscript
    get('recent-preview-section').hidden = recent === undefined
    get('recent-preview-range').textContent = recent
      ? passagePosition({ start: prepared.cutoff, end: prepared.cutoff + recent.length })
      : '전송할 최근 원고 없음'
    research.renderResults(prepared, loreFocus)
    const value = estimate(payload)
    get('request-preview-estimate').textContent = value
    get('writing-estimate').textContent = value + (prepared.semanticPending ? ' · 의미 검색 반영 전' : '')
    get('request-json').textContent = JSON.stringify(payload, null, 2)
    status.textContent = prepared.recentWarning || (prepared.remaining < 0
      ? '이 자료를 모두 보내기에는 모델 컨텍스트가 부족해요. 카드 선택이나 출력 한도를 줄여 주세요.'
      : prepared.body.references.includes('manuscriptMemory') && memoryReadThrough(project) < prepared.cutoff
        ? '이어쓰기 전에 최근 원문 앞의 미요약 부분을 원고 메모에 반영해요.' : '')
    semanticAction.hidden = !(prepared.semanticPending || prepared.semanticFailed)
    data.hidden = false
  } catch (error) {
    if (!controller.signal.aborted) {
      data.hidden = true
      status.textContent = completionFailure(error, controller.signal)
    }
  } finally {
    if (activePreview === controller) activePreview = undefined
    syncControls()
    if (loreFocus && !controller.signal.aborted && !data.hidden && document.activeElement === document.body) {
      const field = get(`lore-preview-add-${loreFocus}`) ?? get(`lore-preview-card-${loreFocus}`)?.querySelector('summary')
      field?.focus()
    }
  }
}

async function continueManuscript() {
  if (activeRequest || planAssistant.busy || currentContinuation()) return
  const project = currentProject()
  const original = project.manuscript
  const controller = new AbortController()
  const { signal } = controller
  const focusedGenerate = document.activeElement === generate
  const request = { controller, kind: 'continuation' }
  activeRequest = request
  syncControls()
  if (focusedGenerate) stopWriting.focus({ preventScroll: true })
  writingStatus.textContent = '전송할 원고와 자료를 준비하는 중이에요.'

  try {
    await verifyWorkspaceForRequest()
    const checkInputs = watchWritingPreparation(request, project, original, original.length, { useCurrentNote: true, trackMemory: false })
    checkInputs()
    const oneTimeNote = project.authorMode === 'once' ? project.direction : undefined
    const model = catalogModel(project.model)
    let prepared
    while (!prepared) {
      const plan = research.plan(project, model)
      if (plan.recentWarning) throw new Error(plan.recentWarning)
      if (plan.finish().remaining < 0) throw new Error('모델 컨텍스트가 부족해요. 프롬프트, 참고 자료나 출력 한도를 줄여 주세요.')
      if (plan.body.references.includes('manuscriptMemory') && memoryReadThrough(project) < plan.cutoff) {
        writingStatus.textContent = '최근 원문 앞부분을 원고 메모에 정리하는 중이에요.'
        const error = await refreshProjectMemory(project, plan.cutoff, signal)
        checkInputs()
        if (error) throw new Error(error)
        continue
      }
      const assertCurrent = watchWritingPreparation(request, project, original, original.length, { useCurrentNote: true })
      prepared = await research.prepare(project, model, signal, { assertCurrent })
      await verifyWorkspaceForRequest()
      assertCurrent()
    }
    const { body, remaining } = prepared
    if (remaining < 0) throw new Error('모델 컨텍스트가 부족해요. 프롬프트, 참고 자료나 출력 한도를 줄여 주세요.')
    delete request.cancelPreparation

    let output = ''
    const result = await requestCompletion('/api/write', withModelOptions(project, body), {
      signal, projectId: project.id,
      onText(content) {
        if (!output) writingStatus.textContent = '이어서 쓰는 중이에요.'
        output += content
      },
    })
    signal.throwIfAborted()
    const text = normalizeLineEndings(output.trim())
    if (!text) throw new Error('추가할 원고를 받지 못했어요. 다시 요청해 주세요.')
    if (currentProject() !== project || project.manuscript !== original) {
      throw new Error('생성 중 원고가 바뀌었어요. 현재 원고에서 다시 요청해 주세요.')
    }
    continuations.set(project, {
      original, tail: paragraphRanges(original).at(-1)?.text ?? '', sceneLength: body.draft.sceneLength, oneTimeNote,
      previousPanel: manuscriptPanel, versions: [{ text, direction: body.draft.direction, parent: null, result, truncated: result.truncated }],
      selected: 0, direction: '', feedback: '',
    })
    addedLoreCards.delete(project)
    lorebook.renderQuick()
    writingStatus.textContent = ''
  } catch (error) {
    writingStatus.textContent = completionFailure(error, signal)
  } finally {
    const focusedStop = document.activeElement === stopWriting
    activeRequest = undefined
    if (currentContinuation()) {
      renderContinuation()
      if (activeWorkspaceTab === manuscriptTab) switchPanel('continuation')
    }
    syncControls()
    if (focusedStop && activeWorkspaceTab === manuscriptTab) {
      (currentContinuation() ? continuationDirection : generate).focus({ preventScroll: true })
    }
  }
}

function renderContinuation() {
  const draft = currentContinuation()
  const editing = Boolean(draft && !draft.showManuscript)
  get('manuscript-paper').hidden = editing
  get('manuscript-composer').hidden = Boolean(draft)
  get('continuation-paper').hidden = !editing
  get('continuation-composer').hidden = !editing
  get('open-revision').hidden = editing
  continuationDiscard.hidden = !draft
  if (draft) continuationDiscard.textContent = draft.scene ? '수정 취소' : '초안 버리기'
  get('return-to-continuation').hidden = !draft?.showManuscript
  const historyTab = get('continuation-tab')
  historyTab.hidden = !editing || activeWorkspaceTab !== manuscriptTab
  if (historyTab.hidden && manuscriptPanel === 'continuation') switchPanel()
  if (!editing) {
    if (!draft) renderDraftChanges()
    continuationHistory.replaceChildren()
    return
  }

  const { versions, selected } = draft
  const version = versions[selected]
  const label = get('continuation-label')
  label.textContent = draft.scene?.title ?? '이어쓰기 초안'
  label.title = draft.scene?.title ?? ''
  const position = draft.scene ? `${manuscriptLineRange(draft.scene.range)} · ` : ''
  get('continuation-version').textContent =
    `${position}버전 ${selected + 1} · ${selected === draft.currentVersion ? '현재 원고' : '미반영'}`
  continuationAccept.textContent = draft.scene ? '이 장면 교체' : '원고 끝에 붙이기'
  continuationPrevious.hidden = version.parent === null
  get('continuation-original').textContent = draft.tail
  get('continuation-original').hidden = !draft.tail
  get('continuation-following').textContent = draft.following ?? ''
  get('continuation-following').hidden = !draft.following
  renderDraftChanges(version, versions[version.parent], selected !== draft.currentVersion)
  continuationDirection.value = draft.direction

  const ancestors = new Set(sceneVersionPath(versions, selected))
  const branched = versions.some(({ parent }, index) => parent !== null && parent !== index - 1)
  continuationHistory.replaceChildren(...versions.map(({ direction, parent, source }, index) => {
    const item = document.createElement('li')
    item.classList.toggle('on-version-path', ancestors.has(index))
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.version = index
    if (index === selected) button.setAttribute('aria-current', 'true')
    const title = document.createElement('strong')
    const label = source === 'registered' ? '원고에서 등록' : source === 'manual' ? '원고 직접 편집'
      : parent === null ? '작가의 노트' : '수정 지시'
    title.textContent = `버전 ${index + 1} · ${label}`
    button.append(title)
    for (const [shown, text] of [[index === draft.currentVersion, '현재 원고'], [index === selected, '보는 중']]) {
      if (!shown) continue
      const current = document.createElement('span')
      current.className = 'continuation-current'
      current.textContent = text
      button.append(current)
    }
    if (branched && parent !== null) {
      const source = document.createElement('span')
      source.className = 'continuation-parent'
      source.textContent = `버전 ${parent + 1}에서 수정`
      button.append(source)
    }
    if (!source) {
      const instruction = document.createElement('span')
      instruction.className = 'continuation-instruction'
      instruction.textContent = direction.trim() || '작가의 노트 없음'
      button.append(instruction)
    }
    item.append(button)
    return item
  }))
}

function syncContinuationControls(busy) {
  const draft = currentContinuation()
  if (!draft) return
  const version = draft.versions[draft.selected]
  const rewriting = activeRequest?.kind === 'scene-revision'
  const changed = draft.original !== currentProject().manuscript
  const tooLong = version.text.length > sceneDraftLimit
  continuationDirection.readOnly = busy
  continuationRewrite.hidden = rewriting
  continuationRewrite.disabled = busy || changed || tooLong || !draft.direction.trim()
  continuationStop.hidden = !rewriting
  continuationPrevious.disabled = busy
  continuationAccept.disabled = busy || changed
  continuationDiscard.disabled = busy
  for (const button of continuationHistory.querySelectorAll('button')) button.disabled = busy
  const status = [
    changed ? '원고가 바뀌었어요. 현재 원고에서 초안을 다시 열어 주세요.'
      : draft.feedback || (version.truncated ? '출력 한도에 도달했어요. 끝 문장을 확인해 주세요.' : ''),
    tooLong ? '이 초안은 수정 요청에 보내기에는 너무 길어요.' : '',
    !draft.feedback && version.result?.usage ? usageLabel(version.result.usage) : '',
  ].filter(Boolean).join(' ')
  const statusField = get('continuation-status')
  statusField.hidden = !status
  if (statusField.textContent !== status) statusField.textContent = status
}

function showContinuationVersion(index) {
  const draft = currentContinuation()
  if (!draft || activeRequest || planAssistant.busy || !draft.versions[index] || index === draft.selected) return
  draft.selected = index
  draft.feedback = ''
  renderContinuation()
  syncControls()
}

function watchWritingPreparation(request, project, original, start, { useCurrentNote = false, trackMemory = true } = {}) {
  const { controller } = request
  const stale = new DOMException(writingContextChanged, 'AbortError')
  const inputVersion = () => {
    const settings = referenceSettingsFor(project)
    const enabled = new Set(settings.filter(ref => ref.enabled).map(ref => ref.key))
    return JSON.stringify([
      settings, project.model, project.maxTokens, project.modelOptions, project.systemPrompt,
      project.title, project.synopsis, project.sourceLimits, project.savedScenes?.map(scene => scene.range),
      useCurrentNote ? [project.direction, project.sceneLength, project.authorMode] : undefined,
      enabled.has('pastPassages') ? project.search : undefined,
      enabled.has('lorebook') ? [project.lorebook, [...(addedLoreCards.get(project) ?? [])]] : undefined,
      trackMemory && enabled.has('manuscriptMemory') && memoryReadThrough(project) <= start ? project.manuscriptMemory : undefined,
    ])
  }
  const originalSettings = inputVersion()
  const changed = () => storageWarning === storageConflictMessage || workspaceStorageStatus().conflict ||
    composingManuscript() || project.manuscript !== original || inputVersion() !== originalSettings
  request.cancelPreparation = () => {
    if (changed()) controller.abort(stale)
  }
  return () => {
    request.cancelPreparation()
    controller.signal.throwIfAborted()
  }
}

async function rewriteContinuation() {
  const project = currentProject()
  const draft = currentContinuation()
  if (!draft || continuationRewrite.disabled) return
  const parent = draft.selected
  const direction = draft.direction.trim()
  const controller = new AbortController()
  const { signal } = controller
  const start = draft.scene?.range.start ?? draft.original.length
  const request = { controller, kind: 'scene-revision' }
  activeRequest = request
  draft.feedback = '수정에 사용할 자료를 준비하고 있어요.'
  syncControls()
  if (activeWorkspaceTab === manuscriptTab) continuationStop.focus({ preventScroll: true })
  try {
    await verifyWorkspaceForRequest()
    const assertCurrent = watchWritingPreparation(request, project, draft.original, start)
    assertCurrent()
    const source = {
      ...project, manuscript: draft.original.slice(0, start), direction: draft.versions[0].direction,
      sceneLength: draft.sceneLength, references: referenceSettingsFor(project).map(ref => ({ ...ref })),
      manuscriptMemory: memoryReadThrough(project) <= start ? project.manuscriptMemory : undefined,
    }
    const sceneRevision = {
      text: draft.versions[parent].text, direction, following: draft.following,
      history: sceneRevisionHistory(draft.versions, parent),
    }
    const { body, remaining } = await research.prepare(
      project, catalogModel(project.model), signal, { source, sceneRevision, assertCurrent },
    )
    await verifyWorkspaceForRequest()
    assertCurrent()
    if (remaining < 0) throw new Error('모델 컨텍스트가 부족해요. 출력 한도를 줄이거나 컨텍스트가 더 큰 모델을 선택해 주세요.')
    delete request.cancelPreparation
    draft.feedback = '수정안을 작성하고 있어요.'
    syncControls()
    let output = ''
    const result = await requestCompletion('/api/write', withModelOptions(project, body), {
      signal, projectId: project.id,
      onText(content) { output += content },
    })
    signal.throwIfAborted()
    const text = normalizeLineEndings(output.trim())
    if (!text) throw new Error('수정할 초안을 받지 못했어요. 다시 요청해 주세요.')
    if (project.manuscript !== draft.original) throw new Error('수정 중 원고가 바뀌었어요.')
    draft.versions.push({ text, direction, parent, result, truncated: result.truncated })
    draft.selected = draft.versions.length - 1
    draft.direction = ''
    draft.feedback = ''
    renderContinuation()
  } catch (error) {
    draft.feedback = completionFailure(error, signal)
  } finally {
    const focusedStop = document.activeElement === continuationStop
    activeRequest = undefined
    syncControls()
    if (focusedStop && activeWorkspaceTab === manuscriptTab) continuationDirection.focus({ preventScroll: true })
  }
}

function closeContinuation(project) {
  if (manuscriptPanel === 'continuation') switchPanel(continuations.get(project).previousPanel)
  continuations.delete(project)
  renderContinuation()
  switchPanel()
  syncControls()
}

async function acceptContinuation() {
  const project = currentProject()
  const draft = currentContinuation()
  if (!draft || continuationAccept.disabled) return
  const { scene, original, versions, selected } = draft
  const { text } = versions[selected]
  const updated = scene ? original.slice(0, scene.range.start) + text + original.slice(scene.range.end)
    : appendParagraphs(original, text)
  const start = scene?.range.start ?? updated.length - text.length
  const range = { start, end: start + text.length }
  const savedScene = {
    id: scene?.id ?? crypto.randomUUID(), title: scene?.title ?? sceneTitle(text),
    range, accepted: selected, versions: sceneVersions(versions),
  }
  activeRequest = { kind: 'continuation-save' }
  draft.feedback = '원고에 반영하는 중이에요.'
  syncControls()
  const saved = await saveWorkspace(() => {
    const liveRange = scene && project.savedScenes?.find(item => item.id === scene.id)?.range
    if (project !== currentProject() || project.manuscript !== original ||
        (scene && (liveRange?.start !== scene.range.start || liveRange?.end !== scene.range.end))) {
      throw new Error('초안을 만든 뒤 원고가 바뀌었어요.')
    }
    const previousNote = project.direction
    const previousMemory = project.manuscriptMemory
    const previousScenes = project.savedScenes
    const clearNote = draft.oneTimeNote !== undefined && project.authorMode === 'once' &&
      previousNote === draft.oneTimeNote && draft.versions[0].direction === writingFieldPrefix('direction', previousNote)
    const edit = scene ? { ...scene.range, inserted: text }
      : { start: original.length, end: original.length, inserted: updated.slice(original.length) }
    setManuscriptText(project, updated, edit)
    const updatedMemory = project.manuscriptMemory
    const moved = project.savedScenes ?? []
    const updatedScenes = scene ? moved.map(item => item.id === scene.id ? savedScene : item) : [...moved, savedScene]
    project.savedScenes = updatedScenes
    const undoReview = markSceneForReview(project, savedScene)
    if (clearNote) project.direction = ''
    return () => {
      undoReview()
      if (project.manuscript === updated && project.savedScenes === updatedScenes) {
        const restoreMemory = project.manuscriptMemory === updatedMemory
        setManuscriptText(project, original)
        if (previousScenes) project.savedScenes = previousScenes
        else delete project.savedScenes
        if (restoreMemory && previousMemory) project.manuscriptMemory = previousMemory
      }
      if (clearNote && project.direction === '') project.direction = previousNote
    }
  })
  if (!saved) {
    activeRequest = undefined
    draft.feedback = '원고에 저장하지 못했어요. 저장 상태를 확인한 뒤 다시 시도해 주세요.'
    syncControls()
    return
  }

  selectedScenes.set(project, savedScene.id)
  sceneMessages.delete(project)
  closeContinuation(project)
  get('direction').value = project.direction
  renderManuscriptText(updated)
  activeRequest = undefined
  syncControls()
  if (scene) {
    if (activeWorkspaceTab === manuscriptTab) goToSavedScene(savedScene)
  } else {
    manuscript.setSelectionRange(updated.length, updated.length)
    pendingContinuationStart = start
    showContinuationStart()
    if (activeWorkspaceTab === manuscriptTab) manuscript.focus({ preventScroll: true })
  }
  refreshMemoryAfterScene(project)
  sceneReviewJobs.start(project, { retry: true })
  writingStatus.textContent = scene ? `버전 ${selected + 1}의 초안을 장면에 반영했어요.`
    : `버전 ${selected + 1}의 초안을 원고에 붙였어요.`
}

async function generateRevision(revision) {
  if (activeRequest || planAssistant.busy) return
  setWorkspaceTab(manuscriptTab)
  const project = currentProject()
  const view = revisionProposal
  const preview = { original: project.manuscript, revision, text: '', model: '', status: '수정안을 준비하는 중이에요.' }
  const controller = new AbortController()
  activeRequest = { controller, kind: 'paragraph-revision' }
  revisionDraft = preview
  syncControls()
  get('revision-proposal-position').textContent = passagePosition(revision)
  get('revision-original-text').textContent = revision.text
  renderRevisionProposal(preview)
  view.section.showModal()
  get('revision-original-text').scrollTop = 0
  view.body.scrollTop = 0
  const output = document.createTextNode('')
  view.body.replaceChildren(output)

  try {
    const body = revisionBody(project, revision)
    const result = await requestCompletion('/api/revise', withModelOptions(project, body), {
      signal: controller.signal, projectId: project.id,
      onText(content) {
        if (controller.signal.aborted) return
        if (!preview.text.trim()) {
          preview.status = '초안을 작성하고 있어요.'
          renderRevisionProposal(preview)
        }
        preview.text += content
        output.appendData(content)
      },
    })
    controller.signal.throwIfAborted()
    preview.model = result.model ?? body.model
    preview.usage = result.usage
    preview.complete = !result.truncated
    preview.status = result.truncated ? '토큰 한도에 도달했어요. 끝 문장을 확인해 주세요.'
      : '기존 문단과 비교하고 교체 여부를 선택하세요.'
  } catch (error) {
    preview.status = completionFailure(error, controller.signal)
  } finally {
    activeRequest = undefined
    syncControls()
    if (view.section.open) {
      renderRevisionProposal(preview)
      if (document.activeElement === document.body) view.title.focus({ preventScroll: true })
    }
  }
}

function completionFailure(error, signal) {
  if (error?.message === writingContextChanged || signal.reason?.message === writingContextChanged) return writingContextChanged
  if (signal.aborted) return '생성을 중지했어요.'
  if (error?.name === 'AbortError') return '요청을 준비하는 동안 원고나 설정이 바뀌었어요. 다시 요청해 주세요.'
  if (error instanceof TypeError) return '서버와 연결이 끊겼어요. 다시 시도해 주세요.'
  if (error instanceof SyntaxError) return '서버 응답을 읽지 못했어요. 다시 시도해 주세요.'
  return error.message
}

function memoryTarget(project) {
  const plan = research.plan(project, catalogModel(project.model))
  return plan.recentWarning ? 0 : plan.cutoff
}

function refreshMemoryAfterScene(project) {
  if (project.autoMemory !== false &&
      referenceSettingsFor(project).some(ref => ref.key === 'manuscriptMemory' && ref.enabled)) refreshProjectMemory(project)
}

function renderMemory() {
  const project = currentProject()
  const job = memoryJobs.get(project)
  const through = memoryReadThrough(project)
  const target = memoryTarget(project)
  const remaining = Math.max(0, target - through)
  const running = Boolean(job?.controller)
  const hasManuscript = Boolean(project.manuscript.trim())
  const text = memoryForPrompt(project)

  memoryAuto.checked = project.autoMemory !== false
  memoryRefresh.disabled = running || !hasManuscript || remaining === 0
  memoryStop.hidden = !running
  get('memory-content').hidden = !text
  if (memoryText.value !== text) memoryText.value = text
  get('memory-usage').textContent = job?.usage ? usageLabel(job.usage) : ''

  const message = running ? `${formatNumber.format(through)}자까지 읽었어요. 원고를 읽고 있어요.`
    : job?.error || (!hasManuscript ? '원고가 준비되면 메모를 갱신할 수 있어요.'
      : remaining && project.manuscriptMemory?.stale ? '이미 읽은 원고가 바뀌었어요. 갱신하면 최근 원문 앞부분을 다시 읽어요.'
      : remaining ? `아직 메모에 반영할 원고가 ${formatNumber.format(remaining)}자 남았어요.`
      : target ? '최근 원문이 시작되기 전까지 반영했어요.' : '최근 원문 앞에 요약할 부분이 없어요.')
  if (memoryStatus.textContent !== message) memoryStatus.textContent = message
}

async function refreshProjectMemory(project, target = memoryTarget(project), parentSignal) {
  const requested = project.manuscript.slice(0, target)
  if (memoryReadThrough(project) >= requested.length) return ''
  parentSignal?.throwIfAborted()
  const pending = memoryJobs.get(project)
  if (pending?.controller) {
    if (!pending.requestedManuscript.startsWith(requested)) pending.requestedManuscript = requested
    if (!parentSignal) return pending.task
    const stopWaiting = () => pending.controller?.abort(parentSignal.reason)
    parentSignal.addEventListener('abort', stopWaiting, { once: true })
    try { return await pending.task } finally { parentSignal.removeEventListener('abort', stopWaiting) }
  }

  const controller = new AbortController()
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  const job = { controller, error: '', requestedManuscript: requested }
  memoryJobs.set(project, job)
  const refreshVisible = () => { if (project === currentProject()) renderMemory() }
  refreshVisible()

  job.task = (async () => {
    try {
      let snapshot
      do {
        snapshot = job.requestedManuscript
        await updateManuscriptMemory(project, snapshot, signal, async checkpoint => {
          let applied = false
          const saved = await saveWorkspace(() => {
            signal.throwIfAborted()
            if (!workspace.projects.includes(project) ||
                project.manuscript.slice(0, checkpoint.through) !== snapshot.slice(0, checkpoint.through)) return
            const previous = project.manuscriptMemory
            project.manuscriptMemory = checkpoint
            applied = true
            return () => {
              if (project.manuscriptMemory === checkpoint) project.manuscriptMemory = previous
            }
          })
          signal.throwIfAborted()
          if (!saved) throw new Error('메모를 브라우저에 저장할 수 없어 갱신을 멈췄어요.')
          if (!applied) throw new Error('메모를 갱신하는 동안 원고가 바뀌었어요.')
          refreshVisible()
          if (project === currentProject()) writingInputsChanged()
        }, usage => {
          job.usage = combineUsage(job.usage, usage)
          refreshVisible()
        })
      } while (snapshot !== job.requestedManuscript)
    } catch (error) {
      job.error = signal.aborted ? '메모 갱신을 중지했어요.' : completionFailure(error, signal)
    } finally {
      job.controller = null
      refreshVisible()
      if (project === currentProject() && projectNoteDialog.open && !memoryPanel.hidden &&
          document.activeElement === document.body) memoryStatus.focus()
    }
    return job.error
  })()
  return job.task
}

function currentPlanEntry() {
  const project = currentProject()
  if (!plans.has(project)) {
    plans.set(project, {
      idea: '', action: 'append', drafts: { append: null, replace: null }, lastReplacement: null,
    })
  }
  return plans.get(project)
}

function setWorkspaceTab(activeTab) {
  if (activeTab === activeWorkspaceTab) return
  if (activeWorkspaceTab === noteWorkspaceTab) planAssistant.rememberScroll()
  if (activeWorkspaceTab === loreWorkspaceTab) lorebook.rememberScroll()
  activeWorkspaceTab = activeTab
  for (const tab of workspaceTabs) {
    const selected = tab === activeTab
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
    get(tab.getAttribute('aria-controls')).hidden = !selected
  }
  renderSidebarContext()
  renderContinuation()
  const draft = currentContinuation()
  if (activeTab === manuscriptTab && draft && !draft.showManuscript) switchPanel('continuation')
  else switchPanel(activeTab === loreWorkspaceTab ? 'lore' : undefined)
  syncControls()
  if (activeTab === manuscriptTab) showContinuationStart()
  if (activeTab === noteWorkspaceTab) {
    planProgress.render()
    planAssistant.restoreScroll()
  }
  if (activeTab === loreWorkspaceTab) lorebook.restoreScroll()
}

function renderPlanner() {
  const entry = currentPlanEntry()
  planAction.value = entry.action
  planIdea.value = entry.idea
  planIdea.placeholder = noteKinds.synopsis.placeholder
  planAssistant.useConversation(entry)
  renderSidebarContext()
  renderPlanContextLimit()
  renderPlanDraft()
  planProgress.render()
  updatePlanControls()
}

function renderPlanContextLimit() {
  const status = get('plan-context-limit')
  const message = projectNotesLimitHint(currentProject())
  status.hidden = !message
  if (status.textContent !== message) status.textContent = message
}

function renderPlanDraft() {
  const { action, drafts } = currentPlanEntry()
  const draft = drafts[action]
  const title = action === 'replace' ? '수정안' : '초안'
  get('note-draft').hidden = draft === null
  get('note-draft-title').textContent = `줄거리 ${title}`
  get('note-draft-replace-hint').hidden = action !== 'replace'
  get('plan-show-draft').textContent = `${title} 보기`
  get('plan-discard').textContent = `${title} 버리기`
  planDraftText.value = draft?.text ?? ''
}

function planDraftResult(target, original, action, draft) {
  const text = draft?.text.trim() ?? ''
  if (!text) return { text, message: '' }
  const replacing = action === 'replace'
  if (replacing && draft.original !== original) {
    return { text, message: '수정안을 만든 뒤 기존 메모가 바뀌었어요. 새 수정안을 만들어 주세요.' }
  }
  const result = replacing ? text : appendParagraphs(original, text)
  if (result.length <= writingFields[target]) return { text: result, message: '' }
  const message = replacing
    ? `교체하려면 수정안을 ${formatNumber.format(writingFields[target])}자 이내로 줄여 주세요.`
    : '메모에 추가하려면 기존 메모나 초안의 길이를 줄여 주세요.'
  return { text: result, message }
}

async function savePlanNote(target, text, rollbackOnFailure) {
  const project = currentProject()
  const update = () => {
    const previous = project[target]
    project[target] = text
    return () => { if (project[target] === text) project[target] = previous }
  }
  if (!rollbackOnFailure) update()
  const saved = await saveWorkspace(rollbackOnFailure ? update : undefined)
  const field = get(target)
  if (project === currentProject()) field.value = project[target] ?? ''
  return { saved, field }
}

function updatePlanControls() {
  const planning = planAssistant.busy
  const target = 'synopsis'
  const { action, drafts, lastReplacement, saving } = currentPlanEntry()
  const replacing = action === 'replace'
  const draft = drafts[action]
  const original = currentProject()[target] ?? ''
  const tooLongToReplace = replacing && original.length > writingFields[target]
  planAction.disabled = planning
  planIdea.readOnly = planning
  planGenerate.hidden = planning
  planGenerate.textContent = replacing ? '수정안 만들기' : '초안 만들기'
  planGenerate.disabled = Boolean(activeRequest) || tooLongToReplace
  planSend.hidden = planning
  planSend.disabled = Boolean(activeRequest) || tooLongToReplace || !planIdea.value.trim()
  planStop.hidden = !planning
  planReset.disabled = planning || planTranscript.hidden
  get('plan-revision-limit').hidden = !tooLongToReplace

  get('plan-empty').hidden = !planTranscript.hidden || draft !== null
  get('plan-show-draft').hidden = draft === null
  planUndoReplacement.hidden = !lastReplacement || lastReplacement.after !== original
  planUndoReplacement.disabled = planning || saving
  const { text, message } = planDraftResult(target, original, action, draft)
  const status = get('note-draft-status')
  status.hidden = !message
  if (status.textContent !== message) status.textContent = message
  planDraftText.readOnly = planning
  get('plan-discard').disabled = planning
  planAccept.textContent = replacing ? '기존 메모 교체' : '메모에 추가'
  planAccept.disabled = planning || saving || Boolean(message) || !text
}

async function sendPlanMessage(mode) {
  if (activeRequest || planAssistant.busy) return
  const project = currentProject()
  const target = 'synopsis'
  const entry = currentPlanEntry()
  const { action, drafts } = entry
  const replacing = action === 'replace'
  const original = project[target] ?? ''
  if (replacing && original.length > writingFields[target]) return
  const idea = entry.idea
  const previousDraft = drafts[action]
  const reusableDraft = !replacing || previousDraft?.original === original ? previousDraft?.text.trim() : ''
  const draftRequest = replacing ? '지금까지의 대화를 반영해 기존 줄거리 전체의 수정안을 작성해 주세요.'
    : '줄거리, 관련 설정과 지금까지의 대화를 바탕으로 초안을 작성해 주세요.'
  const message = idea.trim() || (mode === 'draft' ? draftRequest : '')
  if (!message) return
  entry.idea = ''
  planIdea.value = ''
  const sent = await planAssistant.send({
    kind: 'note',
    mode,
    model: modelFor(project, 'plan'),
    maxTokens: project.maxTokens,
    target,
    noteAction: action,
    context: assistantProjectContext(project, message),
    systemPrompt: project.notePrompts?.[target],
    draft: reusableDraft || null,
  }, message, project)
  if (!sent) entry.idea = idea
  if (currentPlanEntry() !== entry) return
  planIdea.value = entry.idea
  updatePlanControls()
  if (document.activeElement === document.body && !notePlanner.hidden) {
    const receivedDraft = mode === 'draft' && sent && drafts[action] && drafts[action] !== previousDraft
    const field = receivedDraft ? planDraftText : planIdea
    field.focus()
  }
}

function bindField(id, update) {
  const field = get(id)
  field.addEventListener('input', () => {
    update(field.value)
    saveWorkspace()
    writingInputsChanged()
  })
}

function currentPromptTarget() {
  if (promptEditorMode === 'lore') return 'lore'
  return promptEditorMode === 'note' ? 'synopsis' : promptTarget.value
}

function currentPromptDefault() {
  const target = currentPromptTarget()
  if (target === 'continuation') return defaultSystemPrompt
  if (target === 'memory') return defaultMemoryPrompt
  if (target === 'lore') return defaultLoreSystemPrompt
  return target === 'revision' ? defaultRevisionPrompt : defaultNoteSystemPrompt(target)
}

function renderPromptEditor() {
  const project = currentProject()
  const target = currentPromptTarget()
  const value = target === 'continuation' ? project.systemPrompt : project.notePrompts?.[target]
  const assistantLabel = target === 'lore' ? '로어북 AI 카드' : noteKinds[target]?.label
  get('manuscript-prompt-target').hidden = promptEditorMode !== 'manuscript'
  get('system-prompt-label').textContent = assistantLabel ? `${assistantLabel} 도우미 프롬프트` : '시스템 프롬프트'
  systemPrompt.value = value ?? currentPromptDefault()
  systemPrompt.scrollTop = 0
  updatePromptControls()
}

function setPromptOverride(value) {
  const project = currentProject()
  const target = currentPromptTarget()
  if (target === 'continuation') {
    project.systemPrompt = value
  } else {
    project.notePrompts ??= {}
    project.notePrompts[target] = value
  }
}

function updatePromptControls() {
  resetSystemPrompt.disabled = systemPrompt.value === currentPromptDefault()
  get('system-prompt-status').textContent = ''
}

function showNoteStatus(id, message = '', isError = false) {
  const status = get(`${id}-status`)
  status.hidden = !message
  status.dataset.error = String(isError)
  status.textContent = message
}

async function readNoteFile(file) {
  if (!/\.(txt|md|markdown)$/i.test(file.name)) {
    throw new Error('TXT 또는 Markdown 파일을 선택해 주세요.')
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const encodings = bytes[0] === 0xff && bytes[1] === 0xfe ? ['utf-16le']
    : bytes[0] === 0xfe && bytes[1] === 0xff ? ['utf-16be']
    : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? ['utf-8']
    : ['utf-8', 'euc-kr']
  let text
  for (const encoding of encodings) {
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
      break
    } catch {
      // Try the next encoding for a file without a byte-order mark.
    }
  }
  if (text === undefined || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new Error('파일을 텍스트로 읽을 수 없어요. UTF-8로 저장한 뒤 다시 불러와 주세요.')
  }
  if (!text.trim()) throw new Error('내용이 있는 파일만 불러올 수 있어요.')
  return normalizeLineEndings(text)
}

function bindNoteImport(id, key) {
  const field = get(id)
  const input = get(`${id}-file`)
  const button = get(`${id}-import`)
  const limit = writingFields[key]
  const sizeError = `메모는 총 ${formatNumber.format(limit)}자까지 담을 수 있어요. 파일이나 기존 메모를 줄여 주세요.`
  field.maxLength = limit
  bindField(id, value => {
    currentProject()[key] = value
    showNoteStatus(id)
    renderPlanContextLimit()
  })
  button.addEventListener('click', () => input.click())
  input.addEventListener('change', async () => {
    const files = Array.from(input.files)
    input.value = ''
    if (!files.length) return

    const project = currentProject()
    button.disabled = true
    showNoteStatus(id, '파일을 읽는 중이에요.')
    try {
      const bytes = files.reduce((sum, file) => sum + file.size, 0)
      if (bytes > limit * 4 + files.length * 3) throw new Error(sizeError)
      const texts = await Promise.all(files.map(readNoteFile))
      const value = [project[key] ?? '', ...texts].filter(Boolean).join('\n\n')
      if (value.length > limit) throw new Error(sizeError)
      project[key] = value
      if (project === currentProject()) {
        field.value = value
        showNoteStatus(id, `파일 ${formatNumber.format(files.length)}개를 불러왔어요.`)
        renderPlanContextLimit()
        writingInputsChanged()
      }
      saveWorkspace()
    } catch (error) {
      if (project === currentProject()) {
        const message = error instanceof DOMException
          ? '파일을 열 수 없어요. 다시 선택해 주세요.' : error.message
        showNoteStatus(id, message, true)
      }
    } finally {
      button.disabled = false
    }
  })
}

const manuscriptSelection = () => ({ start: manuscript.selectionStart, end: manuscript.selectionEnd })

function applyManuscriptInput(inputType, selection) {
  const project = currentProject()
  const before = project.manuscript
  const value = manuscript.value
  if (value === before) return
  const scenes = project.savedScenes
  const replay = scenes?.length && sceneHistoryReplay(sceneUndo, before, value, inputType)
  const edit = scenes?.length ? replay?.edit ??
    manuscriptEdit(before, value, selection && !isSceneHistoryEdit(inputType) ? { ...selection, caret: manuscript.selectionStart } : undefined) : undefined
  setManuscriptText(project, value, edit)
  if (scenes?.length) {
    project.savedScenes = reconcileSceneUndo(sceneUndo, before, value, scenes, project.savedScenes, inputType, edit, replay)
  }
  sceneMessages.delete(project)
  updateCharacterCount()
  renderSavedScenes()
  renderMemory()
  saveWorkspace()
  writingInputsChanged()
}

manuscript.addEventListener('compositionstart', () => {
  manuscriptSelectionBeforeEdit = undefined
  manuscriptComposition = { project: currentProject(), selection: manuscriptSelection() }
})
manuscript.addEventListener('compositionend', () => {
  const composition = manuscriptComposition
  manuscriptComposition = undefined
  if (composition?.project === currentProject()) applyManuscriptInput('insertCompositionText', composition.selection)
})
manuscript.addEventListener('beforeinput', event => {
  if (!manuscriptComposition) manuscriptSelectionBeforeEdit = manuscriptSelection()
  else if (event.inputType === 'historyUndo') {
    manuscriptComposition.undo = { text: manuscript.value, caret: manuscript.selectionStart }
  }
})
manuscript.addEventListener('input', event => {
  if (event.isComposing) {
    activeRequest?.cancelPreparation?.()
    return
  }
  const composition = manuscriptComposition
  const selection = composition?.selection ?? manuscriptSelectionBeforeEdit
  manuscriptComposition = undefined
  manuscriptSelectionBeforeEdit = undefined
  if (composition) {
    const { project, undo } = composition
    if (project !== currentProject()) return
    // Chromium can undo an in-progress composition without firing compositionend.
    if (event.inputType === 'historyUndo' && undo && manuscript.value === project.manuscript) {
      rememberUndoneComposition(sceneUndo, project.manuscript, undo.text, project.savedScenes, { ...selection, caret: undo.caret })
      return
    }
  }
  applyManuscriptInput(event.inputType, selection)
})
manuscript.addEventListener('scroll', syncManuscriptGutter)
manuscript.addEventListener('selectionchange', selectSceneAtManuscriptCaret)
new ResizeObserver(() => {
  syncManuscriptGutter()
  scheduleManuscriptSceneMarks()
}).observe(manuscript)
bindField('direction', value => { currentProject().direction = value })
get('scene-length').maxLength = writingFields.sceneLength
bindField('scene-length', value => {
  const length = value.trim()
  if (length) currentProject().sceneLength = length
  else delete currentProject().sceneLength
})
get('author-mode').addEventListener('change', event => {
  currentProject().authorMode = event.target.value
  saveWorkspace()
  writingInputsChanged()
})
for (const event of ['select', 'mouseup', 'keyup']) {
  manuscript.addEventListener(event, () => {
    updateRevision()
    if (!scenesPanel.hidden) {
      sceneMessages.delete(currentProject())
      syncSceneControls()
    }
  })
}
revisionLine.addEventListener('input', () => revisionLine.setCustomValidity(''))
get('revision-line-form').addEventListener('submit', event => {
  event.preventDefault()
  const line = revisionLine.valueAsNumber - 1
  const start = manuscriptLineStarts[line]
  const end = manuscriptLineStarts[line + 1] ?? manuscript.value.length
  const paragraph = paragraphRanges(manuscript.value).find(item => item.start < end && item.end > start)
  if (paragraph) {
    goToPassage(paragraph)
    updateRevision()
  } else {
    revisionLine.setCustomValidity('본문이 있는 줄 번호를 입력해 주세요.')
    revisionLine.reportValidity()
  }
})
get('open-revision').addEventListener('click', () => {
  updateRevision()
  switchPanel('tools')
  get('revision').open = true
  get('revision').querySelector('summary').focus()
})
get('revision-direction').addEventListener('input', renderEstimates)
get('generate-revision').addEventListener('click', () => {
  const paragraph = selectedRevision()
  if (paragraph) generateRevision(paragraph)
})
get('preview-request').addEventListener('click', event => showRequestPreview({ origin: event.currentTarget }))
get('preview-semantic-search').addEventListener('click', () => showRequestPreview({ refreshSemantic: true }))
get('retry-search').addEventListener('click', event => showRequestPreview({ refreshSemantic: true, origin: event.currentTarget }))
get('close-request-preview').addEventListener('click', () => {
  const origin = previewOrigin
  closeRequestPreview()
  syncControls()
  if (origin) switchPanel(origin.panel)
  if (origin?.button.getClientRects().length) origin.button.focus()
  else document.querySelector('.tool-switcher [aria-pressed="true"]').focus()
})
memoryAuto.addEventListener('change', () => {
  currentProject().autoMemory = memoryAuto.checked
  saveWorkspace()
})
memoryRefresh.addEventListener('click', () => {
  refreshProjectMemory(currentProject())
  memoryStatus.focus()
})
memoryStop.addEventListener('click', () => memoryJobs.get(currentProject())?.controller?.abort())
bindNoteImport('synopsis', 'synopsis')
promptTarget.addEventListener('change', renderPromptEditor)
for (const tab of workspaceTabs) {
  tab.addEventListener('click', () => setWorkspaceTab(tab))
  tab.addEventListener('keydown', event => {
    let nextTab
    const index = workspaceTabs.indexOf(tab)
    if (event.key === 'Home') nextTab = workspaceTabs[0]
    else if (event.key === 'End') nextTab = workspaceTabs.at(-1)
    else if (event.key === 'ArrowLeft') nextTab = workspaceTabs[(index + workspaceTabs.length - 1) % workspaceTabs.length]
    else if (event.key === 'ArrowRight') nextTab = workspaceTabs[(index + 1) % workspaceTabs.length]
    if (!nextTab) return
    event.preventDefault()
    setWorkspaceTab(nextTab)
    nextTab.focus()
  })
}
for (const [id, mode] of Object.entries({
  'edit-manuscript-prompt': 'manuscript',
  'edit-plan-prompt': 'note',
  'edit-lore-prompt': 'lore',
})) {
  get(id).addEventListener('click', () => {
    promptEditorMode = mode
    renderPromptEditor()
    promptDialog.showModal()
    systemPrompt.focus()
  })
}
for (const button of writingTools.querySelectorAll('[data-open-project-note]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.openProjectNote
    selectProjectNote(key)
    get('project-note-title').textContent = button.textContent.trim()
    projectNoteDialog.showModal()
  })
}
planIdea.maxLength = assistantMessageLimit
planDraftText.maxLength = assistantNoteDraftLimit
planAction.addEventListener('change', () => {
  if (!noteDraftActions.includes(planAction.value) || planAssistant.busy) return
  currentPlanEntry().action = planAction.value
  renderPlanDraft()
  updatePlanControls()
})
planIdea.addEventListener('input', () => {
  currentPlanEntry().idea = planIdea.value
  updatePlanControls()
})
get('note-planner-form').addEventListener('submit', event => {
  event.preventDefault()
  sendPlanMessage('chat')
})
planGenerate.addEventListener('click', () => sendPlanMessage('draft'))
planStop.addEventListener('click', () => planAssistant.stop())
get('plan-show-draft').addEventListener('click', () => planDraftText.focus())
planReset.addEventListener('click', () => {
  planAssistant.reset()
  planIdea.focus()
})
planDraftText.addEventListener('input', () => {
  if (planAssistant.busy) return
  const { drafts, action } = currentPlanEntry()
  if (!drafts[action]) return
  drafts[action].text = planDraftText.value
  updatePlanControls()
})
get('plan-discard').addEventListener('click', () => {
  const { drafts, action } = currentPlanEntry()
  drafts[action] = null
  renderPlanDraft()
  updatePlanControls()
  planIdea.focus()
})
planAccept.addEventListener('click', async () => {
  const target = 'synopsis'
  const entry = currentPlanEntry()
  const { action, drafts } = entry
  if (planAssistant.busy || planAccept.disabled) return
  const original = currentProject()[target] ?? ''
  const { text, message } = planDraftResult(target, original, action, drafts[action])
  if (!text || message) return
  const replacing = action === 'replace'
  entry.saving = true
  updatePlanControls()
  const { saved, field } = await savePlanNote(target, text, replacing)
  entry.saving = false
  updatePlanControls()
  if (replacing && !saved) {
    planStatus.textContent = '브라우저에 저장하지 못했어요. 기존 메모와 수정안은 그대로 있어요.'
    writingInputsChanged()
    return
  }
  if (replacing) {
    entry.lastReplacement = { before: original, after: text }
  }
  drafts[action] = null
  renderPlanDraft()
  writingInputsChanged()
  planStatus.textContent = replacing ? '기존 줄거리를 수정안으로 교체했어요.'
    : saved ? '초안을 줄거리에 추가했어요.' : '줄거리에 추가했지만 브라우저에 저장하지 못했어요.'
  planIdea.focus()
  field.setSelectionRange(text.length, text.length)
  field.scrollTop = field.scrollHeight
})
planUndoReplacement.addEventListener('click', async () => {
  const target = 'synopsis'
  const entry = currentPlanEntry()
  const replacement = entry.lastReplacement
  if (!replacement || planUndoReplacement.disabled || replacement.after !== (currentProject()[target] ?? '')) return
  entry.saving = true
  updatePlanControls()
  const { saved } = await savePlanNote(target, replacement.before, true)
  entry.saving = false
  updatePlanControls()
  if (saved) {
    entry.lastReplacement = null
    planIdea.focus()
  }
  writingInputsChanged()
  planStatus.textContent = saved ? '교체하기 전 메모를 복원했어요.' : '메모를 복원하지 못했어요. 브라우저 저장 상태를 확인해 주세요.'
})
systemPrompt.maxLength = systemPromptLimit
bindField('system-prompt', value => {
  setPromptOverride(value === currentPromptDefault() ? undefined : value)
  updatePromptControls()
})
resetSystemPrompt.addEventListener('click', () => {
  setPromptOverride(undefined)
  renderPromptEditor()
  systemPrompt.setSelectionRange(0, 0)
  saveWorkspace()
  writingInputsChanged()
  systemPrompt.focus()
  get('system-prompt-status').textContent = '기본 시스템 프롬프트를 복원했어요.'
})
projectSelect.addEventListener('change', () => {
  workspace.activeProjectId = projectSelect.value
  renderWorkspace()
  saveWorkspace()
})
function openProjectTitle() {
  projectTitle.value = currentProject().title
  projectTitleDialog.showModal()
  projectTitle.select()
}
get('edit-project-title').addEventListener('click', openProjectTitle)
get('cancel-project-title').addEventListener('click', () => projectTitleDialog.close())
get('project-title-form').addEventListener('submit', event => {
  event.preventDefault()
  currentProject().title = projectTitle.value
  renderProjectSelect()
  saveWorkspace()
  writingInputsChanged()
  projectTitleDialog.close()
})
get('add-project').addEventListener('click', () => {
  const project = makeProject()
  workspace.projects.push(project)
  workspace.activeProjectId = project.id
  renderWorkspace()
  saveWorkspace()
  setWorkspaceTab(manuscriptTab)
  switchPanel('notes')
  openProjectTitle()
})
for (const button of toolButtons) {
  button.addEventListener('click', () => switchPanel(button.dataset.panel))
}
get('manuscript-composer').addEventListener('submit', event => {
  event.preventDefault()
  continueManuscript()
})
savedSceneList.addEventListener('click', event => {
  const button = event.target.closest('[data-scene]')
  if (!button || manuscriptCommitPending()) return
  const scene = currentProject().savedScenes?.find(item => item.id === button.dataset.scene)
  if (scene) selectSavedScene(scene)
})
sceneRewrite.addEventListener('click', openSavedScene)
sceneRegister.addEventListener('click', () => saveSceneRange())
sceneConfirmRange.addEventListener('click', () => {
  const scene = selectedScene()
  if (scene && !scene.range) saveSceneRange(scene)
})
continuationDirection.maxLength = writingFields.direction
continuationDirection.addEventListener('input', () => {
  const draft = currentContinuation()
  draft.direction = continuationDirection.value
  draft.feedback = ''
  syncControls()
})
get('continuation-composer').addEventListener('submit', event => {
  event.preventDefault()
  rewriteContinuation()
})
continuationHistory.addEventListener('click', event => {
  const version = event.target.closest('[data-version]')
  if (!version) return
  showContinuationVersion(Number(version.dataset.version))
  continuationHistory.querySelector(`[data-version="${version.dataset.version}"]`)?.focus()
})
continuationPrevious.addEventListener('click', () => {
  const draft = currentContinuation()
  const previous = draft.versions[draft.selected].parent
  if (previous === null) return
  showContinuationVersion(previous)
  if (continuationPrevious.hidden) get('continuation-scroll').focus({ preventScroll: true })
})
get('return-to-continuation').addEventListener('click', () => {
  currentContinuation().showManuscript = false
  renderContinuation()
  switchPanel('continuation')
  syncControls()
  get('continuation-scroll').focus({ preventScroll: true })
})
continuationDiscard.addEventListener('click', () => {
  const draft = currentContinuation()
  if (continuationDiscard.disabled || !draft) return
  const project = currentProject()
  closeContinuation(project)
  if (draft.scene) {
    const scene = project.savedScenes?.find(item => item.id === draft.scene.id)
    if (scene?.range) selectSavedScene(scene)
    else manuscript.focus({ preventScroll: true })
  } else get('direction').focus({ preventScroll: true })
})
continuationAccept.addEventListener('click', acceptContinuation)
for (const stop of [stopWriting, continuationStop, revisionProposal.stop]) {
  stop.addEventListener('click', () => activeRequest?.controller?.abort())
}
revisionProposal.discard.addEventListener('click', closeRevisionProposal)
revisionProposal.section.addEventListener('cancel', event => {
  event.preventDefault()
  closeRevisionProposal()
})
revisionProposal.accept.addEventListener('click', () => {
  const project = currentProject()
  if (!revisionDraft || activeRequest || revisionProposal.accept.disabled) return
  const { start, end, text: original } = revisionDraft.revision
  if (project.manuscript.slice(start, end) !== original) return
  const text = normalizeLineEndings(revisionDraft.text.trim())
  closeRevisionProposal()
  saveManuscript(project, project.manuscript.slice(0, start) + text + project.manuscript.slice(end), { start, end, inserted: text })
  goToPassage({ start, end: start + text.length, text })
})

function saveManuscript(project, text, edit) {
  setManuscriptText(project, text, edit)
  saveWorkspace()
  renderManuscriptText(text)
}

function renderManuscriptText(text) {
  revisionSelection = undefined
  if (manuscript.value !== text) {
    sceneUndo.length = 0
    manuscriptSelectionBeforeEdit = undefined
    manuscriptComposition = undefined
    manuscript.value = text
  }
  updateCharacterCount()
  renderSavedScenes()
  renderMemory()
  writingInputsChanged()
}
function download(content, extension, type) {
  const title = projectName(currentProject()).replace(/[<>:"/\\|?*]/g, '_')
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${title}.${extension}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const filesDialog = get('files-dialog')
const deleteProjectDialog = get('delete-project-dialog')
const fileStatus = message => { get('files-status').textContent = message }
const packOptions = () => ({ lorebook: get('pack-lore').checked, prompts: get('pack-prompts').checked })
const downloadJson = (value, extension) => download(JSON.stringify(value, null, 2), extension, 'application/json;charset=utf-8')
const packReview = get('pack-review')
let pendingPack
let filesSession = 0
let pendingProjectDeletion

function clearPackReview() {
  pendingPack = undefined
  packReview.hidden = true
}

get('open-files').addEventListener('click', () => {
  filesSession++
  clearPackReview()
  fileStatus('')
  filesDialog.showModal()
})
filesDialog.addEventListener('close', () => {
  // The close event is queued and the dialog may already be open again.
  if (!filesDialog.open) clearPackReview()
})
get('export-project').addEventListener('click', () => {
  const project = currentProject()
  download([projectName(project), project.manuscript].filter(Boolean).join('\n\n'), 'txt', 'text/plain;charset=utf-8')
})
function downloadProjectBackup() {
  downloadJson(exportProject(currentProject()), '통조림.json')
}
get('download-backup').addEventListener('click', downloadProjectBackup)
get('download-storage-backup').addEventListener('click', downloadProjectBackup)
get('open-delete-project').addEventListener('click', () => {
  pendingProjectDeletion = currentProject()
  get('delete-project-message').textContent =
    `‘${projectName(pendingProjectDeletion)}’의 원고, 메모, 로어북과 설정을 삭제해요. 복원하려면 삭제 전에 JSON으로 백업해 주세요.`
  get('delete-project-status').hidden = true
  deleteProjectDialog.showModal()
})
get('cancel-delete-project').addEventListener('click', () => deleteProjectDialog.close())
deleteProjectDialog.addEventListener('close', () => {
  if (!deleteProjectDialog.open) pendingProjectDeletion = undefined
})
get('delete-project-backup').addEventListener('click', () => {
  if (pendingProjectDeletion === currentProject()) downloadProjectBackup()
})
get('delete-project-form').addEventListener('submit', async event => {
  event.preventDefault()
  const project = pendingProjectDeletion
  const status = get('delete-project-status')
  if (project !== currentProject() || activeRequest || planAssistant.busy) {
    status.textContent = '작품 상태가 바뀌었어요. 창을 닫고 다시 시도해 주세요.'
    status.hidden = false
    return
  }

  if (!await saveWorkspace(() => {
    const previous = workspace.projects
    const index = previous.indexOf(project)
    if (index < 0) return
    const remaining = previous.filter(item => item !== project)
    if (!remaining.length) remaining.push(makeProject())
    workspace.projects = remaining
    workspace.activeProjectId = remaining[Math.min(index, remaining.length - 1)].id
    return () => {
      if (workspace.projects !== remaining) return
      workspace.projects = previous
      workspace.activeProjectId = project.id
    }
  })) {
    status.textContent = storageWarning
    status.hidden = false
    return
  }

  memoryJobs.get(project)?.controller?.abort()
  sceneReviewJobs.stop(project)
  continuations.delete(project)
  deleteProjectDialog.close()
  renderWorkspace()
  fileStatus(`‘${projectName(project)}’을 삭제했어요.`)
})
get('download-pack').addEventListener('click', () => {
  try { downloadJson(exportPack(currentProject(), packOptions()), '통조림-설정.json') }
  catch (error) { fileStatus(error.message) }
})

function checkImportProject(project) {
  if (deleteProjectDialog.open || activeRequest || planAssistant.busy || project !== currentProject()) {
    throw new Error('작품 상태가 바뀌었어요. 다시 불러와 주세요.')
  }
}

function bindProjectImport(action, read, prepare) {
  const input = get(`${action}-file`)
  const button = get(action)
  button.addEventListener('click', () => input.click())
  input.addEventListener('change', async () => {
    const file = input.files[0]
    input.value = ''
    if (!file) return
    clearPackReview()
    fileStatus('')
    const session = filesSession
    const project = currentProject()
    button.disabled = true
    try {
      const text = await file.text()
      if (!filesDialog.open || session !== filesSession) return
      checkImportProject(project)
      await prepare(read(text, packOptions()), project)
    } catch (error) {
      if (filesDialog.open && session === filesSession) fileStatus(error.message)
    } finally {
      button.disabled = false
    }
  })
}
bindProjectImport('restore-backup', readProject, async restored => {
  workspace.projects.push(restored)
  workspace.activeProjectId = restored.id
  renderWorkspace()
  fileStatus(await saveWorkspace() ? `‘${projectName(restored)}’을 새 작품으로 복원했어요.` : '불러왔지만 브라우저에 저장할 수 없어요.')
})
bindProjectImport('import-pack', readPack, (settings, project) => {
  const details = [`‘${projectName(project)}’의 선택한 설정을 교체해요.`]
  if (Object.hasOwn(settings, 'lorebook')) {
    const before = project.lorebook?.length ?? 0
    const after = settings.lorebook.length
    details.push(before && !after
      ? `가져올 로어북이 비어 있어 기존 카드 ${formatNumber.format(before)}장이 모두 삭제돼요.`
      : `기존 로어북 카드 ${formatNumber.format(before)}장이 가져오는 카드 ${formatNumber.format(after)}장으로 교체돼요.`)
  }
  if (Object.keys(settings).some(key => key !== 'lorebook')) details.push('문체·프롬프트 설정을 교체해요.')
  pendingPack = { settings, project }
  get('pack-review-details').textContent = details.join(' ')
  packReview.hidden = false
  get('pack-review-title').focus()
})
for (const id of ['pack-lore', 'pack-prompts']) {
  get(id).addEventListener('change', () => {
    if (!pendingPack) return
    clearPackReview()
    fileStatus('가져올 항목을 바꿨어요. 설정 파일을 다시 선택해 주세요.')
  })
}
get('cancel-pack-import').addEventListener('click', () => {
  clearPackReview()
  fileStatus('설정 가져오기를 취소했어요.')
  get('import-pack').focus()
})
get('apply-pack-import').addEventListener('click', async () => {
  if (!pendingPack || !filesDialog.open) return
  const { settings, project } = pendingPack
  try {
    checkImportProject(project)
    if (!await saveWorkspace(() => {
      const previous = new Map(Object.keys(settings).map(key => [key, Object.hasOwn(project, key) ? project[key] : undefined]))
      Object.assign(project, settings)
      return () => {
        for (const [key, value] of previous) {
          if (project[key] !== settings[key]) continue
          if (value === undefined) delete project[key]
          else project[key] = value
        }
      }
    })) {
      throw new Error('설정을 브라우저에 저장할 수 없어 교체하지 않았어요.')
    }
    renderWorkspace()
    fileStatus(`‘${projectName(project)}’에 선택한 설정을 적용했어요.`)
  } catch (error) {
    fileStatus(error.message)
  } finally {
    clearPackReview()
    get('import-pack').focus()
  }
})
function syncWorkspaceFromStorage(latest = readCachedWorkspace()) {
  if (!syncSavedWorkspace(latest)) {
    storageWarning = storageConflictMessage
  }
  showStorageStatus()
}

async function verifyWorkspaceForRequest() {
  // A tab opened before this release can still update the snapshot without its notification marker.
  syncWorkspaceFromStorage(await readLatestWorkspace({ full: true }))
  if (storageWarning === storageConflictMessage || workspaceStorageStatus().conflict || composingManuscript()) {
    throw new DOMException(writingContextChanged, 'AbortError')
  }
}

document.addEventListener(workspaceChangeEvent, () => syncWorkspaceFromStorage())
window.addEventListener('beforeunload', event => {
  // A rejected edit can exist only in this tab even after the shared cache has finished saving.
  const unsavedWorkspace = storageWarning && hasUnsavedWorkspace()
  if (!continuations.size && !unsavedWorkspace && !composingManuscript()) return
  event.preventDefault()
  event.returnValue = true
})
document.addEventListener(settingsChangeEvent, event => {
  if (event.detail === storageKey) syncWorkspaceFromStorage()
})
document.addEventListener(workspaceStatusEvent, showStorageStatus)
get('refresh-catalog').addEventListener('click', loadCatalog)
renderWorkspace()
if (savedVersion != null && JSON.stringify(workspace) !== savedVersion) saveWorkspace()
showStorageStatus()
loadCatalog()
