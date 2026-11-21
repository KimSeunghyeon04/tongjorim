import { embedPast } from './embedding-index.mjs'
import { embeddingRouteKey, modelOptionsFor } from './model-options.mjs'
import { memoryForPrompt } from './manuscript-memory.mjs'
import { defaultReferenceSettings, loreCardFields, validLoreCard } from './project-files.mjs'
import { actualUsage, combineUsage, estimateLabel, usageLabel } from './request-tools.mjs'
import { chunkManuscript, loreKinds, loreLimits, rankPast, retrievalInput, searchFor } from './retrieval.mjs'
import { assistantMessageLimit, createWritingAssistant, projectNotesLimitHint } from './writing-assistant.mjs'
import { modelFor, projectNotesForRequest, referenceLabels, sourceLimitsFor, writingFieldPrefix } from './writing-config.mjs'
import { planWritingContext } from './writing-context.mjs'

const refsFor = project => project.references ?? defaultReferenceSettings()

const element = (tag, label) => Object.assign(document.createElement(tag), { textContent: label })
function action(label, title, click) {
  const button = element('button', label)
  button.type = 'button'
  button.className = 'quiet-button'
  button.setAttribute('aria-label', title)
  button.addEventListener('click', click)
  return button
}

export function setupResearch({ get, currentProject, saveWorkspace, onChange, goToPassage, passagePosition }) {
  const cache = new WeakMap()
  const localSearch = new WeakMap()
  const loreSessions = new WeakMap()
  const editor = get('lore-editor')
  const cardForm = get('lore-form')
  const cardInputs = [...cardForm.querySelectorAll('input, select, textarea')]
  const assistantForm = get('lore-assistant-form')
  const assistantPrompt = get('lore-assistant-prompt')
  const assistantStatus = get('lore-assistant-status')
  const deleteDialog = get('lore-delete-dialog')
  let editorEntry
  let requestedDeletion

  const assistant = createWritingAssistant({
    transcript: get('lore-assistant-transcript'),
    status: assistantStatus,
    onChange: syncAssistant,
    onReply({ draft }) {
      if (!draft) return
      editorEntry.draft = draft
      renderCardDraft()
    },
  })

  function readCardFields() {
    return {
      kind: get('lore-kind').value,
      name: get('lore-name').value.trim(),
      aliases: [...new Set(get('lore-aliases').value.split(/[,\n]/).map(alias => alias.trim()).filter(Boolean))],
      description: get('lore-description').value.trim(),
      priority: Number(get('lore-priority').value),
      always: get('lore-always').checked,
    }
  }

  function writeCardFields(card) {
    get('lore-kind').value = card.kind
    get('lore-name').value = card.name
    get('lore-aliases').value = card.aliases.join(', ')
    get('lore-description').value = card.description
    get('lore-priority').value = card.priority
    get('lore-always').checked = card.always
  }

  function renderCardDraft() {
    const cardDraft = editorEntry.draft
    get('lore-card-draft').hidden = !cardDraft
    if (!cardDraft) {
      get('lore-draft-fields').replaceChildren()
      return
    }
    const { kind, name, aliases, description, priority, always } = cardDraft
    const fields = [
      ['종류', loreKinds[kind]], ['카드 이름', name], ['별칭', aliases.join(', ') || '없음'],
      ['설명', description], ['우선순위', priority], ['항상 포함', always ? '예' : '아니요'],
    ]
    get('lore-draft-fields').replaceChildren(...fields.flatMap(([label, value]) => [element('dt', label), element('dd', value)]))
  }

  function syncAssistant() {
    assistantPrompt.disabled = assistant.busy
    get('lore-send').disabled = assistant.busy || !assistantPrompt.value.trim()
    get('lore-draft-start').disabled = assistant.busy
    get('lore-assistant-stop').hidden = !assistant.busy
    get('lore-draft-apply').disabled = assistant.busy
    get('lore-assistant-reset').hidden = get('lore-assistant-transcript').hidden && !editorEntry.draft
  }

  function loreSession(project = currentProject()) {
    if (!loreSessions.has(project)) {
      loreSessions.set(project, { cards: project.lorebook, entries: new Map(), selectedId: undefined, deletions: [], status: '' })
    }
    return loreSessions.get(project)
  }

  function selectEditor(cardId) {
    const session = loreSession()
    if (!session.entries.has(cardId)) session.entries.set(cardId, { cardId, draft: null })
    const next = session.entries.get(cardId)
    if (next === editorEntry) return
    if (editorEntry) {
      editorEntry.values = cardInputs.map(input => input.type === 'checkbox' ? input.checked : input.value)
      editorEntry.prompt = assistantPrompt.value
      editorEntry.status = get('lore-form-status').textContent
      editorEntry.open = editor.open
    }
    session.selectedId = cardId
    editorEntry = next
    cardForm.reset()
    const card = (session.cards ?? []).find(item => item.id === cardId)
    if (card) writeCardFields(card)
    if (next.values) {
      cardInputs.forEach((input, index) => {
        if (input.type === 'checkbox') input.checked = next.values[index]
        else input.value = next.values[index]
      })
    }
    assistantPrompt.value = next.prompt ?? ''
    get('lore-form-status').textContent = next.status ?? ''
    get('save-lore').textContent = card ? '카드 수정' : '카드 추가'
    get('lore-cancel').hidden = !card
    get('lore-new-card').hidden = !card
    editor.querySelector('summary').textContent = card ? '카드 편집' : '카드 작성'
    editor.open = Boolean(next.open)
    assistant.useConversation(next)
    renderCardDraft()
    syncAssistant()
  }

  async function sendAssistant(mode) {
    const written = assistantPrompt.value.trim()
    const message = written || (mode === 'draft' ? '현재 카드 내용과 작품 메모를 바탕으로 로어북 카드 초안을 작성해 줘.' : '')
    if (!message || assistant.busy) return
    const project = currentProject()
    const entry = editorEntry
    const card = readCardFields()
    card.aliases = card.aliases.filter(alias => alias.length <= loreLimits.names).slice(0, loreLimits.aliases)
    if (!get('lore-priority').validity.valid) card.priority = 0
    const sent = await assistant.send({
      kind: 'lore', mode, model: modelFor(project, 'plan'), maxTokens: project.maxTokens,
      context: { ...projectNotesForRequest(project), manuscriptMemory: memoryForPrompt(project) },
      card, draft: entry.draft, systemPrompt: project.notePrompts?.lore,
    }, message, project)
    if (entry !== editorEntry) return
    if (sent) assistantPrompt.value = ''
    syncAssistant()
    if (document.activeElement === document.body && editor.open && !get('lore-panel').hidden) {
      assistantPrompt.focus()
    }
  }

  function settingsChanged() {
    saveWorkspace()
    onChange()
  }

  function renderRefs(focus) {
    const project = currentProject()
    const settings = refsFor(project)
    const rows = settings.map(({ key, enabled }, index) => {
      const labelText = referenceLabels[key]
      const row = element('li', '')
      const label = element('label', '')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = enabled
      checkbox.addEventListener('change', () => {
        settings[index].enabled = checkbox.checked
        project.references = settings
        settingsChanged()
      })
      label.append(checkbox, labelText)
      row.append(label)
      for (const [delta, arrow, desc] of [[-1, '↑', '위로'], [1, '↓', '아래로']]) {
        const button = action(arrow, `${labelText} ${desc}`, () => {
          const to = index + delta
          ;[settings[to], settings[index]] = [settings[index], settings[to]]
          project.references = settings
          renderRefs({ key, delta })
          settingsChanged()
        })
        button.dataset.key = key
        button.dataset.delta = delta
        button.disabled = index + delta < 0 || index + delta >= settings.length
        row.append(button)
      }
      return row
    })
    get('reference-list').replaceChildren(...rows)
    if (focus) {
      const buttons = [...get('reference-list').querySelectorAll('button')]
      const target = buttons.find(button => button.dataset.key === focus.key && Number(button.dataset.delta) === focus.delta)
      if (!target.disabled) target.focus()
      else target.parentElement.querySelector('input').focus()
    }
  }

  function renderLore() {
    const project = currentProject()
    const cards = project.lorebook ?? []
    const { deletions, status } = loreSession(project)
    const latest = deletions.at(-1)
    const undo = get('lore-undo-delete')
    get('lore-list-feedback').hidden = !status && !latest
    get('lore-list-status').textContent = status
    undo.hidden = !latest
    if (latest) undo.setAttribute('aria-label', `${latest.card.name} 삭제 실행 취소`)
    get('lore-empty').hidden = cards.length > 0
    get('lore-list').replaceChildren(...cards.map(card => {
      const row = element('li', '')
      const heading = element('div', '')
      heading.className = 'field-heading'
      const title = element('strong', card.name)
      const controls = element('div', '')
      controls.className = 'compact-actions'
      controls.append(action('편집', `${card.name} 편집`, () => {
        selectEditor(card.id)
        editor.open = true
        get('lore-name').focus()
      }), action('삭제', `${card.name} 삭제`, () => {
        requestedDeletion = { project, card }
        get('lore-delete-message').textContent = `‘${card.name}’ 카드를 삭제할까요? 이 탭을 새로고침하기 전까지 실행 취소할 수 있어요.`
        deleteDialog.showModal()
      }))
      heading.append(title, controls)
      const info = element('p', `${loreKinds[card.kind]} · 우선순위 ${card.priority}${card.always ? ' · 항상 포함' : ''}`)
      info.className = 'field-hint'
      row.append(heading, info)
      return row
    }))
  }

  function reconcileLorebook(project, session) {
    if (session.cards === project.lorebook) return
    const byId = cards => new Map((cards ?? []).map(card => [card.id, card]))
    const before = byId(session.cards)
    const after = byId(project.lorebook)
    for (const [id] of session.entries) {
      if (id === undefined) continue
      if (before.has(id) && after.has(id) &&
          JSON.stringify(loreCardFields(before.get(id))) === JSON.stringify(loreCardFields(after.get(id)))) continue
      session.entries.delete(id)
      if (session.selectedId === id) session.selectedId = undefined
    }
    session.cards = project.lorebook
    session.deletions.length = 0
    session.status = ''
  }

  function saveLorebook(project, cards) {
    const previous = project.lorebook
    project.lorebook = cards
    if (!saveWorkspace()) {
      if (previous === undefined) delete project.lorebook
      else project.lorebook = previous
      return false
    }
    loreSession(project).cards = cards
    onChange()
    return true
  }

  function deleteCard(project, card) {
    const cards = project.lorebook ?? []
    const index = cards.indexOf(card)
    if (index < 0) return
    const session = loreSession(project)
    if (!saveLorebook(project, cards.filter(item => item !== card))) {
      session.status = `‘${card.name}’ 카드를 삭제하지 못했어요. 브라우저 저장 상태를 확인해 주세요.`
    } else {
      session.deletions.push({ card, index })
      session.status = `‘${card.name}’ 카드를 삭제했어요.`
      if (editorEntry.cardId === card.id) {
        selectEditor(undefined)
        editor.open = false
      }
    }
    renderLore()
    if (session.deletions.length) get('lore-undo-delete').focus()
    else editor.querySelector('summary').focus()
  }

  function undoCardDeletion() {
    const project = currentProject()
    const session = loreSession(project)
    const deletion = session.deletions.at(-1)
    if (!deletion) return
    const { card, index } = deletion
    const cards = [...(project.lorebook ?? [])]
    if (cards.length >= loreLimits.cards) {
      session.status = `카드가 ${loreLimits.cards}개라서 지금은 삭제를 실행 취소할 수 없어요.`
      renderLore()
      return
    }
    cards.splice(index, 0, card)
    if (saveLorebook(project, cards)) {
      session.deletions.pop()
      session.status = `‘${card.name}’ 카드를 복구했어요.`
    } else {
      session.status = `‘${card.name}’ 카드를 복구하지 못했어요. 브라우저 저장 상태를 확인해 주세요.`
    }
    renderLore()
    if (session.deletions.length) get('lore-undo-delete').focus()
    else editor.querySelector('summary').focus()
  }

  function setSearchStatus(search, estimate, usage) {
    get('search-state').textContent = search
    get('embedding-estimate').textContent = estimate ? `임베딩 · ${estimateLabel(estimate)}` : ''
    get('embedding-usage').textContent = usage ? `임베딩 · ${usageLabel(usage)}` : ''
  }

  function render() {
    const project = currentProject()
    const session = loreSession(project)
    reconcileLorebook(project, session)
    selectEditor(session.selectedId)
    renderLore()
    renderRefs()
    const { enabled } = searchFor(project)
    get('semantic-enabled').checked = enabled
    renderState()
  }

  function renderState() {
    const project = currentProject()
    const noteLimit = get('lore-notes-limit')
    const hint = projectNotesLimitHint(project)
    if (noteLimit.textContent !== hint) noteLimit.textContent = hint
    noteLimit.hidden = !hint
    const entry = cache.get(project)
    const search = searchFor(project)
    const refs = refsFor(project).filter(ref => ref.enabled).map(ref => ref.key)
    if (!refs.includes('pastPassages')) {
      cancelPending(project)
      return setSearchStatus('과거 원문을 요청에서 제외했어요.')
    }
    if (!search.enabled) return setSearchStatus('키워드 검색')
    if (!entry || !sameResearch(entry, project, refs, search)) {
      cancelPending(project)
      return setSearchStatus('의미 검색 켜짐 · 다음 검색에서 색인')
    }
    setSearchStatus(entry.status, entry.estimate, entry.usage)
  }

  function sameResearch(entry, project, refs, search) {
    return entry.manuscript === project.manuscript && entry.direction === project.direction &&
      entry.recent === refs.includes('manuscript') && entry.enabled === search.enabled &&
      entry.routeKey === embeddingRouteKey(search.model, modelOptionsFor(project, search.model))
  }

  function forget(project) {
    cache.get(project)?.controller.abort()
    cache.delete(project)
  }

  function cancelPending(project) {
    if (cache.get(project)?.pending) forget(project)
  }

  function searchInput(project, references, cutoff, onlyCached = false) {
    const manuscript = project.manuscript
    const direction = writingFieldPrefix('direction', project.direction)
    const recent = references.includes('manuscript')
    let local = localSearch.get(project)
    if (onlyCached) {
      return local?.manuscript === manuscript && local.direction === direction && local.recent === recent
        ? local.inputs.get(cutoff) : undefined
    }
    if (local?.manuscript !== manuscript) {
      local = { manuscript, corpus: undefined }
      localSearch.set(project, local)
    }
    if (local.direction !== direction || local.recent !== recent) {
      Object.assign(local, { direction, recent, inputs: new Map() })
    }
    if (!local.inputs.has(cutoff)) {
      if (cutoff > 0) local.corpus ??= chunkManuscript(manuscript)
      const input = retrievalInput(manuscript, direction, recent, { cutoff, corpus: local.corpus })
      if (local.inputs.size >= 4) local.inputs.delete(local.inputs.keys().next().value)
      local.inputs.set(cutoff, input)
    }
    return local.inputs.get(cutoff)
  }

  function startSearch(project, references, search, { chunks, query }) {
    forget(project)
    const controller = new AbortController()
    const modelOptions = modelOptionsFor(project, search.model)
    const entry = { ...search, modelOptions, routeKey: embeddingRouteKey(search.model, modelOptions),
      manuscript: project.manuscript, direction: project.direction,
      recent: references.includes('manuscript'), chunkCount: chunks.length, status: '관련 원문 찾는 중…', controller, pending: true, waiters: 0 }
    cache.set(project, entry)
    const show = () => { if (project === currentProject()) renderState() }
    entry.promise = (async () => {
      try {
        entry.semantic = await embedPast(project.id, entry, chunks, query, controller.signal, estimate => {
          entry.estimate = estimate
          show()
        }, usage => {
          entry.usage = usage
          show()
        })
        entry.status = '키워드 + 의미 검색'
      } catch (error) {
        controller.signal.throwIfAborted()
        if (entry.estimate) entry.usage = combineUsage(entry.usage, actualUsage())
        entry.status = `키워드 검색 · 의미 검색 실패 (${error.message})`
      }
      show()
    })().finally(() => { entry.pending = false })
    show()
    return entry
  }

  async function ensureSearch(project, references, cutoff, signal) {
    signal.throwIfAborted()
    const search = searchFor(project)
    if (!search.enabled || !cutoff) return
    const input = searchInput(project, references, cutoff)
    if (!input.chunks.length || !input.query) return
    const cached = cache.get(project)
    const entry = cached && cached.chunkCount >= input.chunks.length && sameResearch(cached, project, references, search)
      ? cached : startSearch(project, references, search, input)
    if (!entry.pending) return entry

    entry.waiters++
    let onAbort
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([entry.promise, cancelled])
      return entry
    } finally {
      signal.removeEventListener('abort', onAbort)
      entry.waiters--
      if (!entry.waiters && entry.pending && cache.get(project) === entry) {
        forget(project)
        if (project === currentProject()) renderState()
      }
    }
  }

  function rankedPast(input, semantic) {
    if (!input?.chunks.length || !input.query) return []
    if (!semantic) {
      input.keyword ??= rankPast(input.chunks, input.query, undefined, input.intent)
      return input.keyword
    }
    if (input.semantic !== semantic) {
      input.semantic = semantic
      input.combined = rankPast(input.chunks, input.query, semantic, input.intent)
    }
    return input.combined
  }

  function resolvePlan(project, plan, onlyCached) {
    const empty = { ranked: () => [], status: '검색할 과거 원문 또는 검색어 없음' }
    if (!plan.pastLimit || !plan.cutoff) return empty
    const { references } = plan.body
    const input = searchInput(project, references, plan.cutoff, onlyCached)
    if (!input) return { ...empty, pastPending: plan.canFitPast }
    if (!input.chunks.length || !input.query) return empty
    const search = searchFor(project)
    const cached = cache.get(project)
    const entry = search.enabled && cached && cached.chunkCount >= input.chunks.length && sameResearch(cached, project, references, search)
      ? cached : undefined
    const semanticPending = plan.canFitPast && search.enabled && (!entry || entry.pending)
    return {
      semanticPending,
      semanticFailed: Boolean(plan.canFitPast && entry && !entry.pending && !entry.semantic),
      status: semanticPending ? '키워드 검색 · 의미 검색 반영 전' : entry?.status ?? '키워드 검색',
      ranked: keywordOnly => rankedPast(input, keywordOnly || semanticPending ? undefined : entry?.semantic),
    }
  }

  function plansFor(project, model, limits = sourceLimitsFor(project)) {
    const references = refsFor(project).filter(ref => ref.enabled).map(ref => ref.key)
    return planWritingContext(project, references, model, limits)
  }

  function inspect(project, model, limits, { onlyCached = false } = {}) {
    const saved = plansFor(project, model)
    const next = limits ? plansFor(project, model, limits) : saved
    const before = resolvePlan(project, saved, onlyCached)
    const after = next === saved ? before : resolvePlan(project, next)
    const semanticPending = Boolean(before.semanticPending || after.semanticPending)
    const semanticFailed = Boolean(before.semanticFailed || after.semanticFailed)
    const keywordOnly = semanticPending || semanticFailed
    const current = saved.finish(before.ranked(keywordOnly))
    return {
      saved: current, draft: next === saved ? current : next.finish(after.ranked(keywordOnly)),
      semanticPending, semanticFailed, pastPending: before.pastPending,
    }
  }

  async function refreshSearch(project, model, limits, signal) {
    const saved = plansFor(project, model)
    const next = plansFor(project, model, limits)
    if (resolvePlan(project, saved).semanticFailed || resolvePlan(project, next).semanticFailed) forget(project)
    const cutoff = Math.max(saved.canFitPast ? saved.cutoff : 0, next.canFitPast ? next.cutoff : 0)
    await ensureSearch(project, next.body.references, cutoff, signal)
  }

  function preparedPlan(project, plan) {
    const { ranked, status, semanticPending, semanticFailed } = resolvePlan(project, plan)
    return { ...plan.finish(ranked()), status, semanticPending, semanticFailed }
  }

  function preview(project, model) {
    return preparedPlan(project, plansFor(project, model))
  }

  async function prepare(project, model, signal, { retry = false } = {}) {
    const plan = plansFor(project, model)
    if (retry) forget(project)
    if (plan.canFitPast) await ensureSearch(project, plan.body.references, plan.cutoff, signal)
    signal.throwIfAborted()
    return preparedPlan(project, plan)
  }

  function renderResults({ lore, hits, status, body }) {
    const showLore = body.references.includes('lorebook')
    const showPast = body.references.includes('pastPassages')
    get('lore-preview-section').hidden = !showLore
    get('past-preview-section').hidden = !showPast
    get('lore-activation').replaceChildren(...(lore.length ? lore.map(card => {
      const reasons = [card.always ? '항상 포함' : '', ...card.keywords.map(word => `‘${word}’ 매칭`)].filter(Boolean)
      return element('li', `${card.name} · ${reasons.join(', ')}`)
    }) : [element('li', '포함된 카드 없음')]))
    get('past-search-summary').textContent = status
    get('past-reading-list').replaceChildren(...(hits.length ? hits.map(hit => {
      const item = element('li', '')
      const position = passagePosition(hit)
      item.append(action(position, `${position}로 이동`, () => goToPassage(hit)))
      item.append(element('p', hit.text))
      return item
    }) : [element('li', '전송할 과거 원문 없음')]))
  }

  get('lore-kind').replaceChildren(...Object.entries(loreKinds).map(([key, label]) => new Option(label, key)))
  assistantPrompt.maxLength = assistantMessageLimit
  assistantPrompt.addEventListener('input', syncAssistant)
  assistantForm.addEventListener('submit', event => {
    event.preventDefault()
    sendAssistant('chat')
  })
  get('lore-draft-start').addEventListener('click', () => sendAssistant('draft'))
  get('lore-assistant-stop').addEventListener('click', () => assistant.stop())
  get('lore-assistant-reset').addEventListener('click', () => {
    editorEntry.draft = null
    assistantForm.reset()
    assistant.reset()
    renderCardDraft()
    assistantPrompt.focus()
  })
  get('lore-open-assistant').addEventListener('click', () => get('lore-assistant-title').focus())
  get('lore-new-card').addEventListener('click', () => {
    selectEditor(undefined)
    editor.open = true
    get('lore-name').focus()
  })
  get('lore-draft-apply').addEventListener('click', () => {
    if (!editorEntry.draft || assistant.busy) return
    writeCardFields(editorEntry.draft)
    editorEntry.draft = null
    renderCardDraft()
    syncAssistant()
    get('lore-form-status').textContent = `초안을 카드에 반영했어요. ‘${get('save-lore').textContent}’를 눌러 저장하세요.`
    get('lore-name').focus()
  })
  cardForm.addEventListener('submit', event => {
    event.preventDefault()
    const project = currentProject()
    const cards = project.lorebook ?? []
    const { cardId } = editorEntry
    const card = { id: cardId ?? crypto.randomUUID(), ...readCardFields() }
    if (!validLoreCard(card) || (!cardId && cards.length >= loreLimits.cards)) {
      get('lore-form-status').textContent = '이름과 설명을 입력해 주세요. 별칭은 16개, 카드는 150개까지 저장할 수 있어요.'
      return
    }
    const changed = cardId ? cards.map(item => item.id === cardId ? card : item) : [...cards, card]
    if (!saveLorebook(project, changed)) {
      get('lore-form-status').textContent = '카드를 저장하지 못했어요. 편집 내용은 입력란에 남아 있어요.'
      return
    }
    const session = loreSession(project)
    session.entries.delete(cardId)
    session.entries.set(card.id, editorEntry)
    editorEntry.cardId = card.id
    get('lore-form-status').textContent = ''
    selectEditor(undefined)
    renderLore()
    editor.open = false
    editor.querySelector('summary').focus()
  })
  get('lore-cancel').addEventListener('click', () => {
    loreSession().entries.delete(editorEntry.cardId)
    selectEditor(undefined)
    editor.open = false
    editor.querySelector('summary').focus()
  })
  deleteDialog.addEventListener('cancel', () => { requestedDeletion = undefined })
  deleteDialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault()
    const deletion = requestedDeletion
    requestedDeletion = undefined
    deleteDialog.close()
    if (event.submitter?.value === 'delete' && deletion?.project === currentProject()) {
      deleteCard(deletion.project, deletion.card)
    }
  })
  get('lore-undo-delete').addEventListener('click', undoCardDeletion)
  get('semantic-enabled').addEventListener('change', event => {
    const project = currentProject()
    project.search = { ...searchFor(project), enabled: event.target.checked }
    forget(project)
    settingsChanged()
  })
  return { render, renderState, prepare, preview, renderResults, inspect, refreshSearch }
}
