import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportPack, exportProject, readPack, readProject } from '../public/project-files.mjs'
import { activeLore, chunkManuscript, rankPast, retrievalInput, searchPast } from '../public/retrieval.mjs'
import { actualUsage, combineUsage, estimateUsage } from '../public/request-tools.mjs'
import { planWritingContext } from '../public/writing-context.mjs'
import { projectNotesForRequest, sourceLimitsFor, writingFieldPrefix } from '../public/writing-config.mjs'
import { mergeModelSettings, readWorkspace } from '../public/writing-workspace.mjs'
import { manuscript, passages, queries } from '../scripts/retrieval-fixture.mjs'

test('원문 한도와 검색 범위, 출력 예약을 뺀 컨텍스트와 비용이 함께 바뀐다', () => {
  const project = {
    title: '', direction: '', manuscript: `earlier\n\n${'A'.repeat(35)}🧭`, model: 'qa/write', maxTokens: 1024, systemPrompt: 's',
  }
  const model = { contextLength: 1180, input: 0.001, output: 0.002, request: 0.003 }
  const refs = ['manuscript', 'pastPassages']
  const limits = { manuscript: 99, pastPassages: 99 }
  const large = planWritingContext(project, refs, model, limits)
  const getRank = plan => {
    const { chunks, query, intent } = retrievalInput(project.manuscript, 'earlier', true, { cutoff: plan.cutoff })
    return rankPast(chunks, query, undefined, intent)
  }
  const fitted = large.finish(getRank(large))
  // System message costs 2 tokens. The empty user message is 73 ASCII bytes.
  // Reserving 1,024 output and 128 spare leaves 28 input tokens, so the user message can grow to 104 bytes.
  assert.equal(fitted.body.draft.manuscript, `${'A'.repeat(27)}🧭`)
  assert.equal(fitted.cutoff, 17)
  assert.equal(fitted.originalBudget, 7)
  assert.equal(fitted.remaining, 0)
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
