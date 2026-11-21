import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  assistantHistoryTurns, assistantMessageLimit, assistantNoteDraftLimit, assistantReplyLimit,
  completionPayload, defaultLoreSystemPrompt, defaultMemoryPrompt, defaultNoteSystemPrompt, defaultRevisionPrompt, defaultSystemPrompt,
  defaultReferences, effectiveSystemPrompt, freeModel, memoryExcerptLimit, memoryOutputLimit, modelIdPattern, validModelId,
  noteDraftActions, noteKinds, orderedWritingContext, revisionParagraphLimit, systemPromptLimit,
  validWritingTokenLimit, writingFields,
} from './public/writing-config.mjs'
import { actualUsage } from './public/request-tools.mjs'
import { openRouterOptions, reasoningEfforts, validModelOptions } from './public/model-options.mjs'
import { loreCardFields, validLoreCardFields } from './public/project-files.mjs'
import { chunkLimit, embeddingBatchSize, embeddingQueryLimit, loreKinds, loreLimits } from './public/retrieval.mjs'

try {
  loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API?.trim()
const managementKey = process.env.OPENROUTER_MANAGE?.trim()
const port = Number(process.env.PORT || 4173)
const baseUrl = 'https://openrouter.ai/api/v1'
const writingRequestBytes = 1024 * 1024
const assistantRequestBytes = 512 * 1024
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
const assets = new Map([
  ['/', ['writer.html', 'text/html; charset=utf-8']],
  ['/settings', ['settings.html', 'text/html; charset=utf-8']],
  ['/favicon.png', ['favicon.png', 'image/png']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/model-classification.mjs', ['model-classification.mjs', 'text/javascript; charset=utf-8']],
  ['/model-options.mjs', ['model-options.mjs', 'text/javascript; charset=utf-8']],
  ['/writer.js', ['writer.js', 'text/javascript; charset=utf-8']],
  ['/writing-config.mjs', ['writing-config.mjs', 'text/javascript; charset=utf-8']],
  ['/writing-assistant.mjs', ['writing-assistant.mjs', 'text/javascript; charset=utf-8']],
  ['/writing-workspace.mjs', ['writing-workspace.mjs', 'text/javascript; charset=utf-8']],
  ['/manuscript-memory.mjs', ['manuscript-memory.mjs', 'text/javascript; charset=utf-8']],
  ['/retrieval.mjs', ['retrieval.mjs', 'text/javascript; charset=utf-8']],
  ['/embedding-index.mjs', ['embedding-index.mjs', 'text/javascript; charset=utf-8']],
  ['/research-panel.mjs', ['research-panel.mjs', 'text/javascript; charset=utf-8']],
  ['/writing-context.mjs', ['writing-context.mjs', 'text/javascript; charset=utf-8']],
  ['/source-panel.mjs', ['source-panel.mjs', 'text/javascript; charset=utf-8']],
  ['/request-tools.mjs', ['request-tools.mjs', 'text/javascript; charset=utf-8']],
  ['/project-files.mjs', ['project-files.mjs', 'text/javascript; charset=utf-8']],
  ['/completion.js', ['completion.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/writer.css', ['writer.css', 'text/css; charset=utf-8']],
  ['/writing-assistant.css', ['writing-assistant.css', 'text/css; charset=utf-8']],
  ['/settings.css', ['settings.css', 'text/css; charset=utf-8']],
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

function tokenLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

const selectableModelId = id => validModelId(id) && !/:batch$/i.test(id)

let cachedModels
async function modelCatalog() {
  if (cachedModels?.expires > Date.now()) return cachedModels.result

  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(7000) })
    if (!response.ok) throw new Error('Catalog request failed')
    const { data } = await response.json()
    const models = data
      .filter(model => selectableModelId(model?.id) && model.id !== freeModel.id &&
        model.architecture?.input_modalities?.includes('text') && model.architecture?.output_modalities?.includes('text'))
      .map(model => {
        const input = modelPrice(model.pricing?.prompt)
        const output = modelPrice(model.pricing?.completion)
        const request = model.pricing?.request == null ? 0 : modelPrice(model.pricing.request)
        const contextLimits = [model.context_length, model.top_provider?.context_length].map(tokenLimit).filter(Boolean)
        const contextLength = contextLimits.length ? Math.min(...contextLimits) : null
        const maxCompletionTokens = tokenLimit(model.top_provider?.max_completion_tokens)
        const advertisedEfforts = model.reasoning?.supported_efforts
        const supportedEfforts = advertisedEfforts === null ? reasoningEfforts
          : Array.isArray(advertisedEfforts) ? advertisedEfforts.filter(effort => reasoningEfforts.includes(effort)) : []
        return { id: model.id, name: model.name, input, output, request, contextLength, maxCompletionTokens, supportedEfforts,
          free: input === 0 && output === 0 && request === 0 }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    const result = { models: [freeModel, ...models], catalogAvailable: true }
    cachedModels = { result, expires: Date.now() + 5 * 60_000 }
    return result
  } catch {
    return { models: cachedModels?.result.models ?? [freeModel], catalogAvailable: false }
  }
}

async function readOpenRouterUsage(path, key, read, subject, credential) {
  try {
    const response = await fetch(`${baseUrl}/${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
    })
    if (response.ok) {
      const { data } = await response.json()
      const usage = read(data)
      if (usage) return usage
    } else {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) {
        return { error: `OpenRouter에서 ${subject} 조회 권한을 확인하지 못했어요. .env의 ${credential} 값을 확인해 주세요.` }
      }
    }
  } catch {
    // Allow the other usage figures to load when this request fails.
  }
  return { error: `${subject} 정보를 불러오지 못했어요. 잠시 후 새로고침해 주세요.` }
}

function keyUsage(data) {
  if (!Number.isFinite(data?.usage)) return null
  if (data.limit !== null && (!Number.isFinite(data.limit) || !Number.isFinite(data.limit_remaining))) return null
  return {
    total: data.usage,
    today: Number.isFinite(data.usage_daily) ? data.usage_daily : null,
    month: Number.isFinite(data.usage_monthly) ? data.usage_monthly : null,
    limit: data.limit,
    remaining: data.limit === null ? null : Math.max(0, data.limit_remaining),
    reset: ['daily', 'weekly', 'monthly'].includes(data.limit_reset) ? data.limit_reset : null,
  }
}

function creditBalance(data) {
  if (!Number.isFinite(data?.total_credits) || !Number.isFinite(data?.total_usage)) return null
  return { balance: data.total_credits - data.total_usage }
}

async function openRouterUsage() {
  const [key, credits] = await Promise.all([
    apiKey ? readOpenRouterUsage('key', apiKey, keyUsage, '키 사용액', '집필용 API 키')
      : { error: '집필용 OpenRouter API 키를 설정하면 사용액과 한도를 볼 수 있어요.' },
    managementKey ? readOpenRouterUsage('credits', managementKey, creditBalance, '계정 크레딧', 'OPENROUTER_MANAGE')
      : null,
  ])
  return { key, credits }
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

function resolveSystemPrompt(prompt, fallback) {
  if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > systemPromptLimit)) {
    throw new RequestError(400, '시스템 프롬프트의 형식과 길이를 확인해 주세요.')
  }
  return effectiveSystemPrompt(prompt, fallback)
}

function writingCompletion({ model, maxTokens, draft, systemPrompt, references }) {
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
      !validWritingTokenLimit(maxTokens) ||
      !Object.entries(included).every(([field, text]) => typeof text === 'string' && text.length <= writingFields[field])) {
    throw new RequestError(400, '모델, 생성 한도와 원고 설정을 확인해 주세요.')
  }
  const prompt = resolveSystemPrompt(systemPrompt, defaultSystemPrompt)
  if (!Object.entries(included).some(([field, text]) => field !== 'projectTitle' && field !== 'sceneLength' && text.trim())) {
    throw new RequestError(400, '원고, 작품 메모, 또는 이어쓰기 지시를 먼저 입력해 주세요.')
  }

  return completionPayload(model, maxTokens, prompt, included)
}

function assistantCompletion({ kind, mode, model, maxTokens, target, messages, context, card, draft, systemPrompt, noteAction = 'append' }) {
  const fields = ['projectTitle', ...Object.keys(noteKinds), 'manuscriptMemory']
  const notes = Object.fromEntries(fields.map(field => [field, context?.[field]]))
  notes.manuscriptMemory ??= ''
  if (!validModelId(model) || !validWritingTokenLimit(maxTokens) || !['note', 'lore'].includes(kind) ||
      !['draft', 'chat'].includes(mode) || !Array.isArray(messages) || messages.length % 2 !== 1 ||
      messages.length > assistantHistoryTurns * 2 + 1 ||
      messages.some((message, index) => message?.role !== (index % 2 ? 'assistant' : 'user') ||
        typeof message.content !== 'string' || !message.content.trim() ||
        message.content.length > (index % 2 ? assistantReplyLimit : assistantMessageLimit)) ||
      fields.some(field => typeof notes[field] !== 'string' || notes[field].length > writingFields[field])) {
    throw new RequestError(400, '모델, 작품 메모와 대화 내용을 확인해 주세요.')
  }

  let instruction
  let draftFormat
  if (kind === 'note') {
    if (typeof target !== 'string' || !Object.hasOwn(noteKinds, target) || !noteDraftActions.includes(noteAction) ||
        (draft !== null && (typeof draft !== 'string' || draft.length > assistantNoteDraftLimit))) {
      throw new RequestError(400, '메모 종류와 초안 내용을 확인해 주세요.')
    }
    instruction = resolveSystemPrompt(systemPrompt, defaultNoteSystemPrompt(target))
    draftFormat = noteAction === 'replace'
      ? `notes[target]의 기존 메모 전체를 교체할 수 있는 수정본을 ${writingFields[target]}자 이내 문자열로 작성하세요. 변경 요청이 없는 부분은 보존하고 수정 요약 대신 최종 메모 전문을 넣으세요. 앞의 지시가 반영 형식과 충돌하면 이 형식을 따르세요.`
      : `메모 끝에 덧붙일 새 내용만 ${assistantNoteDraftLimit}자 이내 문자열로 작성하세요.`
  } else {
    if (!validLoreCardFields(card, { allowIncomplete: true }) || (draft !== null && !validLoreCardFields(draft))) {
      throw new RequestError(400, '로어북 카드와 초안 내용을 확인해 주세요.')
    }
    instruction = resolveSystemPrompt(systemPrompt, defaultLoreSystemPrompt)
    draftFormat = [
      '수정 사항을 반영한 카드 전체를 {"kind":"character", "name":"이름", "aliases":[], "description":"설명", "priority":0, "always":false} 형식으로 작성하세요.',
      `kind는 ${Object.entries(loreKinds).map(([key, label]) => `${key}(${label})`).join(', ')} 중 하나입니다.`,
      `이름은 ${loreLimits.names}자, 별칭은 ${loreLimits.aliases}개(각 ${loreLimits.names}자), 설명은 ${loreLimits.description}자 이내입니다. 우선순위는 -100부터 100까지 정수입니다.`,
      '별칭 하나에 쉼표나 줄바꿈을 넣지 마세요. 작가가 요청하면 우선순위와 항상 포함 설정을 수정하세요.',
    ].join(' ')
  }

  const prompt = [
    instruction,
    '출력은 {"reply":"작가와 나눌 답변", "draft":null} 형식의 JSON 객체 하나입니다. 코드 블록을 붙이지 마세요.',
    `reply에 ${assistantReplyLimit}자 이내로 답변하세요. draft가 있으면 본문을 반복하는 대신 핵심 변경을 설명하세요.`,
    `draft를 작성할 때는 ${draftFormat}`,
    '사용자 메시지의 JSON은 작품 메모(notes), 편집 중인 초안(draft), 해당하는 경우 현재 카드(card), 작성 모드(mode)와 작가의 발화(request)를 담고 있습니다.',
    'mode가 draft면 대화와 작가의 요청을 반영해 초안을 제안하세요. mode가 chat이면 먼저 발화에 답하고, 작성이나 수정을 요청했을 때 초안을 제안하세요.',
    '초안 변경이 없거나 먼저 확인할 내용이 있으면 draft는 null로 두세요. 작가가 언어를 지정하지 않으면 한국어를 사용하세요.',
  ].join('\n')
  const conversation = messages.slice(0, -1).map(({ role, content }) => ({ role, content }))
  const content = JSON.stringify({ notes, mode, target: kind === 'note' ? target : undefined,
    noteAction: kind === 'note' ? noteAction : undefined,
    card: kind === 'lore' ? loreCardFields(card) : undefined,
    draft: kind === 'lore' && draft ? loreCardFields(draft) : draft, request: messages.at(-1).content })

  return { model, max_completion_tokens: maxTokens, messages: [
    { role: 'system', content: prompt }, ...conversation, { role: 'user', content },
  ] }
}

function memoryCompletion({ model, projectTitle, memory, excerpt, systemPrompt }) {
  if (typeof model !== 'string' || model.length > 200 || !modelIdPattern.test(model) ||
      typeof projectTitle !== 'string' || projectTitle.length > writingFields.projectTitle ||
      typeof memory !== 'string' || memory.length > writingFields.manuscriptMemory ||
      typeof excerpt !== 'string' || !excerpt.trim() || excerpt.length > memoryExcerptLimit) {
    throw new RequestError(400, '메모를 갱신할 원고 범위를 확인해 주세요.')
  }

  return completionPayload(model, memoryOutputLimit, resolveSystemPrompt(systemPrompt, defaultMemoryPrompt),
    { projectTitle, memory, excerpt })
}

function revisionCompletion({ model, maxTokens, paragraph, direction, systemPrompt }) {
  if (typeof model !== 'string' || model.length > 200 || !modelIdPattern.test(model) ||
      !validWritingTokenLimit(maxTokens) ||
      typeof paragraph !== 'string' || !paragraph.trim() || paragraph.length > revisionParagraphLimit ||
      typeof direction !== 'string' || direction.length > writingFields.direction) {
    throw new RequestError(400, '퇴고할 문단과 지시를 확인해 주세요.')
  }
  return completionPayload(model, maxTokens, resolveSystemPrompt(systemPrompt, defaultRevisionPrompt), { paragraph, direction })
}

function inferencePayload(payload, modelOptions, options) {
  if (modelOptions !== undefined && !validModelOptions(modelOptions)) {
    throw new RequestError(400, '모델 상세설정의 형식이나 범위를 확인해 주세요.')
  }
  return { ...payload, ...openRouterOptions(modelOptions, options) }
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
  const models = data.filter(model => selectableModelId(model?.id) &&
      (!model.architecture?.input_modalities || model.architecture.input_modalities.includes('text')))
    .map(model => ({
      id: model.id, name: model.name ?? model.id,
      input: modelPrice(model.pricing?.prompt), request: model.pricing?.request == null ? 0 : modelPrice(model.pricing.request),
    }))
  cachedEmbeddingModels = { models, expires: Date.now() + 5 * 60_000 }
  return models
}

async function embed(req, res) {
  const { model, input, kind, modelOptions } = (await readJsonRequest(req)) ?? {}
  const maxChars = kind === 'document' ? chunkLimit : embeddingQueryLimit
  if (typeof model !== 'string' || !modelIdPattern.test(model) || !['document', 'query'].includes(kind) ||
      !Array.isArray(input) || !input.length || input.length > (kind === 'query' ? 1 : embeddingBatchSize) ||
      input.some(text => typeof text !== 'string' || !text.trim() || text.length > maxChars)) {
    throw new RequestError(400, '임베딩에 보낼 문단이나 검색어를 확인해 주세요.')
  }
  const body = inferencePayload({ model, input, encoding_format: 'float' }, modelOptions, { embedding: true })
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
      body: JSON.stringify(body),
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

async function readStreamingPayload(req, completionFor, maxBytes) {
  const { modelOptions, ...input } = (await readJsonRequest(req, maxBytes)) ?? {}
  return inferencePayload({ ...completionFor(input), stream: true }, modelOptions)
}

async function streamCompletion(req, res, completionFor, maxBytes) {
  if (!apiKey) throw new RequestError(503, '.env에 OPENROUTER_API 키를 설정하고 서버를 다시 시작해 주세요.')
  const payload = await readStreamingPayload(req, completionFor, maxBytes)
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
      body: JSON.stringify(payload),
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
    } else if (req.method === 'GET' && path === '/api/openrouter/usage') {
      json(res, 200, await openRouterUsage())
    } else if (req.method === 'POST' && path === '/api/write') {
      await streamCompletion(req, res, writingCompletion, writingRequestBytes)
    } else if (req.method === 'POST' && path === '/api/write/preview') {
      json(res, 200, await readStreamingPayload(req, writingCompletion, writingRequestBytes))
    } else if (req.method === 'POST' && path === '/api/revise') {
      await streamCompletion(req, res, revisionCompletion)
    } else if (req.method === 'POST' && path === '/api/assistant') {
      await streamCompletion(req, res, assistantCompletion, assistantRequestBytes)
    } else if (req.method === 'POST' && path === '/api/memory') {
      await streamCompletion(req, res, memoryCompletion)
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

server.listen(port, '127.0.0.1', () => console.log(`통조림 실행 중 http://127.0.0.1:${port}`))
