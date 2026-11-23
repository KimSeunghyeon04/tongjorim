import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultReferenceSettings, exportPack, exportProject, readPack, readProject } from '../public/project-files.mjs'
import { memoryForPrompt, memoryRequest, setManuscriptText, updateManuscriptMemory } from '../public/manuscript-memory.mjs'
import { applyMemoryUpdate, manuscriptMemoryPayload } from '../public/memory-knowledge.mjs'
import { numberedPassages } from '../public/numbered-passages.mjs'
import { forgetSceneUndo, manuscriptEdit, reconcileSceneUndo, rememberUndoneComposition, sceneHistoryReplay } from '../public/manuscript-scenes.mjs'
import { activeLore, chunkManuscript, rankPast, retrievalInput, searchPast } from '../public/retrieval.mjs'
import { actualUsage, combineUsage, estimateUsage } from '../public/request-tools.mjs'
import { evidenceInScene, markSceneForReview, parseSceneReview, pendingLoreChanges, planReplacement,
  resolveSceneReview, sceneResolutionInput, sceneReviewPayload } from '../public/scene-review.mjs'
import { planWritingContext } from '../public/writing-context.mjs'
import { projectNotesForRequest, sourceLimitsFor, writingFieldPrefix } from '../public/writing-config.mjs'
import { mergeModelSettings, readWorkspace, workspaceMatchesSnapshot } from '../public/writing-workspace.mjs'
import { manuscript, passages, queries } from '../scripts/retrieval-fixture.mjs'

test('원문 한도와 검색 범위, 출력 예약을 뺀 컨텍스트와 비용이 함께 바뀐다', () => {
  const project = {
    title: '', direction: '', manuscript: `earlier\n\n${'A'.repeat(35)}\n\n🧭`, model: 'qa/write', maxTokens: 1024, systemPrompt: 's',
  }
  const model = { contextLength: 1180, input: 0.001, output: 0.002, request: 0.003 }
  const refs = ['manuscript', 'pastPassages']
  const limits = { manuscript: 99, pastPassages: 99 }
  const large = planWritingContext(project, refs, model, limits)
  const getRank = plan => {
    const { chunks, query, intent } = retrievalInput(project.manuscript, 'earlier', true, { cutoff: plan.cutoff })
    return rankPast(chunks, query, undefined, intent)
  }
  const fitted = large.finish([{ start: 9, end: 44, text: 'A'.repeat(35) }])
  // System message costs 2 tokens. The empty user message is 73 ASCII bytes.
  // Reserving 1,024 output and 128 spare leaves 28 input tokens, so the user message can grow to 104 bytes.
  assert.equal(fitted.body.draft.manuscript, '🧭')
  assert.equal(fitted.cutoff, 46)
  assert.equal(fitted.originalBudget, 7)
  assert.equal(fitted.remaining, 6)
  assert.equal(fitted.recentReduced, true)
  assert.equal(fitted.pastReduced, true)
  assert.deepEqual(fitted.hits, [])

  const small = planWritingContext(project, refs, model, { manuscript: 2, pastPassages: 16 })
  const before = small.finish(getRank(small))
  assert.equal(before.body.draft.manuscript, '🧭')
  assert.equal(before.remaining, 6)
  assert.equal(before.body.draft.pastPassages, '')
  const expanded = planWritingContext(project, refs, model, { manuscript: 2, pastPassages: 17 })
  const after = expanded.finish(getRank(expanded))
  assert.equal(after.body.draft.pastPassages, '[원고 1–7자]\nearlier')
  assert.deepEqual(after.hits.map(({ start, end }) => [start, end]), [[0, 7]])
  assert.equal(after.usage.inputTokens, 28)
  assert.equal(after.remaining, 0)
  assert.equal(Number((after.usage.cost - before.usage.cost).toFixed(6)), 0.006)
})

test('이어쓰기는 마지막 미등록 문단 전체가 들어가는 한도에서만 최근 원문을 보낸다', () => {
  const latest = `${'A'.repeat(35)}🧭`
  const project = {
    title: '', direction: '', manuscript: `earlier\n\n${latest}`, model: 'qa/write', maxTokens: 1024, systemPrompt: 's',
  }
  const refs = ['manuscript', 'pastPassages']
  const plan = (contextLength, manuscript = 37) => planWritingContext(
    project, refs, { contextLength }, { manuscript, pastPassages: 99 },
  )
  // 1,024 output tokens and 128 spare leave 29 or 30 for input.
  // The system message costs 2 tokens and the 112-byte user message costs 28.
  const tooSmall = plan(1181)
  const blocked = tooSmall.finish()
  assert.equal(blocked.body.draft.manuscript, '')
  assert.equal(blocked.cutoff, 46)
  assert.equal(tooSmall.canFitPast, false)
  assert.match(blocked.recentWarning, /^모델 컨텍스트에 마지막 문단 전체를 담을 수 없어요\./)

  const exact = plan(1182).finish()
  assert.equal(exact.body.draft.manuscript, latest)
  assert.equal(exact.cutoff, 9)
  assert.equal(exact.usage.inputTokens, 30)
  assert.equal(exact.remaining, 0)
  assert.equal(exact.recentWarning, '')

  const belowCharLimit = plan(1182, 36).finish()
  assert.equal(belowCharLimit.body.draft.manuscript, '')
  assert.match(belowCharLimit.recentWarning, /^마지막 문단은 37자로, 최근 원문 한도 36자를 넘어요\./)
})

test('이어쓰기는 잘린 장면을 통째로 요약 범위에 두고 마지막 장면은 분할하지 않는다', () => {
  const first = '수문.\n\n열쇠.'
  const latest = '나래.'
  const project = {
    title: '', direction: '', manuscript: first + '\n\n' + latest, model: 'qa/write', maxTokens: 100,
    savedScenes: [
      { range: { start: 10, end: 13 } },
      { range: { start: 0, end: 8 } },
    ],
  }
  const plan = limit => planWritingContext(project, ['manuscript'], null, { manuscript: limit, pastPassages: 0 }).finish()
  assert.equal(plan(7).body.draft.manuscript, latest)
  assert.equal(plan(7).cutoff, 10)
  assert.equal(plan(3).body.draft.manuscript, latest)
  assert.equal(plan(3).recentWarning, '')
  assert.equal(plan(2).body.draft.manuscript, '')
  assert.equal(plan(2).recentWarning, '마지막 장면은 3자로, 최근 원문 한도 2자를 넘어요. 한도를 늘리거나 마지막 장면을 나눠 주세요.')
  assert.equal(plan(0).recentWarning, '')
})

test('장면 검토 결과는 원문 근거와 줄거리 문구가 있는 항목을 보존하고 카드 승인 전까지 대기한다', () => {
  const evidence = '수문은 밀물에만 열린다.'
  const first = '벽의 낙서에 수문은 밀물에만 열린다. 라고 적혀 있었다.'
  const corridor = '동쪽 회랑은 낮에만 출입할 수 있다.'
  const sceneText = [first, evidence, corridor].join('\n\n')
  const synopsis = '1. 수문 규칙을 발견한다.\n수문은 썰물에 열린다.'
  const card = { id: 'gate', kind: 'world', name: '수문', aliases: [], description: '썰물에 열린다. 수문은 직원이 지킨다.', priority: 0, always: false }
  const scene = { id: 'scene', title: '발견', range: { start: 3, end: 3 + sceneText.length }, accepted: 0,
    versions: [{ text: sceneText, direction: '', parent: null }] }
  const project = {
    id: 'work', title: '시험', model: 'qa/write', maxTokens: 500, direction: '', synopsis,
    manuscript: '앞.\n' + sceneText, savedScenes: [scene], lorebook: [card],
  }
  markSceneForReview(project, scene)
  assert.equal(project.sceneReviews[0].pending, true)
  const suggestion = { kind: 'world', name: '수문', fact: '밀물에만 열린다.', evidenceIds: [2], scope: 'durable' }
  const input = { model: 'qa/plan', projectTitle: '시험', synopsis, scene: sceneText, cards: [card] }
  const sent = JSON.parse(sceneReviewPayload(input).messages[1].content)
  assert.deepEqual(sent.scene, [{ id: 1, text: first }, { id: 2, text: evidence }, { id: 3, text: corridor }])
  assert.equal(sent.cards, undefined)
  const result = parseSceneReview(JSON.stringify({
    progress: [
      { milestone: '수문 규칙을 발견한다.', completed: true, evidenceIds: [2, 1] },
      { milestone: '수문 규칙을 발견한다.', completed: true, evidenceIds: [2, 99] },
      { milestone: '수문은 썰물에 열린다.', completed: false, evidenceIds: [1] },
      { milestone: '근거 없는 전개', completed: true, evidenceIds: [1] },
    ],
    planChange: { before: '수문은 썰물에 열린다.', after: evidence, evidenceIds: [2] },
    lore: [
      suggestion, { ...suggestion, name: '동쪽 회랑', fact: corridor, evidenceIds: [3] }, { ...suggestion, evidenceIds: [4] },
      { ...suggestion, scope: 'temporary', fact: '수문에서 발을 뗐다.' },
      { ...suggestion, fact: '게시문은 훼손하면 안 된다.' },
    ],
  }), input)
  assert.deepEqual(result.progress, [{ milestone: '1. 수문 규칙을 발견한다.', evidence: [{ text: first, occurrence: 0 }, { text: evidence, occurrence: 1 }] }])
  assert.equal(planReplacement(synopsis, result.planChange), '1. 수문 규칙을 발견한다.\n수문은 밀물에만 열린다.')
  assert.equal(planReplacement(synopsis + ' ' + synopsis, result.planChange), null)
  const resolution = JSON.parse(sceneReviewPayload({ ...input, ...sceneResolutionInput(result) }).messages[1].content)
  assert.deepEqual(resolution.scene, sent.scene)
  assert.equal(resolution.synopsis, undefined)
  assert.deepEqual(resolution.candidates.map(item => item.matchingCards), [[1], [], [1]])
  assert.deepEqual(resolution.candidates[0].evidence, [evidence])
  assert.deepEqual(resolution.cards[0].description, [{ id: 1, text: '썰물에 열린다.' }, { id: 2, text: '수문은 직원이 지킨다.' }])
  const verdicts = {
    progress_1: { missingPrerequisite: '' },
    progress_2: { missingPrerequisite: '' },
    lore_1: { scope: 'standing_rule', card: 1, replaces: 1, fact: '모델이 바꾸려 한 내용' },
    lore_2: { scope: 'standing_rule', card: -1, replaces: 0 },
    lore_3: { scope: 'standing_rule', card: 1, replaces: 0 },
    lore_4: { scope: 'temporary', card: 0, replaces: 0 },
  }
  const { lore, progress } = resolveSceneReview(result, input, JSON.stringify(verdicts))
  assert.deepEqual(progress, result.progress)
  const prerequisite = { progress: [{ ...result.progress[0], milestone: '자정에 수문을 연다.' }], candidates: [] }
  assert.deepEqual(resolveSceneReview(prerequisite, input, JSON.stringify({ progress_1: { missingPrerequisite: '자정' } })).progress, [])
  assert.deepEqual(resolveSceneReview(prerequisite, input, JSON.stringify({ progress_1: { missingPrerequisite: '아침' } })).progress, prerequisite.progress)
  assert.deepEqual(resolveSceneReview(prerequisite, { ...input, scene: '자정에 수문이 열렸다.' },
    JSON.stringify({ progress_1: { missingPrerequisite: '자정' } })).progress, prerequisite.progress)
  const { lore_2, ...missingVerdict } = verdicts
  assert.equal(lore_2.scope, 'standing_rule')
  assert.throws(() => resolveSceneReview(result, input, JSON.stringify(missingVerdict)), /근거 대조 결과/)
  assert.deepEqual(lore.map(item => item.description), [
    '밀물에만 열린다. 수문은 직원이 지킨다.', corridor, '썰물에 열린다. 수문은 직원이 지킨다.\n\n게시문은 훼손하면 안 된다.',
  ])
  const temporaryCandidate = { kind: 'character', name: '나래', fact: '나래가 잠시 손을 놓았다.', evidence: result.candidates[0].evidence }
  const withTemporary = resolveSceneReview({ ...result, candidates: [...result.candidates, temporaryCandidate] }, input, JSON.stringify(verdicts))
  assert.deepEqual(withTemporary.lore.map(item => item.description), lore.map(item => item.description))
  project.sceneReviews[0] = { ...project.sceneReviews[0], progress, planChange: result.planChange, lore, pending: false }
  const restored = readProject(JSON.stringify(exportProject(project)))
  assert.equal(restored.lorebook[0].description, '썰물에 열린다. 수문은 직원이 지킨다.')
  assert.deepEqual(restored.sceneReviews, project.sceneReviews)
  const start = 5 + first.length
  assert.deepEqual(pendingLoreChanges(restored)[0].passages, [{ start, end: start + evidence.length, text: evidence }])
  assert.deepEqual(evidenceInScene({ text: sceneText, start: 3 }, evidence), [{ start: 10, end: 10 + evidence.length, text: evidence }])
  restored.manuscript = restored.manuscript.replace('밀물', '썰물')
  assert.deepEqual(pendingLoreChanges(restored).map(item => item.proposal.name), ['동쪽 회랑'])
})

test('근거 번호는 긴 문단의 이모지를 자르지 않고 원문 위치를 유지한다', () => {
  const first = '가'.repeat(799)
  assert.deepEqual(numberedPassages(first + '🧭끝'), [
    { id: 1, start: 0, text: first }, { id: 2, start: 799, text: '🧭끝' },
  ])
})

test('인물 지식은 후속 메모가 생략해도 유지하고 이번 원문에 있는 변경만 적용한다', async t => {
  const fact = '황동 열쇠 손잡이에 별 모양 균열이 있다.'
  const original = { fact, knows: ['나래'], unaware: ['현도'], exclusive: true }
  const first = '나래만 균열을 보고 현도에게 말하지 않았다.'
  const quiet = '현도는 등대 문을 닫았다.'
  const informed = '나래는 현도에게 열쇠의 균열을 보여 주었다.'
  const manuscript = [first, quiet, informed].join('\n\n')
  const project = { id: 'memory', title: '등대', model: 'qa/memory', maxTokens: 100, manuscript, synopsis: '', direction: '',
    notePrompts: { memory: '짧게 정리해.' } }
  const replies = [
    { summary: '열쇠를 발견했다.', knowledgeChanges: [
      { id: 0, ...original, unaware: ['현도', '다른 인물'], source: 'excerpt', evidenceIds: [1] },
    ] },
    { summary: '등대 문이 닫혔다.', knowledgeChanges: [{ id: 1, ...original, knows: ['현도'], unaware: [], source: 'excerpt', evidenceIds: [2] }] },
    { summary: '두 사람이 확인했다.', knowledgeChanges: [{ id: 1, ...original, knows: ['나래', '현도'], unaware: [], source: 'excerpt', evidenceIds: [1] }] },
    '손상된 응답',
  ]
  const sent = []
  t.mock.method(globalThis, 'fetch', async (_path, { body }) => {
    sent.push(JSON.parse(body))
    const reply = replies[sent.length - 1]
    return new Response(JSON.stringify({ type: 'text', content: typeof reply === 'string' ? reply : JSON.stringify(reply) }) + '\n' +
      JSON.stringify({ type: 'done', truncated: false }) + '\n')
  })
  const checkpoint = value => { project.manuscriptMemory = value }
  const controller = new AbortController()
  await updateManuscriptMemory(project, first + '\n\n', controller.signal, checkpoint, () => {})
  await updateManuscriptMemory(project, first + '\n\n' + quiet + '\n\n', controller.signal, checkpoint, () => {})
  assert.match(memoryForPrompt(project), /균열이 있다\. · 나래만 앎 · 현도 모름/)
  await updateManuscriptMemory(project, manuscript, controller.signal, checkpoint, () => {})
  assert.equal(sent[1].excerpt, quiet + '\n\n')
  assert.deepEqual(sent[2].knowledge, [original])
  assert.deepEqual(project.manuscriptMemory.knowledge, [{ ...original, knows: ['나래', '현도'], unaware: [] }])
  const payload = manuscriptMemoryPayload({ ...memoryRequest(project), excerpt: informed })
  assert.equal(payload.response_format, undefined)
  assert.ok(payload.messages[0].content.startsWith('짧게 정리해.'))
  assert.deepEqual(JSON.parse(payload.messages[1].content).excerpt, [{ id: 1, text: informed }])
  const legacy = manuscriptMemoryPayload({ ...memoryRequest(project), excerpt: informed, knowledge: undefined })
  assert.equal(JSON.parse(legacy.messages[1].content).excerpt, informed)
  const restored = readProject(JSON.stringify(exportProject(project)))
  assert.equal(memoryForPrompt(restored), memoryForPrompt(project))
  assert.deepEqual(restored.manuscriptMemory, project.manuscriptMemory)
  const last = project.manuscriptMemory
  project.manuscript += '\n\n나래는 등을 돌렸다.'
  await assert.rejects(updateManuscriptMemory(project, project.manuscript, controller.signal, checkpoint, () => {}), /응답 형식/)
  assert.equal(project.manuscriptMemory, last)
  assert.throws(() => applyMemoryUpdate(JSON.stringify({ summary: '가'.repeat(8000), knowledgeChanges: [] }),
    { memory: '', excerpt: quiet, knowledge: [original] }), /합친 원고 메모가 너무 길어요/)
  const oldChange = JSON.stringify({ summary: quiet, knowledgeChanges: [{ id: 0, ...original, source: 'memory', evidenceIds: [1] }] })
  assert.deepEqual(applyMemoryUpdate(oldChange, { memory: first, excerpt: quiet, knowledge: null }).knowledge, [original])
  assert.deepEqual(applyMemoryUpdate(oldChange, { memory: first, excerpt: quiet, knowledge: [] }).knowledge, [])
})

test('초안 수정은 앞뒤 원고에 한도를 나눠 쓰고 검색 결과를 남은 예산에 맞춘다', () => {
  const project = {
    title: '계단', direction: '처음 지시', manuscript: '열쇠는 계단 아래에 숨겨졌다.\n\nBEFORE',
    model: 'qa/write', maxTokens: 128, systemPrompt: 's',
  }
  const scene = { text: '그녀는 방 안으로 들어갔다.', direction: '계단 아래에', following: 'AFTER' }
  const plan = (references, manuscript, contextLength = 1024, pastPassages = 100) => planWritingContext(
    project, references, { contextLength }, { manuscript, pastPassages }, undefined, scene,
  )
  const refs = ['pastPassages', 'manuscript']
  const prepared = plan(refs, 6)
  const result = prepared.finish([{ start: 0, end: 16, text: '열쇠는 계단 아래에 숨겨졌다.' }])
  assert.equal(prepared.canFitPast, true)
  assert.equal(result.body.draft.manuscript, 'ORE')
  assert.equal(result.body.draft.pastPassages, '[원고 1–16자]\n열쇠는 계단 아래에 숨겨졌다.')
  assert.deepEqual(result.body.sceneRevision, { ...scene, following: 'AFT' })
  const excluded = plan(['pastPassages'], 6).finish()
  assert.equal(Object.hasOwn(excluded.body.draft, 'manuscript'), false)
  assert.equal(Object.hasOwn(excluded.body.sceneRevision, 'following'), false)
  assert.equal(plan(refs, 0).finish().body.draft.manuscript, '')
  assert.equal(Object.hasOwn(plan(refs, 0).finish().body.sceneRevision, 'following'), false)
  assert.equal(plan(refs, 6, 256).canFitPast, false)
  assert.equal(retrievalInput(project.manuscript, scene.direction, true,
    { recentManuscript: scene.text, recentLimit: 0 }).query, scene.direction)
})

test('수정 이력은 입력 예산에 포함되고 한도를 넘겨도 일부 이력만 보내지 않는다', () => {
  const project = { title: '창가', direction: '', manuscript: '', model: 'qa/write', maxTokens: 128 }
  const scene = { text: '불이 꺼졌다.', direction: '이전 문장을 살려 줘.' }
  const removed = '아주 멀리 흔들리는 불빛을 오래 바라보았다. '.repeat(500)
  const history = [
    { fromVersion: 1, toVersion: 2, direction: '등불 묘사를 빼 줘.', diff: `@@ -0,${removed.length} +0,0 @@\n- ${removed}` },
    { fromVersion: 2, toVersion: 4, direction: '불빛을 줄여 줘.', diff: '@@ -0,2 +0,1 @@\n- 등불\n+ 불' },
  ]
  const prepare = revision => planWritingContext(project, [], { contextLength: 1024 },
    { manuscript: 0, pastPassages: 0 }, [], revision).finish()
  assert.ok(prepare(scene).remaining > 0)
  const result = prepare({ ...scene, history })
  assert.ok(result.remaining < 0)
  assert.deepEqual(result.body.sceneRevision, { ...scene, history })
})

test('장면 분량은 참고 자료 없이도 요청에 포함되고 비어 있으면 생략된다', () => {
  const project = { title: '저편', direction: '문을 열어', manuscript: '', model: 'qa/write', maxTokens: 1024 }
  const request = sceneLength => planWritingContext({ ...project, sceneLength }, [], null,
    { manuscript: 0, pastPassages: 0 }).finish().body

  const body = request('  1,500~2,000자  ')
  assert.deepEqual(body.draft, { projectTitle: '저편', direction: '문을 열어', sceneLength: '1,500~2,000자' })
  assert.equal(body.maxTokens, 1024)
  assert.deepEqual(request('  ').draft, { projectTitle: '저편', direction: '문을 열어' })
  assert.deepEqual(request(undefined).draft, { projectTitle: '저편', direction: '문을 열어' })
})

test('앞쪽 입력과 장면 내부 편집은 장면 위치를 옮기고 경계를 가로지르면 재확인하게 한다', () => {
  const project = {
    manuscript: 'P\n\nABC\n\nDEF\n\nQ',
    savedScenes: [{ id: 'one', range: { start: 3, end: 6 } }, { id: 'two', range: { start: 8, end: 11 } }],
  }
  const locations = () => project.savedScenes.map(({ range }) => range)
  const insert = 'X\n\n' + project.manuscript
  setManuscriptText(project, insert, manuscriptEdit(project.manuscript, insert, { start: 0, end: 0, caret: 3 }))
  assert.deepEqual(locations(), [{ start: 6, end: 9 }, { start: 11, end: 14 }])
  setManuscriptText(project, 'X\n\nP\n\nA별빛C\n\nDEF\n\nQ', { start: 7, end: 8, inserted: '별빛' })
  assert.deepEqual(locations(), [{ start: 6, end: 10 }, { start: 12, end: 15 }])
  assert.equal(project.manuscript.slice(6, 10), 'A별빛C')
  assert.equal(project.manuscript.slice(12, 15), 'DEF')
  setManuscriptText(project, 'X\n\nP\n!별빛C\n\nDEF\n\nQ', { start: 5, end: 7, inserted: '!' })
  assert.deepEqual(locations(), [null, { start: 11, end: 14 }])
  assert.equal(project.manuscript.slice(11, 14), 'DEF')
})

test('장면 끝의 이어진 문장과 다음 문단을 구별하고 겹쳐 보이는 삭제는 위치를 확인한다', () => {
  const project = { manuscript: 'AAA', savedScenes: [{ range: { start: 0, end: 3 } }] }
  setManuscriptText(project, 'AAA!', { start: 3, end: 3, inserted: '!' })
  setManuscriptText(project, 'AAA!?\n\n새 장면', { start: 4, end: 4, inserted: '?\n\n새 장면' })
  assert.deepEqual(project.savedScenes[0].range, { start: 0, end: 5 })
  const before = 'AAAAAA'
  const after = 'AAAA'
  assert.deepEqual(manuscriptEdit(before, after), { start: 4, end: 6, inserted: '', earliest: 0 })
  assert.deepEqual(manuscriptEdit(before, after, { start: 0, end: 2, caret: 0 }), { start: 0, end: 2, inserted: '' })
  const ambiguous = { manuscript: before, savedScenes: [{ range: { start: 3, end: 6 } }] }
  setManuscriptText(ambiguous, after)
  assert.equal(ambiguous.savedScenes[0].range, null)
})

test('장면 시작의 같은 줄을 포함하고 인접 장면 사이의 삽입은 줄을 기준으로 나눈다', () => {
  const first = { id: 'first', range: { start: 0, end: 3 } }
  const second = { id: 'second', range: { start: 3, end: 6 } }
  const project = { manuscript: 'ABCDEF', savedScenes: [first, second] }
  setManuscriptText(project, 'ABCx\ny\nzDEF', { start: 3, end: 3, inserted: 'x\ny\nz' })
  assert.deepEqual(project.savedScenes.map(({ range }) => range), [{ start: 0, end: 4 }, { start: 7, end: 11 }])
  setManuscriptText(project, '앞 줄\n첫ABCx\ny\nzDEF', { start: 0, end: 0, inserted: '앞 줄\n첫' })
  assert.deepEqual(project.savedScenes.map(({ range }) => project.manuscript.slice(range.start, range.end)), ['첫ABCx', 'zDEF'])
  const shared = { manuscript: 'ABCDEF', savedScenes: [first, second] }
  setManuscriptText(shared, 'ABCxDEF', { start: 3, end: 3, inserted: 'x' })
  assert.deepEqual(shared.savedScenes.map(({ range }) => range), [null, null])
})

test('되돌리기가 경계 편집을 복원하면 장면 위치도 돌아오고 명시적으로 버린 위치는 복원하지 않는다', () => {
  const range = { start: 3, end: 6 }
  const valid = [{ id: 'scene', range }]
  const invalid = [{ id: 'scene', range: null }]
  const history = []
  const before = 'P\n\nABC\n\nQ'
  const after = 'P\n_ BC\n\nQ'
  const edit = manuscriptEdit(before, after)
  const reverse = (inputType, from, to, prior, result) => {
    const replay = sceneHistoryReplay(history, from, to, inputType)
    return reconcileSceneUndo(history, from, to, prior, result, inputType, replay?.edit, replay)
  }
  reconcileSceneUndo(history, before, after, valid, invalid, 'insertText', edit)
  assert.deepEqual(reverse('historyUndo', after + '.', before, invalid, invalid), invalid)
  reconcileSceneUndo(history, before, after, valid, invalid, 'insertText', edit)
  assert.deepEqual(reverse('historyUndo', after, before, invalid, invalid), valid)
  assert.deepEqual(reverse('historyRedo', before, after, valid, invalid), invalid)
  forgetSceneUndo(history, 'scene')
  assert.deepEqual(reverse('historyUndo', after, before, invalid, invalid), invalid)
})

test('한글 조합을 즉시 되돌렸다가 다시 실행하면 같은 글자가 겹쳐도 장면의 원래 경계를 사용한다', () => {
  const history = []
  const before = '가가나'
  const after = '가가가나'
  const scene = { id: 'scene', range: { start: 1, end: 3 } }
  const project = { manuscript: before, savedScenes: [scene] }
  rememberUndoneComposition(history, before, after, project.savedScenes, { start: 1, end: 1, caret: 2 })
  assert.deepEqual(project.savedScenes, [{ id: 'scene', range: { start: 1, end: 3 } }])
  const replay = sceneHistoryReplay(history, before, after, 'historyRedo')
  setManuscriptText(project, after, replay?.edit)
  project.savedScenes = reconcileSceneUndo(history, before, after, [scene], project.savedScenes, 'historyRedo', replay?.edit, replay)
  assert.deepEqual(project.savedScenes, [{ id: 'scene', range: { start: 1, end: 4 } }])
  assert.equal(project.manuscript.slice(project.savedScenes[0].range.start, project.savedScenes[0].range.end), '가가나')
})

test('여러 차례 경계 편집을 되돌려도 장면 밖의 말과 따옴표는 밖에 남는다', () => {
  const history = []
  const project = { manuscript: 'P “ABC”', savedScenes: [{ id: 'scene', range: { start: 3, end: 6 } }] }
  const edit = (start, end, inserted, inputType = 'insertText') => {
    const before = project.manuscript
    const prior = project.savedScenes
    const next = before.slice(0, start) + inserted + before.slice(end)
    const replay = sceneHistoryReplay(history, before, next, inputType)
    const edit = replay?.edit ?? { start, end, inserted }
    setManuscriptText(project, next, edit)
    project.savedScenes = reconcileSceneUndo(history, before, next, prior, project.savedScenes, inputType, edit, replay)
  }
  edit(2, 3, '')
  edit(1, 2, '')
  edit(1, 1, ' ', 'historyUndo')
  assert.deepEqual(project.savedScenes[0].range, { start: 2, end: 5 })
  edit(2, 2, '“', 'historyUndo')
  assert.deepEqual(project.savedScenes[0].range, { start: 3, end: 6 })
  edit(3, 3, '새 줄\n앞')
  edit(3, 8, '', 'historyUndo')
  assert.equal(project.manuscript, 'P “ABC”')
  assert.deepEqual(project.savedScenes[0].range, { start: 3, end: 6 })
  edit(3, 3, '새 줄\n앞', 'historyRedo')
  assert.deepEqual(project.savedScenes[0].range, { start: 7, end: 11 })
  assert.equal(project.manuscript.slice(7, 11), '앞ABC')
})

test('Undo로 복원한 텍스트를 편집 후 등록한 장면이 흡수하지 않는다', () => {
  const history = []
  const project = { manuscript: '문장. ABCDEF Q', savedScenes: [{ id: 'original', range: { start: 4, end: 7 } }] }
  const step = (value, edit, type) => {
    const before = project.manuscript
    const prior = project.savedScenes
    const replay = sceneHistoryReplay(history, before, value, type)
    setManuscriptText(project, value, replay?.edit ?? edit)
    project.savedScenes = reconcileSceneUndo(history, before, value, prior, project.savedScenes, type, replay?.edit ?? edit, replay)
  }
  step('very long replacement EF Q', { start: 0, end: 8, inserted: 'very long replacement ' }, 'insertText')
  assert.equal(project.savedScenes[0].range, null)
  project.savedScenes.push({ id: 'registered', range: { start: 0, end: 24 } })
  step('문장. ABCDEF Q', undefined, 'historyUndo')
  assert.deepEqual(project.savedScenes, [
    { id: 'original', range: { start: 4, end: 7 } }, { id: 'registered', range: null },
  ])
})

test('반복된 본문에서 경계를 바꾸지 않은 편집도 Undo와 Redo 순서에 반영된다', () => {
  const history = []
  const project = { manuscript: 'aaaaa', savedScenes: [{ id: 'scene', range: { start: 1, end: 2 } }] }
  function step(value, edit, type = 'insertText') {
    const before = project.manuscript
    const prior = project.savedScenes
    const replay = sceneHistoryReplay(history, before, value, type)
    const operation = replay?.edit ?? edit
    setManuscriptText(project, value, operation)
    project.savedScenes = reconcileSceneUndo(history, before, value, prior, project.savedScenes, type, operation, replay)
  }
  step('aaaaaa', { start: 1, end: 1, inserted: 'a' })
  step('aaaaa', { start: 5, end: 6, inserted: '' })
  step('aaaaaa', { start: 5, end: 5, inserted: 'a' })
  step('aaaaa', undefined, 'historyUndo')
  assert.deepEqual(project.savedScenes[0].range, { start: 1, end: 3 })
  step('aaaaaa', undefined, 'historyUndo')
  step('aaaaa', undefined, 'historyUndo')
  assert.deepEqual(project.savedScenes[0].range, { start: 1, end: 2 })
  step('aaaaaa', undefined, 'historyRedo')
  assert.deepEqual(project.savedScenes[0].range, { start: 1, end: 3 })
})

test('장면 수정의 자동 로어북은 앞 원고와 초안의 대상을 각각 찾는다', () => {
  const card = (name, aliases = []) => ({ id: name, name, aliases, kind: 'character', description: name, priority: 0 })
  const project = {
    title: '예시', direction: '처음 지시', manuscript: '은별이 복도에서 기다렸다.',
    model: 'qa/write', maxTokens: 128, lorebook: [card('은별'), card('수현'), card('경계', ['기다렸다.\n그는'])],
  }
  const revision = { text: '그는 조용히 고개를 끄덕였다. 수현은 돌아섰다.', direction: '행동을 더 짧게 써 줘.' }
  const plan = references => planWritingContext(project, references, null,
    { manuscript: 300, pastPassages: 0 }, [], revision).finish()
  assert.deepEqual(plan(['manuscript', 'lorebook']).lore.filter(card => card.included).map(card => card.name), ['은별', '수현'])
  assert.equal(Object.hasOwn(plan(['manuscript']).body.draft, 'lorebook'), false)
})

test('작품 백업은 장면 버전과 위치를 복원하고 줄바꿈을 원고에 맞춘다', () => {
  const project = {
    id: 'scene-backup', title: '계단', synopsis: '', model: 'qa/write', maxTokens: 512,
    manuscript: 'AA\r\n\r\nBBB\r\nC\r\n\r\nD', direction: '',
    savedScenes: [{
      id: 'scene-1', title: '계단 위', range: { start: 6, end: 12 },
      versions: [
        { text: 'BBB\r\nC', direction: '', parent: null, source: 'registered' },
        { text: 'EEE\r\nF', direction: '마지막 줄을 고쳐 줘.', parent: 0, truncated: true },
      ],
      accepted: 0,
    }],
  }
  const backup = exportProject(project)
  const restored = readProject(JSON.stringify(backup))
  assert.equal(restored.manuscript, 'AA\n\nBBB\nC\n\nD')
  assert.deepEqual(restored.savedScenes, [{
    id: 'scene-1', title: '계단 위', range: { start: 4, end: 9 },
    versions: [
      { text: 'BBB\nC', direction: '', parent: null, source: 'registered' },
      { text: 'EEE\nF', direction: '마지막 줄을 고쳐 줘.', parent: 0, truncated: true },
    ], accepted: 0,
  }])
  backup.project.savedScenes[0].versions[1].parent = 1
  assert.throws(() => readProject(JSON.stringify(backup)), /원고나 작품 설정의 형식/)
})

test('이어쓰기는 참고 자료를 모두 꺼도 긴 줄거리 전문을 그대로 담는다', () => {
  const synopsis = '  ' + '사건의 흐름을 압축한 줄거리. '.repeat(600) + '\r\n\r\n결말. '
  const project = {
    title: '저편', direction: '', manuscript: '', model: 'qa/write', maxTokens: 100,
    synopsis,
  }
  const request = planWritingContext(project, [], { contextLength: 1000 }, { manuscript: 0, pastPassages: 0 }).finish()
  assert.equal(request.body.draft.synopsis, synopsis)
  assert.ok(request.remaining < 0)
})

test('이어쓰기 계획은 수동으로 지정한 카드만 더하고 로어북 토글을 따른다', () => {
  const card = { id: 'tide', kind: 'world', name: '밀물', aliases: [], description: '밀물에는 항구를 닫는다.', priority: 0, always: false }
  const project = {
    title: '', synopsis: '줄거리.', direction: '추격 장면을 써 줘.', manuscript: '', model: 'qa/write', maxTokens: 100, lorebook: [card],
  }
  const request = (references, added) => planWritingContext(project, references, null, { manuscript: 0, pastPassages: 0 }, added).finish()
  const omitted = request(['lorebook'], ['deleted-id'])
  assert.equal(omitted.body.draft.lorebook, '')
  assert.deepEqual(omitted.lore.map(({ id, included, manual }) => [id, included, manual]), [['tide', false, false]])
  const included = request(['lorebook'], ['tide'])
  assert.equal(included.body.draft.lorebook, '[세계관] 밀물\n밀물에는 항구를 닫는다.')
  assert.deepEqual(included.lore.map(({ id, included, manual }) => [id, included, manual]), [['tide', true, true]])
  assert.equal(Object.hasOwn(request([], ['tide']).body.draft, 'lorebook'), false)
})

test('원문 설정은 작품 백업에서 복원되고 기존 프로젝트에는 기본값을 쓴다', () => {
  const project = { id: 'original', title: '저편', synopsis: '', worldNotes: '', model: 'qa/write', maxTokens: 1024,
    direction: '', manuscript: '' }
  assert.deepEqual(sourceLimitsFor(project), { manuscript: 18_000, pastPassages: 3_600 })
  const sourceLimits = { manuscript: 80_000, pastPassages: 0 }
  const restore = limits => readProject(JSON.stringify(exportProject({ ...project, sourceLimits: limits })))
  assert.deepEqual(restore(sourceLimits).sourceLimits, sourceLimits)
  assert.throws(() => restore({ ...sourceLimits, manuscript: 80_001 }), /형식/)
})

test('작품 백업은 양의 정수인 출력 토큰 한도를 복원한다', () => {
  const project = { id: 'original', title: '저편', synopsis: '', worldNotes: '', model: 'qa/write',
    direction: '', manuscript: '' }
  const restore = maxTokens => readProject(JSON.stringify(exportProject({ ...project, maxTokens })))
  for (const maxTokens of [1, 2048, 4096, 8193]) assert.equal(restore(maxTokens).maxTokens, maxTokens)
  for (const maxTokens of [0, -1, 1.5, '8193', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => restore(maxTokens), /형식/)
  }
})

test('한국어 로어북 조사와 이름 경계, 별칭, 우선순위와 입력 한도', () => {
  const card = { id: '1', kind: 'character', name: '나래', aliases: ['종잡이'], description: '문지기', priority: 31, always: false }
  assert.deepEqual(activeLore([card], '나래이션은 끝났다.', '').included, [])
  assert.deepEqual(activeLore([card], '나래는 기다렸다.', '종잡이에게 물어').included[0].keywords, ['나래', '종잡이'])
  const longCards = [1, 8, 5, 7].map(priority => ({ ...card, id: String(priority), name: `카드 ${priority}`,
    priority, description: '긴'.repeat(1800) }))
  const result = activeLore(longCards, '카드 1, 카드 5, 카드 8, 카드 7', '')
  assert.deepEqual(result.included.map(item => item.priority), [8, 7])
  assert.equal(result.text, `[인물] 카드 8\n${'긴'.repeat(1800)}\n\n[인물] 카드 7\n${'긴'.repeat(1800)}`)
  assert.deepEqual(activeLore(longCards, '카드 8, 카드 7', '', ['1']).included.map(item => item.id), ['8', '1'])
  const pinned = longCards.map(item => item.id === '8' ? item : { ...item, always: true })
  assert.deepEqual(activeLore(pinned, '카드 8', '').included.map(item => item.id), ['7', '5', '1'])
})

test('긴 문단을 순서와 위치를 보존해 나누고 최근 원고와 경계가 겹치는 조각은 제외', () => {
  const sentence = '비가 그쳤다. '
  const long = sentence.repeat(160).trim()
  const text = `앞 문단\r\n\r\n${long}\n\n뒤 문단`
  const chunks = chunkManuscript(text)
  assert.equal(chunks.length, 4)
  assert.equal(chunks[0].text, '앞 문단')
  assert.equal(chunks.at(-1).text, '뒤 문단')
  assert.equal(chunks.slice(1, -1).map(chunk => chunk.text).join(''), long)
  assert(chunks.slice(1, -1).every(chunk => chunk.text.length >= 500 && chunk.text.length <= 900))
  assert(chunks.slice(1, -2).every(chunk => chunk.text.trimEnd().endsWith('.')))
  for (const { start, end, text: excerpt } of chunks) assert.equal(text.slice(start, end), excerpt)
  const research = retrievalInput(manuscript, '검색', true)
  for (const row of queries.filter(item => item.answer)) {
    const target = research.chunks.find(chunk => chunk.text === passages[row.answer])
    assert(target && target.end < manuscript.length - 18000)
  }
  assert(research.chunks.every(chunk => chunk.end <= manuscript.length - 18000))
  assert.equal(research.query, '검색\n문이 열린 뒤 두 사람은 말없이 마당으로 걸어 나왔다.')
})

test('최근 원고를 끄면 검색어에서 빠지고 과거 원문 범위는 유지된다', () => {
  const manuscript = `앞 문단.\n\n${'끝'.repeat(17_998)}`
  const older = [{ start: 0, end: 5, text: '앞 문단.' }]
  assert.deepEqual(retrievalInput(manuscript, '검색', true), {
    query: `검색\n${'끝'.repeat(240)}`, intent: '검색', chunks: older,
  })
  assert.deepEqual(retrievalInput(manuscript, '검색', false), { query: '검색', intent: '검색', chunks: older })
  assert.deepEqual(retrievalInput(manuscript.slice(0, -1), '검색', false).chunks, [])
  assert.deepEqual(retrievalInput('앞 문단.', '검색', false), { query: '검색', intent: '검색', chunks: [] })
})

test('BM25/RRF 정답 기준은 임베딩을 끄거나 순위를 뒤집으면 실패한다', () => {
  const keys = ['fox', 'elevator', 'sailor']
  const sourceVectors = new Map(keys.map((key, i) => [passages[key], keys.map((_, n) => i === n ? 1 : 0)]))
  const metrics = { exact: 0, semantic: 0, disabled: 0, inverted: 0, unrelatedHits: [] }
  for (const row of queries) {
    const { chunks, query, intent } = retrievalInput(manuscript, row.text, true)
    const vectors = chunks.map(chunk => sourceVectors.get(chunk.text) ?? [0, 0, 0])
    const vector = sourceVectors.get(passages[row.answer]) ?? [0, 0, 0]
    const hits = searchPast(chunks, query, { query: vector, vectors }, intent)
    const found = rows => rows.some(hit => hit.text === passages[row.answer])
    if (row.kind === 'exact') metrics.exact += Number(found(hits) && found(searchPast(chunks, query, null, intent)))
    if (row.kind === 'semantic') {
      metrics.semantic += Number(found(hits))
      metrics.disabled += Number(found(searchPast(chunks, query, null, intent)))
      metrics.inverted += Number(found(searchPast(chunks, query, { query: vector.map(value => -value), vectors }, intent)))
    }
    if (row.kind === 'unrelated') metrics.unrelatedHits.push(hits.length)
    assert(hits.length <= 3 && hits.every(a => hits.every(b => a === b || a.end <= b.start || b.end <= a.start)))
  }
  assert.deepEqual(metrics, { exact: 3, semantic: 3, disabled: 0, inverted: 0, unrelatedHits: [0, 0] })
  const short = [{ start: 0, end: 9, text: '나래는 돌아왔다.' }, { start: 11, end: 17, text: '나래이션이다.' }]
  assert.equal(searchPast(short, '나래', null, '나래')[0].text, '나래는 돌아왔다.')
  assert.equal(searchPast(short, '나래', null, '나래').length, 1)
})

test('과거 문단이 하나여도 세 글자 이름을 조사와 단어 경계로 찾는다', () => {
  const exact = '서하린은 낡은 표를 보관했다.'
  const searchName = older => {
    const { chunks, query, intent } = retrievalInput(`${older}\n\n${'끝'.repeat(18_000)}`, '서하린', true)
    assert.equal(chunks.length, 1)
    return searchPast(chunks, query, undefined, intent).map(hit => hit.text)
  }
  assert.deepEqual(searchName(exact), [exact])
  assert.deepEqual(searchName('서하린상자에 표를 보관했다.'), [])
  assert.deepEqual(searchName('박서하린은 낡은 표를 보관했다.'), [])
})

test('정확히 일치하는 이름은 키워드와 의미 점수가 높은 유사 문단보다 앞에 온다', () => {
  const exact = '서하린은 벽난로 안쪽에서 잃어버렸던 은색 상자를 꺼내 먼지를 닦았다.'
  const similar = ['서하와 하린은 남았다.', '서하와 하린은 걸었다.', '서하와 하린은 웃었다.']
  const filler = ['바닷가에 비가 쏟아졌다.', '항구의 종이 마침내 울렸다.', '나는 광장으로 달렸다.', '날이 다시 밝았다.', '강아지가 창가에서 잠들었다.']
  const manuscript = [...similar, ...filler, exact, '끝'.repeat(18_000)].join('\n\n')
  const { chunks, query, intent } = retrievalInput(manuscript, '서하린', true)
  const semantic = { query: [1, 0], vectors: chunks.map(chunk => similar.includes(chunk.text) ? [1, 0] : [0, 1]) }
  const expected = [exact, similar[0], similar[1]]
  assert.deepEqual(searchPast(chunks, query, undefined, intent).map(hit => hit.text), expected)
  assert.deepEqual(searchPast(chunks, query, semantic, intent).map(hit => hit.text), expected)
})

test('백업 형식, 복원 ID, AI 메모 위치와 선택 설정', () => {
  const project = {
    id: 'original', title: '저편', manuscript: '나래가 도착했다.', direction: '문을 열어', authorMode: 'once',
    sceneLength: '1,500자 안팎',
    synopsis: '줄거리', model: 'qa/write', maxTokens: 1024,
    memoryModel: 'qa/memory', revisionModel: 'qa/revision', planModel: 'qa/plan', search: { enabled: false, model: 'qa/embedding' },
    systemPrompt: '이어쓰기 지시', notePrompts: { revision: '퇴고 지시', memory: '메모 지시', lore: '카드 지시' },
    autoMemory: true, manuscriptMemory: { text: '도착함', through: 9, stale: false }, lorebook: [],
  }
  const backup = exportProject({ ...project, apiKey: 'secret' })
  const restored = readProject(JSON.stringify(backup))
  assert.notEqual(restored.id, project.id)
  assert.deepEqual({ ...restored, id: project.id }, project)
  const workspace = { version: 2, activeProjectId: project.id, projects: [project] }
  assert.deepEqual(readWorkspace(JSON.stringify(workspace)), workspace)
  assert.equal(Object.hasOwn(backup.project, 'apiKey'), false)
  assert.throws(() => readProject(JSON.stringify({ ...backup, version: 999 })), /버전/)
  assert.throws(() => readProject(JSON.stringify({ ...backup, project: { ...backup.project, sceneLength: 1500 } })), /형식/)
  for (const pinnedNoteParagraphs of [{ direction: ['지시'] }, { synopsis: ['중복', '중복'] }, { synopsis: ['가'.repeat(8001)] }]) {
    assert.throws(() => readProject(JSON.stringify({ ...backup, project: { ...backup.project, pinnedNoteParagraphs } })), /형식/)
  }
  assert.throws(() => readProject(JSON.stringify({ ...backup, project: { ...backup.project,
    manuscriptMemory: { text: '도착', through: 100, stale: false },
  } })), /형식/)
  const pack = exportPack(project, { lorebook: true, prompts: true })
  assert.equal(Object.hasOwn(pack.settings.prompts, 'sceneLength'), false)
  assert.equal(Object.hasOwn(pack.settings.prompts, 'pinnedNoteParagraphs'), false)
  assert.deepEqual(readPack(JSON.stringify(pack), { lorebook: true, prompts: false }), { lorebook: [] })
  assert.deepEqual(readPack(JSON.stringify(pack), { lorebook: false, prompts: true }).notePrompts, {
    revision: '퇴고 지시', memory: '메모 지시', lore: '카드 지시',
  })
})

test('백업 복원 시 원고 줄바꿈과 AI 메모가 읽은 위치를 함께 변환한다', () => {
  const project = {
    id: 'original', title: '저편', synopsis: '', worldNotes: '', model: 'qa/write', maxTokens: 1024, direction: '',
    manuscript: '가\r\n나\r다\r\n\r\n라', manuscriptMemory: { text: '가, 나, 다', through: 6, stale: false },
  }
  const restored = readProject(JSON.stringify(exportProject(project)))
  assert.equal(restored.manuscript, '가\n나\n다\n\n라')
  assert.deepEqual(restored.manuscriptMemory, { text: '가, 나, 다', through: 5, stale: false })
  assert.equal(restored.manuscript.slice(restored.manuscriptMemory.through), '\n\n라')
})

test('다른 탭의 모델 설정을 적용할 때 원고와 프롬프트, 검색 상태를 보존한다', () => {
  const project = {
    id: 'original', title: '저편', synopsis: '', manuscript: '처음 원고', direction: '',
    model: 'qa/write', maxTokens: 2048, revisionModel: 'qa/revision', notePrompts: { lore: '저장된 카드 지시' },
  }
  const other = { ...project, id: 'other', title: '다른 작품', notePrompts: { lore: '다른 작품 카드 지시' } }
  const saved = { version: 2, activeProjectId: project.id, projects: [project, other] }
  const live = structuredClone(saved)
  const editing = live.projects[0]
  editing.manuscript = '편집 중인 원고'
  editing.sceneLength = '두세 문단'
  editing.notePrompts.lore = '편집 중인 카드 지시'
  editing.lorebook = [{ id: 'stay', kind: 'world', name: '세계관 규칙', aliases: [], description: '유지할 메모', priority: 0, always: true }]
  editing.search = { enabled: true, model: 'qwen/qwen3-embedding-4b' }

  const changed = { ...project, model: 'qa/other', maxTokens: 8193, planModel: 'qa/plan',
    search: { enabled: false, model: 'qa/embedding' } }
  delete changed.revisionModel
  const next = { ...saved, projects: [changed, other] }
  assert.deepEqual(mergeModelSettings(live, JSON.stringify(saved), JSON.stringify(next)), new Set(['original']))
  assert.equal(live.projects[0], editing)
  assert.deepEqual(editing, { ...changed, manuscript: '편집 중인 원고', notePrompts: { lore: '편집 중인 카드 지시' },
    lorebook: [{ id: 'stay', kind: 'world', name: '세계관 규칙', aliases: [], description: '유지할 메모', priority: 0, always: true }],
    sceneLength: '두세 문단', search: { enabled: true, model: 'qa/embedding' } })
  assert.deepEqual(live.projects[1], other)

  const conflict = { ...next, projects: [{ ...changed, manuscript: '다른 탭에서 편집한 원고', maxTokens: 4096 }, other] }
  assert.equal(mergeModelSettings(live, JSON.stringify(next), JSON.stringify(conflict)), false)
  assert.equal(editing.maxTokens, 8193)
  assert.equal(editing.manuscript, '편집 중인 원고')
})

test('작품 선택과 동일한 기본 참고 설정만 바뀌면 저장 충돌로 판단하지 않는다', () => {
  const first = { id: 'first', title: '첫 작품', synopsis: '', manuscript: '첫 원고', direction: '', model: 'qa/write', maxTokens: 512 }
  const second = { ...first, id: 'second', title: '두 번째 작품', manuscript: '두 번째 원고' }
  const old = { version: 2, activeProjectId: first.id, projects: [first, second] }
  const latest = structuredClone(old)
  latest.activeProjectId = second.id
  latest.projects[0].references = defaultReferenceSettings()
  const live = structuredClone(old)
  const oldSnapshot = JSON.stringify(old)
  assert.deepEqual(mergeModelSettings(live, oldSnapshot, JSON.stringify(latest)), new Set())
  assert.equal(live.activeProjectId, first.id)
  assert.equal(workspaceMatchesSnapshot(live, JSON.stringify(latest)), true)

  live.projects[0].manuscript = '저장되지 않은 로컬 원고'
  assert.equal(workspaceMatchesSnapshot(live, JSON.stringify(latest)), false)
  const inactive = latest.projects[0].references.find(ref => ref.key === 'manuscript')
  inactive.enabled = false
  assert.equal(mergeModelSettings(live, oldSnapshot, JSON.stringify(latest)), false)
  inactive.enabled = true
  latest.projects[0].references.reverse()
  assert.equal(mergeModelSettings(live, oldSnapshot, JSON.stringify(latest)), false)
  latest.projects[0].references.reverse()
  latest.projects[1].manuscript = '다른 작품의 실제 편집'
  assert.equal(mergeModelSettings(live, oldSnapshot, JSON.stringify(latest)), false)
})

test('다른 탭의 모델 설정을 병합한 순서가 달라도 미저장 변경으로 판단하지 않는다', () => {
  const project = { id: 'first', title: '첫 작품', synopsis: '', manuscript: '첫 원고', direction: '', model: 'qa/write', maxTokens: 512 }
  const workspace = { version: 2, activeProjectId: project.id, projects: [project] }
  const latest = { ...workspace, projects: [{ ...project, memoryModel: 'qa/memory', revisionModel: 'qa/revise' }] }
  const snapshot = JSON.stringify(latest)
  assert.deepEqual(mergeModelSettings(workspace, JSON.stringify(workspace), snapshot), new Set([project.id]))
  assert.equal(workspaceMatchesSnapshot(workspace, snapshot), true)
  project.memoryModel = 'qa/alternate'
  assert.equal(workspaceMatchesSnapshot(workspace, snapshot), false)
})

test('이전 작업공간과 백업은 인물·세계관 메모의 내용과 고정 여부를 카드에 이관한다', () => {
  const synopsis = '줄'.repeat(8000) + '끝'
  const characters = '서윤: 지도 복원가.\r\n선장: 정체를 숨긴다.'
  const world = '# 안개 항로\n' + '해가 뜬 뒤에만 배가 출항한다. '.repeat(180) + '🌙'
  const existing = Array.from({ length: 150 }, (_, index) => ({
    id: `legacy-character-${index + 1}`, kind: 'place', name: `항구 ${index + 1}`, description: '기존 설정',
    priority: 5, aliases: [], always: false,
  }))
  const references = ['manuscript', 'worldNotes', 'lorebook', 'characterNotes', 'synopsis', 'pastPassages', 'manuscriptMemory']
    .map(key => ({ key, enabled: key !== 'synopsis' && key !== 'pastPassages' }))
  const project = {
    id: 'original', title: '제'.repeat(121), model: 'qa/write', maxTokens: 1024, manuscript: '',
    synopsis, characterNotes: `${characters}\r\n\r\n두 사람은 아직 만나지 않았다.`,
    worldNotes: world, pinnedNoteParagraphs: { characterNotes: [characters.replace('\r\n', '\n')], worldNotes: [world] },
    direction: ' '.repeat(1200) + '다음 장면', lorebook: existing, references,
  }
  const state = { version: 2, activeProjectId: project.id, projects: [project] }
  const restored = readProject(JSON.stringify({ kind: 'relay-project', version: 1, project }))
  const workspace = readWorkspace(JSON.stringify(state))
  assert.deepEqual(workspace.projects[0], { ...restored, id: project.id })
  assert.deepEqual(readWorkspace(JSON.stringify(workspace)), workspace)
  assert.deepEqual(readProject(JSON.stringify(exportProject(restored))).lorebook, restored.lorebook)
  assert.deepEqual(restored.lorebook.slice(0, 150), existing)
  const added = restored.lorebook.slice(150)
  assert.deepEqual(added.slice(0, 3).map(card => [card.id, card.name, card.description, card.always]), [
    ['legacy-character-151', '서윤', '서윤: 지도 복원가.', true],
    ['legacy-character-152', '선장', '선장: 정체를 숨긴다.', true],
    ['legacy-character-153', '인물 메모 1', '두 사람은 아직 만나지 않았다.', false],
  ])
  assert.equal(added.slice(3).map(card => card.description).join(''), world)
  assert.ok(added.slice(3).every(card => card.kind === 'world' && card.always && card.description.length <= 1800))
  assert.equal(added[3].name, '안개 항로')
  assert.deepEqual(added[4].aliases, ['안개 항로'])
  assert.ok(['characterNotes', 'worldNotes', 'pinnedNoteParagraphs'].every(key => !Object.hasOwn(restored, key)))
  const currentRefs = [{ key: 'manuscript', enabled: true }, { key: 'lorebook', enabled: true },
    { key: 'pastPassages', enabled: false }, { key: 'manuscriptMemory', enabled: true }]
  assert.deepEqual(restored.references, currentRefs)
  const pack = { kind: 'relay-settings', version: 1, settings: { prompts: { references } } }
  assert.deepEqual(readPack(JSON.stringify(pack), { prompts: true, lorebook: false }).references, currentRefs)
  assert.equal(restored.synopsis, synopsis)
  assert.deepEqual(projectNotesForRequest(restored), { projectTitle: '제'.repeat(120), synopsis: '줄'.repeat(8000) })
  assert.equal(writingFieldPrefix('direction', restored.direction), '다음 장면')
  assert.equal(writingFieldPrefix('direction', '|' + '가'.repeat(1199)), '|' + '가'.repeat(1199))
})

test('요청 기본료와 입력·출력 요금 계산, 값이 비어 있으면 확인 불가', () => {
  assert.deepEqual(estimateUsage(['네글자', '12345'], 4, { input: 2, output: 3, request: 7 }, 2),
    { inputTokens: 5, outputTokens: 4, cost: 36 })
  assert.equal(estimateUsage(['abc'], 4, { input: 2, request: 7 }).cost, null)
  const first = actualUsage({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0 })
  const second = actualUsage({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 })
  assert.deepEqual(combineUsage(first, second), { inputTokens: 7, outputTokens: 4, totalTokens: 11, cost: null })
})
