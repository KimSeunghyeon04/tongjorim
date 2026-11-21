import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openTongjorimStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS workspace (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      previous_snapshot TEXT
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
  const workspace = db.prepare('SELECT revision, snapshot FROM workspace WHERE id = 1')
  const initialize = db.prepare('INSERT OR IGNORE INTO workspace (id, revision, snapshot) VALUES (1, 1, ?)')
  const replace = db.prepare(`
    UPDATE workspace SET revision = revision + 1, previous_snapshot = snapshot, snapshot = ?
    WHERE id = 1 AND revision = ?
  `)
  const insertRequest = db.prepare(`
    INSERT INTO model_requests (id, timestamp, route, project_id, model, request, response, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const readWorkspace = () => workspace.get() ?? { revision: null, snapshot: null }

  return {
    readWorkspace,
    saveWorkspace(revision, snapshot) {
      const current = readWorkspace()
      if (current.snapshot === snapshot) return { revision: current.revision }
      const saved = revision === null ? initialize.run(snapshot) : replace.run(snapshot, revision)
      return saved.changes ? { revision: (revision ?? 0) + 1 } : { conflict: true, ...readWorkspace() }
    },
    recordModelRequest(id, exchange) {
      insertRequest.run(id, exchange.timestamp, exchange.route, exchange.projectId, exchange.request.model,
        JSON.stringify(exchange.request), JSON.stringify(exchange.response), exchange.error)
    },
    close() { db.close() },
  }
}
