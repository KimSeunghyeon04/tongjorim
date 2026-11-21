import { freeModel, requestCompletion, settingsChangeEvent } from './completion.js'
import { withModelOptions } from './model-options.mjs'
import {
  appendParagraphs, completionPayload, defaultLoreSystemPrompt, defaultMemoryPrompt, defaultNoteSystemPrompt, defaultRevisionPrompt, defaultSystemPrompt,
  effectiveSystemPrompt, memoryOutputLimit, modelFor, normalizeLineEndings, noteDraftActions, noteKinds, projectNotesForRequest, referenceLabels,
  systemPromptLimit, writingFields,
} from './writing-config.mjs'
import { assistantMessageLimit, assistantNoteDraftLimit, createWritingAssistant, projectNotesLimitHint } from './writing-assistant.mjs'
import { memoryForPrompt, memoryReadThrough, memoryRequest, setManuscriptText, updateManuscriptMemory } from './manuscript-memory.mjs'
import { exportPack, exportProject, readPack, readProject } from './project-files.mjs'
import { currentProjectOf, makeProject, mergeModelSettings, projectName, readWorkspace, storageKey } from './writing-workspace.mjs'
import { setupResearch } from './research-panel.mjs'
import { setupSourcePanel } from './source-panel.mjs'
import { paragraphRanges } from './retrieval.mjs'
import { combineUsage, completionEstimate, estimateLabel, jsonRequest, usageLabel } from './request-tools.mjs'

const get = id => document.getElementById(id)

function proposalView(id) {
  return {
    section: get(id),
    title: get(`${id}-title`),
    model: get(`${id}-model`),
    status: get(`${id}-status`),
    usage: get(`${id}-usage`),
    body: get(`${id}-body`),
    actions: get(`${id}-actions`),
    stop: get(`${id}-stop`),
    discard: get(`${id}-discard`),
    accept: get(`${id}-accept`),
  }
}

const projectSelect = get('project-select')
const manuscript = get('manuscript')
const manuscriptLines = get('manuscript-lines')
const revisionLine = get('revision-line')
const projectTitle = get('project-title')
const projectTitleDialog = get('project-title-dialog')
const promptTarget = get('prompt-target')
const notePromptTarget = get('note-prompt-target')
const systemPrompt = get('system-prompt')
const resetSystemPrompt = get('reset-system-prompt')
const promptDialog = get('prompt-dialog')
let promptEditorMode = 'manuscript'
const projectNoteDialog = get('project-note-dialog')
const projectNoteContent = get('project-note-content')
const projectNoteSections = [...projectNoteContent.querySelectorAll('[data-project-note]')]
const noteFields = {
  synopsis: 'synopsis',
  'character-notes': 'characterNotes',
  'world-notes': 'worldNotes',
}
const generate = get('generate')
const continuationProposal = proposalView('proposal')
const revisionProposal = proposalView('revision-proposal')
const notePlanner = get('note-planner')
const manuscriptTab = get('manuscript-tab')
const noteWorkspaceTab = get('note-workspace-tab')
const workspaceTabs = [manuscriptTab, noteWorkspaceTab]
const writingTools = get('writing-tools')
const toolButtons = [...writingTools.querySelectorAll('[data-panel]')]
let manuscriptPanel = 'tools'
const planStatus = get('plan-status')
const planTarget = get('plan-target')
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
const continuationPreviews = new Map()
let revisionPreview
const plans = new WeakMap()
const memoryJobs = new WeakMap()
let models = [freeModel]
let activeRequest
let activePreview
let previewOrigin
let revisionSelection
let indexedManuscript
let manuscriptLineStarts = [0]
let savedVersion
let storageReadable = true
let storageWarning = ''
const storageConflictMessage = '다른 탭에서 작품이 바뀌어 이 탭의 변경을 저장할 수 없어요.'

function loadWorkspace() {
  try {
    savedVersion = localStorage.getItem(storageKey)
    return readWorkspace(savedVersion)
  } catch {
    storageReadable = false
    storageWarning = '저장된 작업 공간을 열 수 없어요.'
    const project = makeProject()
    return { activeProjectId: project.id, projects: [project] }
  }
}

const workspace = loadWorkspace()
const currentProject = () => currentProjectOf(workspace)
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
  get('storage-error').hidden = !storageWarning
  const message = get('storage-error-message')
  if (message.textContent !== storageWarning) message.textContent = storageWarning
  const label = storageWarning ? '브라우저 저장 안 됨' : '브라우저에 저장됨'
  if (get('save-status').textContent !== label) get('save-status').textContent = label
}

function syncSavedWorkspace(latest) {
  if (latest === savedVersion) return true
  if (!storageReadable) return false
  let changed
  try {
    changed = mergeModelSettings(workspace, savedVersion, latest)
  } catch {
    return false
  }
  if (!changed) return false
  savedVersion = latest
  storageWarning = ''
  if (changed.has(currentProject().id)) writingInputsChanged()
  return true
}

function saveWorkspace() {
  if (storageReadable) {
    try {
      if (!syncSavedWorkspace(localStorage.getItem(storageKey))) {
        storageWarning = storageConflictMessage
      } else {
        const nextVersion = JSON.stringify(workspace)
        localStorage.setItem(storageKey, nextVersion)
        savedVersion = nextVersion
        storageWarning = ''
      }
    } catch {
      storageWarning = '브라우저에 저장할 수 없어요.'
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
  if (notePlanner.hidden) manuscriptPanel = name
  const panel = notePlanner.hidden ? manuscriptPanel : 'notes'
  for (const button of toolButtons) {
    const selected = button.dataset.panel === panel
    button.setAttribute('aria-pressed', String(selected))
    get(button.getAttribute('aria-controls')).hidden = !selected
  }
  writingTools.scrollTop = 0
}

function selectProjectNote(key) {
  for (const section of projectNoteSections) {
    section.hidden = section.dataset.projectNote !== key
  }
}

function renderSidebarContext() {
  const onNote = !notePlanner.hidden
  writingTools.dataset.workspace = onNote ? 'note' : 'manuscript'
  writingTools.setAttribute('aria-label', onNote ? '선택한 작품 메모' : '집필 도구')
  const host = get(onNote ? 'notes-panel' : 'project-note-body')
  if (projectNoteContent.parentElement !== host) host.append(projectNoteContent)
  if (onNote) selectProjectNote(currentPlan().target)
}

function updateCharacterCount() {
  get('character-count').textContent = `${formatNumber.format(manuscript.value.length)}자`
  renderManuscriptLines()
}

function syncManuscriptGutter() {
  manuscriptLines.style.width = `${manuscript.clientWidth}px`
  manuscriptLines.style.translate = `0 ${-manuscript.scrollTop}px`
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
  manuscriptLines.parentElement.parentElement.style.setProperty('--line-number-digits', String(lines.length).length)
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

function manuscriptLineRange({ start, end }) {
  const first = manuscriptLineAt(start)
  const last = manuscriptLineAt(Math.max(start, end - 1))
  return first === last ? `${formatNumber.format(first)}줄` :
    `${formatNumber.format(first)}–${formatNumber.format(last)}줄`
}

const passagePosition = range => `원고 ${manuscriptLineRange(range)}`

function renderWorkspace() {
  const project = currentProject()
  closeRequestPreview()
  revisionSelection = undefined
  revisionLine.value = ''
  revisionLine.setCustomValidity('')
  get('revision-direction').value = ''
  renderProjectSelect()
  manuscript.value = project.manuscript
  manuscript.scrollTop = manuscript.scrollHeight
  get('direction').value = project.direction
  get('author-mode').value = project.authorMode ?? 'persistent'
  for (const [id, key] of Object.entries(noteFields)) {
    get(id).value = project[key] ?? ''
    showNoteStatus(id)
  }
  renderLegacySceneNotes(project.legacySceneNotes)
  updateCharacterCount()
  renderContinuationProposal()
  renderPlanner()
  renderMemory()
  research.render()
  renderEstimates()
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
  generate.textContent = activeRequest?.view === continuationProposal ? '생성 중…' : '이어서 쓰기'
  get('generate-revision').disabled = busy || !selectedRevision()
  updatePlanControls()
}

function renderContinuationProposal() {
  const preview = continuationPreviews.get(currentProject().id)
  continuationProposal.section.hidden = !preview
  if (preview) renderProposal(continuationProposal, preview)
}

function renderProposal(view, preview) {
  view.model.textContent = preview.model
  view.usage.hidden = !preview.usage
  view.usage.textContent = preview.usage ? usageLabel(preview.usage) : ''
  if (!preview.revision) view.body.hidden = !preview.text.trim()
  if (view.body.textContent !== preview.text) view.body.textContent = preview.text
  updateProposalActions(view, preview)
}

function updateProposalActions(view, preview) {
  const changed = currentProject().manuscript !== preview.original
  const pending = activeRequest?.view === view ? activeRequest.preview : undefined
  let status = preview.retryStatus ?? preview.status
  if (pending && pending !== preview) {
    status = `${pending.status} 아래는 이전 초안이에요.`
  } else if (changed) {
    const stale = '생성 요청 후 원고가 바뀌었어요. 다시 요청해 주세요.'
    status = preview.retryStatus ? `${status} ${stale}` : stale
  }
  if (view.status.textContent !== status) view.status.textContent = status
  const hideActions = !preview.revision && Boolean(pending)
  view.accept.hidden = hideActions
  view.accept.disabled = Boolean(pending) || changed || !preview.text.trim() || (Boolean(preview.revision) && !preview.complete)
  view.discard.hidden = hideActions
  view.stop.hidden = !pending
}

function closeRevisionProposal() {
  if (activeRequest?.view === revisionProposal) activeRequest.controller.abort()
  revisionPreview = undefined
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
    ...Object.keys(noteKinds).map(key => [key, project[key], referenceLabels[key]]),
  ].filter(([key, text]) => Object.hasOwn(draft, key) && text?.length > draft[key].length).map(([, , label]) => label)
  const limitNotice = get('writing-context-limit')
  const limitNotes = []
  if (limitedFields.length) limitNotes.push(`요청 한도에 맞춰 ${limitedFields.join(', ')}의 앞부분을 보냅니다.`)
  if (saved.remaining < 0) limitNotes.push('모델 컨텍스트가 부족해요. 프롬프트, 참고 자료나 출력 한도를 줄여 주세요.')
  else if (saved.recentReduced || saved.pastReduced) limitNotes.push('모델 컨텍스트에 맞춰 원문을 줄였어요.')
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
  const { model, systemPrompt, ...memory } = memoryRequest(project)
  get('memory-estimate').textContent = memory.excerpt.trim() ? estimate(completionPayload(model, memoryOutputLimit,
    effectiveSystemPrompt(systemPrompt, defaultMemoryPrompt), memory)) + ' · 다음 메모 요청' : ''
}

function closeRequestPreview() {
  activePreview?.abort()
  activePreview = undefined
  previewOrigin = undefined
  get('request-preview').hidden = true
  get('preview-request').setAttribute('aria-expanded', 'false')
}

function writingInputsChanged() {
  closeRequestPreview()
  research.renderState()
  renderEstimates()
  syncControls()
}

function goToPassage({ start, end, text }) {
  if (manuscript.value.slice(start, end) !== text) return
  setNoteWorkspace(false)
  manuscript.focus()
  manuscript.setSelectionRange(start, end)
  syncManuscriptGutter()
  const line = manuscriptLineAt(start) - 1
  const range = document.createRange()
  range.setStart(manuscriptLines.children[line].firstChild, start - manuscriptLineStarts[line])
  range.collapse(true)
  const top = range.getBoundingClientRect().top - manuscriptLines.getBoundingClientRect().top
  manuscript.scrollTop = top - Math.floor(manuscript.clientHeight / 3)
}

const research = setupResearch({ get, currentProject, saveWorkspace, onChange: writingInputsChanged, goToPassage, passagePosition })
const catalogModel = id => models.find(model => model.id === id)
const sourcePanel = setupSourcePanel({
  get, currentProject, getModel: catalogModel, research, saveWorkspace, onSave: writingInputsChanged,
  onSearch: renderEstimates, goToPassage, passagePosition,
})

async function showRequestPreview({ refreshSemantic = false, origin } = {}) {
  if (activePreview || activeRequest || planAssistant.busy) return
  setNoteWorkspace(false)
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
  data.hidden = true
  semanticAction.hidden = true
  status.textContent = refreshSemantic ? '참고 원문을 다시 찾는 중이에요.' : '미리보기를 준비하는 중이에요.'
  get('request-preview-title').focus()
  try {
    const model = catalogModel(project.model)
    const prepared = refreshSemantic
      ? await research.prepare(project, model, controller.signal, { retry: true })
      : research.preview(project, model)
    const payload = await jsonRequest('/api/write/preview', {
      body: withModelOptions(project, prepared.body), signal: controller.signal,
    })
    controller.signal.throwIfAborted()
    const blocks = [
      ['시스템 프롬프트', payload.messages[0].content],
      ...Object.entries(JSON.parse(payload.messages[1].content)).map(([key, value]) => {
        const label = ({ projectTitle: '작품 제목', direction: '작가의 노트', ...referenceLabels })[key]
        const position = key === 'manuscript' && value
          ? manuscriptLineRange({ start: prepared.cutoff, end: prepared.cutoff + value.length }) : ''
        return [position ? `${label} · ${position}` : label, value]
      }),
    ]
    get('request-blocks').replaceChildren(...blocks.map(([label, value]) => {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = label
      const contents = document.createElement('pre')
      contents.textContent = value || '(비어 있음)'
      details.append(summary, contents)
      return details
    }))
    research.renderResults(prepared)
    const value = estimate(payload)
    get('request-preview-estimate').textContent = value
    get('writing-estimate').textContent = value + (prepared.semanticPending ? ' · 의미 검색 반영 전' : '')
    get('request-json').textContent = JSON.stringify(payload, null, 2)
    status.textContent = `OpenRouter에 보낼 순서 · ${payload.model}`
    semanticAction.hidden = !(prepared.semanticPending || prepared.semanticFailed)
    data.hidden = false
  } catch (error) {
    if (!controller.signal.aborted) status.textContent = completionFailure(error, controller.signal)
  } finally {
    if (activePreview === controller) activePreview = undefined
    syncControls()
  }
}

async function generateDraft(revision) {
  if (activeRequest || planAssistant.busy) return
  setNoteWorkspace(false)
  const project = currentProject()
  const view = revision ? revisionProposal : continuationProposal
  const previous = revision ? undefined : continuationPreviews.get(project.id)
  const retained = previous?.complete ? previous : undefined
  const oneTimeNote = !revision && project.authorMode === 'once' ? project.direction : undefined
  const preview = {
    original: project.manuscript, revision, text: '', model: '',
    status: revision ? '수정안을 준비하는 중이에요.' : '전송할 원고와 자료를 준비하는 중이에요.',
  }
  const controller = new AbortController()
  activeRequest = { controller, preview, view }
  syncControls()
  if (revision) {
    revisionPreview = preview
    get('revision-proposal-position').textContent = passagePosition(revision)
    get('revision-original-text').textContent = revision.text
    renderProposal(view, preview)
    view.section.showModal()
    get('revision-original-text').scrollTop = 0
    view.body.scrollTop = 0
  } else {
    if (!retained) continuationPreviews.set(project.id, preview)
    renderContinuationProposal()
    view.title.focus()
  }
  const output = retained ? null : document.createTextNode('')
  if (output) view.body.replaceChildren(output)

  try {
    let body
    if (revision) {
      body = revisionBody(project, revision)
    } else {
      const prepared = await research.prepare(project, catalogModel(project.model), controller.signal)
      if (prepared.remaining < 0) throw new Error('모델 컨텍스트가 부족해요. 프롬프트, 참고 자료나 출력 한도를 줄여 주세요.')
      body = prepared.body
    }
    if (oneTimeNote !== undefined && body.draft.direction === oneTimeNote) preview.oneTimeNote = oneTimeNote
    const result = await requestCompletion(revision ? '/api/revise' : '/api/write', withModelOptions(project, body), {
      signal: controller.signal,
      onText(content) {
        if (controller.signal.aborted) return
        if (!preview.text.trim()) {
          if (output) view.body.hidden = false
          preview.status = '초안을 작성하고 있어요.'
          updateProposalActions(view, retained ?? preview)
        }
        preview.text += content
        output?.appendData(content)
      },
    })
    controller.signal.throwIfAborted()
    preview.model = result.model ?? body.model
    preview.usage = result.usage
    preview.complete = !result.truncated
    if (result.truncated) {
      preview.status = retained ? '새 초안이 토큰 한도에 도달했어요.' : '토큰 한도에 도달했어요. 끝 문장을 확인해 주세요.'
    } else {
      preview.status = revision ? '기존 문단과 비교하고 교체 여부를 선택하세요.' : '원고에 추가할 초안을 확인해 주세요.'
    }
  } catch (error) {
    preview.status = completionFailure(error, controller.signal)
  } finally {
    if (retained) {
      if (preview.complete) continuationPreviews.set(project.id, preview)
      else retained.retryStatus = `${preview.status} 이전 초안을 유지했어요.`
    }
    activeRequest = undefined
    syncControls()
    if (!revision || view.section.open) {
      renderProposal(view, retained && !preview.complete ? retained : preview)
      if (document.activeElement === document.body) view.title.focus({ preventScroll: true })
      if (!revision && document.activeElement === view.title) view.actions.scrollIntoView({ block: 'nearest' })
    }
  }
}

function completionFailure(error, signal) {
  if (signal.aborted) return '생성을 중지했어요.'
  if (error?.name === 'AbortError') return '요청을 준비하는 동안 원고나 설정이 바뀌었어요. 다시 요청해 주세요.'
  if (error instanceof TypeError) return '서버와 연결이 끊겼어요. 다시 시도해 주세요.'
  if (error instanceof SyntaxError) return '서버 응답을 읽지 못했어요. 다시 시도해 주세요.'
  return error.message
}

function renderMemory() {
  const project = currentProject()
  const job = memoryJobs.get(project)
  const through = memoryReadThrough(project)
  const remaining = project.manuscript.length - through
  const running = Boolean(job?.controller)
  const hasManuscript = Boolean(project.manuscript.trim())
  const text = memoryForPrompt(project)

  memoryAuto.checked = Boolean(project.autoMemory)
  memoryRefresh.disabled = running || !hasManuscript || remaining === 0
  memoryStop.hidden = !running
  get('memory-content').hidden = !text
  if (memoryText.value !== text) memoryText.value = text
  get('memory-usage').textContent = job?.usage ? usageLabel(job.usage) : ''

  const message = running ? `${formatNumber.format(through)}자까지 읽었어요. 원고를 읽고 있어요.`
    : job?.error || (!hasManuscript ? '원고가 준비되면 메모를 갱신할 수 있어요.'
      : project.manuscriptMemory?.stale ? '이미 읽은 부분이 바뀌었어요. 처음부터 다시 읽으려면 갱신하기를 누르세요.'
      : remaining ? `아직 메모에 반영할 원고가 ${formatNumber.format(remaining)}자 남았어요.`
      : '현재 원고까지 갱신했어요.')
  if (memoryStatus.textContent !== message) memoryStatus.textContent = message
}

async function refreshProjectMemory(project) {
  const pending = memoryJobs.get(project)
  if (pending?.controller) {
    pending.requestedManuscript = project.manuscript
    return
  }
  if (!project.manuscript.trim() || memoryReadThrough(project) === project.manuscript.length) return

  const controller = new AbortController()
  const job = { controller, error: '', requestedManuscript: project.manuscript }
  memoryJobs.set(project, job)
  const refreshVisible = () => { if (project === currentProject()) renderMemory() }
  refreshVisible()

  try {
    let snapshot
    do {
      snapshot = job.requestedManuscript
      await updateManuscriptMemory(project, snapshot, controller.signal, () => {
        if (!saveWorkspace()) throw new Error('메모를 브라우저에 저장할 수 없어 갱신을 멈췄어요.')
        refreshVisible()
        if (project === currentProject()) writingInputsChanged()
      }, usage => {
        job.usage = combineUsage(job.usage, usage)
        refreshVisible()
      })
    } while (snapshot !== job.requestedManuscript)
  } catch (error) {
    job.error = controller.signal.aborted ? '메모 갱신을 중지했어요.' : completionFailure(error, controller.signal)
  } finally {
    job.controller = null
    refreshVisible()
    if (project === currentProject() && projectNoteDialog.open && !memoryPanel.hidden &&
        document.activeElement === document.body) memoryStatus.focus()
  }
}

function currentPlan() {
  const project = currentProject()
  if (!plans.has(project)) {
    const entries = Object.fromEntries(Object.keys(noteKinds).map(target => [target, {
      idea: '', action: 'append', drafts: { append: null, replace: null }, lastReplacement: null,
    }]))
    plans.set(project, { target: 'synopsis', entries })
  }
  return plans.get(project)
}

function currentPlanEntry() {
  const { target, entries } = currentPlan()
  return entries[target]
}

function setNoteWorkspace(visible) {
  if (visible === !notePlanner.hidden) return
  if (!visible) planAssistant.rememberScroll()
  notePlanner.hidden = !visible
  get('manuscript-view').hidden = visible
  const activeTab = visible ? noteWorkspaceTab : manuscriptTab
  for (const tab of workspaceTabs) {
    const selected = tab === activeTab
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
  renderSidebarContext()
  switchPanel()
  if (visible) planAssistant.restoreScroll()
}

function renderPlanner() {
  const { target } = currentPlan()
  const entry = currentPlanEntry()
  planTarget.value = target
  planAction.value = entry.action
  planIdea.value = entry.idea
  planIdea.placeholder = noteKinds[target].placeholder
  planAssistant.useConversation(entry)
  renderSidebarContext()
  renderPlanContextLimit()
  renderPlanDraft()
  updatePlanControls()
}

function renderPlanContextLimit() {
  const status = get('plan-context-limit')
  const message = projectNotesLimitHint(currentProject())
  status.hidden = !message
  if (status.textContent !== message) status.textContent = message
}

function renderPlanDraft() {
  const { target } = currentPlan()
  const { action, drafts } = currentPlanEntry()
  const draft = drafts[action]
  const title = action === 'replace' ? '수정안' : '초안'
  get('note-draft').hidden = draft === null
  get('note-draft-title').textContent = `${noteKinds[target].label} ${title}`
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

function savePlanNote(target, text, rollbackOnFailure) {
  const project = currentProject()
  const previous = project[target]
  project[target] = text
  const saved = saveWorkspace()
  if (!saved && rollbackOnFailure) project[target] = previous
  const fieldId = Object.keys(noteFields).find(id => noteFields[id] === target)
  const field = get(fieldId)
  field.value = project[target] ?? ''
  return { saved, field }
}

function updatePlanControls() {
  const planning = planAssistant.busy
  const { target } = currentPlan()
  const { action, drafts, lastReplacement } = currentPlanEntry()
  const replacing = action === 'replace'
  const draft = drafts[action]
  const original = currentProject()[target] ?? ''
  const tooLongToReplace = replacing && original.length > writingFields[target]
  planTarget.disabled = planning
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
  planUndoReplacement.disabled = planning
  const { text, message } = planDraftResult(target, original, action, draft)
  const status = get('note-draft-status')
  status.hidden = !message
  if (status.textContent !== message) status.textContent = message
  planDraftText.readOnly = planning
  get('plan-discard').disabled = planning
  planAccept.textContent = replacing ? '기존 메모 교체' : '메모에 추가'
  planAccept.disabled = planning || Boolean(message) || !text
}

async function sendPlanMessage(mode) {
  if (activeRequest || planAssistant.busy) return
  const project = currentProject()
  const { target } = currentPlan()
  const entry = currentPlanEntry()
  const { action, drafts } = entry
  const replacing = action === 'replace'
  const original = project[target] ?? ''
  if (replacing && original.length > writingFields[target]) return
  const idea = entry.idea
  const previousDraft = drafts[action]
  const reusableDraft = !replacing || previousDraft?.original === original ? previousDraft?.text.trim() : ''
  const draftRequest = replacing ? '지금까지의 대화를 반영해 기존 메모 전체의 수정안을 작성해 주세요.'
    : '작품 메모와 지금까지의 대화를 바탕으로 초안을 작성해 주세요.'
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
    context: {
      ...projectNotesForRequest(project),
      manuscriptMemory: memoryForPrompt(project),
    },
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
  return promptEditorMode === 'note' ? notePromptTarget.value : promptTarget.value
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
  get('note-prompt-target-field').hidden = promptEditorMode !== 'note'
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

bindField('manuscript', value => {
  setManuscriptText(currentProject(), value)
  updateCharacterCount()
  const preview = continuationPreviews.get(currentProject().id)
  if (preview) updateProposalActions(continuationProposal, preview)
  renderMemory()
})
manuscript.addEventListener('scroll', syncManuscriptGutter)
new ResizeObserver(syncManuscriptGutter).observe(manuscript)
bindField('direction', value => { currentProject().direction = value })
get('author-mode').addEventListener('change', event => {
  currentProject().authorMode = event.target.value
  saveWorkspace()
  writingInputsChanged()
})
for (const event of ['select', 'mouseup', 'keyup']) manuscript.addEventListener(event, updateRevision)
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
  if (paragraph) generateDraft(paragraph)
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
for (const [id, key] of Object.entries(noteFields)) bindNoteImport(id, key)
for (const select of [planTarget, notePromptTarget]) {
  select.replaceChildren(...Object.entries(noteKinds).map(([key, kind]) => new Option(kind.label, key)))
}
for (const select of [promptTarget, notePromptTarget]) {
  select.addEventListener('change', renderPromptEditor)
}
for (const tab of workspaceTabs) {
  tab.addEventListener('click', () => setNoteWorkspace(tab === noteWorkspaceTab))
  tab.addEventListener('keydown', event => {
    let nextTab
    if (event.key === 'Home') nextTab = manuscriptTab
    else if (event.key === 'End') nextTab = noteWorkspaceTab
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') nextTab = workspaceTabs.find(item => item !== tab)
    if (!nextTab) return
    event.preventDefault()
    setNoteWorkspace(nextTab === noteWorkspaceTab)
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
    if (mode === 'note') notePromptTarget.value = currentPlan().target
    renderPromptEditor()
    promptDialog.showModal()
    systemPrompt.focus()
  })
}
for (const button of writingTools.querySelectorAll('[data-open-project-note]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.openProjectNote
    selectProjectNote(key)
    get('project-note-title').textContent = Object.hasOwn(noteKinds, key) ? '작품 메모' : button.textContent.trim()
    projectNoteDialog.showModal()
  })
}
planIdea.maxLength = assistantMessageLimit
planDraftText.maxLength = assistantNoteDraftLimit
planTarget.addEventListener('change', () => {
  currentPlan().target = planTarget.value
  renderPlanner()
})
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
planAccept.addEventListener('click', () => {
  const { target } = currentPlan()
  const entry = currentPlanEntry()
  const { action, drafts } = entry
  if (planAssistant.busy || planAccept.disabled) return
  const original = currentProject()[target] ?? ''
  const { text, message } = planDraftResult(target, original, action, drafts[action])
  if (!text || message) return
  const replacing = action === 'replace'
  const { saved, field } = savePlanNote(target, text, replacing)
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
  planStatus.textContent = replacing ? '기존 메모를 수정안으로 교체했어요.'
    : saved ? '초안을 작품 메모에 추가했어요.' : '메모에 추가했지만 브라우저에 저장하지 못했어요.'
  planIdea.focus()
  field.setSelectionRange(text.length, text.length)
  field.scrollTop = field.scrollHeight
})
planUndoReplacement.addEventListener('click', () => {
  const { target } = currentPlan()
  const entry = currentPlanEntry()
  const replacement = entry.lastReplacement
  if (!replacement || planAssistant.busy || replacement.after !== (currentProject()[target] ?? '')) return
  const { saved } = savePlanNote(target, replacement.before, true)
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
  setNoteWorkspace(false)
  switchPanel('notes')
  openProjectTitle()
})
for (const button of toolButtons) {
  button.addEventListener('click', () => switchPanel(button.dataset.panel))
}
get('manuscript-composer').addEventListener('submit', event => {
  event.preventDefault()
  generateDraft()
})
for (const view of [continuationProposal, revisionProposal]) {
  view.stop.addEventListener('click', () => activeRequest?.controller.abort())
}
continuationProposal.discard.addEventListener('click', () => {
  continuationPreviews.delete(currentProject().id)
  renderContinuationProposal()
  manuscript.focus()
})
revisionProposal.discard.addEventListener('click', closeRevisionProposal)
revisionProposal.section.addEventListener('cancel', event => {
  event.preventDefault()
  closeRevisionProposal()
})
continuationProposal.accept.addEventListener('click', () => {
  acceptProposal(continuationProposal, continuationPreviews.get(currentProject().id))
})
revisionProposal.accept.addEventListener('click', () => acceptProposal(revisionProposal, revisionPreview))

function acceptProposal(view, preview) {
  const project = currentProject()
  if (!preview || activeRequest || view.accept.disabled) return
  const text = normalizeLineEndings(preview.text.trim())
  const revision = preview.revision
  if (revision && project.manuscript.slice(revision.start, revision.end) !== revision.text) return
  const updated = revision
    ? project.manuscript.slice(0, revision.start) + text + project.manuscript.slice(revision.end)
    : appendParagraphs(project.manuscript, text)
  setManuscriptText(project, updated)
  if (project.authorMode === 'once' && project.direction === preview.oneTimeNote) {
    project.direction = ''
    get('direction').value = ''
  }
  revisionSelection = undefined
  manuscript.value = project.manuscript
  if (revision) closeRevisionProposal()
  else continuationPreviews.delete(project.id)
  renderContinuationProposal()
  updateCharacterCount()
  saveWorkspace()
  renderMemory()
  writingInputsChanged()
  if (revision) goToPassage({ start: revision.start, end: revision.start + text.length, text })
  else {
    manuscript.focus()
    manuscript.setSelectionRange(updated.length, updated.length)
    manuscript.scrollTop = manuscript.scrollHeight
    if (project.autoMemory) refreshProjectMemory(project)
  }
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
get('delete-project-form').addEventListener('submit', event => {
  event.preventDefault()
  const project = pendingProjectDeletion
  const status = get('delete-project-status')
  if (project !== currentProject() || activeRequest || planAssistant.busy) {
    status.textContent = '작품 상태가 바뀌었어요. 창을 닫고 다시 시도해 주세요.'
    status.hidden = false
    return
  }

  const previous = workspace.projects
  const index = previous.indexOf(project)
  const remaining = previous.filter(item => item !== project)
  if (!remaining.length) remaining.push(makeProject())
  workspace.projects = remaining
  workspace.activeProjectId = remaining[Math.min(index, remaining.length - 1)].id
  if (!saveWorkspace()) {
    workspace.projects = previous
    workspace.activeProjectId = project.id
    status.textContent = storageWarning
    status.hidden = false
    return
  }

  memoryJobs.get(project)?.controller?.abort()
  continuationPreviews.delete(project.id)
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
      prepare(read(text, packOptions()), project)
    } catch (error) {
      if (filesDialog.open && session === filesSession) fileStatus(error.message)
    } finally {
      button.disabled = false
    }
  })
}
bindProjectImport('restore-backup', readProject, restored => {
  workspace.projects.push(restored)
  workspace.activeProjectId = restored.id
  renderWorkspace()
  fileStatus(saveWorkspace() ? `‘${projectName(restored)}’을 새 작품으로 복원했어요.` : '불러왔지만 브라우저에 저장할 수 없어요.')
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
get('apply-pack-import').addEventListener('click', () => {
  if (!pendingPack || !filesDialog.open) return
  const { settings, project } = pendingPack
  try {
    checkImportProject(project)
    const keys = Object.keys(settings)
    const previous = new Map(keys.filter(key => Object.hasOwn(project, key)).map(key => [key, project[key]]))
    Object.assign(project, settings)
    if (!saveWorkspace()) {
      for (const key of keys) {
        if (previous.has(key)) project[key] = previous.get(key)
        else delete project[key]
      }
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
function syncWorkspaceFromStorage() {
  if (!syncSavedWorkspace(localStorage.getItem(storageKey))) {
    storageWarning = storageConflictMessage
  }
  showStorageStatus()
}

window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) syncWorkspaceFromStorage()
})
document.addEventListener(settingsChangeEvent, event => {
  if (event.detail === storageKey) syncWorkspaceFromStorage()
})
get('refresh-catalog').addEventListener('click', loadCatalog)
renderWorkspace()
saveWorkspace()
loadCatalog()
