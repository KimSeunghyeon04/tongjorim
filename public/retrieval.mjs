import { writingFields } from './writing-config.mjs'

export const loreKinds = { character: '인물', place: '장소', event: '사건', clue: '복선' }
export const defaultEmbeddingModel = 'qwen/qwen3-embedding-4b'
export const embeddingBatchSize = 16
export const embeddingQueryLimit = 2400
export const chunkLimit = 900
export const loreLimits = { cards: 150, names: 100, aliases: 16, description: 1800 }

const wordBoundary = '[\\p{L}\\p{M}\\p{N}]'
const koreanParticle = '(?:은|는|이|가|을|를|의|에|에서|에게|에게서|한테|한테서|께|께서|와|과|랑|이랑|하고|도|만|부터|까지|으로|로|로부터|으로부터|처럼|보다|마저|조차|뿐|이라고|라고|라며|이며|이다)'
const normalize = value => value.normalize('NFKC').toLowerCase().trim()

function includesAlias(text, alias) {
  const escaped = normalize(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!escaped) return false
  return new RegExp(`(?<!${wordBoundary})${escaped}(?:${koreanParticle})?(?!${wordBoundary})`, 'u').test(text)
}

export function activeLore(cards, manuscript, direction) {
  const text = normalize(`${manuscript.slice(-writingFields.manuscript)}\n${direction}`)
  const matches = cards.flatMap(card => {
    const keywords = [...new Set([card.name, ...card.aliases])].filter(alias => includesAlias(text, alias))
    if (!card.always && !keywords.length) return []
    const block = `[${loreKinds[card.kind]}] ${card.name}\n${card.description}`
    return [{ ...card, keywords, block }]
  }).sort((a, b) => b.priority - a.priority)

  let used = 0
  const included = matches.filter(({ block }) => {
    const added = block.length + (used ? 2 : 0)
    if (used + added > writingFields.lorebook) return false
    used += added
    return true
  })
  return { included, text: included.map(card => card.block).join('\n\n') }
}

export function paragraphRanges(manuscript) {
  const paragraphs = []
  let start = 0

  function add(end) {
    const raw = manuscript.slice(start, end)
    const text = raw.trim()
    if (!text) return
    const offset = start + raw.length - raw.trimStart().length
    paragraphs.push({ start: offset, end: offset + text.length, text })
  }

  for (const gap of manuscript.matchAll(/\r?\n[^\S\r\n]*(?:\r?\n[^\S\r\n]*)+/g)) {
    add(gap.index)
    start = gap.index + gap[0].length
  }
  add(manuscript.length)
  return paragraphs
}

const koreanSentences = new Intl.Segmenter('ko', { granularity: 'sentence' })

export function chunkManuscript(manuscript) {
  return paragraphRanges(manuscript).flatMap(paragraph => {
    if (paragraph.text.length <= chunkLimit) return [paragraph]
    const chunks = []
    const boundaries = Array.from(koreanSentences.segment(paragraph.text), sentence => sentence.index)
    let cursor = 0
    let boundary = 0

    while (cursor < paragraph.text.length) {
      const remaining = paragraph.text.length - cursor
      const trailing = Math.min(500, Math.floor(remaining / 2))
      const width = remaining <= chunkLimit ? remaining : Math.min(chunkLimit, remaining - trailing)
      const limit = cursor + width
      while (boundary + 1 < boundaries.length && boundaries[boundary + 1] <= limit) boundary++
      let end = limit === paragraph.text.length ? limit : boundaries[boundary]
      const minimum = cursor + Math.min(width, 500)
      if (end < minimum && limit < paragraph.text.length) {
        const space = paragraph.text.lastIndexOf(' ', limit - 1) + 1
        end = space >= minimum ? space : limit
      }
      if (end < paragraph.text.length && /[\uD800-\uDBFF]/.test(paragraph.text[end - 1])) end--
      const text = paragraph.text.slice(cursor, end)
      chunks.push({ start: paragraph.start + cursor, end: paragraph.start + end, text })
      cursor = end
    }
    return chunks
  })
}

export function retrievalInput(manuscript, direction, includeRecent) {
  const recentLimit = 240
  const intent = direction.trim().slice(0, embeddingQueryLimit - recentLimit - 1)
  let recent = ''
  if (includeRecent) {
    for (const { text } of paragraphRanges(manuscript).slice(-3).reverse()) {
      if (recent && text.length + recent.length + 1 > recentLimit) break
      recent = recent ? `${text}\n${recent}` : text.slice(-recentLimit)
    }
  }
  const query = [intent, recent].filter(Boolean).join('\n')
  const cutoff = manuscript.length - writingFields.manuscript
  const chunks = cutoff > 0 ? chunkManuscript(manuscript).filter(chunk => chunk.end <= cutoff) : []
  return { query, intent, chunks }
}

function bigrams(value) {
  const counts = new Map()
  for (const word of normalize(value).match(/[\p{L}\p{N}]+/gu) ?? []) {
    const letters = Array.from(word)
    for (let i = 1; i < letters.length; i++) {
      const term = letters[i - 1] + letters[i]
      counts.set(term, (counts.get(term) ?? 0) + 1)
    }
  }
  return counts
}

function keywordRanking(chunks, query, intent) {
  const terms = bigrams(query)
  const intentTerms = bigrams(intent || query)
  const keyword = normalize(intent)
  const singleWord = /^[\p{L}\p{N}]{2,}$/u.test(keyword)
  if (!terms.size || !chunks.length) return []
  const frequencies = new Map()
  const docs = chunks.map(chunk => {
    const tokens = bigrams(chunk.text)
    let length = 0
    for (const [term, count] of tokens) {
      length += count
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    }
    return { tokens, length, chunk }
  })
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  return docs.flatMap(({ tokens, length, chunk }, index) => {
    let score = 0
    let intentHits = 0
    let intentScore = 0
    for (const term of terms.keys()) {
      const tf = tokens.get(term)
      if (!tf) continue
      const df = frequencies.get(term)
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
      const weight = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length / average))
      if (intentTerms.has(term)) {
        intentHits++
        intentScore += weight
      } else {
        score += weight
      }
    }
    const exactMatch = singleWord && intentHits === intentTerms.size && includesAlias(normalize(chunk.text), keyword)
    return exactMatch || (intentHits >= 2 && intentScore >= 1.2)
      ? [{ index, score: intentScore + Math.min(score / 4, intentScore / 4), chunk, exactMatch }]
      : []
  }).sort((a, b) => b.score - a.score || a.index - b.index)
}

export function cosine(left, right) {
  if (!left?.length || left.length !== right?.length) return -1
  let dot = 0
  let normLeft = 0
  let normRight = 0
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i]
    normLeft += left[i] ** 2
    normRight += right[i] ** 2
  }
  return normLeft && normRight ? dot / Math.sqrt(normLeft * normRight) : -1
}

export function searchPast(chunks, query, semantic, intent = '') {
  const keyword = keywordRanking(chunks, query, intent)
  const meaning = semantic ? chunks.map((chunk, index) => ({
    chunk, index, score: cosine(semantic.query, semantic.vectors[index]),
  })).filter(item => item.score >= 0.52).sort((a, b) => b.score - a.score || a.index - b.index) : []
  const scores = new Map()

  for (const [kind, list] of [['keyword', keyword], ['semantic', meaning]]) {
    list.forEach((item, rank) => {
      const record = scores.get(item.index) ?? { ...item.chunk, score: 0, exactMatch: Boolean(item.exactMatch) }
      record[kind] = item.score
      record.score += 1 / (60 + rank + 1)
      scores.set(item.index, record)
    })
  }

  const result = []
  let used = 0
  const ranked = Array.from(scores.values()).sort((a, b) =>
    Number(b.exactMatch) - Number(a.exactMatch) || b.score - a.score || a.start - b.start)
  for (const hit of ranked) {
    if (result.length === 3) break
    if (result.some(item => item.start < hit.end && item.end > hit.start)) continue
    const block = `[원고 ${hit.start + 1}–${hit.end}자]\n${hit.text}`
    const added = block.length + (used ? 2 : 0)
    if (used + added > writingFields.pastPassages) continue
    result.push({ ...hit, block })
    used += added
  }
  return result
}
