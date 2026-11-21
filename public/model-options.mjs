import { validModelId } from './writing-config.mjs'

export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const samplingRanges = {
  temperature: { min: 0, max: 2 },
  top_p: { min: 0, max: 1 },
  seed: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const boolean = value => typeof value === 'boolean'
const positivePrice = value => Number.isFinite(value) && value >= 0
const providerSlugs = value => Array.isArray(value) && value.length > 0 &&
  value.every(slug => typeof slug === 'string' && /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(slug))
const within = (value, { min, max }) => Number.isFinite(value) && value >= min && value <= max
const validFields = (value, rules) => record(value) &&
  Object.entries(value).every(([key, entry]) => Object.hasOwn(rules, key) && rules[key](entry))

const routingRules = {
  zdr: boolean,
  allow_fallbacks: boolean,
  require_parameters: boolean,
  only: providerSlugs,
  order: providerSlugs,
  sort: value => ['price', 'latency', 'throughput'].includes(value),
  data_collection: value => ['allow', 'deny'].includes(value),
  max_price: value => validFields(value, { prompt: positivePrice, completion: positivePrice }),
}
const optionRules = {
  provider: value => validFields(value, routingRules),
  reasoning: value => validFields(value, { effort: effort => reasoningEfforts.includes(effort) }),
  temperature: value => within(value, samplingRanges.temperature),
  top_p: value => within(value, samplingRanges.top_p),
  seed: value => Number.isInteger(value) && within(value, samplingRanges.seed),
  stop: value => Array.isArray(value) && value.length > 0 &&
    value.every(sequence => typeof sequence === 'string' && sequence.length > 0),
}

export const validModelOptions = value => validFields(value, optionRules)
export const validModelOptionProfiles = value => record(value) &&
  Object.entries(value).every(([model, options]) => validModelId(model) && validModelOptions(options))

export const modelOptionsFor = (project, model) => project.modelOptions?.[model]

export function withModelOptions(project, payload) {
  return { ...payload, modelOptions: modelOptionsFor(project, payload.model) }
}

export function openRouterOptions({ provider, ...generation } = {}, { embedding = false } = {}) {
  return { ...(embedding ? {} : generation), provider: { zdr: true, ...provider } }
}

export function embeddingRouteKey(model, options) {
  const { provider } = openRouterOptions(options, { embedding: true })
  if (provider.zdr && Object.keys(provider).length === 1) return model
  return model + ':' + JSON.stringify(provider, (_, value) =>
    record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
}
