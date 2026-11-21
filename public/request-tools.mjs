const number = new Intl.NumberFormat('ko-KR')
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 8 })
export const formatCost = value => value == null ? '확인 불가' : usd.format(value)

export function estimateUsage(input, output, model, requests = 1) {
  const bytes = new TextEncoder()
  const inputTokens = input.reduce((sum, text) => sum + Math.ceil(bytes.encode(text).length / 4), 0)
  const cost = model?.input == null || (output && model?.output == null) || model?.request == null
    ? null
    : inputTokens * model.input + output * (model.output ?? 0) + requests * model.request
  return { inputTokens, outputTokens: output, cost }
}

export function completionEstimate(payload, model) {
  return estimateUsage(payload.messages.map(message => message.role + '\n' + message.content),
    payload.max_completion_tokens, model)
}

export function actualUsage(usage) {
  const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  return {
    inputTokens: tokens(usage?.prompt_tokens),
    outputTokens: tokens(usage?.completion_tokens),
    totalTokens: tokens(usage?.total_tokens),
    cost: typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null,
  }
}

export function combineUsage(before, after) {
  if (!before) return after
  return Object.fromEntries(Object.keys(before).map(key => [
    key, before[key] == null || after[key] == null ? null : before[key] + after[key],
  ]))
}

export function estimateLabel({ inputTokens, outputTokens, cost }) {
  return `추정 입력 ${number.format(inputTokens)}토큰 · 출력 한도 ${number.format(outputTokens)}토큰 · 비용 ${formatCost(cost)}`
}

export function usageLabel(usage) {
  const format = value => value == null ? '확인 불가' : number.format(value)
  return `실제 입력 ${format(usage?.inputTokens)} · 출력 ${format(usage?.outputTokens)} · 총 토큰 ${format(usage?.totalTokens)} · 비용 ${formatCost(usage?.cost)}`
}

export async function jsonRequest(path, { body, signal } = {}) {
  const response = await fetch(path, body === undefined ? { signal } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? '요청을 처리할 수 없어요.')
  return data
}
