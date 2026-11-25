import assert from 'node:assert/strict'
import test from 'node:test'
import { createWritingAssistant, requestAssistantReply } from '../public/writing-assistant.mjs'

const card = { kind: 'place', name: '안개역', aliases: ['안개 정거장'], description: '밤에만 열리는 역.', priority: -3, always: false }

function completion(text, truncated = false, omittedGenerationOptions) {
  const halfway = Math.floor(text.length / 2)
  const events = [
    { type: 'text', content: text.slice(0, halfway) },
    { type: 'text', content: text.slice(halfway) },
    { type: 'done', truncated, omittedGenerationOptions },
  ]
  return new Response(events.map(event => `${JSON.stringify(event)}\n`).join(''))
}

test('형식에 맞는 대화 답변은 재요청 없이 그대로 받는다', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion(' {"reply":"  안개역이 어울려요.  ","draft":null}\n'))
  const result = await requestAssistantReply({ kind: 'lore' }, {
    signal: new AbortController().signal,
    onRetry() { assert.fail('정상 답변을 다시 요청했어요.') },
  })
  assert.deepEqual(result, { reply: '안개역이 어울려요.', draft: null, truncated: false })
  assert.equal(fetch.mock.callCount(), 1)
})

test('로어북과 메모는 원래 요청과 잘못된 답변을 함께 보내 한 번 바로잡는다', async t => {
  const fenced = '```json\n{"reply":"정리했어요.","draft":null}\n```'
  for (const [name, kind, invalid, draft] of [
    ['마크다운 응답', 'lore', '## 추천\n안개역이 어울려요.', card],
    ['코드 블록 밖에 설명이 붙은 응답', 'note', '답변입니다.\n' + fenced, null],
    ['JSON 코드 블록이 두 개인 응답', 'note', fenced + '\n' + fenced, null],
    ['객체로 온 메모 초안', 'note', '{"reply":"정리했어요.","draft":{"text":"안개역은 밤에만 열려요."}}', '안개역은 밤에만 열려요.'],
    ['범위를 벗어난 우선순위', 'lore', JSON.stringify({ reply: '정리했어요.', draft: { ...card, priority: 101 } }), card],
    ['카드의 불필요한 필드', 'lore', JSON.stringify({ reply: '정리했어요.', draft: { ...card, id: 'extra' } }), card],
    ['응답의 불필요한 필드', 'note', '{"reply":"정리했어요.","draft":null,"extra":true}', null],
  ]) {
    await t.test(name, async t => {
      const body = { kind, model: 'qa/plan', mode: 'draft', messages: [{ role: 'user', content: '기존 설정으로 초안을 써 줘.' }] }
      const signal = new AbortController().signal
      let attempts = 0
      const fetch = t.mock.method(globalThis, 'fetch', async (path, options) => {
        assert.equal(path, '/api/assistant')
        assert.equal(options.signal, signal)
        return attempts++ === 0 ? completion(invalid) : completion(JSON.stringify({ reply: '정리했어요.', draft }))
      })
      const retries = t.mock.fn()
      assert.deepEqual(await requestAssistantReply(body, { signal, projectId: 'project-1', onRetry: retries }),
        { reply: '정리했어요.', draft, truncated: false })
      assert.equal(retries.mock.callCount(), 1)
      assert.deepEqual(fetch.mock.calls.map(call => JSON.parse(call.arguments[1].body)), [
        { ...body, projectId: 'project-1' },
        { ...body, projectId: 'project-1', previousReply: invalid },
      ])
    })
  }
})

test('두 응답 모두 형식이 잘못되면 추가 요청 없이 오류를 반환한다', async t => {
  for (const [truncated, message] of [[false, '답변 형식을 고치지 못했어요'], [true, '출력 한도에 도달했어요']]) {
    await t.test(message, async t => {
      const fetch = t.mock.method(globalThis, 'fetch', async () => completion('{"reply":', truncated))
      await assert.rejects(requestAssistantReply({ kind: 'note' }, {
        signal: new AbortController().signal, onRetry() {},
      }), new RegExp(message))
      assert.equal(fetch.mock.callCount(), 2)
    })
  }
})

test('모델 요청 오류에는 형식 교정을 요청하지 않는다', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '요청 한도 초과' }, { status: 429 }))
  await assert.rejects(requestAssistantReply({ kind: 'lore' }, {
    signal: new AbortController().signal,
    onRetry() { assert.fail('모델 요청 오류에 재시도했어요.') },
  }), /요청 한도 초과/)
  assert.equal(fetch.mock.callCount(), 1)
})

test('교정 중 중지하면 완료된 답변이 와도 사용하지 않는다', async t => {
  const controller = new AbortController()
  let attempts = 0
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (attempts++ === 0) return completion('일반 텍스트')
    controller.abort()
    return completion('{"reply":"정리했어요.","draft":null}')
  })
  await assert.rejects(requestAssistantReply({ kind: 'note' }, {
    signal: controller.signal, onRetry() {},
  }), { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 2)
})

test('도우미별 출력 한도 안내와 생성 옵션 생략 안내를 함께 표시한다', async t => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  globalThis.document = { createElement: () => ({ dataset: {}, append() {} }) }
  t.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else delete globalThis.document
  })
  t.mock.method(globalThis, 'fetch', async () => completion('{"reply":"정리했어요.","draft":"수정안"}', true, ['stop']))
  const status = { textContent: '' }
  const assistant = createWritingAssistant({
    transcript: { setAttribute() {}, append() {} },
    status,
    onChange() {},
    onReply({ truncated }) {
      assert.equal(truncated, true)
      status.textContent = '수정안이 출력 한도에 걸렸어요.'
    },
  })
  assert.equal(await assistant.send({ kind: 'note', model: 'qa/plan' }, '기존 메모를 수정해 줘.', { id: 'project-1' }), true)
  assert.equal(status.textContent, '수정안이 출력 한도에 걸렸어요. 이번 답변에는 생성 중단 문자열 옵션을 적용하지 않았어요.')
})

test('다시 보내기는 원래 요청을 보내고 마지막 답변만 교체한다', async t => {
  function node() {
    return {
      dataset: {}, children: [],
      get childElementCount() { return this.children.length },
      get textContent() { return this.text ?? this.children.map(child => child.textContent ?? child).join('') },
      set textContent(value) { this.text = value },
      setAttribute() {},
      append(...children) {
        this.children.push(...children)
        for (const child of children) if (typeof child !== 'string') child.parent = this
      },
      remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1) },
      replaceChildren(...children) {
        this.children.length = 0
        this.append(...children)
      },
    }
  }
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  globalThis.document = { createElement: node }
  t.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else delete globalThis.document
  })
  const replies = ['항구 설정을 확인했어요.', '잘못된 출력입니다', null, '항구 뒤에 고층 건물을 두면 어울려요.',
    '다음 설정을 확인했어요.', ' … ', '...', '전망대에서 바다를 보여 주세요.']
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    const reply = replies[requests.length]
    requests.push(JSON.parse(options.body))
    return reply === null ? Response.json({ error: '연결이 끊겼어요.' }, { status: 502 })
      : completion(JSON.stringify({ reply, draft: null }))
  })
  const transcript = node()
  const status = node()
  const assistant = createWritingAssistant({ transcript, status, onChange() {}, onReply() {} })
  const portCard = {}
  assistant.useConversation(portCard)
  const request = { kind: 'lore', mode: 'chat', model: 'qa/plan', card }
  const project = { id: 'project-1' }
  const chat = () => transcript.children.map(row => row.children[1].textContent)

  assert.equal(assistant.canRetry, false)
  await assistant.send(request, '항구 설정을 확인해 줘.', project)
  await assistant.send(request, '고층 건물도 넣을까?', project)
  assert.equal(assistant.canRetry, true)
  const pending = assistant.retry()
  assert.equal(assistant.canRetry, false)
  assert.equal(await assistant.retry(), undefined)
  assert.equal(await pending, undefined)
  assert.equal(status.textContent, '연결이 끊겼어요.')
  assert.equal(chat().at(-1), '잘못된 출력입니다')

  assistant.useConversation({})
  assert.equal(assistant.canRetry, false)
  assistant.useConversation(portCard)
  assert.equal(await assistant.retry(), '고층 건물도 넣을까?')
  assert.deepEqual(requests.slice(2, 4), [requests[1], requests[1]])
  assert.deepEqual(chat(), ['항구 설정을 확인해 줘.', '항구 설정을 확인했어요.', '고층 건물도 넣을까?', '항구 뒤에 고층 건물을 두면 어울려요.'])

  await assistant.send(request, '전망대는 어디가 좋을까?', project)
  assert.deepEqual(requests[4].messages.map(message => message.content), [
    '항구 설정을 확인해 줘.', '항구 설정을 확인했어요.', '고층 건물도 넣을까?', '항구 뒤에 고층 건물을 두면 어울려요.', '전망대는 어디가 좋을까?',
  ])
  assistant.reset()
  assert.equal(assistant.canRetry, false)
  assert.equal(await assistant.retry(), undefined)
  assert.equal(requests.length, 5)

  const firstMessage = '이 장면에서 전망대를 어떻게 묘사하면 좋을까?'
  const sceneRequest = { kind: 'scene', mode: 'chat', model: 'qa/plan', scene: { version: 2, text: '전망대에 올라갔다.' } }
  assert.equal(await assistant.send(sceneRequest, firstMessage, project), false)
  assert.equal(requests.length, 7)
  assert.deepEqual(requests[6], { ...requests[5], retryEllipsis: true })
  assert.match(status.textContent, /모델이 답변 내용을 보내지 않았어요/)
  assert.deepEqual(chat(), [])
  assert.deepEqual(assistant.history, [])
  assert.equal(assistant.canRetry, true)
  assert.equal(await assistant.retry(), firstMessage)
  assert.deepEqual(requests[7], requests[5])
  assert.deepEqual(requests[7].messages, [{ role: 'user', content: firstMessage }])
  assert.deepEqual(chat(), [firstMessage, '전망대에서 바다를 보여 주세요.'])
})
