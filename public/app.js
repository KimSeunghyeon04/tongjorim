import { chatModelKey, freeModel, pricing, requestCompletion, savedChatModel, settingsChangeEvent } from './completion.js'

const byId = id => document.getElementById(id)
const form = byId('chat-form')
const prompt = byId('prompt')
const send = byId('send')
const stop = byId('stop')
const newChat = byId('new-chat')
const reloadModels = byId('reload-models')
const messages = byId('messages')
const conversation = byId('conversation')
const retry = byId('retry-chat')
const chatStatus = byId('chat-status')

let selectedModel = freeModel
let catalog = [freeModel]
let catalogStatus = 'loading'
let keyConfigured
let activeRequest
let retryTurn
const history = []
const tokenFormat = new Intl.NumberFormat('ko-KR')

function updateModel() {
  const id = savedChatModel()
  selectedModel = catalog.find(model => model.id === id) ?? { id, name: id }
  byId('selected-name').textContent = selectedModel.name
  byId('selected-id').textContent = selectedModel.id
  byId('selected-price').textContent = selectedModel.id === 'openrouter/free'
    ? '사용 가능한 무료 모델을 자동으로 선택해요.'
    : pricing(selectedModel)
}

async function loadModels() {
  catalogStatus = 'loading'
  const connection = byId('connection')
  const label = byId('connection-text')
  connection.dataset.state = 'loading'
  label.textContent = '모델 목록 확인 중'
  reloadModels.hidden = true
  try {
    const response = await fetch('/api/models')
    if (!response.ok) throw new Error('Catalog request failed')
    const data = await response.json()
    catalog = data.models
    keyConfigured = data.keyConfigured
    catalogStatus = data.catalogAvailable ? 'online' : 'offline'
    updateModel()
  } catch {
    catalogStatus = 'offline'
  }

  connection.dataset.state = keyConfigured === false ? 'offline' : catalogStatus
  label.textContent = keyConfigured === false ? 'API 키 설정 필요'
    : catalogStatus === 'online' ? '모델 목록 연결됨' : '모델 목록 연결 실패'
  reloadModels.hidden = catalogStatus !== 'offline'
}

function showNotice(message = '', canRetry = false) {
  byId('notice-text').textContent = message
  byId('notice').hidden = !message
  retry.hidden = !canRetry
}

function syncControls() {
  send.hidden = Boolean(activeRequest)
  stop.hidden = !activeRequest
  send.disabled = !prompt.value.trim()
  newChat.disabled = messages.hidden || Boolean(activeRequest)
}

function appendMessage(name, kind, content) {
  const article = document.createElement('article')
  article.className = `message ${kind}`
  const header = document.createElement('div')
  header.className = 'message-heading'
  const icon = document.createElement('span')
  icon.className = 'message-icon'
  icon.textContent = kind === 'assistant' ? 'R' : '나'
  icon.setAttribute('aria-hidden', 'true')
  const title = document.createElement('h2')
  title.textContent = name
  header.append(icon, title)
  const body = document.createElement('div')
  body.className = 'message-body'
  body.textContent = content
  const meta = document.createElement('p')
  meta.className = 'message-meta'
  meta.hidden = true
  article.append(header, body, meta)
  messages.append(article)
  return { article, title, body, meta }
}

function scrollToEnd() {
  conversation.scrollTop = conversation.scrollHeight
}

function nearEnd() {
  return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120
}

async function runTurn(turn) {
  if (activeRequest) return
  updateModel()
  const model = selectedModel
  const controller = new AbortController()
  activeRequest = controller
  retryTurn = undefined
  showNotice()
  chatStatus.textContent = '답변을 요청했어요.'
  turn.answer.title.textContent = model.name
  turn.answer.body.textContent = '답변을 기다리는 중…'
  turn.answer.body.classList.add('waiting')
  turn.answer.meta.hidden = true
  syncControls()
  scrollToEnd()

  let reply = ''
  const text = document.createTextNode('')
  try {
    const context = [{ role: 'user', content: turn.message }]
    let remaining = 40_000 - turn.message.length
    for (let index = history.length - 2; index >= 0; index -= 2) {
      const question = history[index]
      const answer = history[index + 1]
      remaining -= question.content.length + answer.content.length
      if (remaining < 0 || answer.content.length > 16_000) break
      context.unshift(question, answer)
    }
    const done = await requestCompletion('/api/chat', { model: model.id, messages: context }, {
      signal: controller.signal,
      onText(content) {
        const follow = nearEnd()
        if (!reply) {
          turn.answer.body.classList.remove('waiting')
          turn.answer.body.replaceChildren(text)
        }
        reply += content
        text.appendData(content)
        if (follow) scrollToEnd()
      },
    })
    if (!reply.trim()) throw new Error('답변을 받지 못했어요. 다시 시도해 주세요.')

    history.push({ role: 'user', content: turn.message }, { role: 'assistant', content: reply })
    if (history.length > 38) history.splice(0, history.length - 38)
    const metadata = [
      done.model ?? model.id,
      done.tokens != null ? `총 ${tokenFormat.format(done.tokens)} 토큰` : '',
      done.truncated ? '출력 길이 제한에 도달했어요.' : '',
    ]
    const follow = nearEnd()
    turn.answer.meta.textContent = metadata.filter(Boolean).join('  ·  ')
    turn.answer.meta.hidden = false
    if (follow) scrollToEnd()
    chatStatus.textContent = '답변을 모두 받았어요.'
  } catch (error) {
    const stopped = controller.signal.aborted
    const message = stopped ? '답변 생성을 중지했어요.'
      : error instanceof TypeError ? '서버와 연결이 끊겼어요. 다시 시도해 주세요.'
      : error instanceof SyntaxError ? '서버 응답을 읽지 못했어요. 다시 시도해 주세요.'
      : error.message
    turn.answer.body.classList.remove('waiting')
    if (!reply.trim()) turn.answer.body.textContent = stopped ? '중지됨' : '답변을 받지 못했어요.'
    else {
      turn.answer.meta.textContent = stopped ? '중지됨' : '응답이 중단됐어요.'
      turn.answer.meta.hidden = false
    }
    retryTurn = turn
    showNotice(message, true)
  } finally {
    activeRequest = undefined
    syncControls()
  }
}

form.addEventListener('submit', event => {
  event.preventDefault()
  const message = prompt.value.trim()
  if (activeRequest || !message) return
  prompt.value = ''
  byId('empty-state').hidden = true
  messages.hidden = false
  appendMessage('나', 'user', message)
  const answer = appendMessage(selectedModel.name, 'assistant', '')
  runTurn({ message, answer })
  prompt.focus()
})

prompt.addEventListener('input', syncControls)
prompt.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!activeRequest && !send.disabled) form.requestSubmit()
})

document.querySelectorAll('[data-prompt]').forEach(button => {
  button.addEventListener('click', () => {
    prompt.value = button.dataset.prompt
    syncControls()
    prompt.focus()
  })
})

stop.addEventListener('click', () => {
  activeRequest?.abort()
  prompt.focus()
})

retry.addEventListener('click', () => {
  if (!retryTurn) return
  runTurn(retryTurn)
  prompt.focus()
})

newChat.addEventListener('click', () => {
  if (activeRequest) return
  history.length = 0
  retryTurn = undefined
  prompt.value = ''
  messages.replaceChildren()
  messages.hidden = true
  byId('empty-state').hidden = false
  showNotice()
  chatStatus.textContent = '새 대화를 시작했어요.'
  syncControls()
  prompt.focus()
})

window.addEventListener('storage', event => {
  if (event.key === chatModelKey || event.key === null) updateModel()
})
document.addEventListener(settingsChangeEvent, event => {
  if (event.detail === chatModelKey) updateModel()
})
updateModel()
reloadModels.addEventListener('click', loadModels)
loadModels()
