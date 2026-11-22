import { loreCardFields, referenceSettingsFor, validLoreCard } from './project-files.mjs'
import { loreKinds, loreLimits } from './retrieval.mjs'
import { assistantMessageLimit, assistantProjectContext, createWritingAssistant, projectNotesLimitHint } from './writing-assistant.mjs'
import { modelFor } from './writing-config.mjs'

const nameOrder = new Intl.Collator('ko', { numeric: true })
const element = (tag, text) => Object.assign(document.createElement(tag), { textContent: text })

function groupedCards(cards = []) {
  const groups = new Map(Object.keys(loreKinds).map(kind => [kind, []]))
  for (const card of cards) groups.get(card.kind).push(card)
  for (const group of groups.values()) group.sort((a, b) => nameOrder.compare(a.name, b.name))
  return groups
}

export function setupLorebook({ get, currentProject, saveWorkspace, onChange, addedLoreCards, onSelectLoreCard }) {
  const sessions = new WeakMap()
  const workspace = get('lore-workspace')
  const picker = get('lore-card-select')
  const form = get('lore-form')
  const formStatus = get('lore-form-status')
  const alwaysField = get('lore-always')
  const cardInputs = [...form.querySelectorAll('input, select, textarea')]
  const assistantForm = get('lore-assistant-form')
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
      const first = [...groupedCards(project.lorebook).values()].find(group => group.length)?.[0]
      sessions.set(project, { cards: project.lorebook, entries: new Map(), selectedId: first?.id, deletions: [], status: '' })
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
    get('lore-editor-title').textContent = card ? card.name : '새 카드'
    get('save-lore').textContent = card ? '변경 저장' : '카드 추가'
    get('lore-draft-start').textContent = card ? '수정안 만들기' : '카드 초안 만들기'
    get('lore-draft-title').textContent = card ? '카드 수정안' : '카드 초안'
    get('lore-cancel').hidden = !card
    get('lore-delete-card').hidden = !card
    get('lore-new-card').hidden = !card
    prompt.placeholder = card ? '이 카드에서 바꾸고 싶은 점을 이야기해 보세요.' : '만들고 싶은 인물이나 설정을 이야기해 보세요.'
  }

  function selectEditor(cardId) {
    const session = sessionFor()
    if (!session.entries.has(cardId)) session.entries.set(cardId, { cardId, draft: null })
    const next = session.entries.get(cardId)
    if (editing === next) return
    if (editing) {
      editing.values = cardInputs.map(input => input.type === 'checkbox' ? input.checked : input.value)
      editing.prompt = prompt.value
      editing.status = formStatus.textContent
    }
    session.selectedId = cardId
    editing = next
    const card = (session.cards ?? []).find(item => item.id === cardId)
    form.reset()
    if (card) writeFields(card)
    next.values?.forEach((value, index) => {
      const input = cardInputs[index]
      if (input.type === 'checkbox') input.checked = value
      else input.value = value
    })
    picker.value = cardId ?? ''
    prompt.value = next.prompt ?? ''
    formStatus.textContent = next.status ?? ''
    syncEditorLabels(card)
    assistant.useConversation(next)
    renderDraft()
  }

  function syncAssistant() {
    const { busy } = assistant
    prompt.disabled = busy
    get('lore-send').disabled = busy || !prompt.value.trim()
    get('lore-draft-start').disabled = busy
    get('lore-assistant-stop').hidden = !busy
    get('lore-draft-apply').disabled = busy
    get('lore-draft-discard').disabled = busy
    get('lore-assistant-reset').disabled = busy
    get('lore-assistant-reset').hidden = transcript.hidden && !editing?.draft
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
    if (entry !== editing) return
    if (sent) prompt.value = ''
    syncAssistant()
    if (document.activeElement === document.body && !workspace.hidden) prompt.focus()
  }

  function renderPicker() {
    const session = sessionFor()
    const options = document.createDocumentFragment()
    options.append(new Option('새 카드 초안', ''))
    for (const [kind, cards] of groupedCards(session.cards)) {
      if (!cards.length) continue
      const group = document.createElement('optgroup')
      group.label = loreKinds[kind]
      for (const card of cards) group.append(new Option(card.name, card.id))
      options.append(group)
    }
    picker.replaceChildren(options)
    picker.value = session.selectedId ?? ''
    picker.disabled = !session.cards?.length
  }

  function renderQuick(focusId) {
    const project = currentProject()
    const selected = new Set(addedLoreCards(project))
    const groups = document.createDocumentFragment()
    const cards = project.lorebook ?? []
    const enabled = referenceSettingsFor(project).some(ref => ref.key === 'lorebook' && ref.enabled)
    get('lore-quick-empty').hidden = Boolean(cards.length)
    get('lore-quick-reference').hidden = enabled || !cards.length
    for (const [kind, entries] of groupedCards(cards)) {
      if (!entries.length) continue
      const heading = element('h3', loreKinds[kind])
      const list = element('ul', '')
      for (const card of entries) {
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
        list.append(row)
      }
      groups.append(heading, list)
    }
    get('lore-quick-list').replaceChildren(groups)
    if (focusId) get(focusId)?.focus({ preventScroll: true })
  }

  function saveCards(project, cards) {
    const previous = project.lorebook
    project.lorebook = cards
    if (!saveWorkspace()) {
      if (previous === undefined) delete project.lorebook
      else project.lorebook = previous
      return false
    }
    sessionFor(project).cards = cards
    onChange()
    return true
  }

  function toggleAlways(card, input) {
    const project = currentProject()
    const session = sessionFor(project)
    const cards = session.cards ?? []
    const current = cards.find(item => item.id === card.id)
    if (!current || !saveCards(project, cards.map(item => item === current ? { ...item, always: input.checked } : item))) {
      input.checked = current?.always ?? card.always
      get('lore-quick-status').textContent = '포함 설정을 저장하지 못했어요.'
      return
    }
    const entry = session.entries.get(card.id)
    if (entry?.values) entry.values[cardInputs.indexOf(alwaysField)] = input.checked
    if (entry === editing) alwaysField.checked = input.checked
    get('lore-quick-status').textContent = ''
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
      if (session.selectedId === id && !after.has(id)) session.selectedId = undefined
    }
    session.cards = project.lorebook
    session.deletions.length = 0
    session.status = ''
  }

  function render() {
    reconcile()
    renderPicker()
    selectEditor(sessionFor().selectedId)
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

  get('lore-kind').replaceChildren(...Object.entries(loreKinds).map(([key, label]) => new Option(label, key)))
  picker.addEventListener('change', () => selectEditor(picker.value || undefined))
  get('lore-new-card').addEventListener('click', () => {
    selectEditor(undefined)
    get('lore-name').focus()
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    const project = currentProject()
    const session = sessionFor(project)
    const cards = session.cards ?? []
    const { cardId } = editing
    const card = { id: cardId ?? crypto.randomUUID(), ...readFields() }
    if (!validLoreCard(card)) {
      formStatus.textContent = `이름과 설명을 입력해 주세요. 별칭은 ${loreLimits.aliases}개까지 저장할 수 있어요.`
      return
    }
    if (!saveCards(project, cardId ? cards.map(item => item.id === cardId ? card : item) : [...cards, card])) {
      formStatus.textContent = '카드를 저장하지 못했어요. 편집 내용은 입력란에 남아 있어요.'
      return
    }
    session.entries.delete(cardId)
    session.entries.set(card.id, editing)
    editing.cardId = session.selectedId = card.id
    writeFields(card)
    syncEditorLabels(card)
    renderPicker()
    renderQuick()
    formStatus.textContent = cardId ? '변경을 저장했어요.' : '카드를 추가했어요.'
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
  deleteDialog.querySelector('form').addEventListener('submit', event => {
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
    if (!saveCards(project, cards.filter((_, position) => position !== index))) {
      session.status = '카드를 삭제하지 못했어요.'
    } else {
      session.deletions.push({ card: cards[index], index })
      session.status = `‘${card.name}’ 카드를 삭제했어요.`
      selectEditor(undefined)
      renderPicker()
      renderQuick()
    }
    renderFeedback()
    get(session.deletions.length ? 'lore-undo-delete' : 'lore-delete-card').focus()
  })
  get('lore-undo-delete').addEventListener('click', () => {
    const project = currentProject()
    const session = sessionFor(project)
    const deletion = session.deletions.at(-1)
    if (!deletion) return
    const cards = [...(session.cards ?? [])]
    cards.splice(deletion.index, 0, deletion.card)
    if (saveCards(project, cards)) {
      session.deletions.pop()
      session.status = `‘${deletion.card.name}’ 카드를 복구했어요.`
      selectEditor(deletion.card.id)
      renderPicker()
      renderQuick()
    } else {
      session.status = '카드를 복구하지 못했어요.'
    }
    renderFeedback()
    if (session.deletions.length) get('lore-undo-delete').focus()
    else picker.focus()
  })

  prompt.maxLength = assistantMessageLimit
  prompt.addEventListener('input', syncAssistant)
  assistantForm.addEventListener('submit', event => {
    event.preventDefault()
    sendAssistant('chat')
  })
  get('lore-draft-start').addEventListener('click', () => sendAssistant('draft'))
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

  return { render, renderContext, renderQuick, rememberScroll: assistant.rememberScroll, restoreScroll: assistant.restoreScroll }
}
