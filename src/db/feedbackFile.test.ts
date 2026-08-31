/**
 * 批3 冒烟测试（node:test，零新依赖）
 * 覆盖批3任务⑥ 反馈闭环核心：
 *  - appendFeedbackToFile：写入 data/feedback.json（按 id 去重、created_at 降序）
 *  - listFeedbackFromFile：读取（文件不存在返回空）
 *  - computeQualityMetricsFromDbAndFile：DB + 文件合并统计（一致性/满意度/低分分布）
 *
 * 注意：feedbackFile 路径基于 config.dbPath（读 env DB_PATH）。测试临时设 DB_PATH 到
 * 系统临时目录，避免污染真实 data/ai_insight.db。config 模块级读 env，故需先设 env 再 import。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 设临时 DB_PATH（config 模块级读 env，动态 import 保证读到）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { appendFeedbackToFile, listFeedbackFromFile, computeQualityMetricsFromDbAndFile } = await import('./feedbackFile.js');
const fbFile = path.join(tmpDir, 'feedback.json');

test('appendFeedbackToFile: 写入并读取，按 created_at 降序', () => {
  const fb1 = {
    id: 'fb_issue_1',
    event_id: 'Cursor 新闻',
    report_id: '',
    agent_score: 0,
    human_score: 4,
    problem_tags: ['不准确'],
    suggestion: '时间不对',
    created_at: '2026-08-30T10:00:00.000Z',
  };
  const fb2 = {
    id: 'fb_issue_2',
    event_id: 'OpenAI 新闻',
    report_id: '',
    agent_score: 0,
    human_score: 2,
    problem_tags: ['标题党'],
    suggestion: '标题夸大',
    created_at: '2026-08-31T10:00:00.000Z',
  };
  appendFeedbackToFile(fb1);
  appendFeedbackToFile(fb2);
  const all = listFeedbackFromFile();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'fb_issue_2', '应最新在前');
  assert.equal(all[1].id, 'fb_issue_1');
  assert.ok(fs.existsSync(fbFile), 'feedback.json 应已生成');
});

test('appendFeedbackToFile: 同 id 去重替换（可回溯）', () => {
  const fb = {
    id: 'fb_issue_1',
    event_id: 'Cursor 新闻（修订）',
    report_id: '',
    agent_score: 0,
    human_score: 5,
    problem_tags: ['其他'],
    suggestion: '改分',
    created_at: '2026-08-31T12:00:00.000Z',
  };
  const count = appendFeedbackToFile(fb);
  const all = listFeedbackFromFile();
  assert.equal(count, 2, '去重后仍 2 条');
  assert.equal(all.filter((f) => f.id === 'fb_issue_1').length, 1, '同 id 只保留一条');
  const updated = all.find((f) => f.id === 'fb_issue_1')!;
  assert.equal(updated.human_score, 5, '应被新值替换');
  assert.equal(updated.event_id, 'Cursor 新闻（修订）');
});

test('listFeedbackFromFile: 文件不存在返回空数组', () => {
  // 删除后读取应为空
  fs.rmSync(fbFile, { force: true });
  assert.deepEqual(listFeedbackFromFile(), []);
  // 恢复文件（后续测试依赖 2 条数据）
  const fb1 = {
    id: 'fb_issue_1', event_id: 'Cursor 新闻', report_id: '', agent_score: 0, human_score: 4,
    problem_tags: ['不准确'], suggestion: '', created_at: '2026-08-30T10:00:00.000Z',
  };
  const fb2 = {
    id: 'fb_issue_2', event_id: 'OpenAI 新闻', report_id: '', agent_score: 0, human_score: 2,
    problem_tags: ['标题党'], suggestion: '', created_at: '2026-08-31T10:00:00.000Z',
  };
  appendFeedbackToFile(fb1);
  appendFeedbackToFile(fb2);
});

test('computeQualityMetricsFromDbAndFile: 合并 DB+文件统计', () => {
  const dbRows = [
    { id: 'fb_db_1', event_id: 'A', report_id: '', agent_score: 4, human_score: 4, problem_tags: ['不准确'], suggestion: '', created_at: '2026-08-30T00:00:00.000Z' },
  ];
  const fileRows = listFeedbackFromFile();
  const weekly = computeQualityMetricsFromDbAndFile(dbRows, fileRows, 'weekly');
  // 共 3 条（db 1 + file 2，id 不重叠）
  assert.equal(weekly.total_feedback, 3);
  // 一致性：db1(4 vs 4 ±0.5 ✅) + issue1(0 vs 4 ✗) + issue2(0 vs 2 ✗) → 1/3
  assert.equal(weekly.consistency_rate, Number((1 / 3 * 100).toFixed(1)));
  // 满意度：human>=4 → db1(4) + issue1(4) → 2/3
  assert.equal(weekly.satisfaction_rate, Number((2 / 3 * 100).toFixed(1)));
  // 低分原因：不准确(db1+issue1) + 标题党(issue2)
  assert.equal(weekly.low_score_reasons['不准确'], 2);
  assert.equal(weekly.low_score_reasons['标题党'], 1);
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});
