import { embedPast } from './embedding-index.mjs'
import { memoryForPrompt } from './manuscript-memory.mjs'
import { defaultReferenceSettings, validLoreCard } from './project-files.mjs'
import { actualUsage, combineUsage, estimateLabel, jsonRequest, usageLabel } from './request-tools.mjs'
import { activeLore, defaultEmbeddingModel, loreKinds, loreLimits, retrievalInput, searchPast } from './retrieval.mjs'
import { referenceLabels, writingFields } from './writing-config.mjs'

export const refsFor = project => project.references ?? defaultReferenceSettings()
export const searchFor = project => project.search ?? { enabled: false, model: defaultEmbeddingModel }

export function writingBody(project, references, lore, hits) {
  return {
    model: project.model, maxTokens: project.maxTokens, systemPrompt: project.systemPrompt, references,
    draft: {
      projectTitle: project.title,
      direction: project.direction,
      synopsis: project.synopsis,
      characterNotes: project.characterNotes ?? '',
      worldNotes: project.worldNotes,
      manuscriptMemory: memoryForPrompt(project),
      manuscript: references.includes('manuscript') ? project.manuscript.slice(-writingFields.manuscript) : '',
      lorebook: lore.text,
      pastPassages: hits.map(hit => hit.block).join('\n\n'),
    },
  }
}

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
  const catalogSelect = get('embedding-model')
  const cardForm = get('lore-form')
  let catalog
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

  function renderCatalog() {
    const { model } = searchFor(currentProject())
    const models = catalog ?? []
    catalogSelect.replaceChildren(...models.map(item => new Option(item.name, item.id)))
    if (!models.some(item => item.id === model)) catalogSelect.append(new Option(model, model))
    catalogSelect.value = model
  }

  async function showCatalog() {
    try {
      catalog = (await jsonRequest('/api/embeddings/models')).models
      renderCatalog()
      get('embedding-catalog-status').textContent = catalog.some(item => item.id === catalogSelect.value)
        ? '' : '선택한 모델이 목록에 없어요. 다른 모델을 고를 수 있어요.'
    } catch (error) {
      get('embedding-catalog-status').textContent = error.message
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
    get('embedding-model-settings').hidden = !enabled
    get('embedding-catalog-status').textContent = ''
    renderCatalog()
    if (enabled && !catalog) showCatalog()
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

  function cachedHits(project, references) {
    const entry = cache.get(project)
    if (entry && sameResearch(entry, project, references, searchFor(project))) return entry.hits
    return undefined
  }

  function startSearch(project, references, search) {
    forget(project)
    const controller = new AbortController()
    const entry = { ...search, manuscript: project.manuscript, direction: project.direction,
      recent: references.includes('manuscript'), status: '관련 원문 찾는 중…', controller, pending: true, waiters: 0 }
    cache.set(project, entry)
    const show = () => { if (project === currentProject()) renderState() }
    entry.promise = (async () => {
      const { chunks, query, intent } = retrievalInput(entry.manuscript, entry.direction, entry.recent)
      let semantic
      if (entry.enabled && chunks.length && query) {
        try {
          semantic = await embedPast(project.id, entry.model, chunks, query, controller.signal, estimate => {
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
      } else {
        entry.status = entry.enabled ? '색인할 과거 원문 또는 검색어가 없어요.' : '키워드 검색'
      }
      entry.hits = searchPast(chunks, query, semantic, intent)
      show()
      return entry.hits
    })().finally(() => { entry.pending = false })
    show()
    return entry
  }

  async function getHits(project, references, signal) {
    signal.throwIfAborted()
    if (!references.includes('pastPassages')) return []
    const search = searchFor(project)
    const cached = cache.get(project)
    const entry = cached && sameResearch(cached, project, references, search)
      ? cached : startSearch(project, references, search)
    if (!entry.pending) return entry.promise

    entry.waiters++
    let onAbort
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([entry.promise, cancelled])
    } finally {
      signal.removeEventListener('abort', onAbort)
      entry.waiters--
      if (!entry.waiters && entry.pending && cache.get(project) === entry) {
        forget(project)
        if (project === currentProject()) renderState()
      }
    }
  }

  async function prepare(project, signal) {
    const references = refsFor(project).filter(ref => ref.enabled).map(ref => ref.key)
    const lore = references.includes('lorebook') ? activeLore(project.lorebook ?? [], project.manuscript, project.direction)
      : { text: '', included: [] }
    const snapshot = writingBody(project, references, lore, [])
    const hits = await getHits(project, references, signal)
    signal.throwIfAborted()
    snapshot.draft.pastPassages = hits.map(hit => hit.block).join('\n\n')
    return { body: snapshot, lore: lore.included, hits, status: get('search-state').textContent }
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
    get('embedding-model-settings').hidden = !project.search.enabled
    if (project.search.enabled) showCatalog()
    settingsChanged()
  })
  catalogSelect.addEventListener('change', () => {
    const project = currentProject()
    project.search = { ...searchFor(project), model: catalogSelect.value }
    forget(project)
    get('embedding-catalog-status').textContent = ''
    settingsChanged()
  })
  get('retry-search').addEventListener('click', () => {
    forget(currentProject())
    if (searchFor(currentProject()).enabled) showCatalog()
    onChange()
    get('preview-request').click()
  })
  return { render, renderState, prepare, renderResults, cachedHits }
}
