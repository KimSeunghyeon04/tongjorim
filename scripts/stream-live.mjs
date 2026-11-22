import assert from 'node:assert/strict'
import { qaPort } from './retrieval-fixture.mjs'

const origin = 'http://127.0.0.1:' + (process.argv[2] ?? process.env.PORT ?? qaPort)

async function write(model) {
  const response = await fetch(origin + '/api/write', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, maxTokens: 128, references: [], draft: {
      projectTitle: '스트리밍 검증', direction: '이야기를 이어가 주세요.',
    } }),
  })
  assert.equal(response.status, 200)
  return (await response.text()).trim().split('\n').map(JSON.parse)
}

for (const model of ['qa/filtered', 'qa/choice-error']) {
  const events = await write(model)
  assert.equal(events[0].content, '나래는 마지막 표를...')
  assert.deepEqual(events.map(event => event.type), ['text', 'error'], `${model} must report failure after partial output`)
}

for (const [model, truncated, text] of [
  ['qa/write', false, '나래는 마지막 표를 접어 두었다.'],
  ['qa/truncated', true, '나래는 마지막 표를...'],
]) {
  const events = await write(model)
  assert.deepEqual(events.map(event => event.type), ['text', 'done'])
  assert.equal(events[0].content, text)
  assert.equal(events[1].truncated, truncated)
}

console.log('Stream termination verified for normal, length-limited, filtered and provider-error responses.')
