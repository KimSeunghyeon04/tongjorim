import { requestCompletion } from './completion.js'
import { memoryExcerptLimit, writingFields } from './writing-config.mjs'

export function memoryReadThrough(project) {
  return project.manuscriptMemory?.stale ? 0 : project.manuscriptMemory?.through ?? 0
}

export function memoryForPrompt(project) {
  return memoryReadThrough(project) ? project.manuscriptMemory.text : ''
}

export const modelFor = (project, purpose) => project[`${purpose}Model`] ?? project.model

export function setManuscriptText(project, value) {
  const through = memoryReadThrough(project)
  if (through && value.slice(0, through) !== project.manuscript.slice(0, through)) {
    project.manuscriptMemory.stale = true
  }
  project.manuscript = value
}

function excerptEnd(manuscript, start) {
  const end = Math.min(manuscript.length, start + memoryExcerptLimit)
  if (end === manuscript.length) return end
  const paragraph = manuscript.lastIndexOf('\n\n', end - 2) + 2
  if (paragraph > start + memoryExcerptLimit / 2 &&
      Math.ceil((manuscript.length - paragraph) / memoryExcerptLimit) ===
      Math.ceil((manuscript.length - end) / memoryExcerptLimit)) return paragraph
  const lastCodeUnit = manuscript.charCodeAt(end - 1)
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? end - 1 : end
}

export function memoryRequest(project, snapshot = project.manuscript, through = memoryReadThrough(project), memory = memoryForPrompt(project)) {
  return {
    model: modelFor(project, 'memory'), projectTitle: project.title, memory,
    excerpt: snapshot.slice(through, excerptEnd(snapshot, through)), systemPrompt: project.notePrompts?.memory,
  }
}

export async function updateManuscriptMemory(project, snapshot, signal, onCheckpoint, onUsage) {
  let through = memoryReadThrough(project)
  let memory = memoryForPrompt(project)
  const { model, systemPrompt, projectTitle } = memoryRequest(project)

  while (through < snapshot.length) {
    signal.throwIfAborted()
    const { excerpt } = memoryRequest(project, snapshot, through, memory)
    const end = through + excerpt.length

    if (excerpt.trim()) {
      let revised = ''
      const result = await requestCompletion('/api/memory', {
        model, projectTitle, memory, excerpt, systemPrompt,
      }, {
        signal,
        onText(content) { revised += content },
      })
      onUsage(result.usage)
      revised = revised.trim()
      if (!revised || result.truncated || revised.length > writingFields.manuscriptMemory) {
        throw new Error('메모를 한 번에 완성하기 어려웠어요. 다시 시도하거나 프롬프트에 더 짧게 정리하도록 지시해 주세요.')
      }
      memory = revised
    }

    signal.throwIfAborted()
    if (project.manuscript.slice(0, end) !== snapshot.slice(0, end)) {
      throw new Error('메모를 갱신하는 동안 읽던 원고가 바뀌었어요. 갱신을 다시 눌러 주세요.')
    }
    through = end
    project.manuscriptMemory = { text: memory, through, stale: false }
    onCheckpoint()
  }
}
