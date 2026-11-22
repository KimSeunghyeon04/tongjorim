import { canonicalMilestone, evidenceInScene, planReplacement, reviewedScene } from './scene-review.mjs'

const element = (tag, text = '', className = '') => Object.assign(document.createElement(tag), { textContent: text, className })
const button = (text, className, onclick) => Object.assign(element('button', text, className), { type: 'button', onclick })

export function setupPlanProgress({ get, currentProject, saveWorkspace, goToPassage, onChange }) {
  const panel = get('plan-scene-review')
  const list = get('plan-milestones')
  const suggestions = get('plan-scene-suggestion')
  const status = get('plan-scene-status')
  const sessions = new WeakMap()

  function render() {
    const project = currentProject()
    const session = sessions.get(project)
    const milestones = new Map()
    const edits = []
    for (const review of project.sceneReviews ?? []) {
      const source = reviewedScene(project, review)
      if (!source) continue
      for (const entry of review.progress) {
        const passages = evidenceInScene(source, entry.evidence)
        const milestone = canonicalMilestone(project.synopsis, entry.milestone)
        if (passages && milestone && !milestones.has(milestone)) milestones.set(milestone, { passages, scene: source.scene })
      }
      const change = review.planChange
      const passages = change && evidenceInScene(source, change.evidence)
      if (passages && planReplacement(project.synopsis, change)) edits.unshift({ review, change, passages, scene: source.scene })
    }

    panel.hidden = !milestones.size && !edits.length && !session?.message
    list.replaceChildren(...Array.from(milestones, ([milestone, { passages, scene }]) => {
      const item = element('li')
      item.append(element('span', '완료', 'lore-review-tag'), element('span', milestone),
        ...evidenceButtons(passages, scene.title))
      return item
    }))
    suggestions.replaceChildren(...edits.map(({ review, change, passages, scene }) => {
      const item = element('section')
      const heading = element('div', '', 'lore-review-meta')
      heading.append(element('h3', '줄거리 수정 제안'), element('span', scene.title, 'field-hint'))
      const diff = element('div', '', 'lore-review-diff')
      for (const [label, value] of [['현재 줄거리', change.before], ['제안된 문구', change.after]]) {
        const pane = element('div')
        pane.append(element('h3', label), element('p', value))
        diff.append(pane)
      }
      const actions = element('div', '', 'compact-actions')
      const discard = button('계획 유지', 'quiet-button', () => resolve(project, review, false))
      const approve = button('줄거리에 반영', 'outline-button', () => resolve(project, review, true))
      discard.disabled = approve.disabled = Boolean(session?.saving)
      actions.append(...evidenceButtons(passages, '원고에서 근거 보기'), discard, approve)
      item.append(heading, diff, actions)
      return item
    }))
    status.textContent = session?.message ?? ''
  }

  function evidenceButtons(passages, label) {
    return passages.map((passage, index) => button(
      passages.length === 1 ? label : `근거 ${index + 1}`, 'quiet-button', () => goToPassage(passage),
    ))
  }

  async function resolve(project, review, apply) {
    if (sessions.get(project)?.saving) return
    const session = { saving: true, message: '' }
    sessions.set(project, session)
    render()
    let applied = false
    const saved = await saveWorkspace(() => {
      const before = project.sceneReviews
      const live = before?.find(item => item.sceneId === review.sceneId && item.version === review.version)
      const source = live && reviewedScene(project, live)
      const change = review.planChange
      if (live?.planChange !== change || !source || !evidenceInScene(source, change.evidence)) return
      const synopsis = project.synopsis
      const replacement = apply ? planReplacement(synopsis, change) : synopsis
      if (replacement === null) return
      const after = before.map(item => item === live ? { ...item, planChange: null } : item)
      project.sceneReviews = after
      project.synopsis = replacement
      applied = true
      return () => {
        if (project.sceneReviews === after) project.sceneReviews = before
        if (project.synopsis === replacement) project.synopsis = synopsis
      }
    })
    session.saving = false
    session.message = !saved ? '검토 결과를 저장하지 못했어요.'
      : !applied ? '줄거리나 근거 원고가 바뀌었어요.'
        : apply ? '수정안을 줄거리에 반영했어요.' : '현재 줄거리를 유지했어요.'
    if (saved && applied && apply) onChange(project)
    if (project === currentProject()) render()
  }

  return { render }
}
