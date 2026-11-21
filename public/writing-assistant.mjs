import { requestCompletion } from './completion.js'
import { withModelOptions } from './model-options.mjs'
import { loreCardFields, validLoreCardFields } from './project-files.mjs'
import {
  assistantHistoryTurns, assistantMessageLimit, assistantNoteDraftLimit, assistantReplyLimit,
  noteKinds, referenceLabels, writingFieldPrefix, writingFields,
} from './writing-config.mjs'

export { assistantMessageLimit, assistantNoteDraftLimit }

const formatCount = new Intl.NumberFormat('ko-KR')

export function projectNotesLimitHint(project) {
  const limited = Object.keys(noteKinds).flatMap(field => {
    const text = project[field] ?? ''
    if (text.length <= writingFields[field]) return []
    const sent = writingFieldPrefix(field, text).length
    return [referenceLabels[field] + ' ' + formatCount.format(text.length) + '자 중 ' +
      formatCount.format(sent) + '자']
  })
  return limited.length ? 'AI에 보내는 분량이 제한돼요. ' + limited.join(', ') + '만 전송해요.' : ''
}

function parseReply(text, kind, truncated) {
  const invalid = truncated ? '출력 한도에 도달했어요. 더 짧게 요청하거나 설정에서 생성 한도를 올려 주세요.'
    : '답변 형식이 맞지 않아요. 다시 보내거나 설정에서 다른 모델을 선택해 주세요.'
  const source = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
  let response
  try {
    response = JSON.parse(source)
  } catch {
    throw new Error(invalid)
  }

  const { reply, draft } = response ?? {}
  const validDraft = draft === null || (kind === 'note'
    ? typeof draft === 'string' && draft.length <= assistantNoteDraftLimit && Boolean(draft.trim())
    : validLoreCardFields(draft) && draft.aliases.every(alias => !/[,\r\n]/.test(alias)))
  if (typeof reply !== 'string' || !reply.trim() || reply.length > assistantReplyLimit || !validDraft) {
    throw new Error(invalid)
  }
  return { reply: reply.trim(), draft: kind === 'lore' && draft ? loreCardFields(draft) : draft }
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

  async function send(request, message, project) {
    if (active || !message.trim() || message.length > assistantMessageLimit) return false
    const controller = new AbortController()
    const { history } = conversation
    const user = { role: 'user', content: message.trim() }
    const pending = addMessage('user', user.content)
    revealMessage(pending)
    const turn = { controller, pending }
    active = turn
    status.textContent = 'AI가 답변을 작성하고 있어요.'
    onChange()

    try {
      let text = ''
      const body = withModelOptions(project, { ...request, messages: [...history, user] })
      const result = await requestCompletion('/api/assistant', body, {
        signal: controller.signal,
        onText(content) { text += content },
      })
      if (active !== turn) return false

      const response = parseReply(text, request.kind, result.truncated)
      history.push(user, { role: 'assistant', content: response.reply })
      if (history.length > assistantHistoryTurns * 2) history.splice(0, 2)
      const answer = addMessage('assistant', response.reply)
      status.textContent = result.truncated ? '출력 한도에 도달했어요. 답변을 확인해 주세요.' : ''
      onReply(response)
      revealMessage(answer)
      return true
    } catch (error) {
      if (active === turn) {
        pending.remove()
        transcript.hidden = !transcript.childElementCount
        status.textContent = controller.signal.aborted ? '답변을 중지했어요.' : error.message
      }
      return false
    } finally {
      if (active === turn) {
        active = undefined
        onChange()
      }
    }
  }

  function cancelPending() {
    if (!active) return
    active.controller.abort()
    active.pending.remove()
    active = undefined
    status.textContent = '답변을 중지했어요.'
  }

  return {
    send,
    rememberScroll,
    restoreScroll,
    get busy() { return Boolean(active) },
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
      conversation.scrollTop = 0
      conversation.scrollTarget = undefined
      transcript.replaceChildren()
      transcript.hidden = true
      status.textContent = ''
      onChange()
    },
  }
}
