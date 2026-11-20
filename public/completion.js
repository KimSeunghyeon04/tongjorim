export { freeModel } from './writing-config.mjs'

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 })

export function pricing(model) {
  if (model.free) return '무료'
  if (model.input == null || model.output == null) return '가격 정보 없음'
  const input = usdFormat.format(model.input * 1_000_000)
  const output = usdFormat.format(model.output * 1_000_000)
  const base = `100만 토큰당 입력 ${input} · 출력 ${output}`
  return model.request ? `${base} · 요청당 ${usdFormat.format(model.request)}` : base
}

export async function requestCompletion(path, body, { signal, onText }) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const data = await response.json()
    throw new Error(data.error ?? '요청이 실패했어요. 다시 시도해 주세요.')
  }

  let buffer = ''
  let done
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (buffer + chunk).split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line) continue
      const event = JSON.parse(line)
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'done') done = event
      if (event.type === 'text') onText(event.content)
    }
  }
  if (!done) throw new Error('응답을 끝까지 받지 못했어요. 다시 시도해 주세요.')
  return done
}
