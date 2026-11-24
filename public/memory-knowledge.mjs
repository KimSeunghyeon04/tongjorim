import { numberedPassages, passageInput, selectEvidence } from './numbered-passages.mjs'
import { completionPayload, defaultMemoryPrompt, effectiveSystemPrompt, writingFields } from './writing-config.mjs'

const limited = (value, length) => typeof value === 'string' && Boolean(value.trim()) && value.length <= length
const knowledgePassages = excerpt => numberedPassages(excerpt, { sentences: true })

export function validKnowledge(knowledge) {
  if (!Array.isArray(knowledge) || new Set(knowledge.map(item => item?.fact)).size !== knowledge.length) return false
  return knowledge.every(item => {
    if (!item || !limited(item.fact, 300) || typeof item.exclusive !== 'boolean' ||
        !Array.isArray(item.knows) || !Array.isArray(item.unaware) || (item.exclusive && !item.knows.length)) return false
    const names = [...item.knows, ...item.unaware]
    return names.length > 0 && names.every(name => limited(name, 100) && name === name.trim()) && new Set(names).size === names.length
  })
}

export function memoryWithKnowledge(summary, knowledge) {
  if (!knowledge?.length) return summary
  const lines = knowledge.map(({ fact, knows, unaware, exclusive }) => [
    `- ${fact}`,
    knows.length ? `${knows.join(', ')}${exclusive ? '만' : ''} 앎` : '',
    unaware.length ? `${unaware.join(', ')} 모름` : '',
  ].filter(Boolean).join(' · '))
  return [summary, ['## 인물이 아는 사실', ...lines].join('\n')].filter(Boolean).join('\n\n')
}

export function manuscriptMemoryPayload({ model, maxTokens, projectTitle, memory, excerpt, systemPrompt, knowledge }) {
  const prompt = effectiveSystemPrompt(systemPrompt, defaultMemoryPrompt)
  if (knowledge === undefined) return completionPayload(model, maxTokens, prompt, { projectTitle, memory, excerpt })
  const format = [
    '이 요청의 응답은 마크다운 없이 JSON 객체 하나의 텍스트입니다. {"summary":"요약","knowledgeChanges":[]} 형식을 쓰고, 앞의 작성 지시는 summary에 적용하세요.',
    'knowledge는 이전까지 확인한 인물 지식 목록입니다. 미해결 단서, 비밀, 오해처럼 누가 알고 모르는지가 이후 장면에 영향을 주는 사실만 기록하세요. 등장인물의 추측을 확인된 지식으로 올리지 마세요.',
    '소지, 이동, 감각, 현재 감정, 공개 안내문을 읽거나 공개 규칙을 지킨 일은 요약에 넣으세요. 그런 사건도 다른 인물에게 숨겼거나, 특정 인물만 새 사실을 배웠다는 정보 격차가 명시될 때에만 knowledgeChanges에 남기세요.',
    'knowledgeChanges에 확인된 추가나 변경만 넣으세요. 코드가 생략된 기존 항목을 그대로 보존합니다. 해당 사항이 없으면 빈 배열을 반환하세요.',
    '각 항목은 {"id":0,"fact":"아는 사실","knows":["이름"],"unaware":[],"exclusive":false,"source":"excerpt","evidenceIds":[1]} 형식입니다. 새 사실은 id=0, 변경은 knowledge의 기존 id와 동일한 fact를 사용하세요.',
    'fact에는 알고 있는 내용 한 가지만 적고 인물과 독점 여부는 knows, unaware, exclusive로 분리하세요. “민서만 지도 밑의 숨은 표시를 봤다”라면 fact는 숨은 표시 하나이며, 지도를 가지고 있다는 주변 사실까지 민서만 안다고 확대하지 마세요.',
    'knows와 unaware에는 해당 사실을 확실히 알거나 모르는 인물을 구분해 기록하세요. exclusive=true는 원문이 그 사실을 오직 그 인물들만 안다고 명시할 때만 사용하세요.',
    '근거는 excerpt의 번호만 사용하세요. previousMemo가 제공된 경우에는 이전 메모가 명시한 지식을 id=0, source="memory", previousMemo의 번호로 옮길 수 있습니다. 기존 id의 변경에는 이번 excerpt의 근거가 필요합니다.',
    '각 fact는 300자 이내, 이름은 100자 이내로 기록하세요. 기존 지식과 요약을 합친 메모가 6,000자를 넘지 않도록 summary를 압축하세요.',
  ].join('\n')
  return completionPayload(model, maxTokens, [prompt, format].join('\n\n'), {
    projectTitle, memory, excerpt: passageInput(knowledgePassages(excerpt)),
    knowledge: (knowledge ?? []).map((item, index) => ({ id: index + 1, ...item })),
    ...(knowledge === null && memory ? { previousMemo: passageInput(numberedPassages(memory)) } : {}),
  })
}

export function applyMemoryUpdate(response, { memory, excerpt, knowledge }) {
  let decoded
  try {
    const wrapped = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(response)
    decoded = JSON.parse(wrapped ? wrapped[1] : response)
  } catch {
    throw new Error('원고 메모의 응답 형식을 확인할 수 없어요. 다시 시도해 주세요.')
  }
  if (!limited(decoded?.summary, writingFields.manuscriptMemory) || !Array.isArray(decoded.knowledgeChanges)) {
    throw new Error('원고 메모의 요약과 인물 지식 목록을 확인할 수 없어요. 다시 시도해 주세요.')
  }
  const original = knowledge ?? []
  const next = [...original]
  const excerptPassages = knowledgePassages(excerpt)
  const oldPassages = knowledge === null ? numberedPassages(memory) : []
  const applied = new Set()
  const facts = new Set(original.map(item => item.fact))
  for (const change of decoded.knowledgeChanges) {
    if (!change || !Number.isSafeInteger(change.id) || change.id < 0 || change.id > original.length) continue
    const { id, fact, knows, unaware, exclusive, source, evidenceIds } = change
    const evidence = source === 'excerpt' ? excerptPassages : source === 'memory' && id === 0 ? oldPassages : []
    const cited = selectEvidence(evidence, evidenceIds)
    if (!cited || !validKnowledge([{ fact, knows, unaware, exclusive }]) || (id && applied.has(id))) continue
    const previous = original[id - 1]
    const knownNames = new Set([...(previous?.knows ?? []), ...(previous?.unaware ?? [])])
    const named = name => knownNames.has(name) || cited.some(passage => passage.text.includes(name))
    const entry = { fact, knows: knows.filter(named), unaware: unaware.filter(named), exclusive }
    if (!validKnowledge([entry]) || (id ? previous.fact !== fact : facts.has(fact))) continue
    if (id) {
      next[id - 1] = entry
      applied.add(id)
    } else {
      next.push(entry)
      facts.add(fact)
    }
  }
  const text = decoded.summary.trim()
  if (memoryWithKnowledge('', next).length > writingFields.manuscriptMemory) {
    throw new Error('보존할 인물 지식만으로 원고 메모 한도를 넘었어요.')
  }
  if (memoryWithKnowledge(text, next).length > writingFields.manuscriptMemory) {
    throw new Error('인물 지식과 요약을 합친 원고 메모가 너무 길어요. 요약을 더 짧게 요청해 주세요.')
  }
  return { text, knowledge: next }
}
