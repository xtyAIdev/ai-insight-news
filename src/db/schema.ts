/**
 * SQLite 数据层 —— 规格 Sheet00 R16 三类存储 + 企业池 + 反馈集
 * 表：
 *  - raw_events         原始事件池
 *  - standard_events    标准化事件库
 *  - high_quality_events 高质量事件库
 *  - reports            报告库
 *  - enterprise_pool    企业池数据库
 *  - feedback           反馈数据集
 *  - task_runs          任务运行记录
 *  - source_health      数据源健康状态（Sheet08 R4）
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/index.js';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  return db;
}

function initSchema(d: DatabaseSync): void {
  d.exec(`
  CREATE TABLE IF NOT EXISTS raw_events (
    event_id   TEXT PRIMARY KEY,
    module     TEXT NOT NULL,
    raw_json   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS standard_events (
    event_id         TEXT PRIMARY KEY,
    module           TEXT NOT NULL,
    title            TEXT NOT NULL,
    category         TEXT NOT NULL,
    sub_type         TEXT,
    sub_tags         TEXT,
    company          TEXT,
    product          TEXT,
    source           TEXT,
    time             TEXT,
    added_at         TEXT,
    description      TEXT,
    entities         TEXT,
    insight          TEXT,
    accuracy_score   REAL,
    importance_score REAL,
    status           TEXT NOT NULL,
    trace_log        TEXT,
    raw_event        TEXT,
    created_at       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_std_module ON standard_events(module, time);
  CREATE INDEX IF NOT EXISTS idx_std_status ON standard_events(status);

  CREATE TABLE IF NOT EXISTS high_quality_events (
    event_id   TEXT PRIMARY KEY,
    module     TEXT NOT NULL,
    rank       INTEGER,
    reason     TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reports (
    report_id   TEXT PRIMARY KEY,
    date        TEXT NOT NULL,
    content     TEXT,
    markdown_path TEXT,
    push_status TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS enterprise_pool (
    company      TEXT PRIMARY KEY,
    aliases      TEXT,
    official_sources TEXT,
    domestic_sources TEXT,
    fallback     TEXT
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id           TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL,
    report_id    TEXT,
    agent_score  REAL,
    human_score  REAL,
    problem_tags TEXT,
    suggestion   TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    task_id     TEXT PRIMARY KEY,
    trigger_type TEXT,
    date        TEXT,
    status      TEXT,
    summary     TEXT,
    started_at  TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS source_health (
    source_key  TEXT PRIMARY KEY,
    last_ok     INTEGER,
    last_error  TEXT,
    fail_count  INTEGER DEFAULT 0,
    updated_at  TEXT
  );
  `);

  // 兼容迁移：旧库无 added_at 列 → ALTER 补列（列缺失时执行）
  try {
    d.exec('ALTER TABLE standard_events ADD COLUMN added_at TEXT');
  } catch { /* 列已存在则忽略 */ }
}

export function closeDb(): void {
  if (db) {
    try { db.close(); } catch { /* noop */ }
    db = null;
  }
}
