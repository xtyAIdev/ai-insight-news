/**
 * 报告 / 企业池 / 反馈 / 任务 / 源健康 仓储
 */

import type { DailyReport, FeedbackRecord, QualityMetrics } from '../types/events.js';
import { getDb } from './schema.js';

// ========== Reports ==========

export function saveReport(report: DailyReport, contentMarkdown: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO reports (report_id, date, content, markdown_path, push_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    report.report_id,
    report.date,
    contentMarkdown,
    report.files.markdown_path ?? null,
    JSON.stringify(report.push_status),
    new Date().toISOString(),
  );
}

export function listReports(limit?: number, offset?: number): Array<{ report_id: string; date: string; markdown_path: string | null; push_status: string; created_at: string }> {
  const db = getDb();
  const sql = 'SELECT report_id, date, markdown_path, push_status, created_at FROM reports ORDER BY date DESC'
    + (limit !== undefined ? ' LIMIT ? OFFSET ?' : '');
  const stmt = db.prepare(sql);
  const rows = (limit !== undefined ? stmt.all(limit, offset || 0) : stmt.all()) as Array<{ report_id: string; date: string; markdown_path: string | null; push_status: string; created_at: string }>;
  return rows;
}

export function countReports(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number };
  return row?.n ?? 0;
}

export function getReport(reportId: string): { report_id: string; date: string; content: string; markdown_path: string | null; push_status: string } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM reports WHERE report_id = ?').get(reportId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    report_id: String(row.report_id),
    date: String(row.date),
    content: String(row.content),
    markdown_path: row.markdown_path ? String(row.markdown_path) : null,
    push_status: String(row.push_status),
  };
}

// ========== Enterprise Pool ==========

export interface EnterprisePoolRow {
  company: string;
  aliases: string[];
  official_sources: string[];
  domestic_sources: string[];
  fallback: string[];
}

export function upsertEnterprisePool(rows: EnterprisePoolRow[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO enterprise_pool (company, aliases, official_sources, domestic_sources, fallback)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(r.company, JSON.stringify(r.aliases), JSON.stringify(r.official_sources), JSON.stringify(r.domestic_sources), JSON.stringify(r.fallback));
  }
}

export function listEnterprisePool(): EnterprisePoolRow[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM enterprise_pool').all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    company: String(r.company),
    aliases: JSON.parse(String(r.aliases)) as string[],
    official_sources: JSON.parse(String(r.official_sources)) as string[],
    domestic_sources: JSON.parse(String(r.domestic_sources)) as string[],
    fallback: JSON.parse(String(r.fallback)) as string[],
  }));
}

// ========== Feedback ==========

export function saveFeedback(fb: FeedbackRecord): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO feedback (id, event_id, report_id, agent_score, human_score, problem_tags, suggestion, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(fb.id, fb.event_id, fb.report_id ?? null, fb.agent_score, fb.human_score, JSON.stringify(fb.problem_tags), fb.suggestion, fb.created_at);
}

export function listFeedback(): FeedbackRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM feedback ORDER BY created_at DESC').all();
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    event_id: String(r.event_id),
    report_id: r.report_id ? String(r.report_id) : '',
    agent_score: Number(r.agent_score),
    human_score: r.human_score !== null && r.human_score !== undefined ? Number(r.human_score) : null,
    problem_tags: JSON.parse(String(r.problem_tags)) as string[],
    suggestion: String(r.suggestion),
    created_at: String(r.created_at),
  }));
}

/** 质量指标统计（Sheet07 07-14：一致性、满意度、低分原因分布） */
export function computeQualityMetrics(period: 'weekly' | 'monthly'): QualityMetrics {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - (period === 'weekly' ? 7 : 30));
  const sinceStr = since.toISOString();
  const rows = db.prepare('SELECT * FROM feedback WHERE created_at >= ?').all(sinceStr) as Array<Record<string, unknown>>;
  const total = rows.length;
  let agentSum = 0;
  let humanSum = 0;
  let humanCount = 0;
  let consistent = 0;
  let satisfied = 0;
  const lowScoreReasons: Record<string, number> = {};
  for (const r of rows) {
    agentSum += Number(r.agent_score);
    const h = r.human_score;
    if (h !== null && h !== undefined) {
      const hv = Number(h);
      humanSum += hv;
      humanCount++;
      const av = Number(r.agent_score);
      if (Math.abs(av - hv) <= 0.5) consistent++;
      if (hv >= 4) satisfied++;
      const tags = JSON.parse(String(r.problem_tags)) as string[];
      for (const t of tags) {
        if (t) lowScoreReasons[t] = (lowScoreReasons[t] ?? 0) + 1;
      }
    }
  }
  return {
    period,
    total_feedback: total,
    avg_agent_score: total ? Number((agentSum / total).toFixed(2)) : 0,
    avg_human_score: humanCount ? Number((humanSum / humanCount).toFixed(2)) : 0,
    consistency_rate: humanCount ? Number((consistent / humanCount * 100).toFixed(1)) : 0,
    satisfaction_rate: humanCount ? Number((satisfied / humanCount * 100).toFixed(1)) : 0,
    low_score_reasons: lowScoreReasons,
  };
}

// ========== Task Runs ==========

export interface TaskRunRow {
  task_id: string;
  trigger_type: string;
  date: string;
  status: string;
  summary: string;
  started_at: string;
  finished_at: string;
}

export function saveTaskRun(run: TaskRunRow): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO task_runs (task_id, trigger_type, date, status, summary, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(run.task_id, run.trigger_type, run.date, run.status, run.summary, run.started_at, run.finished_at);
}

export function listTaskRuns(limit = 20): TaskRunRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM task_runs ORDER BY started_at DESC LIMIT ?').all(limit) as unknown as TaskRunRow[];
}

// ========== Source Health（Sheet08 R4 数据源健康状态） ==========

export function recordSourceOk(sourceKey: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO source_health (source_key, last_ok, last_error, fail_count, updated_at)
     VALUES (?, 1, NULL, 0, ?)
     ON CONFLICT(source_key) DO UPDATE SET last_ok = 1, fail_count = 0, updated_at = excluded.updated_at`,
  ).run(sourceKey, new Date().toISOString());
}

export function recordSourceFail(sourceKey: string, error: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO source_health (source_key, last_ok, last_error, fail_count, updated_at)
     VALUES (?, 0, ?, 1, ?)
     ON CONFLICT(source_key) DO UPDATE SET last_ok = 0, last_error = excluded.last_error, fail_count = fail_count + 1, updated_at = excluded.updated_at`,
  ).run(sourceKey, error.slice(0, 300), new Date().toISOString());
}

export function listSourceHealth(): Array<Record<string, unknown>> {
  const db = getDb();
  return db.prepare('SELECT * FROM source_health ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
}
