import { sceneVersionPath } from './manuscript-scenes.mjs'
import { paragraphRanges } from './retrieval.mjs'

const words = new Intl.Segmenter('ko', { granularity: 'word' })

function paragraphTokens(text, ranges = paragraphRanges(text)) {
  if (!ranges.length) return text ? [text] : []
  return ranges.map(({ start }, index) => text.slice(index ? start : 0, ranges[index + 1]?.start))
}

const wordTokens = text => Array.from(words.segment(text), ({ segment }) => segment)
const paragraphWords = text => new Set(Array.from(words.segment(text), word => word.isWordLike ? word.segment : '').filter(Boolean))

function precedingDiagonal(path, index, diagonal, distance) {
  return diagonal === -distance || (diagonal !== distance && path[index - 1] < path[index + 1]) ? 1 : -1
}

// Bounded Myers diff. Each saved frontier lets us recover the matching runs along the edit path.
function matchingRuns(before, after, matches = (left, right) => left === right) {
  const limit = 256
  if (!before.length || !after.length || Math.abs(before.length - after.length) > limit) return []
  const center = limit + 1
  const path = new Int32Array(2 * center + 1)
  const history = []
  let comparisons = 1_000_000
  for (let distance = 0; distance <= limit; distance++) {
    history.push(path.slice())
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = center + diagonal
      const step = precedingDiagonal(path, index, diagonal, distance)
      let left = path[index + step] + Number(step === -1)
      let right = left - diagonal
      while (left < before.length && right < after.length) {
        if (--comparisons === 0) return []
        if (!matches(before[left], after[right])) break
        left++
        right++
      }
      path[index] = left
      if (left >= before.length && right >= after.length) {
        const runs = []
        for (let depth = distance; depth >= 0; depth--) {
          const previous = history[depth]
          const diagonal = left - right
          const index = center + diagonal
          const step = precedingDiagonal(previous, index, diagonal, depth)
          const fromLeft = previous[index + step]
          const fromRight = fromLeft - diagonal - step
          const length = Math.min(left - fromLeft, right - fromRight)
          if (length) runs.push({ left: left - length, right: right - length, length })
          left = fromLeft
          right = fromRight
        }
        return runs.reverse()
      }
    }
  }
  return []
}

function compareTokens(before, after, ignoreSpaces = false) {
  let prefix = 0
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++
  let leftEnd = before.length
  let rightEnd = after.length
  while (leftEnd > prefix && rightEnd > prefix && before[leftEnd - 1] === after[rightEnd - 1]) {
    leftEnd--
    rightEnd--
  }
  const parts = []
  if (prefix) parts.push({ text: before.slice(0, prefix).join('') })
  let leftStart = prefix
  let rightStart = prefix
  const runs = matchingRuns(before.slice(prefix, leftEnd), after.slice(prefix, rightEnd))
  runs.push({ left: leftEnd - prefix, right: rightEnd - prefix, length: 0 })
  for (const { left, right, length } of runs) {
    let leftMatch = prefix + left
    let rightMatch = prefix + right
    const text = before.slice(leftMatch, leftMatch + length).join('')
    if (ignoreSpaces && length) {
      if (/^[^\S\n]+$/.test(text)) continue
      // Spaces between replaced words may belong to both sides. Keep shared spaces beside unchanged prose.
      while (leftMatch > leftStart && rightMatch > rightStart && before[leftMatch - 1] === after[rightMatch - 1] &&
          /^[^\S\n]+$/.test(before[leftMatch - 1])) {
        leftMatch--
        rightMatch--
      }
    }
    if (leftStart < leftMatch || rightStart < rightMatch) {
      parts.push({ before: before.slice(leftStart, leftMatch).join(''), after: after.slice(rightStart, rightMatch).join('') })
    }
    if (length) parts.push({ text: before.slice(leftMatch, prefix + left + length).join('') })
    leftStart = prefix + left + length
    rightStart = prefix + right + length
  }
  if (leftEnd < before.length) parts.push({ text: before.slice(leftEnd).join('') })
  return parts
}

function wordChanges(before, after) {
  return compareTokens(wordTokens(before), wordTokens(after), true)
}

function similarParagraph(before, after) {
  let shared = 0
  for (const word of before) {
    if (after.has(word)) shared++
  }
  return shared >= 2 && shared * 2 >= Math.max(before.size, after.size)
}

function refineChange({ before, after }) {
  const left = paragraphTokens(before)
  const right = paragraphTokens(after)
  if ((left.length === 1 && right.length === 1) || before.replace(/\s+/g, '') === after.replace(/\s+/g, '')) {
    return wordChanges(before, after)
  }

  // Align edited paragraphs before their words so a deleted neighbor cannot claim shared punctuation.
  const runs = matchingRuns(left.map(paragraphWords), right.map(paragraphWords), similarParagraph)
  runs.push({ left: left.length, right: right.length, length: 0 })
  const parts = []
  let leftStart = 0
  let rightStart = 0
  for (const run of runs) {
    if (leftStart < run.left || rightStart < run.right) {
      parts.push(...wordChanges(left.slice(leftStart, run.left).join(''), right.slice(rightStart, run.right).join('')))
    }
    for (let index = 0; index < run.length; index++) {
      parts.push(...wordChanges(left[run.left + index], right[run.right + index]))
    }
    leftStart = run.left + run.length
    rightStart = run.right + run.length
  }
  return parts
}

export function draftChanges(before, after) {
  const paragraphs = paragraphRanges(before)
  const parts = compareTokens(paragraphTokens(before, paragraphs), paragraphTokens(after))
    .flatMap(part => part.before && part.after ? refineChange(part) : [part])
  const starts = new Map(paragraphs.map(({ start }, index) => [start, index]))
  const ends = new Map(paragraphs.map(({ end }, index) => [end, index]))
  let offset = 0
  for (const part of parts) {
    const text = part.text ?? part.before
    if (part.before && !part.after) {
      const first = starts.get(offset + text.length - text.trimStart().length)
      const last = ends.get(offset + text.trimEnd().length)
      if (first !== undefined && last >= first) part.deletedParagraphs = last - first + 1
    }
    offset += text.length
  }
  return parts
}

function formatDraftDiff(before, after) {
  if (before === after) return ''
  const lines = []
  let oldOffset = 0
  let newOffset = 0
  let removed = ''
  let added = ''
  function addHunk() {
    if (!removed && !added) return
    // Hunk ranges are zero-based UTF-16 character offsets and lengths in the two versions.
    lines.push(`@@ -${oldOffset},${removed.length} +${newOffset},${added.length} @@`)
    if (removed) lines.push('- ' + removed.replaceAll('\n', '\n- '))
    if (added) lines.push('+ ' + added.replaceAll('\n', '\n+ '))
    oldOffset += removed.length
    newOffset += added.length
    removed = ''
    added = ''
  }
  for (const part of draftChanges(before, after)) {
    if (part.text !== undefined) {
      addHunk()
      oldOffset += part.text.length
      newOffset += part.text.length
    } else {
      removed += part.before
      added += part.after
    }
  }
  addHunk()
  return lines.join('\n')
}

export function sceneRevisionHistory(versions, selected) {
  const history = []
  for (const index of sceneVersionPath(versions, selected)) {
    const { text, direction, parent } = versions[index]
    if (parent === null) break
    history.push({ fromVersion: parent + 1, toVersion: index + 1, direction, diff: formatDraftDiff(versions[parent].text, text) })
  }
  return history.reverse()
}

function removedTextToggle(removed, label) {
  const button = document.createElement('button')
  button.className = 'quiet-button'
  button.type = 'button'
  function setExpanded(expanded) {
    removed.hidden = !expanded
    button.setAttribute('aria-expanded', String(expanded))
    button.textContent = `${label} · ${expanded ? '접기' : '펼치기'}`
  }
  setExpanded(false)
  button.addEventListener('click', () => setExpanded(removed.hidden))
  return button
}

function changeElement({ before, after, deletedParagraphs }) {
  const change = document.createElement('span')
  change.className = 'continuation-change'
  if (!before.trim() && !after.trim()) {
    const label = document.createElement('span')
    label.className = 'continuation-spacing'
    label.textContent = (before + after).includes('\n') ? '줄바꿈 변경' : '공백 변경'
    change.append(label, after)
    return change
  }
  if (before) {
    const removed = document.createElement('del')
    const content = before.trim()
    if (deletedParagraphs || content.length > 240 || paragraphRanges(content).length > 1) {
      change.classList.add(deletedParagraphs ? 'continuation-deletion' : 'continuation-folded')
      const label = deletedParagraphs ? `문단 ${deletedParagraphs}개 삭제` : after ? '수정 전 본문' : '삭제된 구절'
      removed.textContent = content
      change.append(removedTextToggle(removed, label))
    } else {
      removed.textContent = before
    }
    change.append(removed)
  }
  if (after) {
    const added = document.createElement('ins')
    added.textContent = after
    change.append(added)
  }
  return change
}

export function setupDraftChanges(get) {
  const scroll = get('continuation-scroll')
  const body = get('continuation-text')
  const toolbar = get('continuation-changes')
  const status = get('continuation-change-status')
  const toggle = get('continuation-change-toggle')
  const next = get('continuation-change-next')
  let version
  let parent
  let parts = []
  let count = 0
  let shown = false
  let changes = []
  let current = -1

  function updateStatus() {
    const summary = count ? `변경 ${current < 0 ? `${count}곳` : `${current + 1} / ${count}`}` : '변경 없음'
    status.textContent = `버전 ${version.parent + 1} 기준 · ${summary}`
  }

  function renderBody() {
    current = -1
    changes = []
    if (shown) {
      body.replaceChildren(...parts.map(part => {
        if (part.text !== undefined) return document.createTextNode(part.text)
        const change = changeElement(part)
        changes.push(change)
        return change
      }))
    } else {
      body.textContent = version?.text ?? ''
    }
    toolbar.hidden = !parent
    toggle.hidden = !count
    toggle.textContent = shown ? '수정 표시 숨기기' : '수정 표시 보기'
    next.hidden = !shown
    if (parent) updateStatus()
  }

  toggle.addEventListener('click', () => {
    shown = !shown
    renderBody()
  })
  next.addEventListener('click', () => {
    changes[current]?.removeAttribute('aria-current')
    current = (current + 1) % changes.length
    const change = changes[current]
    change.setAttribute('aria-current', 'true')
    const firstLine = change.getClientRects()[0]
    scroll.scrollTop += firstLine.top - scroll.getBoundingClientRect().top - scroll.clientHeight / 3
    updateStatus()
  })

  return function render(nextVersion, nextParent, showByDefault) {
    if (version === nextVersion && parent === nextParent) return
    version = nextVersion
    parent = nextParent
    parts = parent && parent.text !== version.text ? draftChanges(parent.text, version.text) : []
    count = parts.filter(part => part.text === undefined).length
    shown = Boolean(count && showByDefault)
    renderBody()
    scroll.scrollTop = 0
  }
}
