import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyModel } from '../public/model-classification.mjs'

test('model generations group versions across tier, variant, and date suffixes', () => {
  const cases = [
    ['anthropic/claude-3-5-sonnet-20241022', 'Claude 3.5'],
    ['anthropic/claude-sonnet-4.6', 'Claude 4.6'],
    ['openai/gpt-6.2-astra-pro', 'GPT-6.2'],
    ['openai/gpt-4o-mini', 'GPT-4o'],
    ['google/gemini-2.5-flash-preview-09-2025', 'Gemini 2.5'],
    ['qwen/qwen3.8-27b:free', 'Qwen 3.8'],
    ['deepseek/deepseek-r1-0528', 'DeepSeek R1'],
    ['meta-llama/llama-3.3-70b-instruct', 'Llama 3.3'],
    ['openai/text-embedding-3-large', 'Text Embedding 3'],
  ]
  for (const [id, generation] of cases) assert.equal(classifyModel({ id }).generation, generation, id)
})

test('model publishers use IDs for grouping and models without a generation remain available', () => {
  const model = { id: 'radixark/daisyrose-27b', name: 'RadixArk: DaisyRose 27B', free: true }
  assert.deepEqual(classifyModel(model), {
    ...model, publisher: 'radixark', publisherName: 'RadixArk', generation: '세대 미분류',
  })
  assert.equal(classifyModel({ id: 'mistralai/pixtral-large-2502' }).generation, '세대 미분류')
  assert.equal(classifyModel({ id: 'openrouter/free' }).publisherName, 'OpenRouter')
})
