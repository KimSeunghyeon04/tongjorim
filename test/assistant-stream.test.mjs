import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { requestCompletion } from '../public/completion.js'
import { memoryRequest, updateManuscriptMemory } from '../public/manuscript-memory.mjs'
import { requestAssistantReply } from '../public/writing-assistant.mjs'
import { readWorkspace } from '../public/writing-workspace.mjs'
import { createTongjorimServer } from '../server-app.mjs'
import { openTongjorimStore } from '../tongjorim-store.mjs'

const host = '127.0.0.1:4173'
const origin = `http://${host}`
const apiKey = 'assistant-test-key'
const model = 'google/gemini-4-hydrogen'
const card = { kind: 'place', name: '안개역', aliases: ['안개 정거장'], description: '밤에만 열려요.', priority: -3, always: false }
const savedProvider = {
  only: ['google-ai-studio'], order: ['google-ai-studio'], allow_fallbacks: false,
  zdr: true, data_collection: 'deny', max_price: { prompt: 2, completion: 8 }, require_parameters: false,
}
const routedProvider = { ...savedProvider, require_parameters: true }
const profile = { provider: savedProvider, temperature: 0, stop: ['끝.'] }
const writerRequest = '안개역을 배경으로 초안을 써 줘.'
const invalid = '## 추천\n안개역을 배경으로 써 보세요.'

async function startApp(t, responses) {
  const calls = []
  const exchanges = []
  const store = openTongjorimStore(':memory:')
  const server = createTongjorimServer({
    apiKey, port: 4173,
    store: { ...store, recordModelRequest(id, exchange) {
      store.recordModelRequest(id, exchange)
      exchanges.push(exchange)
    } },
    async upstreamFetch(url, options) {
      const call = { url, ...options, body: JSON.parse(options.body) }
      calls.push(call)
      const response = responses[calls.length - 1]
      assert.ok(response, `Unexpected OpenRouter request ${calls.length}`)
      return typeof response === 'function' ? response(call) : response
    },
  })
  const dir = process.platform === 'win32' ? null : await mkdtemp(join(tmpdir(), 'tongjorim-'))
  const socketPath = dir ? join(dir, 'http.sock') : `\\\\.\\pipe\\tongjorim-${randomUUID()}`
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve))
    server.closeAllConnections()
    await closed
    store.close()
    if (dir) await rmdir(dir)
  })
  server.listen(socketPath)
  await once(server, 'listening')

  function appFetch(path, { method = 'GET', headers, body, signal = AbortSignal.timeout(5000) } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath, path, method, signal, agent: false, headers: { Host: host, Origin: origin, ...headers },
      }, res => resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers })))
      req.on('error', reject)
      req.end(body)
    })
  }
  t.mock.method(globalThis, 'fetch', appFetch)
  return { appFetch, calls, exchanges }
}

function assistantBody(kind, modelOptions = profile) {
  return {
    kind, mode: 'draft', model, maxTokens: 512, draft: null, modelOptions,
    context: { projectTitle: '안개 항로', synopsis: '아무도 모르는 역이 있어요.' },
    ...(kind === 'lore' ? { card } : { target: 'synopsis' }),
    messages: [{ role: 'user', content: '배경을 논의해요.' }, { role: 'assistant', content: '항구를 배경으로 할 수 있어요.' },
      { role: 'user', content: writerRequest }],
  }
}

function sendAssistant(body, onRetry = () => assert.fail('Unexpected format repair'), signal = AbortSignal.timeout(5000)) {
  return requestAssistantReply(body, { signal, projectId: 'project-1', onRetry })
}

function waitFor(promise, message) {
  const timeout = once(AbortSignal.timeout(5000), 'abort').then(() => assert.fail(message))
  return Promise.race([promise, timeout])
}

function sse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function completion(text) {
  const halfway = Math.floor(text.length / 2)
  return sse([
    { model, choices: [{ delta: { content: text.slice(0, halfway) } }] },
    { model, choices: [{ delta: { content: text.slice(halfway) }, finish_reason: 'stop' }] },
    { openrouter_metadata: { attempt: 1 } },
  ])
}

function routingError(attempt, status = 404) {
  return Response.json({ error: { code: status, message: 'Mock router rejection' },
    openrouter_metadata: attempt === undefined ? undefined : { attempt } }, { status })
}

function expectedFormat(kind) {
  const loreDraft = {
    type: 'object', additionalProperties: false,
    required: ['kind', 'name', 'aliases', 'description', 'priority', 'always'],
    properties: {
      kind: { type: 'string', enum: ['character', 'world', 'place', 'event', 'clue'] },
      name: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      description: { type: 'string' }, priority: { type: 'integer' }, always: { type: 'boolean' },
    },
  }
  return {
    type: 'json_schema', json_schema: {
      name: `${kind}_assistant_reply`, strict: true,
      schema: {
        type: 'object', required: ['reply', 'draft'], additionalProperties: false,
        properties: { reply: { type: 'string' }, draft: { anyOf: [kind === 'lore' ? loreDraft : { type: 'string' }, { type: 'null' }] } },
      },
    },
  }
}

function comparableSchema(value) {
  if (Array.isArray(value)) return value.map(comparableSchema).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, comparableSchema(value[key])]))
  }
  return value
}

function checkAssistantCall({ url, headers, body }, kind) {
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(new Headers(headers).get('X-OpenRouter-Metadata'), 'enabled')
  assert.equal(new Headers(headers).get('Authorization'), `Bearer ${apiKey}`)
  assert.equal(body.model, model)
  assert.equal(body.max_completion_tokens, 512)
  assert.equal(body.stream, true)
  assert.deepEqual(comparableSchema(body.response_format), comparableSchema(expectedFormat(kind)))
  assert.deepEqual(body.provider, routedProvider)
  assert.equal(JSON.parse(body.messages.at(-1).content).request, writerRequest)
}

test('원고 메모 갱신은 작품의 출력 한도를 보내고 잘린 응답은 저장하지 않는다', async t => {
  const reply = JSON.stringify({ summary: '나래는 등대에 도착했다.', knowledgeChanges: [] })
  const { appFetch, calls } = await startApp(t, [completion(reply), sse([
    { model, choices: [{ delta: { content: reply }, finish_reason: 'length' }] },
  ])])
  const project = { id: 'memory', model: 'qa/write', memoryModel: model, maxTokens: 321, title: '등대',
    manuscript: '나래는 등대에 도착했다.' }
  const invalid = await appFetch('/api/memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...memoryRequest(project), maxTokens: 0 }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(calls.length, 0)

  const checkpoint = memory => { project.manuscriptMemory = memory }
  const update = () => updateManuscriptMemory(project, project.manuscript, AbortSignal.timeout(5000), checkpoint, () => {})
  await update()
  const saved = project.manuscriptMemory
  assert.equal(saved.text, '나래는 등대에 도착했다.')

  project.maxTokens = 17
  project.manuscript += '\n\n등대 관리인이 문을 잠갔다.'
  await assert.rejects(update, /출력 토큰 한도에 도달/)
  assert.equal(project.manuscriptMemory, saved)
  assert.deepEqual(calls.map(({ body }) => [body.model, body.max_completion_tokens]), [[model, 321], [model, 17]])
})

test('로어북과 메모의 최초 요청과 형식 교정이 각각 엄격한 스키마를 전송한다', async t => {
  for (const kind of ['lore', 'note']) {
    await t.test(kind, async t => {
      const draft = kind === 'lore' ? card : '서윤은 안개역에서 표를 발견한다.'
      const { calls } = await startApp(t, [completion(invalid), completion(JSON.stringify({ reply: '정리했어요.', draft }))])
      const onRetry = t.mock.fn()
      assert.deepEqual(await sendAssistant(assistantBody(kind), onRetry), { reply: '정리했어요.', draft, truncated: false })
      assert.equal(calls.length, 2)
      assert.equal(onRetry.mock.callCount(), 1)
      for (const call of calls) {
        checkAssistantCall(call, kind)
        assert.equal(call.body.temperature, 0)
        assert.deepEqual(call.body.stop, ['끝.'])
      }
      const [first, repair] = calls.map(call => call.body.messages)
      assert.deepEqual(repair.slice(1, -1), first.slice(1, -1))
      assert.match(repair[0].content, /previousReply/)
      const { previousReply, ...originalRequest } = JSON.parse(repair.at(-1).content)
      assert.equal(previousReply, invalid)
      assert.deepEqual(originalRequest, JSON.parse(first.at(-1).content))
    })
  }
})

test('로어북은 대화와 형식 교정에서 초안을 버리고 초안 만들기에서 대화를 반영한다', async t => {
  const reply = '밤에만 열리는 역으로 설정할 수 있어요.'
  const cardReply = JSON.stringify({ reply, draft: card })
  const { calls } = await startApp(t, [
    completion(cardReply), completion(invalid), completion(cardReply),
    completion(JSON.stringify({ reply: '초안을 만들었어요.', draft: card })),
  ])
  const chat = { ...assistantBody('lore'), mode: 'chat', draft: card }
  const chatReply = { reply, draft: null, truncated: false }
  assert.deepEqual(await sendAssistant(chat), chatReply)
  const onRetry = t.mock.fn()
  assert.deepEqual(await sendAssistant(chat, onRetry), chatReply)
  assert.equal(onRetry.mock.callCount(), 1)

  const messages = [...chat.messages, { role: 'assistant', content: reply },
    { role: 'user', content: '지금까지의 대화를 반영해 카드의 수정안을 작성해 줘.' }]
  assert.deepEqual(await sendAssistant({ ...chat, mode: 'draft', messages }),
    { reply: '초안을 만들었어요.', draft: card, truncated: false })
  assert.equal(calls.length, 4)
  for (const { body } of calls.slice(0, 3)) {
    assert.deepEqual(body.response_format.json_schema.schema.properties.draft, { type: 'null' })
    assert.match(body.messages[0].content, /카드 초안이나 수정안을 쓰지 말고 개선 방향을 의논하세요/)
    const input = JSON.parse(body.messages.at(-1).content)
    assert.equal(input.mode, 'chat')
    assert.equal(input.request, writerRequest)
    assert.deepEqual(input.draft, card)
  }
  const draftRequest = calls[3].body
  assert.deepEqual(draftRequest.response_format, expectedFormat('lore'))
  assert.deepEqual(draftRequest.messages.slice(1, -1), messages.slice(0, -1))
  assert.equal(JSON.parse(draftRequest.messages.at(-1).content).mode, 'draft')
})

test('메모 대화는 초안 작성을 요청하면 초안을 받을 수 있다', async t => {
  const result = { reply: '정리했어요.', draft: '안개역은 밤에만 열려요.' }
  const { calls } = await startApp(t, [completion(JSON.stringify(result))])
  assert.deepEqual(await sendAssistant({ ...assistantBody('note'), mode: 'chat' }), { ...result, truncated: false })
  assert.equal(calls.length, 1)
  checkAssistantCall(calls[0], 'note')
})

test('장면 대화는 말줄임표만 받으면 같은 요청에 재작성 지시를 붙여 한 번 다시 보낸다', async t => {
  const reply = '한두 명이면 충분해요.\n\n“말할까…”처럼 망설임을 한 문장으로 보여 주세요.'
  const { calls } = await startApp(t, [
    completion(JSON.stringify({ reply: '...', draft: null })),
    completion(JSON.stringify({ reply, draft: '다른 본문' })),
  ])
  const scene = { version: 2, text: '나래는 마지막 표를 구겼다.', preceding: '막차가 들어왔다.', following: '불이 꺼졌다.' }
  const input = { ...assistantBody('scene'), mode: 'chat', scene }
  const onRetry = t.mock.fn()
  assert.deepEqual(await sendAssistant(input, onRetry), { reply, draft: null, truncated: false })
  assert.equal(onRetry.mock.callCount(), 1)
  assert.equal(calls.length, 2)

  const [{ body }, { body: retry }] = calls
  assert.match(body.messages[0].content, /지금 선택한 scene\.version의 본문/)
  assert.match(body.messages[0].content, /첫 문장에서 작가의 질문에 직접 답하세요/)
  assert.match(body.messages[0].content, /확인 질문 하나를 하세요/)
  assert.match(body.messages[0].content, /문단 사이에 빈 줄을 넣으세요/)
  assert.doesNotMatch(body.messages[0].content, /직전 답변/)
  assert.match(retry.messages[0].content, /직전 답변이 말줄임표\(\.\.\.\)만으로 끝났습니다/)
  assert.match(retry.messages[0].content, /작가의 원래 요청에 구체적으로 답하세요/)
  assert.doesNotMatch(retry.messages[0].content, /previousReply/)
  assert.deepEqual(retry.messages.slice(1), body.messages.slice(1))
  assert.deepEqual(retry.response_format, body.response_format)
  assert.deepEqual(body.messages.slice(1, -1), input.messages.slice(0, -1))
  assert.deepEqual(JSON.parse(body.messages.at(-1).content), {
    mode: 'chat', request: writerRequest, scene,
    notes: { projectTitle: '안개 항로', synopsis: '아무도 모르는 역이 있어요.', lorebook: '', manuscriptMemory: '' },
  })
  assert.equal(body.response_format.json_schema.name, 'scene_assistant_reply')
  assert.deepEqual(body.response_format.json_schema.schema.properties.draft, { type: 'null' })
})

test('장면 대화는 빈 장면을 받고 잘못된 버전과 초안 작성 모드를 거부한다', async t => {
  const { calls } = await startApp(t, [completion(JSON.stringify({ reply: '첫 행동부터 정해 봐요.', draft: null }))])
  const scene = { version: 1, text: '', preceding: '', following: '' }
  const input = { ...assistantBody('scene'), mode: 'chat', scene }
  assert.equal((await sendAssistant(input)).reply, '첫 행동부터 정해 봐요.')
  await assert.rejects(sendAssistant({ ...input, scene: { ...scene, version: 0 } }), /대화할 장면 버전과 본문을 확인/)
  await assert.rejects(sendAssistant({ ...input, mode: 'draft' }), /대화할 장면 버전과 본문을 확인/)
  assert.equal(calls.length, 1)
})

test('정상 라우팅에서 저장된 생성 옵션을 사용해 한 번만 생성한다', async t => {
  const { calls } = await startApp(t, [completion('{"reply":"정리했어요.","draft":null}')])
  assert.deepEqual(await sendAssistant(assistantBody('note')), { reply: '정리했어요.', draft: null, truncated: false })
  assert.equal(calls.length, 1)
  checkAssistantCall(calls[0], 'note')
  assert.equal(calls[0].body.temperature, 0)
  assert.deepEqual(calls[0].body.stop, ['끝.'])
})

test('사전 라우팅 실패를 복구한 뒤 형식 교정에는 생략한 옵션을 다시 보내지 않는다', async t => {
  const { calls, exchanges } = await startApp(t, [routingError(0), completion(invalid),
    completion(JSON.stringify({ reply: '정리했어요.', draft: card }))])
  const onRetry = t.mock.fn()
  const input = assistantBody('lore')
  const saved = structuredClone(input.modelOptions)
  const result = await sendAssistant(input, onRetry)
  assert.deepEqual(result, { reply: '정리했어요.', draft: card, truncated: false, omittedGenerationOptions: ['temperature', 'stop'] })
  assert.deepEqual(input.modelOptions, saved)
  assert.equal(onRetry.mock.callCount(), 1)
  assert.equal(calls.length, 3)
  for (const call of calls) checkAssistantCall(call, 'lore')
  const [{ body: initial, signal }, { body: recovered, signal: recoveredSignal }, { body: repair }] = calls
  const { temperature, stop, ...requiredRequest } = initial
  assert.equal(temperature, 0)
  assert.deepEqual(stop, ['끝.'])
  assert.deepEqual(recovered, requiredRequest)
  assert.equal(recoveredSignal, signal)
  const { messages, ...repairPayload } = repair
  const { messages: recoveredMessages, ...expectedPayload } = recovered
  assert.deepEqual(repairPayload, expectedPayload)
  const { previousReply, ...repairRequest } = JSON.parse(messages.at(-1).content)
  assert.equal(previousReply, invalid)
  assert.deepEqual(repairRequest, JSON.parse(recoveredMessages.at(-1).content))
  assert.deepEqual(exchanges.map(exchange => exchange.response.status), [404, 200, 200])
  assert.deepEqual(exchanges.map(exchange => exchange.request), calls.map(call => call.body))
  assert.ok(exchanges.every(exchange => exchange.route === '/api/assistant' && exchange.projectId === 'project-1'))
  assert.equal(JSON.parse(exchanges[0].response.raw).openrouter_metadata.attempt, 0)
})

test('형식 교정 요청에서 처음 라우팅 실패가 발생해도 같은 교정 본문으로 한 번만 복구한다', async t => {
  const { calls } = await startApp(t, [completion(invalid), routingError(0), completion('{"reply":"정리했어요.","draft":null}')])
  const onRetry = t.mock.fn()
  const modelOptions = { stop: ['끝.'] }
  assert.deepEqual(await sendAssistant(assistantBody('note', modelOptions), onRetry),
    { reply: '정리했어요.', draft: null, truncated: false, omittedGenerationOptions: ['stop'] })
  assert.equal(onRetry.mock.callCount(), 1)
  assert.equal(calls.length, 3)
  const [initial, repair, recovered] = calls.map(call => call.body)
  const { stop, ...requiredRepair } = repair
  assert.deepEqual(stop, initial.stop)
  assert.equal(JSON.parse(repair.messages.at(-1).content).previousReply, invalid)
  assert.deepEqual(recovered, requiredRepair)
  assert.deepEqual(recovered.provider, { zdr: true, require_parameters: true })
})

test('스키마 경로가 없으면 설정한 제공자와 생성 옵션으로 로어북 초안을 받는다', async t => {
  for (const [label, options, provider, schemaAttempts] of [
    ['모든 옵션 필수', { ...profile, provider: routedProvider }, routedProvider, 1],
    ['생성 옵션 필수 아님', profile, savedProvider, 2],
    ['기본 제공자 설정', {}, { zdr: true }, 1],
  ]) {
    await t.test(label, async t => {
      const answer = { reply: '장소 카드를 정리했어요.', draft: card }
      const responses = Array.from({ length: schemaAttempts }, () => routingError(0))
      const { calls, exchanges } = await startApp(t, [...responses, completion('```JSON\r\n' + JSON.stringify(answer) + '\r\n```')])
      assert.deepEqual(await sendAssistant(assistantBody('lore', options)), { ...answer, truncated: false })
      assert.equal(calls.length, schemaAttempts + 1)
      const initial = calls[0].body
      const fallback = calls.at(-1).body
      assert.equal(initial.response_format.type, 'json_schema')
      assert.equal(initial.provider.require_parameters, true)
      assert.equal(Object.hasOwn(fallback, 'response_format'), false)
      assert.deepEqual(fallback.provider, provider)
      assert.equal(fallback.model, model)
      assert.equal(fallback.max_completion_tokens, 512)
      assert.equal(fallback.temperature, options.temperature)
      assert.deepEqual(fallback.stop, options.stop)
      assert.deepEqual(fallback.messages.slice(1), initial.messages.slice(1))
      const [instructions, schema] = fallback.messages[0].content.split('\n').slice(-2)
      assert.match(instructions, /데이터 JSON 객체 하나만/)
      assert.deepEqual(JSON.parse(schema).required, ['reply', 'draft'])
      assert.ok(calls.every(call => call.signal === calls[0].signal))
      assert.deepEqual(exchanges.map(exchange => exchange.response.status), [...responses.map(() => 404), 200])
      assert.deepEqual(exchanges.map(exchange => exchange.request), calls.map(call => call.body))
    })
  }
})

test('스키마 없는 요청도 경로가 막히면 멈추고 제공자 설정을 안내한다', async t => {
  for (const [label, options, count] of [
    ['모든 옵션 필수', { ...profile, provider: routedProvider }, 2],
    ['생략할 옵션 없음', { provider: savedProvider }, 2],
    ['옵션 생략 후에도 경로 없음', profile, 3],
  ]) {
    await t.test(label, async t => {
      const { calls } = await startApp(t, Array.from({ length: count }, () => routingError(0)))
      await assert.rejects(sendAssistant(assistantBody('note', options)), /현재 모델과 제공자 설정으로 요청을 처리할 경로가 없어요/)
      assert.equal(calls.length, count)
      assert.ok(calls.slice(0, -1).every(call => call.body.provider.require_parameters === true))
      assert.equal(Object.hasOwn(calls.at(-1).body, 'response_format'), false)
      assert.deepEqual(calls.at(-1).body.provider, options.provider)
    })
  }
})

test('제공자 호출 전 실패로 입증되지 않은 HTTP·스트림 오류에는 다시 요청하지 않는다', async t => {
  for (const [label, response, message] of [
    ['메타데이터 없는 404', routingError(undefined), /현재 이 모델을 사용할 수 없어요/],
    ['문자열 attempt', routingError('0'), /현재 이 모델을 사용할 수 없어요/],
    ['제공자 호출 뒤 404', routingError(1), /현재 이 모델을 사용할 수 없어요/],
    ['잘못된 오류 본문', new Response('not JSON', { status: 404 }), /현재 이 모델을 사용할 수 없어요/],
    ['인증', routingError(0, 401), /API 키를 인증하지 못했어요/],
    ['크레딧', routingError(0, 402), /크레딧이 부족해요/],
    ['권한', routingError(0, 403), /권한이 없어요/],
    ['한도', routingError(0, 429), /요청 한도에 도달했어요/],
    ['게이트웨이 오류', routingError(0, 502), /OpenRouter가 응답하지 않아요/],
    ['응답 중 스트림 오류', sse([{ choices: [{ delta: { content: invalid } }] },
      { error: { code: 404 }, openrouter_metadata: { attempt: 0 } }]), /현재 이 모델을 사용할 수 없어요/],
  ]) {
    await t.test(label, async t => {
      const { calls } = await startApp(t, [response])
      await assert.rejects(sendAssistant(assistantBody('lore')), message)
      assert.equal(calls.length, 1)
    })
  }
})

test('일반 HTTP 오류는 OpenRouter 오류 본문을 모두 받기 전에 표시한다', async t => {
  let errorBody
  const response = new Response(new ReadableStream({ start(controller) { errorBody = controller } }), { status: 429 })
  const { calls } = await startApp(t, [response])
  try {
    await assert.rejects(sendAssistant(assistantBody('note')), /요청 한도에 도달했어요/)
    assert.equal(calls.length, 1)
  } finally {
    errorBody.close()
  }
})

test('사전 라우팅 오류 본문을 기다리다 중지하면 복구 요청을 보내지 않는다', async t => {
  const controller = new AbortController()
  const reading = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  const raw = new TextEncoder().encode('{"openrouter_metadata":{"attempt":0}}')
  const { calls } = await startApp(t, [({ signal }) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(raw)
      signal.addEventListener('abort', () => {
        stream.close()
        aborted.resolve()
      }, { once: true })
    },
    pull() { reading.resolve() },
  }), { status: 404 })])
  const onRetry = t.mock.fn()
  const outcome = assert.rejects(sendAssistant(assistantBody('note'), onRetry,
    AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])), { name: 'AbortError' })
  await waitFor(reading.promise, '라우팅 오류 응답을 읽기 시작하지 않았어요.')
  controller.abort()
  await Promise.all([outcome, waitFor(aborted.promise, 'OpenRouter 오류 응답 읽기가 중지되지 않았어요.')])
  assert.equal(calls.length, 1)
  assert.equal(onRetry.mock.callCount(), 0)
})

test('교정 중 중지가 실제 진행 중인 OpenRouter 요청에 전달된다', async t => {
  const controller = new AbortController()
  const started = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  const { calls } = await startApp(t, [routingError(0), completion(invalid), ({ signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted.resolve()
        reject(signal.reason)
      }, { once: true })
      started.resolve()
    })])
  const onRetry = t.mock.fn()
  const outcome = assert.rejects(sendAssistant(assistantBody('lore'), onRetry,
    AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])), { name: 'AbortError' })
  await waitFor(started.promise, '교정 요청이 시작되지 않았어요.')
  controller.abort()
  await Promise.all([outcome, waitFor(aborted.promise, 'OpenRouter 요청이 중지되지 않았어요.')])
  assert.equal(calls.length, 3)
  assert.equal(onRetry.mock.callCount(), 1)
})

test('이어쓰기에는 기존 옵션과 스트림을 사용하고 Host·Origin을 검사한다', async t => {
  const { appFetch, calls } = await startApp(t, [completion('이어쓰기 본문입니다.'), routingError(0)])
  for (const headers of [{ Host: 'example.com' }, { Origin: 'http://example.com' }]) {
    const forbidden = await appFetch('/', { headers })
    assert.equal(forbidden.status, 403)
    await forbidden.text()
  }
  const body = { model, maxTokens: 512, draft: { projectTitle: '안개 항로', direction: '이어서 써 줘.' }, references: [], modelOptions: profile }
  const preview = await appFetch('/api/write/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal(preview.status, 200)
  const expected = await preview.json()
  let text = ''
  const options = { signal: AbortSignal.timeout(5000), onText(content) { text += content } }
  await requestCompletion('/api/write', body, options)
  assert.equal(text, '이어쓰기 본문입니다.')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body, expected)
  assert.deepEqual(calls[0].body.provider, savedProvider)
  assert.equal(calls[0].body.response_format, undefined)
  assert.equal(new Headers(calls[0].headers).has('X-OpenRouter-Metadata'), false)
  await assert.rejects(requestCompletion('/api/write', body, options), /현재 이 모델을 사용할 수 없어요/)
  assert.equal(calls.length, 2)
})

test('이어쓰기 초안 수정은 선택한 초안과 최신 지시를 기존 원고와 구분해 보낸다', async t => {
  const { appFetch, calls } = await startApp(t, [completion('발소리는 등 뒤에서 났다.')])
  const body = {
    model, maxTokens: 512, references: ['manuscript'], systemPrompt: '3인칭 과거형으로 써 줘.',
    draft: { projectTitle: '복도 끝의 문', direction: '문을 열기 직전까지 써 줘.', manuscript: '그녀는 손잡이를 잡았다.' },
    sceneRevision: { text: '복도 끝에서 발소리가 났다.', direction: '등 뒤에서 들리게 바꿔 줘.', following: '그때 전화가 울렸다.' },
  }
  const post = input => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  const invalid = await appFetch('/api/write', post({ ...body, sceneRevision: { ...body.sceneRevision, direction: ' ' } }))
  assert.equal(invalid.status, 400)
  await invalid.text()
  assert.equal(calls.length, 0)
  const preview = await appFetch('/api/write/preview', post(body))
  assert.equal(preview.status, 200)
  let output = ''
  await requestCompletion('/api/write', body, { signal: AbortSignal.timeout(5000), onText(text) { output += text } })
  assert.equal(output, '발소리는 등 뒤에서 났다.')
  assert.equal(calls.length, 1)
  const request = calls[0].body
  assert.deepEqual(request, await preview.json())
  assert.match(request.messages[0].content, /^3인칭 과거형으로 써 줘\./)
  assert.match(request.messages[0].content, /sceneRevision\.following은 교체 대상 뒤/)
  assert.match(request.messages[0].content, /수정 초안 전문만 출력/)
  assert.deepEqual(JSON.parse(request.messages[1].content), {
    projectTitle: '복도 끝의 문', direction: '문을 열기 직전까지 써 줘.', manuscript: '그녀는 손잡이를 잡았다.',
    sceneRevision: { text: '복도 끝에서 발소리가 났다.', direction: '등 뒤에서 들리게 바꿔 줘.', following: '그때 전화가 울렸다.' },
  })
})

test('수정 요청 미리보기와 실제 생성이 같은 가지의 전체 diff와 장면 대화를 보낸다', async t => {
  const { appFetch, calls } = await startApp(t, [completion('바람은 따뜻하다. 촛불이 흔들렸다.')])
  const history = [
    { fromVersion: 1, toVersion: 2, direction: '따뜻하게 바꿔 줘.', diff: '@@ -4,3 +4,4 @@\n- 차갑다\n+ 따뜻하다' },
    { fromVersion: 2, toVersion: 4, direction: '촛불 문단을 빼 줘.', diff: '@@ -9,11 +9,0 @@\n- \n- \n- 촛불이 흔들렸다.' },
  ]
  const conversation = [
    { role: 'user', content: '촛불을 유지하면 어떤 효과가 있나요?' },
    { role: 'assistant', content: '촛불이 흔들리는 모습이 바람을 보여 줘요.' },
    { role: 'user', content: '좋아요. 바람을 보여 주는 데 써 주세요.' },
    { role: 'assistant', content: '촛불 문장을 살리는 게 좋겠어요.' },
  ]
  const sceneRevision = { text: '바람은 따뜻하다.', direction: '촛불 문장만 살려 줘.', history, conversation }
  const body = { model, maxTokens: 512, references: [], draft: { projectTitle: '창가', direction: '' }, sceneRevision }
  const post = input => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })

  const invalid = await appFetch('/api/write', post({ ...body, sceneRevision: { ...sceneRevision, history: [history[1]] } }))
  assert.equal(invalid.status, 400)
  await invalid.text()
  for (const malformed of [[conversation[0]], [...conversation].reverse(), Array.from({ length: 4 }, () => conversation).flat()]) {
    const result = await appFetch('/api/write/preview', post({ ...body, sceneRevision: { ...sceneRevision, conversation: malformed } }))
    assert.equal(result.status, 400)
    assert.match(await result.text(), /장면 대화 기록의 형식과 길이/)
  }
  const tooLarge = await appFetch('/api/write', post({ ...body, sceneRevision: {
    ...sceneRevision, history: [{ ...history[0], diff: '- ' + '가'.repeat(350_000) }],
  } }))
  assert.equal(tooLarge.status, 413)
  await tooLarge.text()
  assert.equal(calls.length, 0)

  const preview = await appFetch('/api/write/preview', post(body))
  assert.equal(preview.status, 200)
  let text = ''
  await requestCompletion('/api/write', body, { signal: AbortSignal.timeout(5000), onText(chunk) { text += chunk } })
  assert.equal(text, '바람은 따뜻하다. 촛불이 흔들렸다.')
  assert.equal(calls.length, 1)
  const request = calls[0].body
  assert.deepEqual(request, await preview.json())
  assert.deepEqual(JSON.parse(request.messages[1].content).sceneRevision, sceneRevision)
  assert.match(request.messages[0].content, /과거 지시는 이전 결정을 이해하거나 최신 지시가 되돌리기를 요청할 때만 참고/)
  assert.match(request.messages[0].content, /대화와 sceneRevision\.direction의 최신 지시가 충돌하면 최신 지시를 따르세요/)
})

test('빈 장면을 쓸 때 의도한 앞뒤 원고를 미리보기와 실제 생성에 같은 형태로 보낸다', async t => {
  const { appFetch, calls } = await startApp(t, [completion('지연이 계단에 앉았다.')])
  const sceneRevision = {
    text: '', direction: '', mode: 'fill', following: '곧 지연이 일어났다.',
    conversation: [{ role: 'user', content: '지연을 잠시 쉬게 해 주세요.' },
      { role: 'assistant', content: '계단에 앉게 하면 앞뒤와 이어져요.' }],
  }
  const body = {
    model, maxTokens: 512, references: ['manuscript'],
    draft: { projectTitle: '계단', direction: '', manuscript: '계단에서 발소리가 났다.' }, sceneRevision,
  }
  const post = input => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  const invalid = await appFetch('/api/write/preview', post({ ...body, sceneRevision: { ...sceneRevision, text: '기존 본문' } }))
  assert.equal(invalid.status, 400)
  await invalid.text()
  const preview = await appFetch('/api/write/preview', post(body))
  assert.equal(preview.status, 200)
  assert.equal(calls.length, 0)
  let text = ''
  await requestCompletion('/api/write', body, { signal: AbortSignal.timeout(5000), onText: chunk => { text += chunk } })
  assert.equal(text, '지연이 계단에 앉았다.')
  assert.equal(calls.length, 1)
  const request = calls[0].body
  assert.deepEqual(request, await preview.json())
  assert.match(request.messages[0].content, /선택된 빈 장면에 들어갈 새 장면/)
  assert.match(request.messages[0].content, /대화에서 작가가 정한 방향을 참고/)
  assert.deepEqual(JSON.parse(request.messages[1].content), {
    projectTitle: '계단', direction: '', manuscript: '계단에서 발소리가 났다.', sceneRevision,
  })
})

test('32 MiB를 넘는 작업공간을 압축 저장하고 응답 유실 뒤에도 동시 저장 규칙을 적용한다', async t => {
  const { appFetch } = await startApp(t, [])
  const workspace = readWorkspace(null)
  const project = workspace.projects[0]
  const body = '창밖에 비가 내렸다. '.repeat(320)
  const scenes = Array.from({ length: 830 }, (_, index) => ({
    id: `scene-${index}`, text: body, origins: [], accepted: 0, versions: [
      { text: body, direction: '비 오는 밤을 묘사해 줘.', parent: null },
      { text: '비'.repeat(4000), direction: '장면을 길게 써 줘.', parent: 0 },
      { text: '바람'.repeat(2000), direction: '바람도 불게 해 줘.', parent: 1 },
    ],
  }))
  project.sceneDocument = {
    order: scenes.map(({ id }, index) => ({ id, before: index ? '\n\n' : '' })),
    scenes: Object.fromEntries(scenes.map(scene => [scene.id, scene])), past: [], future: [],
  }
  const attempt = randomUUID()
  const snapshot = JSON.stringify(workspace)
  const encode = (revision, snapshot) => gzipSync(JSON.stringify({ revision, snapshot, attempt }))
  const headers = { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }
  const wire = JSON.stringify({ revision: null, snapshot, attempt })
  assert.ok(Buffer.byteLength(wire) > 32 * 1024 * 1024)
  assert.ok(wire.length < 32 * 1024 * 1024)
  const wrong = await appFetch('/api/workspace', { method: 'POST', headers, body: Buffer.from('gzip 아님') })
  assert.equal(wrong.status, 400)
  const response = await appFetch('/api/workspace', { method: 'POST', headers, body: encode(null, snapshot) })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { revision: 1 })
  const latest = await (await appFetch('/api/workspace')).json()
  assert.equal(latest.snapshot, snapshot)
  project.title = '이어지는 편집'
  const edited = JSON.stringify(workspace)
  const retry = await appFetch('/api/workspace', { method: 'POST', headers, body: encode(null, edited) })
  assert.equal(retry.status, 409)
  const conflict = await retry.json()
  assert.equal(conflict.committedAttempt, true)
  assert.equal(conflict.snapshot, snapshot)
  const noted = await appFetch('/api/workspace', { method: 'POST', headers, body: encode(1, edited) })
  assert.equal(noted.status, 200)
  assert.deepEqual(await noted.json(), { revision: 2 })
})
