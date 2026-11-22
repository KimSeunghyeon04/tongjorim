import { loreLimits } from './retrieval.mjs'
import { matchingLoreName, pendingLoreChanges } from './scene-review.mjs'

const element = (tag, content = '', className = '') => Object.assign(document.createElement(tag), { textContent: content, className })
const button = (content, className, onClick) => Object.assign(element('button', content, className), { type: 'button', onclick: onClick })

function proposalTag(proposal) {
  const label = proposal.conflict ? '설정 충돌' : proposal.targetId ? '카드 수정' : '새 카드'
  const tag = element('span', label, 'lore-review-tag')
  tag.dataset.conflict = String(proposal.conflict)
  return tag
}

function proposalDiff(before, after) {
  const diff = element('div', '', 'lore-review-diff')
  const original = element('div')
  const proposed = element('div')
  const removed = element('p')
  const added = element('p')
  const append = after.startsWith(before)
  if (!before) removed.append(element('span', '등록된 카드 없음', 'field-hint'))
  else if (append) removed.textContent = before
  else removed.append(element('del', before))
  if (append && before) added.append(document.createTextNode(before))
  added.append(element('ins', append ? after.slice(before.length) : after))
  original.append(element('h3', '현재 카드'), removed)
  proposed.append(element('h3', '제안된 설명'), added)
  diff.append(original, proposed)
  return diff
}

function targetCard(project, proposal) {
  return (project.lorebook ?? []).find(card => card.id === proposal.targetId)
}

export function setupLoreReviews({ get, currentProject, saveWorkspace, goToPassage, jobError, onOpen, onChange }) {
  const sessions = new WeakMap()
  const queue = get('lore-review-list')
  const detail = get('lore-review-detail')
  const reviewTab = get('lore-review-tab')
  const cardsTab = get('lore-cards-tab')
  const undoButton = get('lore-review-undo')

  function sessionFor(project) {
    if (!sessions.has(project)) sessions.set(project, { selection: null, open: false, message: '' })
    return sessions.get(project)
  }

  function showNotices(items, project) {
    for (const id of ['lore-tab-count', 'lore-review-count']) {
      const count = get(id)
      count.hidden = !items.length
      count.textContent = String(items.length)
      count.setAttribute('aria-label', `검토 대기 ${items.length}건`)
    }
    const latest = project.sceneReviews?.at(-1)
    const fresh = items.filter(item => item.review === latest).length
    const error = jobError(project)
    const notice = get('lore-review-notice-message')
    const message = fresh ? `이번 장면에서 로어북 수정안 ${fresh}건을 찾았어요.` : error
    if (notice.textContent !== message) notice.textContent = message
    get('lore-review-notice').hidden = !message
    get('open-lore-review').hidden = !fresh
    get('retry-scene-review').hidden = !error
  }

  function render({ focus = false } = {}) {
    const project = currentProject()
    const session = sessionFor(project)
    const items = pendingLoreChanges(project)
    showNotices(items, project)
    cardsTab.setAttribute('aria-pressed', String(!session.open))
    reviewTab.setAttribute('aria-pressed', String(session.open))
    get('lore-cards-view').hidden = session.open
    get('lore-review-view').hidden = !session.open
    if (!session.open) return

    const item = items.find(entry => entry.proposal.id === session.selection) ?? items[0]
    session.selection = item?.proposal.id
    let selectedButton
    queue.replaceChildren(...items.map(entry => {
      const row = button('', 'lore-review-row', () => {
        if (entry === item) return
        session.selection = entry.proposal.id
        session.edit = null
        session.message = ''
        render({ focus: true })
      })
      row.disabled = Boolean(session.saving)
      row.setAttribute('aria-pressed', String(entry === item))
      if (entry === item) selectedButton = row
      const meta = element('span', '', 'lore-review-meta')
      meta.append(proposalTag(entry.proposal), element('span', entry.scene.title, 'field-hint'))
      row.append(element('strong', entry.proposal.name), meta)
      const li = element('li')
      li.append(row)
      return li
    }))
    const oldEditor = get('lore-review-description')
    const editorSelection = oldEditor && document.activeElement === oldEditor ? [oldEditor.selectionStart, oldEditor.selectionEnd] : null
    if (item) renderDetail(project, session, item)
    else detail.replaceChildren(element('h2', '검토할 수정안이 없어요'), element('p', '새 장면에서 카드에 담을 설정을 찾으면 여기에 표시돼요.', 'field-hint'))
    get('lore-review-feedback').hidden = !session.message && !session.undo
    get('lore-review-status').textContent = session.message
    undoButton.hidden = !session.undo
    undoButton.disabled = Boolean(session.saving)
    if (focus) (selectedButton ?? reviewTab).focus({ preventScroll: true })
    else if (editorSelection && get('lore-review-description')) {
      const editor = get('lore-review-description')
      editor.focus({ preventScroll: true })
      editor.setSelectionRange(...editorSelection)
    }
  }

  function renderDetail(project, session, item) {
    const { proposal, passages, scene } = item
    const card = targetCard(project, proposal)
    const duplicate = !proposal.targetId && matchingLoreName(project, proposal.name)
    const edited = session.edit?.id === proposal.id ? session.edit : null
    const changed = card?.description !== proposal.before && Boolean(proposal.targetId)
    const title = element('div', '', 'lore-review-heading')
    title.append(element('h2', card?.name ?? proposal.name), proposalTag(proposal))
    const proof = element('section', '', 'lore-review-proof')
    const proofHead = element('div', '', 'lore-review-meta')
    proofHead.append(element('h3', `원고 근거 · ${scene.title}`))
    proof.append(proofHead)
    for (const [index, passage] of passages.entries()) {
      const label = passages.length === 1 ? '원고에서 보기' : `근거 ${index + 1} 원고에서 보기`
      const source = button(label, 'quiet-button', () => goToPassage(passage))
      if (passages.length === 1) {
        proofHead.append(source)
        proof.append(element('blockquote', passage.text))
      } else {
        const group = element('div', '', 'lore-review-proof-piece')
        group.append(source, element('blockquote', passage.text))
        proof.append(group)
      }
    }
    const warning = duplicate ? '같은 이름이나 별칭을 쓰는 카드가 있어요. 카드 목록에서 기존 카드를 확인해 주세요.'
      : proposal.targetId && !card ? '대상 카드가 삭제됐어요.'
        : changed ? '제안 이후 카드가 바뀌었어요. 현재 설명을 확인하고 직접 고쳐 반영해 주세요.' : ''
    detail.replaceChildren(title)
    if (warning) detail.append(element('p', warning, 'field-hint'))
    detail.append(proof, proposalDiff(card?.description ?? '', proposal.description))

    const actions = element('div', '', 'lore-review-actions')
    const discard = button(proposal.conflict ? '기존 설정 유지' : '제안 제외', 'quiet-button', () => resolve(project, session, item))
    const secondary = element('div', '', 'compact-actions')
    const edit = button(edited ? '수정 취소' : '설명 수정', 'outline-button', () => {
      session.edit = edited ? null : { id: proposal.id, base: card?.description, value: proposal.description }
      render()
      const nextControl = get('lore-review-description') ?? detail.querySelector('.outline-button')
      nextControl.focus()
    })
    const approve = button(edited ? '수정한 설명 반영' : proposal.targetId ? '카드에 반영' : '카드 추가',
      'writing-primary', () => resolve(project, session, item, edited ?? { value: proposal.description, base: proposal.before }))
    const unavailable = Boolean(duplicate || (proposal.targetId && !card))
    const sync = () => {
      approve.disabled = Boolean(session.saving || unavailable || (edited
        ? !edited.value.trim() || edited.base !== card?.description : changed))
    }
    if (edited) {
      const field = element('div', '', 'writing-input lore-review-edit')
      const label = element('label', '반영할 설명')
      const editor = element('textarea', '', 'writing-field')
      editor.id = 'lore-review-description'
      label.htmlFor = editor.id
      editor.rows = 4
      editor.maxLength = loreLimits.description
      editor.value = edited.value
      editor.disabled = Boolean(session.saving)
      editor.oninput = () => {
        edited.value = editor.value
        sync()
      }
      field.append(label, editor)
      detail.append(field)
    }
    edit.disabled = Boolean(session.saving || unavailable)
    discard.disabled = Boolean(session.saving)
    sync()
    secondary.append(edit, approve)
    actions.append(discard, secondary)
    detail.append(actions)
  }

  async function resolve(project, session, item, edit) {
    if (session.saving) return
    session.saving = true
    session.message = ''
    const { proposal } = item
    const index = pendingLoreChanges(project).findIndex(entry => entry.proposal.id === proposal.id)
    render()
    let action
    const saved = await saveWorkspace(() => {
      const live = pendingLoreChanges(project).find(entry => entry.proposal.id === proposal.id)
      if (!live) return
      const reviews = project.sceneReviews
      const cards = project.lorebook
      const beforeCard = targetCard(project, proposal)
      let afterCard
      if (edit) {
        const description = edit.value.trim()
        if (!description || description.length > loreLimits.description) return
        if (proposal.targetId) {
          if (!beforeCard || beforeCard.description !== edit.base) return
          afterCard = { ...beforeCard, description }
          project.lorebook = cards.map(card => card === beforeCard ? afterCard : card)
        } else {
          if (matchingLoreName(project, proposal.name)) return
          afterCard = { id: crypto.randomUUID(), kind: proposal.kind, name: proposal.name.trim(), aliases: [], description, priority: 0, always: false }
          project.lorebook = [...(cards ?? []), afterCard]
        }
      }
      const updatedReview = { ...live.review, lore: live.review.lore.filter(candidate => candidate !== proposal) }
      const nextReviews = reviews.map(review => review === live.review ? updatedReview : review)
      const nextCards = project.lorebook
      project.sceneReviews = nextReviews
      action = { item: live, updatedReview, beforeCard, afterCard }
      return () => {
        if (project.sceneReviews === nextReviews) project.sceneReviews = reviews
        if (project.lorebook === nextCards) project.lorebook = cards
      }
    })
    session.saving = false
    if (saved && action) {
      session.undo = action
      session.edit = null
      const next = pendingLoreChanges(project)
      session.selection = (next[index] ?? next[0])?.proposal.id
      session.message = edit ? `‘${proposal.name}’ 카드에 반영했어요.` : `‘${proposal.name}’ 제안을 제외했어요.`
      onChange(project, Boolean(edit))
    } else session.message = saved ? '원고나 카드가 바뀌었어요. 현재 내용을 확인해 주세요.' : '처리 결과를 저장하지 못했어요.'
    if (project === currentProject()) render({ focus: Boolean(saved && action) })
  }

  undoButton.addEventListener('click', async () => {
    const project = currentProject()
    const session = sessionFor(project)
    if (session.saving || !session.undo) return
    const { item, updatedReview, beforeCard, afterCard } = session.undo
    session.saving = true
    let restored = false
    const saved = await saveWorkspace(() => {
      const reviews = project.sceneReviews
      const cards = project.lorebook
      if (!reviews.includes(updatedReview) ||
          (afterCard && !cards?.includes(afterCard))) return
      const nextReviews = reviews.map(entry => entry === updatedReview ? item.review : entry)
      const nextCards = afterCard ? cards.flatMap(card => card !== afterCard ? [card] : beforeCard ? [beforeCard] : []) : cards
      project.sceneReviews = nextReviews
      project.lorebook = nextCards
      restored = true
      return () => {
        if (project.sceneReviews === nextReviews) project.sceneReviews = reviews
        if (project.lorebook === nextCards) project.lorebook = cards
      }
    })
    session.saving = false
    session.undo = null
    session.message = saved && restored ? '실행을 취소했어요.' : '원고나 카드가 바뀌었거나 저장이 실패해 실행을 취소하지 못했어요.'
    if (saved && restored) {
      session.selection = item.proposal.id
      onChange(project, Boolean(afterCard))
    }
    if (project === currentProject()) render({ focus: true })
  })

  function open({ latest = false } = {}) {
    const project = currentProject()
    const session = sessionFor(project)
    if (latest) session.selection = pendingLoreChanges(project)
      .find(entry => entry.review === project.sceneReviews?.at(-1))?.proposal.id
    session.open = true
    onOpen()
    render({ focus: true })
  }

  reviewTab.addEventListener('click', () => open())
  cardsTab.addEventListener('click', () => {
    sessionFor(currentProject()).open = false
    render()
  })
  get('open-lore-review').addEventListener('click', () => open({ latest: true }))
  return { render, open }
}
