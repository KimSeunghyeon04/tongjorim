import { paragraphRanges } from './retrieval.mjs'
import { savedScenesInManuscriptOrder } from './manuscript-scenes.mjs'

// Registered ranges take precedence over paragraph breaks, including inside a paragraph.
function unitsFor({ manuscript, savedScenes = [] }) {
  const units = []
  let through = 0
  function addParagraphs(end) {
    for (const paragraph of paragraphRanges(manuscript.slice(through, end))) {
      units.push({ start: through + paragraph.start })
    }
  }
  for (const scene of savedScenesInManuscriptOrder(savedScenes)) {
    if (!scene.range) continue
    addParagraphs(scene.range.start)
    units.push({ start: scene.range.start, scene: true })
    through = scene.range.end
  }
  addParagraphs(manuscript.length)
  return units
}

const number = new Intl.NumberFormat('ko-KR')

export function wholeRecentManuscript(project, suffix, limit) {
  const { manuscript } = project
  if (suffix.length === manuscript.length || !limit || !manuscript.trim()) return { text: suffix, warning: '' }
  const units = unitsFor(project)
  const cutoff = manuscript.length - suffix.length
  const first = units.find(unit => unit.start >= cutoff)
  if (first) return { text: manuscript.slice(first.start), warning: '' }
  const last = units.at(-1)
  const name = last.scene ? '장면' : '문단'
  const length = manuscript.length - last.start
  const warning = length > limit
    ? `마지막 ${name}은 ${number.format(length)}자로, 최근 원문 한도 ${number.format(limit)}자를 넘어요. 한도를 늘리거나 마지막 ${name}을 나눠 주세요.`
    : `모델 컨텍스트에 마지막 ${name} 전체를 담을 수 없어요. 참고 자료나 출력 한도를 줄이거나 마지막 ${name}을 나눠 주세요.`
  return { text: '', warning }
}
