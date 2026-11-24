import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  consecutiveScenes, editSceneDocument, insertScene, mergeScenes, moveSceneStructure, projectSceneDocument,
  removeScenes, saveSceneVersion, sceneForEdit, splitScene, validSceneDocument,
} from '../public/scene-document.mjs'
import { exportProject, readProject } from '../public/project-files.mjs'
import { makeProject, readWorkspace } from '../public/writing-workspace.mjs'

test('나누고 합치면 문자를 그대로 두고 새 장면마다 독립된 버전 이력을 만든다', () => {
  const project = makeProject('원고', '앞😀 끝')
  const initial = project.savedScenes[0].id
  project.sceneDocument = editSceneDocument(project.sceneDocument, initial, '앞😀 끝\n\n뒤')
  assert.equal(splitScene(project.sceneDocument, initial, 2), null)
  project.sceneDocument = splitScene(project.sceneDocument, initial, 5).document
  const [left, right] = project.savedScenes
  assert.deepEqual([left.text, right.text], ['앞😀 끝', '\n\n뒤'])
  assert.equal(project.manuscript, '앞😀 끝\n\n뒤')
  assert.notEqual(left.id, initial)
  assert.notEqual(right.id, initial)
  assert.deepEqual(left.origins, [{ id: initial, version: 1 }])
  assert.deepEqual(project.sceneDocument.scenes[initial].versions.map(({ text }) => text), ['앞😀 끝', '앞😀 끝\n\n뒤'])
  assert.deepEqual([left.versions[0].parent, right.versions[0].parent], [null, null])
  assert.equal(sceneForEdit([left, right], { start: 5, end: 5 }, left.id).id, left.id)
  assert.equal(sceneForEdit([left, right], { start: 5, end: 5 }, right.id).id, right.id)

  project.sceneDocument = mergeScenes(project.sceneDocument, new Set([right.id, left.id])).document
  const merged = project.savedScenes[0]
  assert.equal(merged.text, '앞😀 끝\n\n뒤')
  assert.notEqual(merged.id, initial)
  assert.deepEqual(merged.origins, [{ id: left.id, version: 0 }, { id: right.id, version: 0 }])
  assert.equal(merged.versions.length, 1)

  const previous = project.sceneDocument
  project.sceneDocument = editSceneDocument(previous, merged.id, '전체를 새로 고침')
  assert.equal(moveSceneStructure(project.sceneDocument, 'undo'), null)
  const checkpoint = { text: '전체를 새로 고침', direction: '', parent: 0, source: 'manual' }
  project.sceneDocument = saveSceneVersion(project.sceneDocument, merged.id, merged.text, [...merged.versions, checkpoint], 0, 1)
  assert.equal(project.savedScenes[0].versions[2].parent, 1)
  project.sceneDocument = moveSceneStructure(project.sceneDocument, 'undo').document
  assert.deepEqual(project.savedScenes.map(scene => scene.id), [left.id, right.id])
  project.sceneDocument = moveSceneStructure(project.sceneDocument, 'redo').document
  assert.equal(project.savedScenes[0].id, merged.id)
  assert.equal(project.savedScenes[0].versions.length, 3)
})

test('빈 장면과 명시적 경계를 보존하고 인접 장면만 합친다', () => {
  const project = makeProject('원고', '가')
  const first = project.savedScenes[0].id
  const added = insertScene(project.sceneDocument)
  const last = added.focus
  const written = editSceneDocument(added.document, last, '다')
  const middle = insertScene(written, last)
  const { savedScenes } = projectSceneDocument(middle.document)
  assert.deepEqual(savedScenes.map(({ range }) => range), [{ start: 0, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 6 }])
  assert.equal(sceneForEdit(savedScenes, { start: 1, end: 1 }).id, first)
  assert.equal(sceneForEdit(savedScenes, { start: 3, end: 3 }).id, middle.focus)
  assert.equal(sceneForEdit(savedScenes, { start: 1, end: 3 }), undefined)
  assert.deepEqual(consecutiveScenes(middle.document, new Set([first, last])), [])
  const edited = editSceneDocument(middle.document, middle.focus, '\n\n나\n')
  const merged = mergeScenes(edited, new Set([first, middle.focus]))
  assert.equal(projectSceneDocument(merged.document).manuscript, '가\n\n\n\n나\n\n\n다')
})

test('작품 백업과 작업공간을 다시 열어도 삭제와 구조 다시 실행을 보존한다', () => {
  const project = makeProject('원고', '본문')
  const id = project.savedScenes[0].id
  const removed = removeScenes(project.sceneDocument, new Set([id]))
  project.sceneDocument = moveSceneStructure(removed.document, 'undo').document
  const file = exportProject(project)
  assert.equal(file.project.manuscript, undefined)
  assert.equal(file.project.savedScenes, undefined)
  const restored = readProject(JSON.stringify(file))
  assert.equal(restored.manuscript, '본문')
  const workspace = { version: 2, activeProjectId: restored.id, projects: [restored] }
  const reopened = readWorkspace(JSON.stringify(workspace)).projects[0]
  reopened.sceneDocument = moveSceneStructure(reopened.sceneDocument, 'redo').document
  assert.equal(reopened.manuscript, '')
  assert.equal(reopened.savedScenes[0].id, removed.focus)
  assert.equal(reopened.sceneDocument.scenes[id].versions[0].text, '본문')
  const invalid = structuredClone(reopened.sceneDocument)
  invalid.past[0].sources[0].version = 99
  assert.equal(validSceneDocument(invalid), false)
})
