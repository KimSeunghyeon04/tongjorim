import { memoryForPrompt } from './manuscript-memory.mjs'
import { completionEstimate } from './request-tools.mjs'
import { activeLore, selectPast } from './retrieval.mjs'
import {
  completionPayload, defaultSystemPrompt, effectiveSystemPrompt, orderedWritingContext,
  projectNotesForRequest, writingFieldPrefix,
} from './writing-config.mjs'

function suffixAt(text, length) {
  let start = Math.max(0, text.length - length)
  const previous = text.charCodeAt(start - 1)
  const first = text.charCodeAt(start)
  if (previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) start++
  return text.slice(start)
}

export function planWritingContext(project, references, model, limits) {
  const { manuscript, maxTokens, systemPrompt } = project
  const direction = writingFieldPrefix('direction', project.direction)
  const sceneLength = writingFieldPrefix('sceneLength', (project.sceneLength ?? '').trim())
  const lore = references.includes('lorebook') ? activeLore(project.lorebook ?? [], manuscript, direction) : { text: '', included: [] }
  const draft = orderedWritingContext({
    ...projectNotesForRequest(project), direction, sceneLength, manuscriptMemory: memoryForPrompt(project),
    lorebook: lore.text, manuscript: '', pastPassages: '',
  }, references)
  const contextLength = model?.contextLength ?? null
  const reserve = contextLength === null ? 0 : Math.min(2048, Math.max(128, Math.ceil(contextLength * 0.05)))
  const prompt = effectiveSystemPrompt(systemPrompt, defaultSystemPrompt)
  const estimate = context => completionEstimate(completionPayload(project.model, maxTokens, prompt, context), model)
  const base = estimate(draft)
  const budget = contextLength === null ? null : contextLength - base.outputTokens - reserve
  const fits = context => budget === null || estimate(context).inputTokens <= budget
  let recentReduced = false
  if (references.includes('manuscript')) {
    const requested = Math.min(manuscript.length, limits.manuscript)
    const full = suffixAt(manuscript, requested)
    draft.manuscript = full
    if (!fits(draft)) {
      let low = 0
      let high = requested
      while (low < high) {
        const length = Math.ceil((low + high) / 2)
        if (fits({ ...draft, manuscript: suffixAt(manuscript, length) })) low = length
        else high = length - 1
      }
      draft.manuscript = suffixAt(manuscript, low)
      recentReduced = draft.manuscript.length < full.length
    }
  }
  const cutoff = manuscript.length - (draft.manuscript?.length ?? 0)
  const pastLimit = references.includes('pastPassages') ? limits.pastPassages : 0
  const canFitPast = pastLimit > 0 && (budget === null || estimate(draft).inputTokens < budget)
  const body = { model: project.model, maxTokens, systemPrompt, references, draft }
  return {
    cutoff, pastLimit, canFitPast, body,
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
        body: { ...body, draft: context }, lore: lore.included, hits, cutoff, usage, contextLength, reserve,
        originalBudget: budget === null ? null : budget - base.inputTokens,
        remaining: budget === null ? null : budget - usage.inputTokens,
        recentReduced, pastReduced,
        outputTooLarge: model?.maxCompletionTokens != null && maxTokens > model.maxCompletionTokens,
      }
    },
  }
}
