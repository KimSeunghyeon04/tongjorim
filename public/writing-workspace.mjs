import { hasSceneNote, normalizeProject, readProject, referenceSettingsFor, restoreProject, validProject, validProjectBase } from './project-files.mjs'
import { searchFor } from './retrieval.mjs'
import { appendParagraphs, freeModel, normalizeLineEndings, optionalProjectModels } from './writing-config.mjs'
import { attachSceneDocument, createSceneDocument } from './scene-document.mjs'

// Keep the same storage key so older tabs detect a workspace change before saving.
export const storageKey = 'relay.writing.v1'
export const workspaceRequestBytes = 32 * 1024 * 1024
export const workspaceInflatedBytes = 256 * 1024 * 1024
const workspaceVersion = 2
const settingFields = ['model', 'maxTokens', 'modelOptions', ...optionalProjectModels]

export const currentProjectOf = workspace =>
  workspace.projects.find(project => project.id === workspace.activeProjectId) ?? workspace.projects[0]
export const projectName = project => project.title.trim() || '제목 없는 소설'

export function makeProject(title = '제목 없는 소설', text = '') {
  return attachSceneDocument({
    id: crypto.randomUUID(), title, synopsis: '',
    model: freeModel.id, maxTokens: 2048, sceneDocument: createSceneDocument(text), direction: '',
  })
}

function sampleWorkspace() {
  const sample = makeProject('안개 항로 (예시)', [
    '안개가 걷히기도 전에 항구의 시계가 다섯 번 울었다. 서윤은 표를 쥔 손을 코트 주머니에 넣었다. 선착장 끝에는 행선지를 적지 않은 배가 한 척 떠 있었다.',
    '선장이 그녀의 표를 받더니 표 뒷면을 들여다보았다. 서윤도 그제야 거기에 낯선 글씨가 있다는 걸 알았다.',
    '「돌아오는 편은 한 사람만.」',
  ].join('\n\n'))
  sample.direction = '선장은 이 문장을 이미 알고 있다. 서로 모르는 척하는 두 사람의 짧은 대화로 장면을 이어간다.'
  sample.synopsis = '항해 지도에 없는 섬에서 편지가 도착한다. 실종된 오빠가 보낸 편지라고 믿는 서윤은 새벽 여객선에 오른다.'
  sample.lorebook = [
    { id: 'sample-seoyun', kind: 'character', name: '서윤', aliases: [], priority: 0, always: false,
      description: '지도 복원가. 낯선 표식은 쉽게 지나치지 않지만 사람의 속뜻을 바로 묻지는 않는다.' },
    { id: 'sample-captain', kind: 'character', name: '선장', aliases: [], priority: 0, always: false,
      description: '이름을 밝히지 않는다. 행선지에 관해 짧게만 답한다.' },
    { id: 'sample-setting', kind: 'world', name: '배경과 시점', aliases: [], priority: 0, always: true,
      description: '늦가을 항구. 서윤의 시점에서 과거형으로 서술한다.' },
  ]
  return { version: workspaceVersion, activeProjectId: sample.id, projects: [normalizeProject(sample)] }
}

function mergeProjectScenes({ scenes, activeSceneId, ...project }) {
  const activeScene = scenes.find(scene => scene.id === activeSceneId) ?? scenes[0]
  return {
    ...project,
    manuscript: scenes.reduce((text, scene) => appendParagraphs(text, normalizeLineEndings(scene.text)), ''),
    direction: activeScene.direction,
    legacySceneNotes: scenes.flatMap((scene, index) => scene.title || scene.direction ? [{
      title: scene.title || `장면 ${index + 1}`,
      direction: scene.direction,
    }] : []),
  }
}

export function readWorkspace(serialized) {
  if (serialized === null) return sampleWorkspace()
  return normalizeWorkspace(JSON.parse(serialized))
}

export function readProjectBackups(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new Error('유효한 JSON 파일을 선택해 주세요.') }
  if (data?.kind !== undefined || !Array.isArray(data?.projects)) return [readProject(text)]
  try { return normalizeWorkspace(data).projects.map(restoreProject) }
  catch { throw new Error('작업공간 백업의 원고나 작품 설정을 확인해 주세요.') }
}

function normalizeWorkspace(data) {
  if (![1, workspaceVersion].includes(data?.version) || !Array.isArray(data.projects) || !data.projects.length ||
      !data.projects.every(validProjectBase)) {
    throw new Error('Unknown workspace')
  }
  if (data.version === 1 && data.projects.every(project => Array.isArray(project.scenes) &&
      project.scenes.length && project.scenes.every(scene => hasSceneNote(scene) &&
        typeof scene.id === 'string' && typeof scene.text === 'string'))) {
    return { ...data, version: workspaceVersion, projects: data.projects.map(project => normalizeProject(mergeProjectScenes(project))) }
  }
  if (data.version === workspaceVersion && data.projects.every(validProject)) {
    data.projects.forEach(normalizeProject)
    return data
  }
  throw new Error('Unknown workspace')
}

function workspaceContent({ activeProjectId, projects, ...metadata }) {
  return { ...metadata, projects: projects.map(({ references, ...project }) => ({
    ...project, references: referenceSettingsFor({ references }),
  })) }
}

function sameWorkspaceContent(left, right) {
  const orderObjectKeys = (_, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value
  return JSON.stringify(left, orderObjectKeys) === JSON.stringify(right, orderObjectKeys)
}

export function workspaceMatchesSnapshot(workspace, snapshot) {
  return sameWorkspaceContent(workspaceContent(workspace), workspaceContent(JSON.parse(snapshot)))
}

function withoutModelSettings(workspace) {
  const { projects, ...metadata } = workspaceContent(workspace)
  return { ...metadata, projects: projects.map(project => {
    const { search, ...content } = project
    const { model, ...searchSettings } = search ?? {}
    for (const key of settingFields) delete content[key]
    return { ...content, search: { enabled: false, ...searchSettings } }
  }) }
}

// Apply settings changes from another tab while keeping the writer's live project objects.
export function mergeModelSettings(workspace, before, after) {
  if (before === null || after === null) return false
  const previous = readWorkspace(before)
  const latest = readWorkspace(after)
  if (!sameWorkspaceContent(withoutModelSettings(previous), withoutModelSettings(latest))) return false

  const changed = new Set()
  for (const [index, nextProject] of latest.projects.entries()) {
    const project = workspace.projects.find(item => item.id === nextProject.id)
    if (!project) continue
    const previousProject = previous.projects[index]
    for (const key of settingFields) {
      if (JSON.stringify(previousProject[key]) === JSON.stringify(nextProject[key])) continue
      if (nextProject[key] === undefined) delete project[key]
      else project[key] = nextProject[key]
      changed.add(project.id)
    }
    const nextModel = searchFor(nextProject).model
    if (searchFor(previousProject).model !== nextModel) {
      project.search = { ...searchFor(project), model: nextModel }
      changed.add(project.id)
    }
  }
  return changed
}
