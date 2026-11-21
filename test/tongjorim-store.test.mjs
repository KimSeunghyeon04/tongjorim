import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openTongjorimStore } from '../tongjorim-store.mjs'

test('저장한 작품과 모델 원문은 파일을 다시 열어도 함께 조회된다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tongjorim-store-test-'))
  const filename = join(directory, 'workspace.sqlite')
  const initial = '{"projects":[{"id":"work","manuscript":"첫 문장"}]}'
  const edited = '{"projects":[{"id":"work","manuscript":"둘째 문장"}]}'
  const response = { status: 200, text: '{"reply":', raw: 'data: {"reply":\r\n', finishReason: 'stop' }
  const request = { model: 'qa/write', messages: [{ role: 'user', content: '계속 써 줘' }] }
  try {
    const store = openTongjorimStore(filename)
    try {
      assert.deepEqual(store.readWorkspace(), { revision: null, snapshot: null })
      assert.deepEqual(store.saveWorkspace(null, initial), { revision: 1 })
      assert.deepEqual(store.saveWorkspace(1, edited), { revision: 2 })
      assert.deepEqual(store.saveWorkspace(1, edited), { revision: 2 })
      assert.deepEqual(store.saveWorkspace(1, initial), { conflict: true, revision: 2, snapshot: edited })
      assert.deepEqual(store.saveWorkspace(null, initial), { conflict: true, revision: 2, snapshot: edited })
      store.recordModelRequest('log1', { timestamp: '2026-11-21T10:00:00Z', route: '/api/assistant', projectId: 'work', request, response, error: null })
    } finally {
      store.close()
    }

    const db = new DatabaseSync(filename, { readOnly: true })
    try {
      const saved = db.prepare('SELECT snapshot, previous_snapshot FROM workspace').get()
      assert.equal(saved.snapshot, edited)
      assert.equal(saved.previous_snapshot, initial)
      const log = db.prepare('SELECT project_id, route, request, response FROM model_requests').get()
      assert.equal(log.project_id, 'work')
      assert.equal(log.route, '/api/assistant')
      assert.deepEqual(JSON.parse(log.request), request)
      assert.deepEqual(JSON.parse(log.response), response)
    } finally {
      db.close()
    }
  } finally {
    rmSync(filename, { force: true })
    rmdirSync(directory)
  }
})
