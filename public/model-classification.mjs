const publisherNames = new Map([
  ['deepseek', 'DeepSeek'],
  ['meta-llama', 'Meta'],
  ['openai', 'OpenAI'],
  ['openrouter', 'OpenRouter'],
  ['qwen', 'Qwen'],
  ['x-ai', 'xAI'],
])

const seriesNames = new Map([
  ['bge', 'BGE '],
  ['deepseek', 'DeepSeek '],
  ['glm', 'GLM-'],
  ['gpt', 'GPT-'],
  ['kimi-k', 'Kimi K'],
  ['minimax-m', 'MiniMax M'],
  ['o', 'o'],
])

export const unclassifiedGeneration = '세대 미분류'

function generationFor(slug) {
  // Claude puts the tier before or after the version, and some older IDs use a hyphen for the decimal.
  const claude = /^claude-(?:(?:opus|sonnet|haiku)-)?(\d{1,2})(?:[.-](\d{1,2}))?(?=-|$)/.exec(slug)
  if (claude) return `Claude ${claude.slice(1).filter(Boolean).join('.')}`
  if (/^gpt-oss(?:-|$)/.test(slug)) return 'GPT-OSS'

  // Parameter counts and release dates do not describe a generation.
  const match = /^([a-z]+(?:-[a-z]+)*?)-?([vr]?\d{1,2}(?:\.\d{1,2})*[on]?)(?=-|$)/.exec(slug)
  if (!match) return unclassifiedGeneration

  const [, series, version] = match
  const display = series.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
  return (seriesNames.get(series) ?? `${display} `) + version.replace(/^r/, 'R')
}

export function classifyModel(model) {
  const [publisher, slug] = model.id.toLowerCase().split('/')
  const name = typeof model.name === 'string' && model.name.trim() ? model.name : model.id
  const prefix = name.match(/^([^:]+): /)?.[1]
  return {
    ...model,
    name,
    publisher,
    publisherName: publisherNames.get(publisher) ?? prefix ?? publisher,
    generation: generationFor(slug.split(':')[0]),
  }
}
