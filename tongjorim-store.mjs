import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function snapshotState(snapshot) {
  if (snapshot == null) return null
  try {
    const state = JSON.parse(snapshot)
    return Array.isArray(state?.projects) ? state : null
  } catch {
    return null
  }
}

const projectIds = state => new Set(state?.projects.map(project => project.id))

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
      CREATE INDEX IF NOT EXISTS model_requests_by_project ON model_requests (project_id);
      CREATE TABLE IF NOT EXISTS deleted_projects (id TEXT PRIMARY KEY NOT NULL);
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
    UPDATE workspace SET revision = revision + 1, previous_snapshot = CASE WHEN ? THEN ? ELSE snapshot END,
      snapshot = ?, save_attempt = ?
    WHERE id = 1 AND revision = ?
  `)
  const deletedProject = db.prepare('SELECT 1 FROM deleted_projects WHERE id = ?')
  const markDeleted = db.prepare('INSERT OR IGNORE INTO deleted_projects (id) VALUES (?)')
  const deleteRequests = db.prepare('DELETE FROM model_requests WHERE project_id = ?')
  const insertRequest = db.prepare(`
    INSERT INTO model_requests (id, timestamp, route, project_id, model, request, response, error)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)
  `)
  const readWorkspace = () => {
    const row = workspace.get()
    return { revision: row?.revision ?? null, snapshot: row?.snapshot ?? null }
  }

  let knownProjects
  function writeWorkspace(revision, snapshot, attempt, state) {
    const current = workspace.get()
    const currentRevision = current?.revision ?? null
    if (current?.snapshot === snapshot) return { revision: currentRevision }
    const conflict = { conflict: true, revision: currentRevision, snapshot: current?.snapshot ?? null }
    const next = (revision ?? 0) + 1
    if (revision !== currentRevision) {
      if (attempt !== null && currentRevision === next && current.save_attempt === attempt) conflict.committedAttempt = true
      return conflict
    }

    let previousSnapshot
    const ids = state ? projectIds(state) : null
    if (ids) {
      let previous
      const previousIds = knownProjects?.revision === currentRevision ? knownProjects.ids
        : projectIds(previous = snapshotState(current?.snapshot))
      for (const id of ids) {
        if (!previousIds.has(id) && deletedProject.get(id)) return conflict
      }
      const removed = [...previousIds].filter(id => !ids.has(id))
      if (removed.length) {
        previous ??= snapshotState(current.snapshot)
        previous.projects = previous.projects.filter(project => ids.has(project.id))
        if (!previous.projects.some(project => project.id === previous.activeProjectId)) {
          previous.activeProjectId = previous.projects[0]?.id
        }
        previousSnapshot = previous.projects.length ? JSON.stringify(previous) : null
      }
      for (const id of new Set([...removed, ...(state.deletedProjectIds ?? [])])) {
        if (!ids.has(id) && markDeleted.run(id).changes) deleteRequests.run(id)
      }
    }
    const saved = revision === null ? initialize.run(snapshot, attempt)
      : replace.run(Number(previousSnapshot !== undefined), previousSnapshot ?? null, snapshot, attempt, revision)
    if (saved.changes !== 1) throw new Error('Workspace update did not save a snapshot')
    return { revision: next }
  }

  return {
    readWorkspace,
    saveWorkspace(revision, snapshot, attempt = null, state = snapshotState(snapshot)) {
      db.exec('BEGIN IMMEDIATE')
      let result
      try {
        result = writeWorkspace(revision, snapshot, attempt, state)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      if (!result.conflict) knownProjects = { revision: result.revision, ids: projectIds(state) }
      return result
    },
    recordModelRequest(id, exchange) {
      insertRequest.run(id, exchange.timestamp, exchange.route, exchange.projectId, exchange.request.model,
        JSON.stringify(exchange.request), JSON.stringify(exchange.response), exchange.error, exchange.projectId)
    },
    close() { db.close() },
  }
}
