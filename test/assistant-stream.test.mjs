import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { requestCompletion } from '../public/completion.js'
import { requestAssistantReply } from '../public/writing-assistant.mjs'
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

test('스키마 요청을 처리할 경로가 없으면 정책에 맞게 멈추고 원인을 안내한다', async t => {
  for (const [label, options, count] of [
    ['모든 옵션 필수', { ...profile, provider: { ...savedProvider, require_parameters: true } }, 1],
    ['생략할 옵션 없음', { provider: savedProvider }, 1],
    ['옵션 생략 후에도 경로 없음', profile, 2],
  ]) {
    await t.test(label, async t => {
      const { calls } = await startApp(t, Array.from({ length: count }, () => routingError(0)))
      await assert.rejects(sendAssistant(assistantBody('note', options)), /JSON 스키마 요청을 처리할 경로가 없어요/)
      assert.equal(calls.length, count)
      assert.ok(calls.every(call => call.body.provider.require_parameters === true))
      assert.equal(Object.hasOwn(calls[0].body, 'stop'), Object.hasOwn(options, 'stop'))
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
