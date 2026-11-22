import { paragraphRanges } from './retrieval.mjs'

export const passageLengthLimit = 800
export const evidenceCountLimit = 3

export function numberedPassages(source, { sentences = false } = {}) {
  const passages = []
  function add(from, to) {
    while (from < to) {
      let end = Math.min(to, from + passageLengthLimit)
      if (end < to) {
        const window = source.slice(from, end)
        const whitespace = [...window.matchAll(/\s+/g)].at(-1)?.index
        if (whitespace >= passageLengthLimit / 2) end = from + whitespace
        else if (/[\uD800-\uDBFF]/.test(source[end - 1])) end--
      }
      const raw = source.slice(from, end)
      const text = raw.trim()
      if (text) passages.push({ id: passages.length + 1, start: from + raw.length - raw.trimStart().length, text })
      from = end
    }
  }
  for (const paragraph of paragraphRanges(source)) {
    let from = paragraph.start
    if (sentences) {
      for (const stop of paragraph.text.matchAll(/[.!?…。！？]+[”’"'」』]?(?=\s|$)/g)) {
        const to = paragraph.start + stop.index + stop[0].length
        add(from, to)
        from = to
      }
    }
    add(from, paragraph.end)
  }
  return passages
}

export function passageInput(passages) {
  return passages.map(({ id, text }) => ({ id, text }))
}

export function selectEvidence(passages, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > evidenceCountLimit ||
      new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > passages.length)) return null
  return ids.toSorted((a, b) => a - b).map(id => passages[id - 1])
}

export function evidenceAt(source, passages, ids) {
  return selectEvidence(passages, ids)?.map(({ start, text }) => {
    let occurrence = 0
    for (let index = source.indexOf(text); index >= 0 && index < start; index = source.indexOf(text, index + 1)) occurrence++
    return { text, occurrence }
  }) ?? null
}

export function evidenceRange(source, { text, occurrence }) {
  let index = source.indexOf(text)
  while (occurrence-- > 0 && index >= 0) index = source.indexOf(text, index + 1)
  return index < 0 ? null : { start: index, end: index + text.length, text }
}
