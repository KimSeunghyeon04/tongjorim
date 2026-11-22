import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openTongjorimStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS workspace (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        previous_snapshot TEXT,
        save_attempt TEXT
      );
      CREATE TABLE IF NOT EXISTS model_requests (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        route TEXT NOT NULL,
        project_id TEXT,
        model TEXT NOT NULL,
        request TEXT NOT NULL,
        response TEXT NOT NULL,
        error TEXT
      );
    `)
    if (!db.prepare('PRAGMA table_info(workspace)').all().some(column => column.name === 'save_attempt')) {
      db.exec('ALTER TABLE workspace ADD COLUMN save_attempt TEXT')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.close()
    throw error
  }
  const workspace = db.prepare('SELECT revision, snapshot, save_attempt FROM workspace WHERE id = 1')
  const initialize = db.prepare('INSERT OR IGNORE INTO workspace (id, revision, snapshot, save_attempt) VALUES (1, 1, ?, ?)')
  const replace = db.prepare(`
    UPDATE workspace SET revision = revision + 1, previous_snapshot = snapshot, snapshot = ?, save_attempt = ?
    WHERE id = 1 AND revision = ?
  `)
  const insertRequest = db.prepare(`
    INSERT INTO model_requests (id, timestamp, route, project_id, model, request, response, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const readWorkspace = () => {
    const row = workspace.get()
    return { revision: row?.revision ?? null, snapshot: row?.snapshot ?? null }
  }

  return {
    readWorkspace,
    saveWorkspace(revision, snapshot, attempt = null) {
      const current = readWorkspace()
      if (current.snapshot === snapshot) return { revision: current.revision }
      const saved = revision === null ? initialize.run(snapshot, attempt) : replace.run(snapshot, attempt, revision)
      const next = (revision ?? 0) + 1
      if (saved.changes) return { revision: next }
      const latest = workspace.get()
      const conflict = { conflict: true, revision: latest?.revision ?? null, snapshot: latest?.snapshot ?? null }
      if (attempt !== null && latest?.revision === next && latest.save_attempt === attempt) conflict.committedAttempt = true
      return conflict
    },
    recordModelRequest(id, exchange) {
      insertRequest.run(id, exchange.timestamp, exchange.route, exchange.projectId, exchange.request.model,
        JSON.stringify(exchange.request), JSON.stringify(exchange.response), exchange.error)
    },
    close() { db.close() },
  }
}
