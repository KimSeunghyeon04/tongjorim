export const qaPort = '4184'

export const passages = {
  level: '오래된 수리 일지에 따르면 청동수평계는 수문이 닫힌 뒤에도 지하 수로의 기울기를 알려 준다. 서윤은 그것을 기계실 세 번째 서랍에 숨겼다.',
  ticket: '나래는 흰종소리표를 받아 유리병에 넣었다. 자정에 종이 두 번 울릴 때만 이 표로 저편 승강장에 갈 수 있다.',
  oath: '갈무리서약에는 동틀 때까지 북문을 열지 않는다는 조항이 있었다. 열쇠는 재봉사에게 맡겼다.',
  fox: '수의사 경준은 굶주린 새끼 여우 앞에 자기 몫의 배급 빵을 두었다. 그의 저녁은 그 한 조각뿐이었다.',
  elevator: '전기가 나가 엘리베이터가 멎었다. 경비원은 벽면의 긴급 버튼을 눌러 도움을 청했다.',
  sailor: '좌초된 어선에서 살아남은 항해사는 천에서 흘러내리는 물을 양철 통에 모아 목을 축였다.',
  levelDecoy: '청동수평추는 붉은 지붕을 건드리지 않게 매다는 공사용 추였다.',
  ticketDecoy: '흰종이표는 박물관 안내 데스크에서 기증품을 분류할 때만 쓰였다.',
  oathDecoy: '갈무리장부에는 매주 발행한 식량 교환권의 수량이 빼곡했다.',
  foxDecoy: '박물관의 여우 표본은 털의 색을 보존하려고 진열장 조명을 가장 어둡게 해 두었다.',
  elevatorDecoy: '경비원은 평소에도 엘리베이터가 있는 복도를 지켰다. 그날 전등은 끝까지 문제없이 켜져 있었다.',
  sailorDecoy: '어선의 쌍안경은 새 것으로 바뀌었다. 항해사는 선물 받은 빈 양철 통에 못을 담았다.',
}

const intervening = '오후 내내 광장에는 구름 그림자가 지나갔다. 창문을 스친 바람이 빨랫줄을 흔들고, 꽃집 주인은 아직 젖어 있는 바닥을 닦았다. '
const recent = '문이 열린 뒤 두 사람은 말없이 마당으로 걸어 나왔다.'

export const manuscript = [...Object.values(passages), intervening.repeat(440), recent].join('\n\n')

export const queries = [
  { kind: 'exact', text: '청동수평계를 다시 언급해', answer: 'level' },
  { kind: 'exact', text: '흰종소리표를 찾아', answer: 'ticket' },
  { kind: 'exact', text: '갈무리서약을 떠올려', answer: 'oath' },
  { kind: 'semantic', text: '동물 의사가 배고픈 아기 짐승에게 본인 식량을 넘겨주는 장면', answer: 'fox' },
  { kind: 'semantic', text: '정전 탓에 작동을 멈춘 승강기 안에서 비상 호출로 구조를 요청한 부분', answer: 'elevator' },
  { kind: 'semantic', text: '난파된 배 생존자가 빗물을 받아 갈증을 견딘 장면', answer: 'sailor' },
  { kind: 'unrelated', text: '아보카도 토스트 영양 성분', answer: null },
  { kind: 'unrelated', text: '자바스크립트 배열 정렬 성능', answer: null },
]
