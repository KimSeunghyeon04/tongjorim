import { loreCardFields, referenceSettingsFor, validLoreCard } from './project-files.mjs'
import { loreKinds, loreLimits } from './retrieval.mjs'
import { assistantMessageLimit, assistantProjectContext, createWritingAssistant, projectNotesLimitHint } from './writing-assistant.mjs'
import { modelFor } from './writing-config.mjs'

const nameOrder = new Intl.Collator('ko', { numeric: true })
const element = (tag, text) => Object.assign(document.createElement(tag), { textContent: text })
const searchText = text => text.normalize('NFKC').toLowerCase().trim()

function groupedCards(cards = []) {
  const groups = new Map(Object.keys(loreKinds).map(kind => [kind, []]))
  for (const card of cards) groups.get(card.kind).push(card)
  for (const group of groups.values()) group.sort((a, b) => nameOrder.compare(a.name, b.name))
  return groups
}

function cardGroup(kind, cards, closed, renderRow) {
  const group = element('details', '')
  group.className = 'lore-group'
  group.open = !closed.has(kind)
  function rememberDisclosure() {
    if (group.open) closed.delete(kind)
    else closed.add(kind)
  }
  group.addEventListener('toggle', () => {
    if (group.isConnected) rememberDisclosure()
  })
  const summary = element('summary', loreKinds[kind])
  summary.addEventListener('click', event => {
    event.preventDefault()
    group.open = !group.open
    rememberDisclosure()
  })
  const count = element('span', ` ${cards.length}`)
  count.className = 'lore-group-count'
  summary.append(count)
  const list = element('ul', '')
  for (const card of cards) list.append(renderRow(card))
  group.append(summary, list)
  return group
}

export function setupLorebook({ get, currentProject, saveWorkspace, onChange, addedLoreCards, onSelectLoreCard }) {
  const sessions = new WeakMap()
  const workspace = get('lore-workspace')
  const library = get('lore-library')
  const listScroll = get('lore-library-scroll')
  const search = get('lore-search')
  const filter = get('lore-filter')
  const returnCard = get('lore-return-card')
  const editor = get('lore-editor')
  const editorTitle = get('lore-editor-title')
  const back = get('lore-back')
  const save = get('save-lore')
  const form = get('lore-form')
  const editorScroll = form.parentElement
  const formStatus = get('lore-form-status')
  const alwaysField = get('lore-always')
  const cardInputs = [...form.querySelectorAll('input, select, textarea')]
  const discussion = get('lore-discussion')
  const discussionToggle = get('lore-discussion-toggle')
  const assistantForm = get('lore-assistant-form')
  const retry = get('lore-assistant-retry')
  const prompt = get('lore-assistant-prompt')
  const transcript = get('lore-assistant-transcript')
  const deleteDialog = get('lore-delete-dialog')
  let editing
  let requestedDeletion

  const assistant = createWritingAssistant({
    transcript,
    scrollport: get('lore-conversation'),
    status: get('lore-assistant-status'),
    onChange: syncAssistant,
    onReply({ draft }) {
      if (!draft) return
      editing.draft = draft
      renderDraft()
    },
  })

  function sessionFor(project = currentProject()) {
    if (!sessions.has(project)) {
      sessions.set(project, {
        cards: project.lorebook, entries: new Map(), selectedId: undefined, editorOpen: false, deletions: [], status: '',
        list: { query: '', kind: '', scrollTop: 0, closed: new Set(), searchClosed: new Set() },
        quickClosed: new Set(),
      })
    }
    return sessions.get(project)
  }

  function readFields() {
    return {
      kind: get('lore-kind').value,
      name: get('lore-name').value.trim(),
      aliases: [...new Set(get('lore-aliases').value.split(/[,\n]/).map(alias => alias.trim()).filter(Boolean))],
      description: get('lore-description').value.trim(),
      priority: Number(get('lore-priority').value),
      always: alwaysField.checked,
    }
  }

  function writeFields(card) {
    get('lore-kind').value = card.kind
    get('lore-name').value = card.name
    get('lore-aliases').value = card.aliases.join(', ')
    get('lore-description').value = card.description
    get('lore-priority').value = card.priority
    alwaysField.checked = card.always
  }

  function syncEditorLabels(card) {
    editorTitle.textContent = card ? card.name : '새 카드'
    save.textContent = card ? '변경 저장' : '카드 추가'
    get('lore-draft-start').textContent = card ? '수정안 만들기' : '카드 초안 만들기'
    get('lore-draft-title').textContent = card ? '카드 수정안' : '카드 초안'
    get('lore-cancel').hidden = !card
    get('lore-delete-card').hidden = !card
    prompt.placeholder = card ? '이 카드에서 바꾸고 싶은 점을 이야기해 보세요.' : '만들고 싶은 인물이나 설정을 이야기해 보세요.'
  }

  function syncEditorButtons() {
    const saving = Boolean(editing?.saving)
    save.disabled = saving
    back.disabled = saving
    get('lore-cancel').disabled = saving
    get('lore-delete-card').disabled = saving
  }

  function renderDiscussion() {
    const open = Boolean(editing.discussionOpen)
    discussion.hidden = !open
    discussionToggle.setAttribute('aria-expanded', String(open))
    get('lore-editor-columns').classList.toggle('has-discussion', open)
  }

  function describeEdit() {
    const card = sessionFor().cards?.find(item => item.id === editing.cardId)
    const changed = !card || JSON.stringify(loreCardFields(readFields())) !== JSON.stringify(loreCardFields(card))
    formStatus.textContent = changed ? '저장되지 않은 변경' : ''
  }

  function selectEditor(cardId) {
    const session = sessionFor()
    if (!session.entries.has(cardId)) session.entries.set(cardId, { cardId, draft: null })
    const next = session.entries.get(cardId)
    const card = session.cards?.find(item => item.id === cardId)
    if (editing === next) {
      syncEditorLabels(card)
      syncEditorButtons()
      return
    }
    if (editing) {
      editing.values = cardInputs.map(input => input.type === 'checkbox' ? input.checked : input.value)
      editing.prompt = prompt.value
      editing.status = formStatus.textContent
    }
    editing = next
    form.reset()
    if (card) writeFields(card)
    next.values?.forEach((value, index) => {
      const input = cardInputs[index]
      if (input.type === 'checkbox') input.checked = value
      else input.value = value
    })
    prompt.value = next.prompt ?? ''
    formStatus.textContent = next.status ?? ''
    syncEditorLabels(card)
    syncEditorButtons()
    assistant.useConversation(next)
    renderDraft()
  }

  function syncAssistant() {
    const { busy } = assistant
    prompt.disabled = busy
    get('lore-send').disabled = busy || !prompt.value.trim()
    get('lore-draft-start').disabled = busy
    retry.hidden = !assistant.canRetry
    get('lore-assistant-stop').hidden = !busy
    get('lore-draft-apply').disabled = busy
    get('lore-draft-discard').disabled = busy
    get('lore-assistant-reset').disabled = busy
    get('lore-assistant-reset').hidden = transcript.hidden && !editing?.draft && !assistant.canRetry
    get('lore-conversation-empty').hidden = !transcript.hidden || Boolean(editing?.draft)
  }

  function renderDraft() {
    const draft = editing.draft
    get('lore-card-draft').hidden = !draft
    const fields = draft ? [
      ['분류', loreKinds[draft.kind]], ['카드 이름', draft.name], ['별칭', draft.aliases.join(', ') || '없음'],
      ['설명', draft.description], ['우선순위', draft.priority], ['항상 포함', draft.always ? '예' : '아니요'],
    ] : []
    get('lore-draft-fields').replaceChildren(...fields.flatMap(([label, value]) => [element('dt', label), element('dd', value)]))
    syncAssistant()
  }

  async function sendAssistant(mode) {
    const entry = editing
    const request = entry.cardId ? '지금까지의 대화를 반영해 카드의 수정안을 작성해 줘.'
      : '줄거리와 지금까지의 대화를 바탕으로 새 로어북 카드의 초안을 작성해 줘.'
    const message = prompt.value.trim() || (mode === 'draft' ? request : '')
    if (!message || assistant.busy) return
    const project = currentProject()
    const card = readFields()
    card.aliases = card.aliases.filter(alias => alias.length <= loreLimits.names).slice(0, loreLimits.aliases)
    if (!get('lore-priority').validity.valid) card.priority = 0
    const sent = await assistant.send({
      kind: 'lore', mode, model: modelFor(project, 'plan'), maxTokens: project.maxTokens,
      context: assistantProjectContext(project, [card.name, ...card.aliases, message].join('\n')),
      card, draft: entry.draft, systemPrompt: project.notePrompts?.lore,
    }, message, project)
    finishAssistantRequest(entry, sent ? message : undefined)
  }

  function finishAssistantRequest(entry, sentMessage) {
    if (entry !== editing) return
    if (sentMessage && prompt.value.trim() === sentMessage) prompt.value = ''
    syncAssistant()
    if (document.activeElement === document.body && !workspace.hidden && !editor.hidden && !discussion.hidden) prompt.focus()
  }

  function renderLibrary() {
    const { cards = [], list } = sessionFor()
    if (search.value !== list.query) search.value = list.query
    filter.value = list.kind
    const query = searchText(list.query)
    const matches = cards.filter(card => (!list.kind || card.kind === list.kind) &&
      (!query || [card.name, ...card.aliases].some(text => searchText(text).includes(query))))
    const buttons = new Map()
    const groups = document.createDocumentFragment()
    const closed = query ? list.searchClosed : list.closed
    for (const [kind, entries] of groupedCards(matches)) {
      if (!entries.length) continue
      groups.append(cardGroup(kind, entries, closed, card => {
        const row = element('li', '')
        const button = element('button', '')
        button.type = 'button'
        button.className = 'lore-card-open'
        const name = element('strong', card.name)
        name.className = 'lore-card-name'
        button.append(name)
        if (card.always) {
          const pin = element('span', '항상 포함')
          pin.className = 'lore-card-pin'
          button.append(pin)
        }
        const excerpt = element('span', card.description.trim().split(/\r\n?|\n/, 1)[0])
        excerpt.className = 'lore-card-excerpt'
        button.append(excerpt)
        button.addEventListener('click', () => openEditor(card.id))
        row.append(button)
        buttons.set(card.id, button)
        return row
      }))
    }
    get('lore-card-list').replaceChildren(groups)
    const empty = get('lore-list-empty')
    empty.hidden = Boolean(matches.length)
    if (!matches.length) empty.textContent = cards.length ? '조건에 맞는 카드가 없어요.' : '아직 카드가 없어요. 새 카드를 추가해 보세요.'
    const row = buttons.get(list.returnId)
    const visibleRow = row?.closest('details').open ? row : undefined
    const recent = !visibleRow && cards.find(card => card.id === list.returnId)
    returnCard.hidden = !recent
    if (recent) returnCard.textContent = `편집한 카드 다시 열기 · ${recent.name}`
    return visibleRow ?? (recent ? returnCard : undefined)
  }

  function showScreen(session) {
    library.hidden = session.editorOpen
    editor.hidden = !session.editorOpen
  }

  function rememberScroll() {
    const session = sessionFor()
    if (session.editorOpen) {
      if (editorScroll.clientHeight) editing.scrollTop = editorScroll.scrollTop
      assistant.rememberScroll()
    } else if (listScroll.clientHeight) session.list.scrollTop = listScroll.scrollTop
  }

  function restoreScroll() {
    const session = sessionFor()
    if (session.editorOpen) {
      editorScroll.scrollTop = editing.scrollTop ?? 0
      assistant.restoreScroll()
    } else listScroll.scrollTop = session.list.scrollTop
  }

  function openEditor(cardId) {
    const session = sessionFor()
    rememberScroll()
    session.selectedId = cardId
    session.editorOpen = true
    showScreen(session)
    selectEditor(cardId)
    renderDiscussion()
    restoreScroll()
    const focus = cardId === undefined ? get('lore-name') : editorTitle
    focus.focus({ preventScroll: true })
  }

  function openLibrary(cardId) {
    const session = sessionFor()
    rememberScroll()
    session.editorOpen = false
    session.list.returnId = cardId
    showScreen(session)
    const focus = renderLibrary()
    restoreScroll()
    return focus
  }

  function renderQuick(focusId) {
    const project = currentProject()
    const { quickClosed } = sessionFor(project)
    const selected = new Set(addedLoreCards(project))
    const groups = document.createDocumentFragment()
    const cards = project.lorebook ?? []
    const enabled = referenceSettingsFor(project).some(ref => ref.key === 'lorebook' && ref.enabled)
    get('lore-quick-empty').hidden = Boolean(cards.length)
    get('lore-quick-reference').hidden = enabled || !cards.length
    for (const [kind, entries] of groupedCards(cards)) {
      if (!entries.length) continue
      groups.append(cardGroup(kind, entries, quickClosed, card => {
        const row = element('li', '')
        const title = element('strong', card.name)
        const choices = element('div', '')
        choices.className = 'lore-quick-options'
        const checkbox = (key, label, checked, disabled, change) => {
          const control = element('label', '')
          const input = document.createElement('input')
          input.type = 'checkbox'
          input.id = `lore-quick-${key}-${card.id}`
          input.checked = checked
          input.disabled = disabled
          input.setAttribute('aria-label', `${card.name} ${label}`)
          input.addEventListener('change', () => change(input))
          control.append(input, label)
          return control
        }
        choices.append(
          checkbox('always', '항상 포함', card.always, false, input => toggleAlways(card, input)),
          checkbox('request', '이번 요청에 포함', enabled && (card.always || selected.has(card.id)), !enabled || card.always,
            input => onSelectLoreCard(card.id, input.checked)),
        )
        row.append(title, choices)
        return row
      }))
    }
    get('lore-quick-list').replaceChildren(groups)
    if (focusId) get(focusId)?.focus({ preventScroll: true })
  }

  async function saveCards(project, cards) {
    const previous = project.lorebook
    let changed = false
    const saved = await saveWorkspace(() => {
      if (project.lorebook !== previous) return
      project.lorebook = cards
      sessionFor(project).cards = cards
      changed = true
      return () => {
        if (project.lorebook !== cards) return
        if (previous === undefined) delete project.lorebook
        else project.lorebook = previous
        sessionFor(project).cards = previous
        changed = false
      }
    })
    if (changed && project === currentProject()) onChange()
    return saved && changed
  }

  async function toggleAlways(card, input) {
    const project = currentProject()
    const session = sessionFor(project)
    const cards = session.cards ?? []
    const current = cards.find(item => item.id === card.id)
    const checked = input.checked
    const saved = current && await saveCards(project, cards.map(item => item === current ? { ...item, always: checked } : item))
    if (project !== currentProject()) return
    if (!saved) {
      input.checked = current?.always ?? card.always
      get('lore-quick-status').textContent = '포함 설정을 저장하지 못했어요.'
      return
    }
    const entry = session.entries.get(card.id)
    if (entry?.values) entry.values[cardInputs.indexOf(alwaysField)] = checked
    if (entry === editing) alwaysField.checked = checked
    get('lore-quick-status').textContent = ''
    if (!session.editorOpen) {
      rememberScroll()
      renderLibrary()
      restoreScroll()
    }
    renderQuick(input.id)
  }

  function renderFeedback() {
    const { status, deletions } = sessionFor()
    get('lore-list-feedback').hidden = !status && !deletions.length
    get('lore-list-status').textContent = status
    const undo = get('lore-undo-delete')
    undo.hidden = !deletions.length
    if (deletions.length) undo.setAttribute('aria-label', `${deletions.at(-1).card.name} 삭제 실행 취소`)
  }

  function reconcile() {
    const project = currentProject()
    const session = sessionFor(project)
    if (session.cards === project.lorebook) return
    const byId = cards => new Map((cards ?? []).map(card => [card.id, card]))
    const before = byId(session.cards)
    const after = byId(project.lorebook)
    for (const [id] of session.entries) {
      if (id === undefined) continue
      if (before.has(id) && after.has(id) &&
          JSON.stringify(loreCardFields(before.get(id))) === JSON.stringify(loreCardFields(after.get(id)))) continue
      session.entries.delete(id)
      if (session.selectedId === id && !after.has(id)) {
        session.selectedId = undefined
        session.editorOpen = false
      }
    }
    session.cards = project.lorebook
    session.deletions.length = 0
    session.status = ''
  }

  function render() {
    reconcile()
    const session = sessionFor()
    showScreen(session)
    if (session.editorOpen) {
      selectEditor(session.selectedId)
      renderDiscussion()
    } else renderLibrary()
    restoreScroll()
    renderQuick()
    renderFeedback()
    renderContext()
    get('lore-quick-status').textContent = ''
  }

  function renderContext() {
    const noteLimit = get('lore-notes-limit')
    const hint = projectNotesLimitHint(currentProject())
    if (noteLimit.textContent !== hint) noteLimit.textContent = hint
    noteLimit.hidden = !hint
  }

  for (const [key, label] of Object.entries(loreKinds)) {
    get('lore-kind').append(new Option(label, key))
    filter.append(new Option(label, key))
  }
  function updateFilters() {
    const { list } = sessionFor()
    if (Boolean(searchText(list.query)) !== Boolean(searchText(search.value))) list.searchClosed.clear()
    if (list.kind !== filter.value) {
      const closed = searchText(search.value) ? list.searchClosed : list.closed
      closed.delete(filter.value)
    }
    Object.assign(list, { query: search.value, kind: filter.value, scrollTop: 0, returnId: undefined })
    renderLibrary()
    listScroll.scrollTop = 0
  }
  search.addEventListener('input', updateFilters)
  filter.addEventListener('change', updateFilters)
  listScroll.addEventListener('scroll', () => {
    if (listScroll.clientHeight) sessionFor().list.scrollTop = listScroll.scrollTop
  })
  get('lore-new-card').addEventListener('click', () => openEditor(undefined))
  returnCard.addEventListener('click', () => openEditor(sessionFor().list.returnId))
  back.addEventListener('click', () => {
    const focus = openLibrary(editing.cardId) ?? get('lore-new-card')
    focus.focus({ preventScroll: true })
  })
  discussionToggle.addEventListener('click', () => {
    if (editing.discussionOpen) assistant.rememberScroll()
    editing.discussionOpen = !editing.discussionOpen
    renderDiscussion()
    if (editing.discussionOpen) {
      assistant.restoreScroll()
      if (!prompt.disabled) prompt.focus({ preventScroll: true })
    }
  })
  form.addEventListener('input', describeEdit)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const project = currentProject()
    const session = sessionFor(project)
    const cards = session.cards ?? []
    const entry = editing
    if (entry.saving) return
    const { cardId } = entry
    const card = { id: cardId ?? crypto.randomUUID(), ...readFields() }
    if (!validLoreCard(card)) {
      formStatus.textContent = `이름과 설명을 입력해 주세요. 별칭은 ${loreLimits.aliases}개까지 저장할 수 있어요.`
      return
    }
    entry.saving = true
    syncEditorButtons()
    const saved = await saveCards(project, cardId ? cards.map(item => item.id === cardId ? card : item) : [...cards, card])
    entry.saving = false
    if (entry === editing) syncEditorButtons()
    if (!saved) {
      if (entry === editing) formStatus.textContent = '카드를 저장하지 못했어요. 편집 내용은 입력란에 남아 있어요.'
      return
    }
    session.entries.delete(cardId)
    session.entries.set(card.id, entry)
    entry.cardId = card.id
    session.selectedId = card.id
    if (entry !== editing) return
    syncEditorLabels(card)
    if (JSON.stringify(loreCardFields(readFields())) === JSON.stringify(loreCardFields(card))) {
      writeFields(card)
      formStatus.textContent = cardId ? '변경을 저장했어요.' : '카드를 추가했어요.'
    } else if (project === currentProject()) describeEdit()
    if (project === currentProject()) renderQuick()
  })
  get('lore-cancel').addEventListener('click', () => {
    const card = sessionFor().cards?.find(item => item.id === editing.cardId)
    if (card) writeFields(card)
    formStatus.textContent = ''
  })
  get('lore-delete-card').addEventListener('click', () => {
    const project = currentProject()
    const card = sessionFor(project).cards?.find(item => item.id === editing.cardId)
    if (!card) return
    requestedDeletion = { project, card }
    get('lore-delete-message').textContent = `‘${card.name}’ 카드를 삭제할까요? 이 탭을 새로고침하기 전까지 실행 취소할 수 있어요.`
    deleteDialog.showModal()
  })
  deleteDialog.addEventListener('cancel', () => { requestedDeletion = undefined })
  deleteDialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault()
    const deletion = requestedDeletion
    requestedDeletion = undefined
    deleteDialog.close()
    if (event.submitter?.value !== 'delete' || deletion?.project !== currentProject()) return
    const { project, card } = deletion
    const session = sessionFor(project)
    const cards = session.cards ?? []
    const index = cards.findIndex(item => item.id === card.id)
    if (index < 0) return
    const entry = editing
    entry.saving = true
    syncEditorButtons()
    const saved = await saveCards(project, cards.filter((_, position) => position !== index))
    entry.saving = false
    if (entry === editing) syncEditorButtons()
    if (saved) {
      session.deletions.push({ card: cards[index], index })
      session.status = `‘${card.name}’ 카드를 삭제했어요.`
      if (project === currentProject()) {
        openLibrary()
        renderQuick()
      } else {
        session.selectedId = undefined
        session.editorOpen = false
      }
    } else if (entry === editing) {
      formStatus.textContent = '카드를 삭제하지 못했어요.'
    }
    if (project !== currentProject()) return
    renderFeedback()
    get(saved ? 'lore-undo-delete' : 'lore-delete-card').focus()
  })
  get('lore-undo-delete').addEventListener('click', async () => {
    const project = currentProject()
    const session = sessionFor(project)
    const deletion = session.deletions.at(-1)
    if (!deletion) return
    const undo = get('lore-undo-delete')
    undo.disabled = true
    const cards = [...(session.cards ?? [])]
    cards.splice(deletion.index, 0, deletion.card)
    const saved = await saveCards(project, cards)
    undo.disabled = false
    if (saved) {
      session.deletions.pop()
      session.status = `‘${deletion.card.name}’ 카드를 복구했어요.`
    } else {
      session.status = '카드를 복구하지 못했어요.'
    }
    if (project !== currentProject()) return
    renderFeedback()
    if (saved) {
      const focus = openLibrary(deletion.card.id) ?? get('lore-new-card')
      renderQuick()
      focus.focus({ preventScroll: true })
    } else undo.focus()
  })

  prompt.maxLength = assistantMessageLimit
  prompt.addEventListener('input', syncAssistant)
  assistantForm.addEventListener('submit', event => {
    event.preventDefault()
    sendAssistant('chat')
  })
  get('lore-draft-start').addEventListener('click', () => sendAssistant('draft'))
  retry.addEventListener('click', async () => {
    const entry = editing
    finishAssistantRequest(entry, await assistant.retry())
  })
  get('lore-assistant-stop').addEventListener('click', () => assistant.stop())
  get('lore-assistant-reset').addEventListener('click', () => {
    editing.draft = null
    assistantForm.reset()
    assistant.reset()
    renderDraft()
    prompt.focus()
  })
  get('lore-draft-discard').addEventListener('click', () => {
    editing.draft = null
    renderDraft()
    prompt.focus()
  })
  get('lore-draft-apply').addEventListener('click', () => {
    if (!editing.draft || assistant.busy) return
    writeFields(editing.draft)
    editing.draft = null
    renderDraft()
    formStatus.textContent = `편집란에 반영했어요. ‘${get('save-lore').textContent}’를 눌러 저장하세요.`
    get('lore-description').focus()
  })

  return { render, renderContext, renderQuick, rememberScroll, restoreScroll }
}
