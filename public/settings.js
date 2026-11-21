import { chatModelKey, freeModel, pricing, savedChatModel, settingsChangeEvent } from './completion.js'
import { jsonRequest } from './request-tools.mjs'
import { searchFor } from './retrieval.mjs'
import { currentProjectOf, projectName, readWorkspace, storageKey } from './writing-workspace.mjs'
import { optionalProjectModels, validModelId, writingTokenLimits } from './writing-config.mjs'

const get = id => document.getElementById(id)
const notifyChange = key => document.dispatchEvent(new CustomEvent(settingsChangeEvent, { detail: key }))

function setupSettings(root) {
  const projectSelect = get('settings-project')
  const limit = get('generation-limit')
  const dialog = get('model-dialog')
  const search = get('model-search')
  const modelList = get('model-list')
  const retry = get('retry-catalog')
  const modelButtons = [...root.querySelectorAll('[data-model]')]
  const priceFilters = [...dialog.querySelectorAll('[data-free]')]
  const catalogs = {
    text: { path: '/api/models', models: [freeModel] },
    embedding: { path: '/api/embeddings/models', models: [] },
  }
  let workspace
  let serializedWorkspace
  let picker
  let freeOnly = false

  const catalogFor = key => catalogs[key === 'embedding' ? 'embedding' : 'text']
  const selectedProject = () => workspace?.projects.find(project => project.id === projectSelect.value)
  const modelName = (catalog, id) => catalog.models.find(model => model.id === id)?.name ?? id

  function selectedModel(key, project) {
    if (key === 'chat') return savedChatModel()
    if (key === 'embedding') return project ? searchFor(project).model : ''
    return project?.[key] ?? ''
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
    for (const button of modelButtons) {
      const key = button.dataset.model
      const id = selectedModel(key, project)
      const catalog = catalogFor(key)
      const name = modelName(catalog, id)
      const inherited = project && optionalProjectModels.includes(key) && !id
      button.querySelector('strong').textContent = inherited ? '이어쓰기 모델 사용' : name || '선택할 수 없어요'
      button.querySelector('.model-label > span').textContent = inherited ? modelName(catalog, project.model) : name === id ? '' : id
      button.disabled = key !== 'chat' && !project
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
      if (key === 'chat') {
        localStorage.setItem(chatModelKey, id)
        renderSettings()
        showStatus('채팅 모델을 저장했어요.')
        notifyChange(chatModelKey)
      } else {
        saveProjectSetting(projectId, project => {
          if (key === 'embedding') project.search = { ...searchFor(project), model: id }
          else if (id) project[key] = id
          else delete project[key]
        })
      }
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

  function renderPicker() {
    const { key, projectId } = picker
    const catalog = catalogFor(key)
    const project = workspace?.projects.find(item => item.id === projectId)
    const selected = selectedModel(key, project)
    const query = search.value.trim().toLowerCase()
    const models = catalog.models.filter(model => (!freeOnly || model.free) &&
      `${model.name} ${model.id}`.toLowerCase().includes(query))
    const fallback = { id: '', name: '이어쓰기 모델 사용' }
    if (optionalProjectModels.includes(key) && fallback.name.includes(query)) models.unshift(fallback)

    get('model-list-status').textContent = catalog.loading ? '모델 목록을 불러오는 중이에요.'
      : catalog.error || (!models.length ? '일치하는 모델이 없어요.'
        : selected && !catalog.models.some(model => model.id === selected) ? '현재 모델이 목록에 없어요. 다른 모델을 선택할 수 있어요.' : '')
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
      catalog.models = data.models.filter(model => validModelId(model?.id))
      if (data.catalogAvailable === false) catalog.error = '최신 모델 목록을 불러오지 못했어요.'
    } catch (error) {
      catalog.error = error instanceof TypeError ? '모델 목록에 연결할 수 없어요.' : error.message
    } finally {
      catalog.loading = false
      renderSettings()
      if (dialog.open && catalogFor(picker.key) === catalog) renderPicker()
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
      renderPicker()
      dialog.showModal()
    })
  }
  for (const filter of priceFilters) {
    filter.addEventListener('click', () => {
      freeOnly = filter.dataset.free === 'true'
      for (const button of priceFilters) button.setAttribute('aria-pressed', String(button === filter))
      renderPicker()
    })
  }
  search.addEventListener('input', renderPicker)
  retry.addEventListener('click', () => {
    search.focus()
    loadCatalog(catalogFor(picker.key))
  })
  projectSelect.addEventListener('change', renderSettings)
  limit.replaceChildren(...writingTokenLimits.map(value => new Option(`${value.toLocaleString('ko-KR')} 토큰`, value)))
  limit.addEventListener('change', () => {
    const maxTokens = Number(limit.value)
    try {
      saveProjectSetting(projectSelect.value, project => { project.maxTokens = maxTokens })
    } catch {
      renderSettings()
      showStatus('생성 한도를 저장하지 못했어요. 작품이나 브라우저 저장 공간을 확인해 주세요.', true)
    }
  })
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) loadWorkspace()
    else if (event.key === chatModelKey) renderSettings()
    else return
    if (dialog.open) renderPicker()
  })
  loadWorkspace()
  function refreshCatalogs() {
    for (const catalog of Object.values(catalogs)) loadCatalog(catalog)
  }
  refreshCatalogs()
  return () => {
    loadWorkspace('')
    showStatus('변경 사항은 이 브라우저에 자동으로 저장돼요.')
    refreshCatalogs()
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
