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
  for (const [name, kind, invalid, draft] of [
    ['마크다운 응답', 'lore', '## 추천\n안개역이 어울려요.', card],
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
