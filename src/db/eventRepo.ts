/**
 * 事件仓储 —— RawEvent / StandardEvent / HighQuality 的读写
 */

import type { RawEvent, StandardEvent } from '../types/events.js';
import { getDb } from './schema.js';

// ========== RawEvent ==========

export function saveRawEvent(eventId: string, module: string, raw: RawEvent): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO raw_events (event_id, module, raw_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(eventId, module, JSON.stringify(raw), new Date().toISOString());
}

export function listRawEvents(module?: string): Array<{ event_id: string; module: string; raw: RawEvent; created_at: string }> {
  const db = getDb();
  const rows = module
    ? db.prepare('SELECT * FROM raw_events WHERE module = ? ORDER BY created_at DESC').all(module) as Array<Record<string, unknown>>
    : db.prepare('SELECT * FROM raw_events ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    event_id: String(r.event_id),
    module: String(r.module),
    raw: JSON.parse(String(r.raw_json)) as RawEvent,
    created_at: String(r.created_at),
  }));
}

// ========== StandardEvent ==========

export function saveStandardEvent(evt: StandardEvent): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO standard_events
     (event_id, module, title, category, sub_type, sub_tags, company, product, source,
      time, description, entities, insight, accuracy_score, importance_score, status,
      trace_log, raw_event, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evt.event_id,
    evt.category,
    evt.title,
    evt.category,
    evt.sub_type ?? null,
    JSON.stringify(evt.sub_tags),
    evt.company ?? null,
    evt.product ?? null,
    JSON.stringify(evt.source),
    evt.time,
    evt.description,
    JSON.stringify(evt.entities),
    evt.insight ? JSON.stringify(evt.insight) : null,
    evt.accuracy_score,
    evt.importance_score,
    evt.status,
    JSON.stringify(evt.trace_log),
    evt.raw_event ? JSON.stringify(evt.raw_event) : null,
    new Date().toISOString(),
  );
}

export function updateEventStatus(eventId: string, status: StandardEvent['status'], importanceScore?: number): void {
  const db = getDb();
  if (importanceScore !== undefined) {
    db.prepare('UPDATE standard_events SET status = ?, importance_score = ? WHERE event_id = ?').run(status, importanceScore, eventId);
  } else {
    db.prepare('UPDATE standard_events SET status = ? WHERE event_id = ?').run(status, eventId);
  }
}

export function getStandardEvent(eventId: string): StandardEvent | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM standard_events WHERE event_id = ?').get(eventId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToEvent(row);
}

export function listStandardEvents(opts: { module?: string; status?: string; date?: string } = {}): StandardEvent[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (opts.module) { conditions.push('module = ?'); params.push(opts.module); }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.date) { conditions.push('time = ?'); params.push(opts.date); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM standard_events ${where} ORDER BY importance_score DESC`).all(...params);
  return (rows as Array<Record<string, unknown>>).map(rowToEvent);
}

export function listAllStandardEvents(): StandardEvent[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM standard_events ORDER BY time DESC').all();
  return (rows as Array<Record<string, unknown>>).map(rowToEvent);
}

function rowToEvent(row: Record<string, unknown>): StandardEvent {
  return {
    event_id: String(row.event_id),
    title: String(row.title),
    category: row.category as StandardEvent['category'],
    sub_type: row.sub_type ? (row.sub_type as StandardEvent['sub_type']) : undefined,
    sub_tags: JSON.parse(String(row.sub_tags)) as string[],
    company: row.company ? String(row.company) : undefined,
    product: row.product ? String(row.product) : undefined,
    source: JSON.parse(String(row.source)) as StandardEvent['source'],
    time: String(row.time),
    description: String(row.description),
    entities: JSON.parse(String(row.entities)) as Record<string, unknown>,
    insight: row.insight ? JSON.parse(String(row.insight)) : null,
    accuracy_score: Number(row.accuracy_score) || 0,
    importance_score: Number(row.importance_score) || 0,
    status: row.status as StandardEvent['status'],
    trace_log: JSON.parse(String(row.trace_log)) as StandardEvent['trace_log'],
    raw_event: row.raw_event ? (JSON.parse(String(row.raw_event)) as RawEvent) : undefined,
  };
}

// ========== HighQuality ==========

export function saveHighQuality(eventId: string, module: string, rank: number, reason: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO high_quality_events (event_id, module, rank, reason, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventId, module, rank, reason, new Date().toISOString());
}

export function listHighQuality(date?: string): Array<{ event: StandardEvent; rank: number; reason: string }> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT hq.*, se.time as evt_time FROM high_quality_events hq
     LEFT JOIN standard_events se ON hq.event_id = se.event_id
     ORDER BY hq.module, hq.rank`,
  ).all() as Array<Record<string, unknown>>;
  const out: Array<{ event: StandardEvent; rank: number; reason: string }> = [];
  for (const r of rows) {
    const evt = getStandardEvent(String(r.event_id));
    if (evt) {
      if (date && evt.time !== date) continue;
      out.push({ event: evt, rank: Number(r.rank), reason: String(r.reason) });
    }
  }
  return out;
}
