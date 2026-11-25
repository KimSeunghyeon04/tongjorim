import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupPlanProgress } from '../public/plan-progress.mjs'
import { editSceneDocument, insertScene, saveSceneVersion } from '../public/scene-document.mjs'
import { setupSceneReviewJobs } from '../public/scene-review-jobs.mjs'
import { markSceneForReview, pendingLoreChanges } from '../public/scene-review.mjs'
import { makeProject, readWorkspace } from '../public/writing-workspace.mjs'

const gate = '수문은 밤에 열린다.'
const corridor = '회랑은 낮에 열린다.'
const milestone = '수문의 규칙을 발견한다.'
const earlierRule = '수문은 아침에 열린다.'
const unrelated = '나래가 돌아섰다.'
const paragraphs = (...values) => values.join('\n\n')
const quote = `벽에는 ${gate}라고 적혀 있었다.`
const gateEvidence = [{ text: gate, occurrence: 1 }]
const loreProposal = (name, description, evidence) => ({
  id: name, targetId: '', kind: 'world', name, before: '', description, evidence, conflict: false,
})

function reviewedProject(gatePassages = [gate]) {
  const project = makeProject('시험 원고', paragraphs(quote, ...gatePassages, corridor, unrelated))
  const scene = project.savedScenes[0]
  project.synopsis = `${milestone}\n${earlierRule}`
  project.sceneReviews = [{
    sceneId: scene.id, version: scene.accepted, pending: false,
    progress: [{ milestone, evidence: gateEvidence }],
    planChange: { before: earlierRule, after: gate, evidence: gateEvidence },
    lore: [loreProposal('수문', gate, gateEvidence), loreProposal('회랑', corridor, corridor)],
  }]
  return project
}

function editFirstScene(project, text) {
  project.sceneDocument = editSceneDocument(project.sceneDocument, project.savedScenes[0].id, text)
}

test('편집 뒤 온전한 근거의 현재 위치를 복원하고 모호하거나 사라진 근거만 숨긴다', () => {
  let project = reviewedProject()
  assert.deepEqual(pendingLoreChanges(project)[0].passages, [{ start: 27, end: 38, text: gate }])
  editFirstScene(project, paragraphs(quote, gate, corridor, '나래가 돌아섰다!'))
  assert.deepEqual(pendingLoreChanges(project).map(({ proposal }) => proposal.name), ['수문', '회랑'])
  editFirstScene(project, paragraphs('', gate, quote, corridor, '나래가 돌아섰다!'))
  const projects = [project]
  project = readWorkspace(JSON.stringify({ version: 2, activeProjectId: project.id, projects })).projects[0]
  assert.deepEqual(pendingLoreChanges(project).map(({ proposal, passages }) => [proposal.name, passages]), [
    ['수문', [{ start: 2, end: 13, text: gate }]],
    ['회랑', [{ start: 42, end: 53, text: corridor }]],
  ])

  for (const text of [`‘${gate}’라는 말은 거짓이다.`, paragraphs(gate, gate), '수문은 밤에 닫힌다.']) {
    editFirstScene(project, paragraphs(quote, text, corridor))
    assert.deepEqual(pendingLoreChanges(project).map(({ proposal }) => proposal.name), ['회랑'])
  }

  const repeated = reviewedProject([gate, gate])
  assert.equal(pendingLoreChanges(repeated)[0].proposal.name, '수문')
  editFirstScene(repeated, paragraphs(quote, gate, corridor))
  assert.deepEqual(pendingLoreChanges(repeated).map(({ proposal }) => proposal.name), ['회랑'])

  const quoted = reviewedProject()
  quoted.sceneReviews[0].lore[0].evidence = gate
  assert.deepEqual(pendingLoreChanges(quoted)[0].passages, [{ start: 4, end: 15, text: gate }])
  editFirstScene(quoted, paragraphs(gate, quote, corridor))
  assert.deepEqual(pendingLoreChanges(quoted).map(({ proposal }) => proposal.name), ['회랑'])

  const scene = project.savedScenes[0]
  const version = { text: gate, direction: '', parent: 0 }
  project.sceneDocument = saveSceneVersion(project.sceneDocument, scene.id, gate, [...scene.versions, version], 1)
  assert.deepEqual(pendingLoreChanges(project), [])
})

test('줄거리 진행과 제안 반영은 편집 후 현재 원고에서 같은 근거를 확인한다', async t => {
  function element() {
    return {
      children: [],
      append(...children) { this.children.push(...children) },
      replaceChildren(...children) { this.children = children },
    }
  }
  function byText(node, text) {
    if (node.textContent === text) return node
    for (const child of node.children) {
      const match = byText(child, text)
      if (match) return match
    }
  }
  globalThis.document = { createElement: element }
  t.after(() => { delete globalThis.document })
  const fields = new Map(['plan-scene-review', 'plan-milestones', 'plan-scene-suggestion', 'plan-scene-status']
    .map(id => [id, element()]))
  const project = reviewedProject()
  const visited = []
  const { render } = setupPlanProgress({
    get: id => fields.get(id), currentProject: () => project, goToPassage: passage => visited.push(passage),
    async saveWorkspace(change) { change(); return true }, onChange() {},
  })
  editFirstScene(project, paragraphs(gate, quote, corridor))
  render()
  const milestones = fields.get('plan-milestones')
  assert.ok(byText(milestones, milestone))
  byText(milestones, '수문은 밤에 열린다').onclick()
  const suggestions = fields.get('plan-scene-suggestion')
  byText(suggestions, '원고에서 근거 보기').onclick()
  assert.deepEqual(visited, [{ start: 0, end: 11, text: gate }, { start: 0, end: 11, text: gate }])
  const approve = byText(suggestions, '줄거리에 반영')
  editFirstScene(project, paragraphs(quote, corridor))
  await approve.onclick()
  assert.equal(project.synopsis, `${milestone}\n${earlierRule}`)
  assert.equal(milestones.children.length, 0)
  assert.equal(suggestions.children.length, 0)

  editFirstScene(project, paragraphs(gate, quote, corridor))
  render()
  await byText(suggestions, '줄거리에 반영').onclick()
  assert.equal(project.synopsis, `${milestone}\n${gate}`)
  assert.equal(project.sceneReviews[0].planChange, null)
})

const extraction = {
  progress: [{ milestone, completed: true, evidenceIds: [1] }], planChange: null,
  lore: [{ kind: 'world', name: '수문', fact: gate, evidenceIds: [1], scope: 'durable' }],
}
const resolution = {
  progress_1: { missingPrerequisite: '' },
  lore_1: { scope: 'standing_rule', card: 0, replaces: 0, affectsContinuity: true },
}

function reply(content) {
  return new Response(JSON.stringify({ type: 'text', content: JSON.stringify(content) }) + '\n' +
    JSON.stringify({ type: 'done' }) + '\n')
}

test('채택 후 직접 편집된 대기 장면은 AI 검토에 보내지 않는다', t => {
  const project = makeProject('시험 원고', gate)
  markSceneForReview(project, project.savedScenes[0])
  editFirstScene(project, paragraphs(gate, unrelated))
  const fetch = t.mock.method(globalThis, 'fetch', async () => reply(extraction))
  const jobs = setupSceneReviewJobs({ hasProject: () => true, onChange() {} })
  jobs.start(project)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(project.sceneReviews[0].pending, true)
})

test('새 검토는 편집 후에도 근거가 있는 이전 줄거리 진행과 로어북 제안을 중복 생성하지 않는다', { timeout: 5000 }, async t => {
  const project = reviewedProject()
  editFirstScene(project, paragraphs(gate, corridor, '나래가 돌아섰다!'))
  const added = insertScene(project.sceneDocument)
  project.sceneDocument = saveSceneVersion(added.document, added.focus, gate,
    [...added.document.scenes[added.focus].versions, { text: gate, direction: '', parent: 0 }], 1)
  markSceneForReview(project, project.savedScenes.at(-1))
  const completed = Promise.withResolvers()
  const responses = [extraction, resolution]
  t.mock.method(globalThis, 'fetch', async () => reply(responses.shift()))
  const jobs = setupSceneReviewJobs({
    hasProject: () => true,
    async saveWorkspace(change) { change(); return true },
    onChange() {
      if (jobs.visibleError(project)) completed.reject(new Error(jobs.visibleError(project)))
      else if (!project.sceneReviews.at(-1).pending) completed.resolve(project.sceneReviews.at(-1))
    },
  })
  jobs.start(project)
  const review = await completed.promise
  assert.equal(responses.length, 0)
  assert.deepEqual(review.progress, [])
  assert.deepEqual(review.lore, [])
  assert.deepEqual(pendingLoreChanges(project).map(({ proposal }) => proposal.name), ['수문', '회랑'])
})

test('두 검토 응답 대기 중 각각 원고가 달라지면 이전 결과를 저장하지 않는다', { timeout: 5000 }, async t => {
  for (const stage of [1, 2]) {
    await t.test(`${stage}차 응답 대기 중 편집`, async t => {
      const project = makeProject('시험 원고', paragraphs(gate, corridor))
      project.synopsis = milestone
      markSceneForReview(project, project.savedScenes[0])
      const requested = Promise.withResolvers()
      const respond = Promise.withResolvers()
      const finished = Promise.withResolvers()
      const requests = []
      t.mock.method(globalThis, 'fetch', async (_path, { body }) => {
        requests.push(JSON.parse(body))
        if (requests.length === stage) {
          requested.resolve()
          await respond.promise
        }
        return reply(requests.length === 1 ? extraction : resolution)
      })
      const jobs = setupSceneReviewJobs({
        hasProject: () => true,
        async saveWorkspace(change) { change(); return true },
        onChange() {
          if (jobs.visibleError(project) || !project.sceneReviews[0].pending) finished.resolve()
        },
      })
      jobs.start(project)
      await requested.promise
      editFirstScene(project, paragraphs(gate, '회랑은 낮에 열린다!'))
      respond.resolve()
      await finished.promise
      assert.equal(requests.length, stage)
      assert.deepEqual(requests.map(({ scene }) => scene), Array(stage).fill(paragraphs(gate, corridor)))
      assert.equal(project.sceneReviews[0].pending, true)
      assert.deepEqual(project.sceneReviews[0].progress, [])
      assert.deepEqual(project.sceneReviews[0].lore, [])
      assert.match(jobs.visibleError(project), /원고가 바뀌었/)
    })
  }
})
