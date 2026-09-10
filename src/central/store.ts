import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseConnection } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { digest, sumSnapshots, type Snapshot } from './contract.js';

// Native require preserves the node: scheme with the upstream Vite 5 test loader.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export class Conflict extends Error {}
export function migrate(file: string, sql: string, dataset: 'synthetic' | 'production'): void {
  const db = new DatabaseSync(file, { timeout: 5000 });
  try {
    db.exec('BEGIN EXCLUSIVE');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 1) {
      if (db.prepare('SELECT dataset FROM dataset_metadata WHERE id = 1').get()?.dataset !== dataset) throw new Error('Dataset mismatch');
      db.exec('COMMIT'); return;
    }
    if (version !== 0) throw new Error('Unsupported schema version');
    db.exec(readFileSync(sql, 'utf8'));
    db.prepare('INSERT INTO dataset_metadata (id, dataset) VALUES (1, ?)').run(dataset);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { db.close(); }
}

export class Store {
  private db: DatabaseConnection;
  constructor(file: string, dataset: 'synthetic' | 'production') {
    if (!existsSync(file)) throw new Error('Run the explicit migration before serve');
    this.db = new DatabaseSync(file, { timeout: 5000 });
    if (this.db.prepare('PRAGMA user_version').get()?.user_version !== 1) {
      this.db.close(); throw new Error('Unsupported schema; run an approved migration');
    }
    if (this.db.prepare('SELECT dataset FROM dataset_metadata WHERE id = 1').get()?.dataset !== dataset) {
      this.db.close(); throw new Error('Dataset mismatch; use a separate volume');
    }
    // Connection durability settings, never structure or data migrations.
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  }
  close() { this.db.close(); }
  health() { return this.db.prepare('SELECT 1 AS ok').get()?.ok === 1; }
  accept(value: Snapshot, receivedAt = new Date().toISOString()): 'accepted' | 'duplicate' | 'stale' {
    const payload = JSON.stringify(value), hash = digest(payload);
    const eventKey = JSON.stringify([value.installationId, value.eventId]);
    const sessionKey = JSON.stringify([value.memberId, value.installationId, value.project, value.sessionId]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare('SELECT payload_hash FROM receipt_events WHERE event_key = ? AND del_status = 0').get(eventKey);
      if (receipt) {
        if (receipt.payload_hash !== hash) throw new Conflict('Event ID reused with different content');
        this.db.exec('COMMIT'); return 'duplicate';
      }
      const existing = this.db.prepare('SELECT payload FROM usage_snapshots WHERE session_key = ? AND del_status = 0').get(sessionKey);
      const old: Snapshot | undefined = existing ? JSON.parse(String(existing.payload)) : undefined;
      let result: 'accepted' | 'stale' = 'accepted';
      if (old) {
        if (old.firstStopAt !== value.firstStopAt) throw new Conflict('Session date cannot change');
        if (value.sequence < old.sequence) result = 'stale';
        else if (value.sequence === old.sequence) throw new Conflict('Revision reused with a different event');
        else {
          if (value.observedAt < old.observedAt) throw new Conflict('Snapshot time moved backwards');
          for (const key of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) {
            if (old.tokens[key] !== null && (value.tokens[key] === null || value.tokens[key] < old.tokens[key])) {
              throw new Conflict('Cumulative counter decreased');
            }
          }
          if (old.prompts !== null && (value.prompts === null || value.prompts < old.prompts)) throw new Conflict('Prompt counter decreased');
        }
      }
      if (result === 'accepted') {
        if (old) this.db.prepare('UPDATE usage_snapshots SET sequence = ?, observed_at = ?, received_at = ?, payload = ? WHERE session_key = ? AND del_status = 0')
          .run(value.sequence, value.observedAt, receivedAt, payload, sessionKey);
        else this.db.prepare('INSERT INTO usage_snapshots (session_key, member_id, installation_id, project, session_id, first_stop_at, sequence, observed_at, received_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(sessionKey, value.memberId, value.installationId, value.project, value.sessionId, value.firstStopAt, value.sequence, value.observedAt, receivedAt, payload);
      }
      this.db.prepare('INSERT INTO receipt_events (event_key, payload_hash, received_at) VALUES (?, ?, ?)').run(eventKey, hash, receivedAt);
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  summary(filter: { member?: string; project?: string; from: string; to: string }) {
    const rows = this.db.prepare(`SELECT payload, received_at FROM usage_snapshots
      WHERE del_status = 0 AND first_stop_at >= ? AND first_stop_at <= ?
      AND (? = '' OR member_id = ?) AND (? = '' OR project = ?)
      ORDER BY first_stop_at, session_key`).all(
      `${filter.from}T00:00:00.000Z`, `${filter.to}T23:59:59.999Z`, filter.member ?? '', filter.member ?? '', filter.project ?? '', filter.project ?? '',
    );
    const snapshots = rows.map((row) => JSON.parse(String(row.payload)) as Snapshot);
    const groups = (key: 'memberId' | 'project' | 'firstStopAt') => {
      const grouped = new Map<string, Snapshot[]>();
      for (const s of snapshots) {
        const id = key === 'firstStopAt' ? s.firstStopAt.slice(0, 10) : s[key];
        grouped.set(id, [...(grouped.get(id) ?? []), s]);
      }
      return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([id, values]) => ({ id, ...sumSnapshots(values) }));
    };
    const latestReport = rows.reduce<string | null>((last, row) => last === null || String(row.received_at) > last ? String(row.received_at) : last, null);
    return { ...sumSnapshots(snapshots), timezone: 'UTC', filter, latestReport,
      members: groups('memberId'), projects: groups('project'), days: groups('firstStopAt') };
  }
}
