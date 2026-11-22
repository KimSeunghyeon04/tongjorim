import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { createTongjorimServer } from './server-app.mjs'
import { openTongjorimStore } from './tongjorim-store.mjs'

try {
  loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API?.trim()
const managementKey = process.env.OPENROUTER_MANAGE?.trim()
const store = openTongjorimStore(process.env.TONGJORIM_DB_PATH || fileURLToPath(new URL('./data/tongjorim.sqlite', import.meta.url)))
const port = Number(process.env.PORT || 4173)

const server = createTongjorimServer({ apiKey, managementKey, store, port })
server.listen(port, '127.0.0.1', () => console.log(`통조림 실행 중 http://127.0.0.1:${port}`))
