import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  completionPayload, defaultMemoryPrompt, defaultNoteSystemPrompt, defaultRevisionPrompt, defaultSystemPrompt,
  defaultReferences, effectiveSystemPrompt, freeModel, memoryExcerptLimit, memoryOutputLimit, modelIdPattern, noteIdeaLimit,
  noteKinds, orderedWritingContext, systemPromptLimit,
  writingFields, writingTokenLimits,
} from './public/writing-config.mjs'
import { actualUsage } from './public/request-tools.mjs'
import { chunkLimit, embeddingBatchSize, embeddingQueryLimit } from './public/retrieval.mjs'

try {
  loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API?.trim()
const port = Number(process.env.PORT || 4173)
const baseUrl = 'https://openrouter.ai/api/v1'
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
const assets = new Map([
  ['/', ['writer.html', 'text/html; charset=utf-8']],
  ['/chat', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/writer.js', ['writer.js', 'text/javascript; charset=utf-8']],
  ['/writing-config.mjs', ['writing-config.mjs', 'text/javascript; charset=utf-8']],
  ['/manuscript-memory.mjs', ['manuscript-memory.mjs', 'text/javascript; charset=utf-8']],
  ['/retrieval.mjs', ['retrieval.mjs', 'text/javascript; charset=utf-8']],
  ['/embedding-index.mjs', ['embedding-index.mjs', 'text/javascript; charset=utf-8']],
  ['/research-panel.mjs', ['research-panel.mjs', 'text/javascript; charset=utf-8']],
  ['/request-tools.mjs', ['request-tools.mjs', 'text/javascript; charset=utf-8']],
  ['/project-files.mjs', ['project-files.mjs', 'text/javascript; charset=utf-8']],
  ['/completion.js', ['completion.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/writer.css', ['writer.css', 'text/css; charset=utf-8']],
])

const upstreamErrors = {
  400: '모델이 이 요청을 처리할 수 없어요. 메시지를 줄이거나 다른 모델을 선택해 주세요.',
  401: 'OpenRouter가 API 키를 인증하지 못했어요. .env의 키를 확인하고 서버를 다시 시작해 주세요.',
  402: 'OpenRouter 크레딧이 부족해요. 무료 모델을 선택하거나 잔액을 확인해 주세요.',
  403: '이 모델 또는 요청에 대한 권한이 없어요. 다른 모델을 선택해 주세요.',
  404: '현재 이 모델을 사용할 수 없어요. 다른 모델을 선택해 주세요.',
  429: '요청 한도에 도달했어요. 잠시 후 다시 시도하거나 다른 모델을 선택해 주세요.',
}

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function modelPrice(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const price = Number(value)
  return String(value).trim() && Number.isFinite(price) && price >= 0 ? price : null
}

let cachedModels
async function modelCatalog() {
  if (cachedModels?.expires > Date.now()) return cachedModels.result

  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(7000) })
    if (!response.ok) throw new Error('Catalog request failed')
    const { data } = await response.json()
    const models = data
      .filter(model => modelIdPattern.test(model.id) && model.id !== freeModel.id &&
        model.architecture?.input_modalities?.includes('text') && model.architecture?.output_modalities?.includes('text'))
      .map(model => {
        const input = modelPrice(model.pricing?.prompt)
        const output = modelPrice(model.pricing?.completion)
        const request = model.pricing?.request == null ? 0 : modelPrice(model.pricing.request)
        return { id: model.id, name: model.name, input, output, request, free: input === 0 && output === 0 && request === 0 }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    const result = { models: [freeModel, ...models], catalogAvailable: true }
    cachedModels = { result, expires: Date.now() + 5 * 60_000 }
    return result
  } catch {
    return { models: cachedModels?.result.models ?? [freeModel], catalogAvailable: false }
  }
}

async function readJsonRequest(req, maxBytes = 256 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, 'JSON 형식으로 요청해 주세요.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBytes) {
      req.resume()
      throw new RequestError(413, '요청이 너무 길어요. 내용을 줄여서 다시 시도해 주세요.')
    }
    chunks.push(chunk)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, '요청 형식을 확인해 주세요.')
  }
}

async function readChat(req) {
  const body = await readJsonRequest(req)
  const { model, messages } = body ?? {}
  if (typeof model !== 'string' || model.length > 200 || !modelIdPattern.test(model) ||
      !Array.isArray(messages) || messages.length > 40 || messages.at(-1)?.role !== 'user' ||
      messages.some(message => !['user', 'assistant'].includes(message?.role) ||
        typeof message.content !== 'string' || !message.content.trim() || message.content.length > 16_000)) {
    throw new RequestError(400, '모델과 대화 내용을 확인해 주세요.')
  }

  return { model, messages: messages.map(({ role, content }) => ({ role, content })), max_tokens: 2048 }
}

function resolveSystemPrompt(prompt, fallback) {
  if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > systemPromptLimit)) {
    throw new RequestError(400, '시스템 프롬프트의 형식과 길이를 확인해 주세요.')
  }
  return effectiveSystemPrompt(prompt, fallback)
}

async function readWritingRequest(req) {
  const { model, maxTokens, draft, systemPrompt, references } = (await readJsonRequest(req, 512 * 1024)) ?? {}
  const context = Object.fromEntries(Object.keys(writingFields).map(field => [field, draft?.[field]]))
  context.characterNotes ??= ''
  context.manuscriptMemory ??= ''
  context.sceneTitle ??= ''
  context.previousScenes ??= ''
  context.lorebook ??= ''
  context.pastPassages ??= ''
  if (references !== undefined && (!Array.isArray(references) || references.length > defaultReferences.length ||
      new Set(references).size !== references.length || references.some(field => !defaultReferences.includes(field)))) {
    throw new RequestError(400, '참고 자료의 종류와 순서를 확인해 주세요.')
  }
  const included = orderedWritingContext(context, references)
  if (typeof model !== 'string' || model.length > 200 || !modelIdPattern.test(model) ||
      !writingTokenLimits.includes(maxTokens) ||
      !Object.entries(included).every(([field, text]) => typeof text === 'string' && text.length <= writingFields[field])) {
    throw new RequestError(400, '모델, 생성 한도와 원고 설정을 확인해 주세요.')
  }
  const prompt = resolveSystemPrompt(systemPrompt, defaultSystemPrompt)
  if (!Object.entries(included).some(([field, text]) => field !== 'projectTitle' && text.trim())) {
    throw new RequestError(400, '원고, 작품 메모, 또는 이어쓰기 지시를 먼저 입력해 주세요.')
  }

  return completionPayload(model, maxTokens, prompt, included)
}

async function readNotePlanningRequest(req) {
  const { model, maxTokens, target, idea, notes, systemPrompt } = (await readJsonRequest(req, 512 * 1024)) ?? {}
  const fields = ['projectTitle', ...Object.keys(noteKinds), 'manuscriptMemory']
  const context = Object.fromEntries(fields.map(field => [field, notes?.[field]]))
  context.manuscriptMemory ??= ''
  if (typeof model !== 'string' || model.length > 200 || !modelIdPattern.test(model) ||
      !writingTokenLimits.includes(maxTokens) || typeof target !== 'string' || !Object.hasOwn(noteKinds, target) ||
      typeof idea !== 'string' || idea.length > noteIdeaLimit ||
      fields.some(field => typeof context[field] !== 'string' || context[field].length > writingFields[field])) {
    throw new RequestError(400, '메모 종류와 아이디어 내용을 확인해 주세요.')
  }

  const prompt = resolveSystemPrompt(systemPrompt, defaultNoteSystemPrompt(target))
  return completionPayload(model, maxTokens, prompt, { ...context, idea })
}

async function readMemoryRequest(req) {
  const { model, projectTitle, memory, excerpt, systemPrompt } = (await readJsonRequest(req)) ?? {}
  if (typeof model !== 'string' || model.length > 200 || !modelIdPattern.test(model) ||
      typeof projectTitle !== 'string' || projectTitle.length > writingFields.projectTitle ||
      typeof memory !== 'string' || memory.length > writingFields.manuscriptMemory ||
      typeof excerpt !== 'string' || !excerpt.trim() || excerpt.length > memoryExcerptLimit) {
    throw new RequestError(400, '메모를 갱신할 원고 범위를 확인해 주세요.')
  }

  return completionPayload(model, memoryOutputLimit, resolveSystemPrompt(systemPrompt, defaultMemoryPrompt),
    { projectTitle, memory, excerpt })
}

async function readRevisionRequest(req) {
  const { model, maxTokens, paragraph, direction, systemPrompt } = (await readJsonRequest(req)) ?? {}
  if (typeof model !== 'string' || model.length > 200 || !modelIdPattern.test(model) ||
      !writingTokenLimits.includes(maxTokens) ||
      typeof paragraph !== 'string' || !paragraph.trim() || paragraph.length > writingFields.manuscript ||
      typeof direction !== 'string' || direction.length > writingFields.direction) {
    throw new RequestError(400, '퇴고할 문단과 지시를 확인해 주세요.')
  }
  return completionPayload(model, maxTokens, resolveSystemPrompt(systemPrompt, defaultRevisionPrompt), { paragraph, direction })
}

let cachedEmbeddingModels
async function embeddingModels() {
  if (cachedEmbeddingModels?.expires > Date.now()) return cachedEmbeddingModels.models
  const response = await fetch(`${baseUrl}/embeddings/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new RequestError(response.status, upstreamErrors[response.status] ?? '임베딩 모델 목록을 불러올 수 없어요.')
  const { data } = await response.json()
  if (!Array.isArray(data)) throw new RequestError(502, '임베딩 모델 목록을 읽을 수 없어요.')
  const models = data.filter(model => typeof model.id === 'string' && modelIdPattern.test(model.id) &&
      (!model.architecture?.input_modalities || model.architecture.input_modalities.includes('text')))
    .map(model => ({
      id: model.id, name: model.name ?? model.id,
      input: modelPrice(model.pricing?.prompt), request: model.pricing?.request == null ? 0 : modelPrice(model.pricing.request),
    }))
  cachedEmbeddingModels = { models, expires: Date.now() + 5 * 60_000 }
  return models
}

async function embed(req, res) {
  const { model, input, kind } = (await readJsonRequest(req)) ?? {}
  const maxChars = kind === 'document' ? chunkLimit : embeddingQueryLimit
  if (typeof model !== 'string' || !modelIdPattern.test(model) || !['document', 'query'].includes(kind) ||
      !Array.isArray(input) || !input.length || input.length > (kind === 'query' ? 1 : embeddingBatchSize) ||
      input.some(text => typeof text !== 'string' || !text.trim() || text.length > maxChars)) {
    throw new RequestError(400, '임베딩에 보낼 문단이나 검색어를 확인해 주세요.')
  }
  if (!(await embeddingModels()).some(item => item.id === model)) {
    throw new RequestError(404, '현재 이 임베딩 모델을 사용할 수 없어요.')
  }
  if (res.destroyed) return
  const disconnect = new AbortController()
  const abort = () => disconnect.abort()
  res.once('close', abort)
  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input, encoding_format: 'float' }),
      signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(45000)]),
    })
    if (!response.ok) throw new RequestError(response.status, upstreamErrors[response.status] ?? '임베딩 요청에 실패했어요.')
    const data = await response.json()
    const vectors = Array(input.length)
    const dimension = data?.data?.[0]?.embedding?.length
    if (!dimension || dimension > 8192 || !Array.isArray(data.data) || data.data.length !== input.length) {
      throw new RequestError(502, '임베딩 응답의 개수 또는 차원이 달라요.')
    }
    for (const row of data.data) {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= input.length || vectors[row.index] ||
          !Array.isArray(row.embedding) || row.embedding.length !== dimension || !row.embedding.every(Number.isFinite)) {
        throw new RequestError(502, '임베딩 응답 형식을 확인해 주세요.')
      }
      vectors[row.index] = row.embedding
    }
    if (!res.destroyed) json(res, 200, { vectors, usage: actualUsage(data.usage) })
  } finally {
    res.off('close', abort)
  }
}

const streamingPayload = completion => ({ ...completion, stream: true })

async function streamCompletion(req, res, readRequest) {
  if (!apiKey) throw new RequestError(503, '.env에 OPENROUTER_API 키를 설정하고 서버를 다시 시작해 주세요.')
  const completion = await readRequest(req)
  const disconnect = new AbortController()
  const timeout = AbortSignal.timeout(120_000)
  const signal = AbortSignal.any([disconnect.signal, timeout])
  const abort = () => disconnect.abort()
  res.once('close', abort)

  async function send(event) {
    if (!res.write(`${JSON.stringify(event)}\n`)) await once(res, 'drain', { signal })
  }

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(streamingPayload(completion)),
      signal,
    })
    if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
      await upstream.body?.cancel()
      const status = upstreamErrors[upstream.status] ? upstream.status : 502
      throw new RequestError(status, upstreamErrors[status] ?? 'OpenRouter가 응답하지 않아요. 잠시 후 다시 시도해 주세요.')
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
    res.flushHeaders()
    let buffer = ''
    let actualModel
    let finishReason
    const usage = actualUsage()
    let receivedText = false

    for await (const chunk of upstream.body.pipeThrough(new TextDecoderStream())) {
      const lines = (buffer + chunk).split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          if (!receivedText) throw new RequestError(502, '모델이 답변을 보내지 않았어요. 다른 모델로 다시 시도해 주세요.')
          await send({ type: 'done', model: actualModel, tokens: usage.totalTokens, usage, truncated: finishReason === 'length' })
          res.end()
          return
        }
        const event = JSON.parse(data)
        const choice = event.choices?.[0]
        if (event.error || choice?.finish_reason === 'error') {
          throw new RequestError(502, upstreamErrors[event.error?.code] ?? '모델이 답변을 중단했어요. 다시 시도해 주세요.')
        }
        if (modelIdPattern.test(event.model)) actualModel = event.model
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (event.usage) {
          for (const [key, value] of Object.entries(actualUsage(event.usage))) {
            if (value !== null) usage[key] = value
          }
        }
        if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
          receivedText ||= Boolean(choice.delta.content.trim())
          await send({ type: 'text', content: choice.delta.content })
        }
      }
    }
    throw new RequestError(502, '답변을 받는 도중 연결이 끊겼어요. 다시 시도해 주세요.')
  } catch (error) {
    if (disconnect.signal.aborted || res.destroyed) return
    const message = error instanceof RequestError ? error.message : timeout.aborted
      ? '답변 시간이 초과됐어요. 다시 시도해 주세요.'
      : 'OpenRouter에 연결할 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'
    if (res.headersSent) res.end(`${JSON.stringify({ type: 'error', message })}\n`)
    else json(res, error instanceof RequestError ? error.status : 502, { error: message })
  } finally {
    res.off('close', abort)
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")

  try {
    const origin = `http://${req.headers.host}`
    if (!hosts.has(req.headers.host) || (req.headers.origin && req.headers.origin !== origin)) {
      throw new RequestError(403, '로컬 앱 주소에서 다시 시도해 주세요.')
    }

    const path = new URL(req.url, origin).pathname
    if (req.method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path)
      const content = await readFile(new URL(`public/${file}`, import.meta.url))
      res.writeHead(200, { 'Content-Type': type })
      res.end(content)
    } else if (req.method === 'GET' && path === '/api/models') {
      json(res, 200, { keyConfigured: Boolean(apiKey), ...await modelCatalog() })
    } else if (req.method === 'POST' && path === '/api/chat') {
      await streamCompletion(req, res, readChat)
    } else if (req.method === 'POST' && path === '/api/write') {
      await streamCompletion(req, res, readWritingRequest)
    } else if (req.method === 'POST' && path === '/api/write/preview') {
      json(res, 200, streamingPayload(await readWritingRequest(req)))
    } else if (req.method === 'POST' && path === '/api/revise') {
      await streamCompletion(req, res, readRevisionRequest)
    } else if (req.method === 'POST' && path === '/api/plan') {
      await streamCompletion(req, res, readNotePlanningRequest)
    } else if (req.method === 'POST' && path === '/api/memory') {
      await streamCompletion(req, res, readMemoryRequest)
    } else if (req.method === 'GET' && path === '/api/embeddings/models') {
      if (!apiKey) throw new RequestError(503, 'OpenRouter API 키를 설정해 주세요.')
      json(res, 200, { models: await embeddingModels() })
    } else if (req.method === 'POST' && path === '/api/embeddings') {
      if (!apiKey) throw new RequestError(503, 'OpenRouter API 키를 설정해 주세요.')
      await embed(req, res)
    } else {
      json(res, 404, { error: '페이지를 찾을 수 없어요.' })
    }
  } catch (error) {
    if (res.destroyed) return
    if (error instanceof RequestError) json(res, error.status, { error: error.message })
    else json(res, 500, { error: '서버에서 문제가 발생했어요. 다시 시도해 주세요.' })
  }
})

server.listen(port, '127.0.0.1', () => console.log(`Relay is running at http://127.0.0.1:${port}`))
