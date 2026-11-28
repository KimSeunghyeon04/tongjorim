import { requestCompletion } from './completion.js'
import { withModelOptions } from './model-options.mjs'
import { canonicalMilestone, evidenceInScene, matchingLoreName, parseSceneReview, pendingLoreChanges, resolveSceneReview,
  reviewedScene, sceneForReview, sceneResolutionInput, sceneReviewInputValid, sceneReviewRequest } from './scene-review.mjs'

export function setupSceneReviewJobs({ hasProject, saveWorkspace, onChange }) {
  const jobs = new WeakMap()
  const pendingReview = (project, attempted) => project.sceneReviews?.find(
    review => !attempted?.has(review) && sceneForReview(project, review),
  )

  function start(project, { retry = false } = {}) {
    const previous = jobs.get(project)
    if (previous?.controller || (previous?.error && !retry)) return
    if (!pendingReview(project)) {
      if (retry && previous?.error) {
        previous.error = '다시 검토할 장면 본문이 없어요.'
        onChange(project)
      }
      return
    }
    const controller = new AbortController()
    const job = { controller, error: '', errorDismissed: false }
    jobs.set(project, job)
    onChange(project)
    run()

    async function run() {
      const { signal } = controller
      const attempted = new Set()
      try {
        let review
        while (!signal.aborted && hasProject(project) && (review = pendingReview(project, attempted))) {
          attempted.add(review)
          try {
            await analyze(project, review, signal)
          } catch (error) {
            if (!signal.aborted) {
              job.error = error instanceof SyntaxError ? '장면 검토 응답의 형식이 올바르지 않아요.' : error.message
              job.errorDismissed = false
            }
          }
          onChange(project)
        }
      } finally {
        job.controller = null
        onChange(project)
      }
    }
  }

  async function requestReview(project, input, signal) {
    let response = ''
    const result = await requestCompletion('/api/scene-review', withModelOptions(project, input), {
      signal, projectId: project.id, onText(content) { response += content },
    })
    signal.throwIfAborted()
    if (result.truncated) throw new Error('장면 검토 응답이 중간에 끝났어요.')
    return response
  }

  async function analyze(project, review, signal) {
    const source = sceneForReview(project, review)
    const input = sceneReviewRequest(project, source)
    if (!sceneReviewInputValid(input)) throw new Error('검토할 장면이 너무 길어요. 장면을 나눠 주세요.')
    const extracted = parseSceneReview(await requestReview(project, input, signal), input)
    if (!hasProject(project) || !project.sceneReviews?.includes(review)) return
    if (sceneForReview(project, review)?.text !== source.text) throw new Error('검토하는 동안 원고가 바뀌었어요.')
    const matchingInput = sceneReviewRequest(project, source)
    const resolution = extracted.candidates.length || extracted.progress.length
      ? await requestReview(project, { ...matchingInput, ...sceneResolutionInput(extracted) }, signal) : undefined
    const { progress, lore: proposed } = resolveSceneReview(extracted, matchingInput, resolution)
    let applied = false
    const saved = await saveWorkspace(() => {
      if (signal.aborted || !hasProject(project) || !project.sceneReviews?.includes(review)) return
      if (sceneForReview(project, review)?.text !== source.text) return
      const before = project.sceneReviews
      const completed = new Set()
      for (const entry of before) {
        const original = reviewedScene(project, entry)
        if (!original) continue
        for (const item of entry.progress) {
          if (evidenceInScene(original, item.evidence)) completed.add(canonicalMilestone(project.synopsis, item.milestone))
        }
      }
      const freshProgress = progress.filter(item => {
        const milestone = canonicalMilestone(project.synopsis, item.milestone)
        if (!milestone || completed.has(milestone)) return false
        completed.add(milestone)
        return true
      })
      const alreadyProposed = pendingLoreChanges(project).map(item => item.proposal)
      const lore = proposed.filter(proposal => {
        if (!proposal.targetId && matchingLoreName(project, proposal.name)) return false
        return !alreadyProposed.some(item => item.targetId === proposal.targetId &&
          item.name === proposal.name && item.description === proposal.description)
      })
      const completedReview = { ...review, pending: false, progress: freshProgress, planChange: extracted.planChange, lore }
      if ((freshProgress.length || completedReview.planChange || lore.length) &&
          source.text !== source.scene.versions[review.version].text.trim()) completedReview.reviewedText = source.text
      const after = before.map(item => item === review ? completedReview : item)
      project.sceneReviews = after
      applied = true
      return () => { if (project.sceneReviews === after) project.sceneReviews = before }
    })
    signal.throwIfAborted()
    if (!saved) throw new Error('장면 검토 결과를 저장하지 못했어요.')
    if (!applied && project.sceneReviews?.includes(review)) throw new Error('검토하는 동안 원고가 바뀌었거나 결과를 저장하지 못했어요.')
  }

  return {
    start,
    visibleError(project) {
      const job = jobs.get(project)
      return job && !job.errorDismissed ? job.error : ''
    },
    dismissError(project) {
      const job = jobs.get(project)
      if (!job?.error || job.errorDismissed) return
      job.errorDismissed = true
      onChange(project)
    },
    stop: project => jobs.get(project)?.controller?.abort(),
  }
}
