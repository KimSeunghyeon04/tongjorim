import { embedPast } from './embedding-index.mjs'
import { defaultReferenceSettings, validLoreCard } from './project-files.mjs'
import { actualUsage, combineUsage, estimateLabel, usageLabel } from './request-tools.mjs'
import { chunkManuscript, loreKinds, loreLimits, rankPast, retrievalInput, searchFor } from './retrieval.mjs'
import { referenceLabels, sourceLimitsFor, writingFieldPrefix } from './writing-config.mjs'
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

export function setupResearch({ get, currentProject, saveWorkspace, onChange, goToPassage }) {
  const cache = new WeakMap()
  const localSearch = new WeakMap()
  const cardForm = get('lore-form')
  let cardId

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
    get('lore-empty').hidden = cards.length > 0
    get('lore-list').replaceChildren(...cards.map(card => {
      const row = element('li', '')
      const heading = element('div', '')
      heading.className = 'field-heading'
      const title = element('strong', card.name)
      const controls = element('div', '')
      controls.className = 'compact-actions'
      controls.append(action('편집', `${card.name} 편집`, () => {
        cardId = card.id
        get('lore-kind').value = card.kind
        get('lore-name').value = card.name
        get('lore-aliases').value = card.aliases.join(', ')
        get('lore-description').value = card.description
        get('lore-priority').value = card.priority
        get('lore-always').checked = card.always
        get('save-lore').textContent = '카드 수정'
        get('lore-cancel').hidden = false
        get('lore-editor').open = true
        get('lore-name').focus()
      }), action('삭제', `${card.name} 삭제`, () => {
        project.lorebook = cards.filter(item => item.id !== card.id)
        if (cardId === card.id) resetForm()
        renderLore()
        get('lore-editor').querySelector('summary').focus()
        settingsChanged()
      }))
      heading.append(title, controls)
      const info = element('p', `${loreKinds[card.kind]} · 우선순위 ${card.priority}${card.always ? ' · 항상 포함' : ''}`)
      info.className = 'field-hint'
      row.append(heading, info)
      return row
    }))
  }

  function resetForm() {
    cardId = undefined
    cardForm.reset()
    get('lore-cancel').hidden = true
    get('save-lore').textContent = '카드 추가'
    get('lore-form-status').textContent = ''
  }

  function setSearchStatus(search, estimate, usage) {
    get('search-state').textContent = search
    get('embedding-estimate').textContent = estimate ? `임베딩 · ${estimateLabel(estimate)}` : ''
    get('embedding-usage').textContent = usage ? `임베딩 · ${usageLabel(usage)}` : ''
  }

  function render() {
    resetForm()
    get('lore-editor').open = false
    renderLore()
    renderRefs()
    const { enabled } = searchFor(currentProject())
    get('semantic-enabled').checked = enabled
    renderState()
  }

  function renderState() {
    const project = currentProject()
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
      entry.recent === refs.includes('manuscript') && entry.enabled === search.enabled && entry.model === search.model
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
    const entry = { ...search, manuscript: project.manuscript, direction: project.direction,
      recent: references.includes('manuscript'), chunkCount: chunks.length, status: '관련 원문 찾는 중…', controller, pending: true, waiters: 0 }
    cache.set(project, entry)
    const show = () => { if (project === currentProject()) renderState() }
    entry.promise = (async () => {
      try {
        entry.semantic = await embedPast(project.id, entry.model, chunks, query, controller.signal, estimate => {
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
    if (!plan.pastLimit || !plan.cutoff) return { ranked: () => [] }
    const { references } = plan.body
    const input = searchInput(project, references, plan.cutoff, onlyCached)
    if (!input) return { ranked: () => [], pastPending: plan.canFitPast }
    if (!input.chunks.length || !input.query) return { ranked: () => [] }
    const search = searchFor(project)
    const cached = cache.get(project)
    const entry = search.enabled && cached && cached.chunkCount >= input.chunks.length && sameResearch(cached, project, references, search)
      ? cached : undefined
    const semanticPending = plan.canFitPast && search.enabled && (!entry || entry.pending)
    return {
      semanticPending,
      semanticFailed: Boolean(plan.canFitPast && entry && !entry.pending && !entry.semantic),
      ranked: keywordOnly => rankedPast(input, keywordOnly ? undefined : entry?.semantic),
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

  async function prepare(project, model, signal) {
    const plan = plansFor(project, model)
    const { references } = plan.body
    const input = plan.pastLimit && plan.cutoff ? searchInput(project, references, plan.cutoff) : undefined
    const entry = plan.canFitPast ? await ensureSearch(project, references, plan.cutoff, signal) : undefined
    signal.throwIfAborted()
    const status = entry?.status ?? (input?.chunks.length && input.query ? '키워드 검색' : '검색할 과거 원문 또는 검색어 없음')
    return { ...plan.finish(rankedPast(input, entry?.semantic)), status }
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
      const position = `원고 ${hit.start + 1}–${hit.end}자`
      item.append(action(position, `${position}로 이동`, () => goToPassage(hit)))
      item.append(element('p', hit.text))
      return item
    }) : [element('li', '전송할 과거 원문 없음')]))
  }

  get('lore-kind').replaceChildren(...Object.entries(loreKinds).map(([key, label]) => new Option(label, key)))
  cardForm.addEventListener('submit', event => {
    event.preventDefault()
    const project = currentProject()
    const cards = project.lorebook ?? []
    const card = {
      id: cardId ?? crypto.randomUUID(), kind: get('lore-kind').value, name: get('lore-name').value.trim(),
      aliases: [...new Set(get('lore-aliases').value.split(/[,\n]/).map(alias => alias.trim()).filter(Boolean))],
      description: get('lore-description').value.trim(), priority: Number(get('lore-priority').value),
      always: get('lore-always').checked,
    }
    if (!validLoreCard(card) || (!cardId && cards.length >= loreLimits.cards)) {
      get('lore-form-status').textContent = '이름과 설명을 입력해 주세요. 별칭은 16개, 카드는 150개까지 저장할 수 있어요.'
      return
    }
    project.lorebook = cardId ? cards.map(item => item.id === cardId ? card : item) : [...cards, card]
    resetForm()
    renderLore()
    get('lore-editor').open = false
    get('lore-editor').querySelector('summary').focus()
    settingsChanged()
  })
  get('lore-cancel').addEventListener('click', resetForm)
  get('semantic-enabled').addEventListener('change', event => {
    const project = currentProject()
    project.search = { ...searchFor(project), enabled: event.target.checked }
    forget(project)
    settingsChanged()
  })
  get('retry-search').addEventListener('click', () => {
    forget(currentProject())
    onChange()
    get('preview-request').click()
  })
  return { render, renderState, prepare, renderResults, inspect, refreshSearch }
}
