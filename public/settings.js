import { freeModel, pricing, settingsChangeEvent } from './completion.js'
import { classifyModel, unclassifiedGeneration } from './model-classification.mjs'
import { modelOptionsFor, reasoningEfforts, samplingRanges, validModelOptions } from './model-options.mjs'
import { formatCost, jsonRequest } from './request-tools.mjs'
import { searchFor } from './retrieval.mjs'
import { currentProjectOf, projectName, readWorkspace, storageKey } from './writing-workspace.mjs'
import { optionalProjectModels, validModelId, validWritingTokenLimit } from './writing-config.mjs'

const get = id => document.getElementById(id)
const notifyChange = key => document.dispatchEvent(new CustomEvent(settingsChangeEvent, { detail: key }))
const labelOrder = new Intl.Collator('ko', { numeric: true })

function optionValue(field) {
  if (field.type === 'checkbox') return field.checked === field.defaultChecked ? undefined : field.checked
  if (!field.value) return undefined
  if (field.type === 'number') return field.valueAsNumber
  if (!field.dataset.list) return field.value
  const values = field.value.split(field.dataset.list === 'lines' ? /\r?\n/ : /[,\s]+/).filter(Boolean)
  return values.length ? [...new Set(values)] : undefined
}

function setOptionField(field, value) {
  if (field.type === 'checkbox') field.checked = value ?? field.defaultChecked
  else field.value = Array.isArray(value) ? value.join(field.dataset.list === 'lines' ? '\n' : ', ') : value ?? ''
}

function setupOpenRouterUsage() {
  const button = get('openrouter-refresh')
  const spend = get('openrouter-spend')
  const periods = get('openrouter-periods')
  const remaining = get('openrouter-remaining')
  const limit = get('openrouter-limit')
  const creditMetric = get('openrouter-credit-metric')
  const credit = get('openrouter-credit')
  const status = get('openrouter-status')
  const resetLabels = { daily: '일일 한도', weekly: '주간 한도', monthly: '월간 한도' }
  const time = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' })
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  const formatAmount = value => value == null ? formatCost(value) : usd.format(value)

  async function refresh() {
    if (button.hasAttribute('aria-disabled')) return
    button.setAttribute('aria-disabled', 'true')
    status.removeAttribute('data-error')
    status.textContent = '사용량을 불러오는 중이에요.'
    try {
      const { key, credits } = await jsonRequest('/api/openrouter/usage')
      spend.textContent = formatAmount(key.total)
      periods.hidden = key.today == null && key.month == null
      periods.textContent = periods.hidden ? '' : `오늘 ${formatAmount(key.today)} · 이번 달 ${formatAmount(key.month)}`
      remaining.textContent = key.limit === null ? '한도 미설정' : formatAmount(key.remaining)
      limit.hidden = key.limit == null
      limit.textContent = limit.hidden ? '' : `${resetLabels[key.reset] ?? '전체 한도'} ${formatCost(key.limit)}`
      creditMetric.hidden = credits === null
      credit.textContent = formatAmount(credits?.balance)

      const errors = [key.error, credits?.error].filter(Boolean)
      status.toggleAttribute('data-error', errors.length > 0)
      status.textContent = errors.length ? errors.join(' ') : `최근 확인 ${time.format(Date.now())}`
    } catch {
      spend.textContent = remaining.textContent = credit.textContent = formatCost(null)
      periods.hidden = limit.hidden = true
      status.setAttribute('data-error', '')
      status.textContent = 'OpenRouter 사용량에 연결할 수 없어요. 새로고침해 주세요.'
    } finally {
      button.removeAttribute('aria-disabled')
    }
  }

  button.addEventListener('click', refresh)
  refresh()
  return refresh
}

function setupSettings(root) {
  const refreshUsage = setupOpenRouterUsage()
  const projectSelect = get('settings-project')
  const limit = get('generation-limit')
  const limitError = get('generation-limit-error')
  const dialog = get('model-dialog')
  const search = get('model-search')
  const publisherFilter = get('model-publisher')
  const generationFilter = get('model-generation')
  const modelList = get('model-list')
  const retry = get('retry-catalog')
  const modelButtons = [...root.querySelectorAll('[data-model]')]
  const optionsButtons = [...root.querySelectorAll('[data-model-options]')]
  const optionsForm = get('model-options')
  const optionsTitle = get('model-options-title')
  const optionsError = get('model-options-error')
  const generationOptions = get('model-generation-options')
  const routingOptions = get('model-routing-options')
  const outputPrice = get('model-output-price')
  const optionFields = [...optionsForm.elements].filter(field => field.name)
    .map(field => ({ field, path: field.name.split('.') }))
  for (const [key, { min, max }] of Object.entries(samplingRanges)) {
    const input = optionsForm.elements.namedItem(key)
    input.min = min
    input.max = max
  }
  const effortLabels = {
    none: '끔', minimal: '최소', low: '낮음', medium: '중간',
    high: '높음', xhigh: '매우 높음', max: '최대',
  }
  const effortInput = get('model-reasoning-effort')
  const priceFilters = [...dialog.querySelectorAll('[data-free]')]
  const catalogs = {
    text: { path: '/api/models', models: [classifyModel(freeModel)] },
    embedding: { path: '/api/embeddings/models', models: [] },
  }
  let workspace
  let serializedWorkspace
  let picker
  let optionsEditor
  let freeOnly = false

  const catalogFor = key => catalogs[key === 'embedding' ? 'embedding' : 'text']
  const selectedProject = () => workspace?.projects.find(project => project.id === projectSelect.value)
  const modelName = (catalog, id) => catalog.models.find(model => model.id === id)?.name ?? id

  function selectedModel(key, project) {
    if (key === 'embedding') return project ? searchFor(project).model : ''
    return project?.[key] ?? ''
  }

  function effectiveModel(key, project) {
    return selectedModel(key, project) || project?.model
  }

  function showStatus(message, error = false) {
    const status = get('settings-status')
    status.textContent = message
    status.toggleAttribute('data-error', error)
  }

  function renderSettings() {
    const project = selectedProject()
    limit.disabled = !project
    limit.value = project?.maxTokens ?? ''
    limitError.textContent = ''
    renderModelSettings()
  }

  function renderModelSettings() {
    const project = selectedProject()
    for (const button of modelButtons) {
      const key = button.dataset.model
      const id = selectedModel(key, project)
      const catalog = catalogFor(key)
      const name = modelName(catalog, id)
      const inherited = project && optionalProjectModels.includes(key) && !id
      button.querySelector('strong').textContent = inherited ? '이어쓰기 모델 사용' : name || '선택할 수 없어요'
      button.querySelector('.model-label > span').textContent = inherited ? modelName(catalog, project.model) : name === id ? '' : id
      button.disabled = !project
    }
    for (const button of optionsButtons) button.disabled = !project
    if (optionsEditor && (optionsEditor.projectId !== project?.id ||
        effectiveModel(optionsEditor.key, project) !== optionsEditor.model)) closeOptions(false)
  }

  function closeOptions(restoreFocus = true) {
    if (!optionsEditor) return
    const { button } = optionsEditor
    button.setAttribute('aria-expanded', 'false')
    optionsForm.hidden = true
    optionsEditor = undefined
    if (restoreFocus) button.focus()
  }

  function openOptions(button) {
    if (optionsEditor?.button === button) return closeOptions()
    closeOptions(false)
    const project = selectedProject()
    const key = button.dataset.modelOptions
    const model = effectiveModel(key, project)
    const previous = modelOptionsFor(project, model) ?? {}
    const catalog = catalogFor(key)
    const savedEffort = previous.reasoning?.effort
    const supportedEfforts = catalog.models.find(entry => entry.id === model)?.supportedEfforts ?? reasoningEfforts
    const effortOptions = supportedEfforts.map(effort => new Option(effortLabels[effort], effort))
    if (savedEffort && !supportedEfforts.includes(savedEffort)) {
      effortOptions.push(new Option(`${effortLabels[savedEffort]} (이전 설정)`, savedEffort))
    }
    effortInput.replaceChildren(new Option(effortOptions.length ? '기본값' : '모델 기본값', ''), ...effortOptions)
    effortInput.disabled = !effortOptions.length
    optionsEditor = { button, key, model, projectId: project.id, previous: JSON.stringify(previous) }
    const embedding = key === 'embedding'
    generationOptions.hidden = embedding
    generationOptions.disabled = embedding
    outputPrice.hidden = embedding
    outputPrice.querySelector('input').disabled = embedding
    routingOptions.open = embedding || Object.keys(previous.provider ?? {}).some(field => field !== 'zdr')
    for (const { field, path } of optionFields) {
      setOptionField(field, path.reduce((value, segment) => value?.[segment], previous))
    }
    optionsTitle.textContent = modelName(catalog, model)
    optionsError.hidden = true
    button.closest('.settings-row').after(optionsForm)
    optionsForm.hidden = false
    button.setAttribute('aria-expanded', 'true')
    get('model-zdr').focus()
  }

  function saveOptions(event) {
    event.preventDefault()
    if (!optionsEditor) return
    const { model, projectId, previous } = optionsEditor
    const options = {}
    for (const { field, path } of optionFields) {
      const value = optionValue(field)
      if (value === undefined) continue
      const target = path.slice(0, -1).reduce((parent, segment) => (parent[segment] ??= {}), options)
      target[path.at(-1)] = value
    }
    if (!validModelOptions(options)) {
      optionsError.textContent = '상세설정 값을 확인해 주세요. 제공자 목록에는 이름 대신 OpenRouter 제공자 ID를 입력해 주세요.'
      routingOptions.open = true
      optionsError.hidden = false
      return
    }
    try {
      saveProjectSetting(projectId, project => {
        if (JSON.stringify(modelOptionsFor(project, model) ?? {}) !== previous) {
          throw new Error('다른 탭에서 이 모델의 상세설정이 바뀌었어요. 다시 열어 최신 값을 확인해 주세요.')
        }
        const profiles = { ...project.modelOptions }
        if (Object.keys(options).length) profiles[model] = options
        else delete profiles[model]
        if (Object.keys(profiles).length) project.modelOptions = profiles
        else delete project.modelOptions
      })
      closeOptions()
    } catch (error) {
      optionsError.textContent = error instanceof DOMException
        ? '브라우저에 상세설정을 저장하지 못했어요.' : error.message
      optionsError.hidden = false
    }
  }

  function renderProjects(preferred = projectSelect.value) {
    const projects = workspace?.projects ?? []
    projectSelect.replaceChildren(...projects.map(project => new Option(projectName(project), project.id)))
    projectSelect.disabled = !projects.length
    if (workspace) {
      projectSelect.value = projects.find(project => project.id === preferred)?.id ?? currentProjectOf(workspace).id
    }
    get('workspace-error').hidden = Boolean(workspace)
    renderSettings()
  }

  function loadWorkspace(preferred) {
    try {
      const latest = localStorage.getItem(storageKey)
      if (!workspace || serializedWorkspace !== latest) workspace = readWorkspace(latest)
      serializedWorkspace = latest
    } catch {
      workspace = undefined
      get('workspace-error').textContent = '브라우저에 저장된 작품을 열 수 없어요.'
    }
    renderProjects(preferred)
  }

  function saveProjectSetting(projectId, update) {
    const latest = localStorage.getItem(storageKey)
    const next = latest === null && serializedWorkspace === null ? structuredClone(workspace) : readWorkspace(latest)
    const project = next.projects.find(item => item.id === projectId)
    if (!project) throw new Error('선택한 작품을 찾을 수 없어요.')
    update(project)
    const serialized = JSON.stringify(next)
    localStorage.setItem(storageKey, serialized)
    serializedWorkspace = serialized
    workspace = next
    renderProjects(projectId)
    showStatus(`‘${projectName(project)}’ 설정을 저장했어요.`)
    notifyChange(storageKey)
  }

  function chooseModel(id) {
    const { key, projectId } = picker
    try {
      saveProjectSetting(projectId, project => {
        if (key === 'embedding') project.search = { ...searchFor(project), model: id }
        else if (id) project[key] = id
        else delete project[key]
      })
      dialog.close()
    } catch {
      const error = get('model-save-error')
      error.textContent = '모델을 저장하지 못했어요. 작품이나 브라우저 저장 공간을 확인해 주세요.'
      error.hidden = false
    }
  }

  function modelOption(model, selected) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    const details = document.createElement('span')
    const name = document.createElement('strong')
    details.className = 'model-option-label'
    name.textContent = model.name
    details.append(name)
    if (model.id) {
      const id = document.createElement('span')
      id.textContent = model.id
      details.append(id)
    }
    button.type = 'button'
    button.className = 'model-option'
    button.setAttribute('aria-pressed', String(model.id === selected))
    button.append(details)
    if (picker.key !== 'embedding' && model.id) {
      const price = document.createElement('span')
      price.className = model.free ? 'option-price free-price' : 'option-price'
      price.textContent = pricing(model)
      button.append(price)
    }
    button.addEventListener('click', () => chooseModel(model.id))
    item.append(button)
    return item
  }

  function setFilterOptions(filter, label, options) {
    const selected = filter.value
    filter.replaceChildren(new Option(label, ''), ...[...options].map(([value, name]) => new Option(name, value)))
    filter.value = options.has(selected) ? selected : ''
    filter.disabled = !options.size
  }

  function matchesPublisher(model) {
    return !publisherFilter.value || model.publisher === publisherFilter.value
  }

  function renderGenerationFilter() {
    const models = catalogFor(picker.key).models.filter(matchesPublisher)
    const generations = new Set(models.map(model => model.generation))
    const sorted = [...generations].filter(generation => generation !== unclassifiedGeneration).sort(labelOrder.compare)
    if (generations.has(unclassifiedGeneration)) sorted.push(unclassifiedGeneration)
    setFilterOptions(generationFilter, '모든 세대', new Map(sorted.map(label => [label, label])))
  }

  function renderClassificationFilters() {
    const publishers = catalogFor(picker.key).models.map(model => [model.publisher, model.publisherName])
    publishers.sort(([, a], [, b]) => labelOrder.compare(a, b))
    setFilterOptions(publisherFilter, '모든 제공사', new Map(publishers))
    renderGenerationFilter()
  }

  function renderPicker() {
    const { key, projectId } = picker
    const catalog = catalogFor(key)
    const project = workspace?.projects.find(item => item.id === projectId)
    const selected = selectedModel(key, project)
    const query = search.value.trim().toLowerCase()
    const generation = generationFilter.value
    const models = catalog.models.filter(model => matchesPublisher(model) &&
      (!generation || model.generation === generation) && (!freeOnly || model.free) &&
      `${model.name} ${model.id} ${model.publisherName} ${model.generation}`.toLowerCase().includes(query))
    const count = models.length
    const fallback = { id: '', name: '이어쓰기 모델 사용' }
    if (!publisherFilter.value && !generation && optionalProjectModels.includes(key) && fallback.name.includes(query)) models.unshift(fallback)

    get('model-list-status').textContent = catalog.loading ? '모델 목록을 불러오는 중이에요.'
      : catalog.error || (!models.length ? '조건에 맞는 모델이 없어요.'
        : selected && !catalog.models.some(model => model.id === selected) ? '현재 모델이 목록에 없어요. 다른 모델을 선택할 수 있어요.'
          : count ? `모델 ${count.toLocaleString('ko-KR')}개` : '')
    retry.hidden = !catalog.error || catalog.loading
    modelList.replaceChildren(...models.map(model => modelOption(model, selected)))
    modelList.scrollTop = 0
  }

  async function loadCatalog(catalog) {
    if (catalog.loading) return
    catalog.loading = true
    catalog.error = ''
    if (dialog.open && catalogFor(picker.key) === catalog) renderPicker()
    try {
      const data = await jsonRequest(catalog.path)
      if (!Array.isArray(data.models)) throw new Error('모델 목록을 읽을 수 없어요.')
      catalog.models = data.models.filter(model => validModelId(model?.id)).map(classifyModel)
      if (data.catalogAvailable === false) catalog.error = '최신 모델 목록을 불러오지 못했어요.'
    } catch (error) {
      catalog.error = error instanceof TypeError ? '모델 목록에 연결할 수 없어요.' : error.message
    } finally {
      catalog.loading = false
      renderModelSettings()
      if (dialog.open && catalogFor(picker.key) === catalog) {
        renderClassificationFilters()
        renderPicker()
      }
    }
  }

  for (const button of modelButtons) {
    button.addEventListener('click', () => {
      const key = button.dataset.model
      picker = { key, projectId: projectSelect.value }
      get('dialog-title').textContent = get(button.getAttribute('aria-labelledby').split(' ')[0]).textContent
      get('model-filters').hidden = key === 'embedding'
      get('model-save-error').hidden = true
      freeOnly = false
      for (const filter of priceFilters) filter.setAttribute('aria-pressed', String(filter.dataset.free === 'false'))
      search.value = ''
      publisherFilter.value = ''
      generationFilter.value = ''
      renderClassificationFilters()
      renderPicker()
      dialog.showModal()
    })
  }
  for (const button of optionsButtons) button.addEventListener('click', () => openOptions(button))
  optionsForm.addEventListener('submit', saveOptions)
  optionsForm.addEventListener('invalid', event => {
    if (routingOptions.contains(event.target)) routingOptions.open = true
  }, true)
  optionsForm.addEventListener('input', () => { optionsError.hidden = true })
  get('cancel-model-options').addEventListener('click', () => closeOptions())
  get('reset-model-options').addEventListener('click', () => {
    for (const { field } of optionFields) {
      if (!field.matches(':disabled')) setOptionField(field)
    }
    optionsError.hidden = true
  })
  for (const filter of priceFilters) {
    filter.addEventListener('click', () => {
      freeOnly = filter.dataset.free === 'true'
      for (const button of priceFilters) button.setAttribute('aria-pressed', String(button === filter))
      renderPicker()
    })
  }
  search.addEventListener('input', renderPicker)
  publisherFilter.addEventListener('change', () => {
    renderGenerationFilter()
    renderPicker()
  })
  generationFilter.addEventListener('change', renderPicker)
  retry.addEventListener('click', () => {
    search.focus()
    loadCatalog(catalogFor(picker.key))
  })
  projectSelect.addEventListener('change', renderSettings)
  function saveGenerationLimit() {
    const project = selectedProject()
    if (!project) return
    const maxTokens = limit.valueAsNumber
    if (!validWritingTokenLimit(maxTokens)) {
      limit.value = project.maxTokens
      limitError.textContent = '1 이상의 정수를 입력해 주세요.'
      return
    }
    if (maxTokens === project.maxTokens) return
    try {
      saveProjectSetting(project.id, latest => { latest.maxTokens = maxTokens })
    } catch {
      renderSettings()
      limitError.textContent = '저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.'
    }
  }
  limit.addEventListener('input', () => { limitError.textContent = '' })
  limit.addEventListener('change', saveGenerationLimit)
  limit.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    saveGenerationLimit()
  })
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return
    loadWorkspace()
    if (dialog.open) renderPicker()
  })
  loadWorkspace()
  function refreshCatalogs() {
    for (const catalog of Object.values(catalogs)) loadCatalog(catalog)
  }
  refreshCatalogs()
  return () => {
    closeOptions(false)
    loadWorkspace('')
    showStatus('설정은 이 브라우저에 저장돼요.')
    refreshCatalogs()
    refreshUsage()
  }
}

function setupPopup(trigger) {
  const target = new URL(trigger.href)
  const popup = document.createElement('dialog')
  popup.className = 'settings-popup'
  popup.setAttribute('aria-labelledby', 'settings-popup-title')
  popup.innerHTML = `
    <header class="settings-popup-header">
      <h2 id="settings-popup-title">설정</h2>
      <form method="dialog"><button type="submit" class="close-button" aria-label="설정 닫기" autofocus>×</button></form>
    </header>
    <div class="settings-popup-body">
      <div class="settings-popup-status">
        <p role="status"></p>
        <button type="button" class="outline-button" hidden>다시 불러오기</button>
      </div>
    </div>
  `
  document.body.append(popup)

  const close = popup.querySelector('.close-button')
  const scrollport = popup.querySelector('.settings-popup-body')
  const feedback = scrollport.querySelector('.settings-popup-status')
  const status = feedback.querySelector('p')
  const retry = feedback.querySelector('button')
  let loading = false
  let refresh

  function scrollToSection() {
    if (!popup.open) return
    const section = target.hash && document.getElementById(target.hash.slice(1))
    scrollport.scrollTop = section
      ? scrollport.scrollTop + section.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
      : 0
  }

  async function load() {
    if (loading) return
    loading = true
    if (document.activeElement === retry) close.focus()
    status.textContent = '설정을 불러오는 중이에요.'
    retry.hidden = true
    let picker
    try {
      const response = await fetch(target)
      if (!response.ok) throw new Error('Settings request failed')
      const page = new DOMParser().parseFromString(await response.text(), 'text/html')
      const main = page.querySelector('.settings-main')
      picker = page.getElementById('model-dialog')
      if (!main || !picker) throw new Error('Settings page is incomplete')
      const content = document.createElement('div')
      content.className = main.className
      main.querySelector('h1')?.remove()
      content.append(...main.children)
      scrollport.replaceChildren(content)
      document.body.append(picker)
      refresh = setupSettings(content)
      scrollToSection()
    } catch {
      picker?.remove()
      scrollport.replaceChildren(feedback)
      status.textContent = '설정을 불러오지 못했어요.'
      retry.hidden = false
    } finally {
      loading = false
    }
  }

  trigger.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return
    event.preventDefault()
    if (popup.open) return
    popup.showModal()
    if (refresh) {
      refresh()
      scrollToSection()
    } else {
      load()
    }
  })
  retry.addEventListener('click', load)
}

const settingsPage = document.querySelector('.settings-main')
const settingsTrigger = document.querySelector('[data-open-settings]')
if (settingsPage) setupSettings(settingsPage)
if (settingsTrigger) setupPopup(settingsTrigger)
