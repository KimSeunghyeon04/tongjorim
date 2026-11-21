import { formatCost } from './request-tools.mjs'
import { maxSourceLimits, sourceLimitsFor, validSourceLimit } from './writing-config.mjs'

const number = new Intl.NumberFormat('ko-KR')
const tokens = value => `${number.format(value)}토큰`
const characters = value => `${number.format(value)}자`
const fields = Object.keys(maxSourceLimits)

export function setupSourcePanel({ get, currentProject, getModel, research, saveWorkspace, onSave, onSearch, goToPassage, passagePosition }) {
  const panel = get('source-settings')
  const save = get('save-source-limits')
  const reset = get('reset-source-limits')
  const refresh = get('refresh-source-search')
  const inputs = fields.map(field => [field, get(`source-${field}`)])
  let project
  let activeSearch

  function message(text) {
    get('source-save-status').textContent = text
    get('source-save-status').hidden = !text
  }

  function resetInputs() {
    for (const [field, input] of inputs) input.value = sourceLimitsFor(project)[field]
  }

  function edits() {
    return Object.fromEntries(inputs.map(([field, input]) => [field, /^[0-9]+$/.test(input.value) ? Number(input.value) : NaN]))
  }

  function passage({ start, end, text }, target) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'quiet-button'
    button.textContent = passagePosition({ start, end })
    button.addEventListener('click', () => goToPassage({ start, end, text }))
    const excerpt = document.createElement('p')
    const sample = Array.from(text.trimStart().slice(0, 108))
    excerpt.textContent = `“${sample.slice(0, 54).join('').trimEnd()}${sample.length > 54 ? '…' : ''}”`
    target.append(button, excerpt)
  }

  function renderPassages({ body, cutoff, hits }) {
    const recent = get('source-recent-passage')
    const past = get('source-past-hits')
    const text = body.draft.manuscript ?? ''
    recent.replaceChildren()
    recent.hidden = !text
    if (text) passage({ start: cutoff, end: cutoff + text.length, text }, recent)
    past.replaceChildren(...hits.map(hit => {
      const item = document.createElement('li')
      passage(hit, item)
      return item
    }))
    past.hidden = hits.length === 0
  }

  function renderMetrics({ saved, draft }) {
    const { contextLength, originalBudget, remaining, reserve, usage, recentReduced, pastReduced, outputTooLarge } = draft
    get('source-budget').textContent = originalBudget === null ? '확인 불가' : tokens(Math.max(0, originalBudget))
    const remainingText = get('source-remaining')
    remainingText.textContent = remaining === null ? '확인 불가' : remaining < 0 ? `${tokens(-remaining)} 부족` : tokens(remaining)
    remainingText.dataset.warning = remaining !== null && remaining < 0
    const delta = usage.cost === null || saved.usage.cost === null ? null : usage.cost - saved.usage.cost
    const cost = get('source-cost')
    cost.textContent = formatCost(usage.cost)
    if (delta !== null && saved !== draft) {
      const amount = formatCost(Math.abs(delta))
      const difference = amount === formatCost(0) ? '변화 없음' : `${amount} ${delta > 0 ? '증가' : '감소'}`
      const change = document.createElement('div')
      change.className = 'field-hint'
      change.textContent = `저장 ${formatCost(saved.usage.cost)} 대비 ${difference}`
      cost.append(change)
    }
    const context = get('source-context-note')
    const notes = contextLength === null ? ['이 모델의 컨텍스트 한도를 확인할 수 없어요.'] : [
      `모델 한도 ${tokens(contextLength)}에서 출력 ${tokens(usage.outputTokens)}과 여유분 ${tokens(reserve)}을 예약했어요. 입력은 추정치예요.`,
    ]
    if (remaining !== null && remaining < 0) notes.push('프롬프트나 메모 분량, 또는 출력 한도를 줄여 주세요.')
    else if (recentReduced || pastReduced) notes.push('컨텍스트에 맞춰 원문을 줄였어요.')
    if (outputTooLarge) notes.push('선택한 출력 한도가 제공업체의 최대 출력보다 높아요.')
    context.textContent = notes.join(' ')
  }

  function render() {
    if (project !== currentProject()) {
      activeSearch?.abort()
      activeSearch = undefined
      project = currentProject()
      resetInputs()
      message('')
    }
    if (!panel.open) return
    const limits = edits()
    const saved = sourceLimitsFor(project)
    const valid = fields.every(field => validSourceLimit(field, limits[field]))
    const dirty = fields.some(field => limits[field] !== saved[field])
    const comparison = research.inspect(project, getModel(project.model), valid && dirty ? limits : undefined)
    const { draft, semanticPending, semanticFailed } = comparison
    save.disabled = !dirty || !valid
    reset.hidden = !dirty
    get('source-metrics').hidden = !valid
    get('source-context-note').hidden = !valid
    for (const [field, input] of inputs) {
      const savedValue = get(`source-saved-${field}`)
      const label = `저장값 ${characters(saved[field])}`
      if (savedValue.textContent !== label) savedValue.textContent = label
      const invalid = !validSourceLimit(field, limits[field])
      const enabled = draft.body.references.includes(field)
      const length = draft.body.draft[field]?.length ?? 0
      input.setAttribute('aria-invalid', String(invalid))
      const status = get(`source-${field}-status`)
      status.dataset.warning = invalid
      status.textContent = invalid ? `0~${characters(maxSourceLimits[field])} 사이로 입력해 주세요.` :
        !enabled ? '참고 자료에서 꺼져 있어요.' : !valid ? '' :
          field === 'pastPassages' ? `${draft.hits.length}건 · 전송 ${characters(length)}` : `전송 ${characters(length)}`
    }
    renderPassages(valid ? draft : { body: { draft: {} }, hits: [] })
    if (valid) renderMetrics(comparison)
    const search = get('source-search-status')
    search.textContent = activeSearch ? '의미 검색 결과를 가져오는 중이에요.' : semanticFailed
      ? '의미 검색에 실패했어요. 키워드 검색 결과를 표시해요.' : semanticPending
        ? '키워드 검색 기준이에요. 의미 검색을 반영하면 원문 범위와 비용이 바뀔 수 있어요.' : ''
    search.hidden = !valid || !search.textContent
    refresh.hidden = !valid || !(semanticPending || semanticFailed || activeSearch)
    refresh.disabled = Boolean(activeSearch)
    return comparison
  }

  for (const [, input] of inputs) {
    input.addEventListener('input', () => {
      message('')
      render()
    })
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        if (!save.disabled) save.click()
      }
    })
  }
  panel.addEventListener('toggle', onSearch)
  reset.addEventListener('click', () => {
    resetInputs()
    message('')
    render()
    inputs[0][1].focus()
  })
  save.addEventListener('click', () => {
    const previous = project.sourceLimits
    project.sourceLimits = edits()
    if (saveWorkspace()) {
      resetInputs()
      onSave()
      message('이 작품의 분량을 저장했어요.')
      panel.querySelector('summary').focus()
      return
    }
    if (previous) project.sourceLimits = previous
    else delete project.sourceLimits
    render()
    message('분량을 저장하지 못했어요. 작업 공간 저장 상태를 확인해 주세요.')
  })
  refresh.addEventListener('click', async () => {
    const controller = new AbortController()
    activeSearch = controller
    render()
    try {
      await research.refreshSearch(project, getModel(project.model), edits(), controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) message(error.message)
    } finally {
      if (activeSearch === controller) {
        activeSearch = undefined
        onSearch()
      }
    }
  })
  return { render }
}
