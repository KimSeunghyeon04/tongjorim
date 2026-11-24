import { memoryForPrompt } from './manuscript-memory.mjs'
import { wholeRecentManuscript } from './recent-manuscript.mjs'
import { completionEstimate } from './request-tools.mjs'
import { activeLore, selectPast } from './retrieval.mjs'
import {
  continuationPayload, orderedWritingContext, sceneNeighborLimit, sceneRevisionContext,
  writingFieldPrefix,
} from './writing-config.mjs'

function suffixAt(text, length) {
  let start = Math.max(0, text.length - length)
  const previous = text.charCodeAt(start - 1)
  const first = text.charCodeAt(start)
  if (previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) start++
  return text.slice(start)
}

function fitSuffix(text, fits) {
  if (fits(text)) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const length = Math.ceil((low + high) / 2)
    if (fits(suffixAt(text, length))) low = length
    else high = length - 1
  }
  return suffixAt(text, low)
}

const contextReserve = length => length === null ? 0 : Math.min(2048, Math.max(128, Math.ceil(length * 0.05)))

export function planWritingContext(project, references, model, limits, addedLoreCards, sceneRevision) {
  const { manuscript, maxTokens, systemPrompt } = project
  const direction = writingFieldPrefix('direction', project.direction)
  const sceneLength = writingFieldPrefix('sceneLength', (project.sceneLength ?? '').trim())
  const recentLimit = references.includes('manuscript') ? limits.manuscript : 0
  const revision = sceneRevision && sceneRevisionContext({ ...sceneRevision, following: undefined })
  if (revision && recentLimit && sceneRevision.following) {
    const afterLimit = Math.max(Math.floor(recentLimit / 2), recentLimit - manuscript.length)
    const following = sceneRevision.following.slice(0, Math.min(afterLimit, sceneNeighborLimit)).toWellFormed()
    if (following) revision.following = following
  }
  const lore = references.includes('lorebook')
    ? activeLore(project.lorebook ?? [], manuscript, direction, addedLoreCards, revision)
    : { text: '', candidates: [] }
  const draft = orderedWritingContext({
    projectTitle: writingFieldPrefix('projectTitle', project.title), synopsis: project.synopsis ?? '',
    direction, sceneLength, manuscriptMemory: memoryForPrompt(project),
    lorebook: lore.text, manuscript: '', pastPassages: '',
  }, references)
  const contextLength = model?.contextLength ?? null
  const reserve = contextReserve(contextLength)
  const estimate = context => completionEstimate(continuationPayload(project.model, maxTokens, systemPrompt, context, revision), model)
  const budget = contextLength === null ? null : contextLength - maxTokens - reserve
  const fits = context => budget === null || estimate(context).inputTokens <= budget
  if (revision?.following && !fits(draft)) delete revision.following
  if (!revision && draft.manuscriptMemory && manuscript.length <= recentLimit &&
      fits({ ...draft, manuscript, manuscriptMemory: '' })) draft.manuscriptMemory = ''
  const base = estimate(draft)
  let recentReduced = false
  let recentWarning = ''
  if (references.includes('manuscript')) {
    const requested = Math.min(manuscript.length, sceneRevision?.precedingLimit ?? Infinity,
      recentLimit - (revision?.following?.length ?? 0))
    const full = suffixAt(manuscript, requested)
    const suffix = fitSuffix(full, manuscript => fits({ ...draft, manuscript }))
    if (revision) draft.manuscript = suffix
    else {
      const recent = wholeRecentManuscript(project, suffix, recentLimit)
      draft.manuscript = recent.text
      recentWarning = recent.warning
    }
    recentReduced = draft.manuscript.length < full.length
  }
  const cutoff = manuscript.length - (draft.manuscript?.length ?? 0)
  const pastLimit = references.includes('pastPassages') ? limits.pastPassages : 0
  const canFitPast = !recentWarning && pastLimit > 0 && (budget === null || estimate(draft).inputTokens < budget)
  const body = { model: project.model, maxTokens, systemPrompt, references, draft, ...(revision ? { sceneRevision: revision } : {}) }
  return {
    cutoff, pastLimit, canFitPast, recentWarning, body,
    finish(ranked = []) {
      let pastReduced = false
      const { hits, text } = selectPast(ranked, pastLimit, candidate => {
        const allowed = fits({ ...draft, pastPassages: candidate })
        if (!allowed) pastReduced = true
        return allowed
      })
      const context = references.includes('pastPassages') ? { ...draft, pastPassages: text } : draft
      const usage = estimate(context)
      return {
        body: { ...body, draft: context }, lore: lore.candidates, hits, cutoff, usage, contextLength, reserve,
        originalBudget: budget === null ? null : budget - base.inputTokens,
        remaining: budget === null ? null : budget - usage.inputTokens,
        recentReduced, recentWarning, pastReduced,
        outputTooLarge: model?.maxCompletionTokens != null && maxTokens > model.maxCompletionTokens,
      }
    },
  }
}
