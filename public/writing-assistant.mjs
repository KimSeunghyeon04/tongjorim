import { parseCompletionJson, requestCompletion } from './completion.js'
import { generationOptionLabels, withModelOptions, withoutGenerationOptions } from './model-options.mjs'
import { loreCardFields, validLoreCardFields } from './project-files.mjs'
import { memoryForPrompt } from './manuscript-memory.mjs'
import { activeLore } from './retrieval.mjs'
import {
  assistantAllowsDraft, assistantHistoryTurns, assistantMessageLimit, assistantNoteDraftLimit, assistantRepairTextLimit, assistantReplyLimit,
  projectNotesForRequest, writingFieldPrefix, writingFields,
} from './writing-config.mjs'

export { assistantMessageLimit, assistantNoteDraftLimit }

const formatCount = new Intl.NumberFormat('ko-KR')

export function projectNotesLimitHint(project) {
  if (project.synopsis.length <= writingFields.synopsis) return ''
  const sent = writingFieldPrefix('synopsis', project.synopsis).length
  return `도우미에는 줄거리 ${formatCount.format(project.synopsis.length)}자 중 ${formatCount.format(sent)}자만 보내요.`
}

export function assistantProjectContext(project, message, sceneText) {
  const revision = sceneText === undefined ? undefined : { text: sceneText, direction: '' }
  const lore = activeLore(project.lorebook ?? [], project.manuscript, message, [], revision)
  return {
    ...projectNotesForRequest(project),
    lorebook: writingFieldPrefix('lorebook', lore.text),
    manuscriptMemory: memoryForPrompt(project),
  }
}

function parseReply(text, { kind, mode }) {
  let response
  try {
    response = parseCompletionJson(text)
  } catch {
    return null
  }

  const { reply, draft } = response ?? {}
  if (typeof reply !== 'string' || !reply.trim() || reply.length > assistantReplyLimit ||
      Object.keys(response).length !== 2 || !Object.hasOwn(response, 'draft')) {
    return null
  }
  if (draft === null || !assistantAllowsDraft(kind, mode)) return { reply: reply.trim(), draft: null }
  if (kind === 'note') {
    return typeof draft === 'string' && draft.length <= assistantNoteDraftLimit && draft.trim()
      ? { reply: reply.trim(), draft } : null
  }
  if (!validLoreCardFields(draft) || draft.aliases.some(alias => /[,\r\n]/.test(alias))) return null
  const card = loreCardFields(draft)
  return Object.keys(card).length === Object.keys(draft).length ? { reply: reply.trim(), draft: card } : null
}

export async function requestAssistantReply(body, { signal, projectId, onRetry }) {
  async function complete(payload) {
    let text = ''
    const { truncated, omittedGenerationOptions } = await requestCompletion('/api/assistant', payload, {
      signal, projectId,
      onText(content) { text += content },
    })
    signal.throwIfAborted()
    const omitted = Array.isArray(omittedGenerationOptions)
      ? omittedGenerationOptions.filter(name => typeof name === 'string' && Object.hasOwn(generationOptionLabels, name)) : []
    const response = parseReply(text, body)
    const ellipsisOnly = /^(?:\.{3,}|\.*…[.…]*)$/u.test((response?.reply ?? text).replace(/\s/g, ''))
    return { text, truncated, omitted, response, ellipsisOnly }
  }

  let result = await complete(body)
  let omitted = result.omitted
  if (result.ellipsisOnly || !result.response) {
    const retry = { ...body }
    if (result.ellipsisOnly) {
      onRetry('ellipsis')
      retry.retryEllipsis = true
    } else {
      onRetry()
      retry.previousReply = result.text.trim().slice(0, assistantRepairTextLimit).toWellFormed()
    }
    if (omitted.length) retry.modelOptions = withoutGenerationOptions(body.modelOptions ?? {}, omitted)
    result = await complete(retry)
    omitted = [...new Set([...omitted, ...result.omitted])]
  }
  if (result.ellipsisOnly) throw new Error('모델이 답변 내용을 보내지 않았어요. 다시 보내거나 설정에서 다른 모델을 선택해 주세요.')
  if (!result.response) {
    throw new Error(result.truncated ? '출력 한도에 도달했어요. 더 짧게 요청하거나 설정에서 생성 한도를 올려 주세요.'
      : '답변 형식을 고치지 못했어요. 다시 보내거나 설정에서 다른 모델을 선택해 주세요.')
  }
  return { ...result.response, truncated: result.truncated, ...(omitted.length ? { omittedGenerationOptions: omitted } : {}) }
}

function appendEmphasis(parent, text) {
  let start = 0
  for (const match of text.matchAll(/(\*\*|__)(?=\S)(.+?)\1/g)) {
    const emphasis = document.createElement('strong')
    emphasis.textContent = match[2]
    parent.append(text.slice(start, match.index), emphasis)
    start = match.index + match[0].length
  }
  parent.append(text.slice(start))
}

function renderAssistantText(body, text) {
  let paragraph
  let list
  for (const line of text.split(/\r\n?|\n/)) {
    const heading = /^ {0,3}#{1,6}\s+(.+)$/.exec(line)
    const item = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(line)
    if (heading) {
      const title = document.createElement('p')
      title.className = 'assistant-reply-heading'
      appendEmphasis(title, heading[1])
      body.append(title)
    } else if (item) {
      const number = Number.parseInt(item[1], 10)
      const tag = Number.isNaN(number) ? 'UL' : 'OL'
      if (list?.tagName !== tag) {
        list = document.createElement(tag.toLowerCase())
        if (tag === 'OL') list.start = number
        body.append(list)
      }
      const row = document.createElement('li')
      appendEmphasis(row, item[2])
      list.append(row)
      paragraph = undefined
      continue
    } else if (line.trim()) {
      if (paragraph) paragraph.append('\n')
      else {
        paragraph = document.createElement('p')
        body.append(paragraph)
      }
      appendEmphasis(paragraph, line)
      list = undefined
      continue
    }
    paragraph = undefined
    list = undefined
  }
}

export function createWritingAssistant({ transcript, scrollport = transcript, status, onChange, onReply }) {
  const conversations = new WeakMap()
  let conversation = { history: [] }
  let conversationKey
  let active

  scrollport.tabIndex = 0
  transcript.setAttribute('aria-live', 'polite')

  function rememberScroll() {
    if (scrollport.clientHeight) conversation.scrollTop = scrollport.scrollTop
  }

  function revealMessage(message) {
    if (!scrollport.clientHeight) {
      conversation.scrollTarget = message
      return
    }
    scrollport.scrollTop += message.getBoundingClientRect().top - scrollport.getBoundingClientRect().top - scrollport.clientTop
    conversation.scrollTarget = undefined
  }

  function restoreScroll() {
    if (!scrollport.clientHeight) return
    if (conversation.scrollTarget && transcript.contains(conversation.scrollTarget)) revealMessage(conversation.scrollTarget)
    else scrollport.scrollTop = conversation.scrollTop ?? 0
  }

  function addMessage(role, content) {
    const message = document.createElement('li')
    message.className = 'assistant-message'
    message.dataset.role = role
    const label = document.createElement('strong')
    label.textContent = role === 'user' ? '나' : 'AI'
    const body = document.createElement('div')
    body.className = 'assistant-message-body'
    if (role === 'assistant') renderAssistantText(body, content)
    else body.textContent = content
    message.append(label, body)
    transcript.append(message)
    transcript.hidden = false
    return message
  }

  async function runTurn(turn, activity) {
    const { body, projectId, request } = turn
    const controller = new AbortController()
    const pending = turn.answer ? undefined : addMessage('user', body.messages.at(-1).content)
    if (pending) revealMessage(pending)
    const attempt = { controller, pending }
    active = attempt
    status.textContent = activity
    onChange()

    try {
      const response = await requestAssistantReply(body, {
        signal: controller.signal, projectId,
        onRetry(reason) {
          status.textContent = reason === 'ellipsis' ? 'AI가 답변을 다시 작성하고 있어요.' : '답변 형식을 고치는 중이에요.'
        },
      })
      if (active !== attempt) return false

      conversation.history = [...body.messages, { role: 'assistant', content: response.reply }].slice(-assistantHistoryTurns * 2)
      turn.answer?.remove()
      const answer = addMessage('assistant', response.reply)
      turn.answer = answer
      status.textContent = response.truncated ? '출력 한도에 도달했어요. 답변을 확인해 주세요.' : ''
      onReply?.(response, request)
      const omitted = response.omittedGenerationOptions?.map(name => generationOptionLabels[name]).join(', ')
      if (omitted) status.textContent = [status.textContent, `이번 답변에는 ${omitted} 옵션을 적용하지 않았어요.`].filter(Boolean).join(' ')
      revealMessage(answer)
      return true
    } catch (error) {
      if (active === attempt) {
        pending?.remove()
        transcript.hidden = !transcript.childElementCount
        status.textContent = controller.signal.aborted ? '답변을 중지했어요.' : error.message
      }
      return false
    } finally {
      if (active === attempt) {
        active = undefined
        onChange()
      }
    }
  }

  function cancelPending() {
    if (!active) return
    active.controller.abort()
    active.pending?.remove()
    active = undefined
    status.textContent = '답변을 중지했어요.'
  }

  return {
    async send(request, message, project) {
      if (active || !message.trim() || message.length > assistantMessageLimit) return false
      const user = { role: 'user', content: message.trim() }
      const body = withModelOptions(project, { ...request, messages: [...conversation.history, user] })
      const turn = { body, projectId: project.id, request }
      conversation.lastTurn = turn
      return runTurn(turn, 'AI가 답변을 작성하고 있어요.')
    },
    async retry() {
      const turn = conversation.lastTurn
      if (active || !turn) return
      if (await runTurn(turn, 'AI가 답변을 다시 작성하고 있어요.')) return turn.body.messages.at(-1).content
    },
    rememberScroll,
    restoreScroll,
    get history() { return conversation.history.slice() },
    get busy() { return Boolean(active) },
    get canRetry() { return !active && Boolean(conversation.lastTurn) },
    stop() { active?.controller.abort() },
    useConversation(key) {
      if (key === conversationKey) return
      cancelPending()
      if (conversationKey) {
        conversation.messages = [...transcript.children]
        rememberScroll()
        conversation.status = status.textContent
      }
      if (!conversations.has(key)) conversations.set(key, { history: [] })
      conversationKey = key
      conversation = conversations.get(key)
      transcript.replaceChildren(...(conversation.messages ?? []))
      conversation.messages = undefined
      transcript.hidden = !transcript.childElementCount
      restoreScroll()
      status.textContent = conversation.status ?? ''
      onChange()
    },
    reset() {
      cancelPending()
      conversation.history.length = 0
      conversation.lastTurn = undefined
      conversation.scrollTop = 0
      conversation.scrollTarget = undefined
      transcript.replaceChildren()
      transcript.hidden = true
      status.textContent = ''
      onChange()
    },
  }
}
