/**
 * 反馈持久化到仓库文件（2026-08-31 批3 任务⑥ 反馈闭环）
 *
 * 背景：GitHub Pages 纯静态托管无法写 SQLite；CI 的 DB 每次 checkout 重置不持久。
 * 方案：读者反馈 → 预填 GitHub Issue → `feedback-collect.yml`（issues: opened）解析 →
 *       追加到 `data/feedback.json`（git add -f 提交回仓库，跨 CI 持久化，类似 reports/ 与 state/）。
 * 本文件提供文件版反馈的读写 + 与 DB 合并统计（computeQualityMetrics 使用）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { FeedbackRecord, QualityMetrics } from '../types/events.js';

/** feedback.json 路径：data/feedback.json（与 DB 同目录） */
function feedbackFile(): string {
  return path.join(path.dirname(config.dbPath), 'feedback.json');
}

/** 读取全部文件反馈（无文件/损坏返回空数组，不抛异常） */
export function listFeedbackFromFile(): FeedbackRecord[] {
  try {
    const file = feedbackFile();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw as FeedbackRecord[];
  } catch {
    return [];
  }
}

/**
 * 追加一条反馈到 feedback.json（按 id 去重：已存在则替换，保持可回溯）。
 * 返回写入后的全部文件反馈条数；失败返回 -1（不影响主流程）。
 */
export function appendFeedbackToFile(fb: FeedbackRecord): number {
  try {
    const file = feedbackFile();
    const existing = listFeedbackFromFile().filter((f) => f.id !== fb.id);
    existing.push(fb);
    // 按 created_at 降序
    existing.sort((a, b) => b.created_at.localeCompare(a.created_at));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return existing.length;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[feedbackFile] 写入失败: ${err instanceof Error ? err.message : err}`);
    return -1;
  }
}

/** 从文件反馈计算质量指标（与 DB 的 computeQualityMetrics 同语义，供合并统计） */
function computeMetricsFromRecords(rows: FeedbackRecord[], period: 'weekly' | 'monthly'): QualityMetrics {
  const since = new Date();
  since.setDate(since.getDate() - (period === 'weekly' ? 7 : 30));
  const sinceStr = since.toISOString();
  const recent = rows.filter((r) => r.created_at >= sinceStr);
  const total = recent.length;
  let agentSum = 0;
  let humanSum = 0;
  let humanCount = 0;
  let consistent = 0;
  let satisfied = 0;
  const lowScoreReasons: Record<string, number> = {};
  for (const r of recent) {
    agentSum += Number(r.agent_score) || 0;
    if (r.human_score !== null && r.human_score !== undefined) {
      const hv = Number(r.human_score);
      humanSum += hv;
      humanCount++;
      const av = Number(r.agent_score) || 0;
      if (Math.abs(av - hv) <= 0.5) consistent++;
      if (hv >= 4) satisfied++;
      for (const t of r.problem_tags || []) {
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

/** DB 反馈 + 文件反馈合并统计（period 周/月）。DB 为空时用文件；两者合并时先 DB 后文件按 id 去重。 */
export function computeQualityMetricsFromDbAndFile(dbRows: FeedbackRecord[], fileRows: FeedbackRecord[], period: 'weekly' | 'monthly'): QualityMetrics {
  const merged = new Map<string, FeedbackRecord>();
  for (const r of [...dbRows, ...fileRows]) {
    if (r.id) merged.set(r.id, r);
  }
  return computeMetricsFromRecords(Array.from(merged.values()), period);
}
