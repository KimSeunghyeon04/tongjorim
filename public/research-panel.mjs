import { embedPast } from './embedding-index.mjs'
import { embeddingRouteKey, modelOptionsFor } from './model-options.mjs'
import { referenceSettingsFor } from './project-files.mjs'
import { actualUsage, combineUsage, estimateLabel, usageLabel } from './request-tools.mjs'
import { chunkManuscript, loreKinds, rankPast, retrievalInput, searchFor } from './retrieval.mjs'
import { referenceLabels, sourceLimitsFor, writingFieldPrefix } from './writing-config.mjs'
import { planWritingContext } from './writing-context.mjs'

const element = (tag, label) => Object.assign(document.createElement(tag), { textContent: label })
function action(label, title, click) {
  const button = element('button', label)
  button.type = 'button'
  button.className = 'quiet-button'
  button.setAttribute('aria-label', title)
  button.addEventListener('click', click)
  return button
}

export function setupResearch({ get, currentProject, saveWorkspace, onChange, goToPassage, passagePosition,
  addedLoreCards, onSelectLoreCard, assertWorkspaceCurrent }) {
  const cache = new WeakMap()
  const localSearch = new WeakMap()
  function settingsChanged() {
    saveWorkspace()
    onChange()
  }

  function renderRefs(focus) {
    const project = currentProject()
    const settings = referenceSettingsFor(project)
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

  function setSearchStatus(search, estimate, usage) {
    get('search-state').textContent = search
    get('embedding-estimate').textContent = estimate ? `임베딩 · ${estimateLabel(estimate)}` : ''
    get('embedding-usage').textContent = usage ? `임베딩 · ${usageLabel(usage)}` : ''
  }

  function render() {
    const project = currentProject()
    renderRefs()
    const { enabled } = searchFor(project)
    get('semantic-enabled').checked = enabled
    renderState()
  }

  function renderState() {
    const project = currentProject()
    const entry = cache.get(project)
    const search = searchFor(project)
    const refs = referenceSettingsFor(project).filter(ref => ref.enabled).map(ref => ref.key)
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

  function searchInput(project, references, cutoff, onlyCached = false, sceneRevision) {
    const manuscript = project.manuscript
    const direction = sceneRevision?.direction ?? writingFieldPrefix('direction', project.direction)
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
      const options = { cutoff, corpus: local.corpus }
      if (sceneRevision) {
        options.recentManuscript = sceneRevision.text
        options.recentLimit = Math.min(240, sourceLimitsFor(project).manuscript)
      }
      const input = { ...retrievalInput(manuscript, direction, recent, options), corpus: local.corpus }
      if (local.inputs.size >= 4) local.inputs.delete(local.inputs.keys().next().value)
      local.inputs.set(cutoff, input)
    }
    return local.inputs.get(cutoff)
  }

  function startSearch(project, references, search, input, options) {
    forget(project)
    const controller = new AbortController()
    const modelOptions = modelOptionsFor(project, search.model)
    const sourceLimitVersion = JSON.stringify(sourceLimitsFor(project))
    const entry = { ...search, modelOptions, routeKey: embeddingRouteKey(search.model, modelOptions),
      manuscript: project.manuscript, direction: project.direction,
      recent: references.includes('manuscript'), chunkCount: input.chunks.length, status: '관련 원문 찾는 중…', controller, pending: true, waiters: 0 }
    cache.set(project, entry)
    const show = () => { if (project === currentProject()) renderState() }
    entry.promise = (async () => {
      try {
        entry.semantic = await embedPast(project.id, entry, input, controller.signal, estimate => {
          entry.estimate = estimate
          show()
        }, usage => {
          entry.usage = usage
          show()
        }, {
          ...options,
          async assertCurrent() {
            await assertWorkspaceCurrent(project)
            const enabled = referenceSettingsFor(project).filter(ref => ref.enabled).map(ref => ref.key)
            if (!enabled.includes('pastPassages') || !sameResearch(entry, project, enabled, searchFor(project)) ||
                JSON.stringify(sourceLimitsFor(project)) !== sourceLimitVersion) {
              throw new DOMException('검색할 원고나 설정이 바뀌었어요.', 'AbortError')
            }
            options?.assertCurrent?.()
          },
        })
        entry.status = '키워드 + 의미 검색'
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          if (cache.get(project) === entry) cache.delete(project)
          show()
          controller.signal.throwIfAborted()
          throw error
        }
        if (entry.estimate) entry.usage = combineUsage(entry.usage, actualUsage())
        entry.status = `키워드 검색 · 의미 검색 실패 (${error.message})`
      }
      show()
    })().finally(() => { entry.pending = false })
    show()
    return entry
  }

  async function ensureSearch(project, references, cutoff, signal, options) {
    signal.throwIfAborted()
    const search = searchFor(project)
    if (!search.enabled || !cutoff) return
    const input = searchInput(project, references, cutoff, false, options?.sceneRevision)
    if (!input.chunks.length || !input.query) return
    const cached = cache.get(project)
    const entry = cached && cached.chunkCount >= input.chunks.length && sameResearch(cached, project, references, search)
      ? cached : startSearch(project, references, search, input, options)
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
    const input = searchInput(project, references, plan.cutoff, onlyCached, plan.body.sceneRevision)
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

  function plansFor(project, model, limits = sourceLimitsFor(project), { cards = addedLoreCards(project), sceneRevision } = {}) {
    const references = referenceSettingsFor(project).filter(ref => ref.enabled).map(ref => ref.key)
    return planWritingContext(project, references, model, limits, cards, sceneRevision)
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

  async function prepare(project, model, signal, { retry = false, source = project, sceneRevision, assertCurrent } = {}) {
    const plan = plansFor(source, model, undefined, { cards: addedLoreCards(project), sceneRevision })
    if (retry) forget(source)
    if (plan.canFitPast) await ensureSearch(source, plan.body.references, plan.cutoff, signal,
      { sceneRevision: plan.body.sceneRevision, prune: source === project, assertCurrent })
    signal.throwIfAborted()
    return preparedPlan(source, plan)
  }

  function renderLoreChoices(cards, focusedCard) {
    const open = new Set([...get('lore-preview-fields').querySelectorAll('details[open]')].map(item => item.id))
    function row(card) {
      const item = element('li', '')
      const detail = element('details', '')
      detail.id = `lore-preview-card-${card.id}`
      detail.open = open.has(detail.id)
      const reasons = [card.always && '항상 포함', card.manual && '이번 요청에 추가', ...card.keywords.map(word => `‘${word}’ 매칭`)]
        .filter(Boolean)
      const reason = card.included ? reasons.join(', ') : reasons.length ? '로어북 분량 한도로 빠짐' : '이름이나 별칭이 나오지 않음'
      detail.append(element('summary', card.name), element('p', `${loreKinds[card.kind]} · ${reason}`), element('pre', card.description))
      if (!card.included || card.manual) {
        const label = element('label', '')
        label.className = 'lore-preview-choice'
        const input = element('input', '')
        input.type = 'checkbox'
        input.id = `lore-preview-add-${card.id}`
        input.checked = card.manual
        input.setAttribute('aria-label', `${card.name} 이번 요청에 추가`)
        input.addEventListener('change', () => onSelectLoreCard(card.id, input.checked))
        label.append(input, '이번 요청에 추가')
        detail.append(label)
      }
      item.append(detail)
      return item
    }
    const included = cards.filter(card => card.included)
    const omitted = cards.filter(card => !card.included)
    const omittedSection = get('lore-preview-omitted')
    omittedSection.hidden = !omitted.length
    omittedSection.open = open.has(omittedSection.id) || omitted.some(card => card.id === focusedCard)
    get('lore-preview-omitted-count').textContent = `빠진 카드 ${omitted.length}장`
    const activeRows = document.createDocumentFragment()
    const omittedRows = document.createDocumentFragment()
    for (const card of included) activeRows.append(row(card))
    if (!included.length) activeRows.append(element('li', '포함된 카드 없음'))
    for (const card of omitted) omittedRows.append(row(card))
    get('lore-activation').replaceChildren(activeRows)
    get('lore-omitted-list').replaceChildren(omittedRows)
  }

  function renderResults({ lore, hits, status, body }, focusedCard) {
    const showLore = body.references.includes('lorebook')
    const showPast = body.references.includes('pastPassages')
    get('lore-preview-section').hidden = !showLore
    get('past-preview-section').hidden = !showPast
    renderLoreChoices(lore, focusedCard)
    get('past-search-summary').textContent = status
    get('past-reading-list').replaceChildren(...(hits.length ? hits.map(hit => {
      const item = element('li', '')
      const position = passagePosition(hit)
      item.append(action(position, `${position}로 이동`, () => goToPassage(hit)))
      item.append(element('p', hit.text))
      return item
    }) : [element('li', '전송할 과거 원문 없음')]))
  }

  get('semantic-enabled').addEventListener('change', event => {
    const project = currentProject()
    project.search = { ...searchFor(project), enabled: event.target.checked }
    forget(project)
    settingsChanged()
  })
  return { render, renderState, plan: plansFor, prepare, preview, renderResults, inspect, refreshSearch }
}
