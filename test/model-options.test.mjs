import assert from 'node:assert/strict'
import test from 'node:test'
import { embeddingRouteKey, openRouterOptions, validModelOptions, withModelOptions } from '../public/model-options.mjs'
import { exportProject, readProject } from '../public/project-files.mjs'
import { mergeModelSettings, readWorkspace } from '../public/writing-workspace.mjs'

const model = 'google/gemini-4-hydrogen'
const options = {
  reasoning: { effort: 'low' },
  temperature: 0,
  top_p: 1,
  seed: 0,
  stop: ['Coda'],
  provider: {
    zdr: false, only: ['google-vertex'], allow_fallbacks: false,
    max_price: { prompt: 0, completion: 8 },
  },
}

test('기존 요청은 ZDR을 사용하고 명시적으로 끈 설정과 숫자 0은 유지한다', () => {
  assert.deepEqual(openRouterOptions(), { provider: { zdr: true } })
  assert.deepEqual(openRouterOptions({ provider: { sort: 'latency' } }), {
    provider: { zdr: true, sort: 'latency' },
  })
  assert.deepEqual(openRouterOptions(options), options)
  assert.deepEqual(openRouterOptions(options, { embedding: true }), { provider: options.provider })
})

test('모델 ID가 다른 요청에는 해당 모델의 옵션만 선택한다', () => {
  const project = { modelOptions: { [model]: options, 'qa/revise': { temperature: 2 } } }
  assert.deepEqual(withModelOptions(project, { model }), { model, modelOptions: options })
  assert.deepEqual(withModelOptions(project, { model: 'qa/revise' }), {
    model: 'qa/revise', modelOptions: { temperature: 2 },
  })
  assert.deepEqual(withModelOptions(project, { model: 'qa/memory' }), {
    model: 'qa/memory', modelOptions: undefined,
  })
})

test('지원 범위를 벗어난 값과 전달할 수 없는 필드를 거절한다', () => {
  assert.equal(validModelOptions(options), true)
  assert.equal(validModelOptions({ temperature: 2, top_p: 0 }), true)
  for (const invalid of [
    { provider: { zdr: 'false' } }, { provider: { only: ['Google Vertex'] } },
    { provider: { max_price: { prompt: -0.1 } } }, { temperature: 2.01 }, { top_p: -0.01 },
    { seed: 0.5 }, { reasoning: { effort: 'unsupported' } }, { stop: [''] },
    { safetySettings: [] },
  ]) assert.equal(validModelOptions(invalid), false, JSON.stringify(invalid))
})

test('같은 임베딩 라우팅은 색인을 공유하고 변경된 라우팅은 색인을 구분한다', () => {
  const base = 'qwen/qwen3-embedding-4b'
  assert.equal(embeddingRouteKey(base, { temperature: 0, provider: { zdr: true } }), base)
  assert.notEqual(embeddingRouteKey(base, { provider: { zdr: false } }), base)
  assert.equal(
    embeddingRouteKey(base, { provider: { only: ['p/region'], zdr: false, max_price: { prompt: 0, completion: 1 } } }),
    embeddingRouteKey(base, { provider: { zdr: false, max_price: { completion: 1, prompt: 0 }, only: ['p/region'] } }),
  )
  assert.notEqual(
    embeddingRouteKey(base, { provider: { order: ['p', 'q'] } }),
    embeddingRouteKey(base, { provider: { order: ['q', 'p'] } }),
  )
})

test('작품 백업과 열린 집필실에 상세설정을 복원하면서 편집 중 원고를 보존한다', () => {
  const workspace = readWorkspace(null)
  const project = workspace.projects[0]
  const before = JSON.stringify(workspace)
  const next = structuredClone(workspace)
  next.projects[0].modelOptions = { [model]: options }
  const restored = readProject(JSON.stringify(exportProject(next.projects[0])))
  assert.deepEqual(restored.modelOptions, { [model]: options })
  assert.notEqual(restored.id, project.id)

  project.manuscript = '아직 저장하지 않은 원고'
  const after = JSON.stringify(next)
  assert.deepEqual(mergeModelSettings(workspace, before, after), new Set([project.id]))
  assert.equal(workspace.projects[0], project)
  assert.equal(project.manuscript, '아직 저장하지 않은 원고')
  assert.deepEqual(project.modelOptions, { [model]: options })
  assert.deepEqual(mergeModelSettings(workspace, after, after), new Set())
  assert.deepEqual(mergeModelSettings(workspace, after, before), new Set([project.id]))
  assert.equal(project.modelOptions, undefined)
})
