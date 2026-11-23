import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { draftChanges, sceneRevisionHistory } from '../public/draft-changes.mjs'

test('한국어 구절 두 곳을 바꾸면 공통 문장을 사이에 둔 두 변경을 돌려준다', () => {
  assert.deepEqual(
    draftChanges('나래는 문을 세게 닫았다. 그리고 바닥에 주저앉았다.', '나래는 문을 아주 조용히 닫았다. 그리고 바닥에 기대었다.'),
    [
      { text: '나래는 문을 ' },
      { before: '세게', after: '아주 조용히' },
      { text: ' 닫았다. 그리고 바닥에 ' },
      { before: '주저앉았다', after: '기대었다' },
      { text: '.' },
    ],
  )
})

test('통째로 빠진 문단을 인접 문단의 문구 수정이나 공백 변경과 구분한다', () => {
  assert.deepEqual(
    draftChanges('나래는 남았다.\n\n불이 꺼졌다.\n\n창문이 흔들렸다.\n\n새가 날았다.', '나래는 남았다.\n\n새가 날았다.'),
    [
      { text: '나래는 남았다.\n\n' },
      { before: '불이 꺼졌다.\n\n창문이 흔들렸다.\n\n', after: '', deletedParagraphs: 2 },
      { text: '새가 날았다.' },
    ],
  )
  assert.deepEqual(draftChanges('못 갈지도 몰라.', '못갈지도 몰라.'), [
    { before: '못 갈지도', after: '못갈지도' }, { text: ' 몰라.' },
  ])
  assert.deepEqual(draftChanges('첫 줄\n둘째 줄', '첫 줄\n\n둘째 줄'), [
    { text: '첫 줄\n' }, { before: '', after: '\n' }, { text: '둘째 줄' },
  ])
})

test('바로 앞 문단을 수정해도 삭제된 문단 양쪽의 마침표를 각각 보존한다', () => {
  assert.deepEqual(
    draftChanges('나래는 문을 세게 닫았다.\n\n복도에 아무도 없었다.\n\n신호등이 바뀌었다.',
      '나래는 문을 조용히 닫았다.\n\n신호등이 바뀌었다.'),
    [
      { text: '나래는 문을 ' },
      { before: '세게', after: '조용히' },
      { text: ' 닫았다.\n\n' },
      { before: '복도에 아무도 없었다.\n\n', after: '', deletedParagraphs: 1 },
      { text: '신호등이 바뀌었다.' },
    ],
  )
})

test('버전이 같으면 원문만 반환하고 큰 교체에서도 바깥 문단을 보존한다', () => {
  const same = '“불을 켜.”\n\n🔦'
  assert.deepEqual(draftChanges(same, same), [{ text: same }])
  const before = '왼쪽 '.repeat(900).trim()
  const after = '오른쪽 '.repeat(900).trim()
  assert.deepEqual(draftChanges(`처음 문단.\n\n${before}\n\n끝 문단.`, `처음 문단.\n\n${after}\n\n끝 문단.`), [
    { text: '처음 문단.\n\n' }, { before, after }, { text: '\n\n' }, { text: '끝 문단.' },
  ])
})

test('수정 이력은 선택한 가지의 모든 지시와 실제 diff를 오래된 순서로 담는다', () => {
  const versions = [
    { parent: null, direction: '창가 장면을 써 줘.', text: '바람은 차갑다.\n\n촛불이 흔들렸다.' },
    { parent: 0, direction: '따뜻하게 바꿔 줘.', text: '바람은 따뜻하다.\n\n촛불이 흔들렸다.' },
    { parent: 1, direction: '촛불을 등불로 바꿔 줘.', text: '바람은 따뜻하다.\n\n등불이 흔들렸다.' },
    { parent: 1, direction: '촛불 문단을 빼 줘.', text: '바람은 따뜻하다.' },
    { parent: 3, direction: '다시 확인해 줘.', text: '바람은 따뜻하다.' },
  ]
  assert.deepEqual(sceneRevisionHistory(versions, 0), [])
  assert.deepEqual(sceneRevisionHistory(versions, 4), [
    { fromVersion: 1, toVersion: 2, direction: '따뜻하게 바꿔 줘.', diff: '@@ -4,3 +4,4 @@\n- 차갑다\n+ 따뜻하다' },
    { fromVersion: 2, toVersion: 4, direction: '촛불 문단을 빼 줘.', diff: '@@ -9,11 +9,0 @@\n- \n- \n- 촛불이 흔들렸다.' },
    { fromVersion: 4, toVersion: 5, direction: '다시 확인해 줘.', diff: '' },
  ])
})
