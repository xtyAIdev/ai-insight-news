/**
 * 批2 冒烟测试（node:test，零新依赖）
 * 覆盖批2任务③ 的关键行为：
 *  - filterCandidates 对新星（created≤14天 + stars≥30）豁免 updated_at 时间窗（不误杀）
 *  - 成熟项目仍受 updated_at 时间窗约束（>72h 被滤掉）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCandidates } from './opensource.js';
import type { OpenSourceRawEvent, TaskContext } from '../types/events.js';

function mkRepo(over: Partial<OpenSourceRawEvent>): OpenSourceRawEvent {
  return {
    module: 'opensource',
    project_name: 'repo',
    repo_url: 'https://github.com/x/repo',
    owner: 'x',
    stars: 0,
    tech_tags: [],
    description: 'An LLM agent framework',
    source_urls: [{ url: 'https://github.com/x/repo', source_type: 'github_repo', name: 'GitHub', credibility_score: 5 }],
    ...over,
  };
}

const ctx: TaskContext = {
  task_id: 't',
  trigger_type: 'manual',
  date_range: { start: new Date(Date.now() - 24 * 3600_000).toISOString(), end: new Date().toISOString() },
  report_date: undefined,
  time_window_hours: 24,
  top_n: 5,
  modules: ['opensource'],
  started_at: new Date().toISOString(),
  deadline: new Date(Date.now() + 60_000).toISOString(),
};

test('filterCandidates: 新星（created≤14天 stars≥30）即使超更新时间窗也保留', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const repo = mkRepo({
    project_name: 'newstar',
    repo_url: 'https://github.com/x/newstar',
    stars: 500,
    created_at: daysAgo(5),       // 5 天前创建 → 新星
    updated_at: daysAgo(10),      // 10 天前更新 → 超过 72h 窗口
    tech_tags: ['llm', 'agent'],
    description: 'New AI agent framework for LLM orchestration',
  });
  const out = filterCandidates([repo], ctx);
  assert.equal(out.length, 1, `新星不应被 updated_at 窗口误杀，实际 ${out.length}`);
});

test('filterCandidates: 成熟项目超过更新时间窗被滤掉', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const oldRepo = mkRepo({
    project_name: 'oldrepo',
    repo_url: 'https://github.com/x/oldrepo',
    stars: 5000,
    created_at: daysAgo(300),     // 老仓库（非新星）
    updated_at: daysAgo(10),      // 10 天前更新 → 超窗
    description: 'LLM inference library',
  });
  const out = filterCandidates([oldRepo], ctx);
  assert.equal(out.length, 0, `成熟项目超窗应被滤掉，实际 ${out.length}`);
});

test('filterCandidates: 新星 star 门槛（<30 且非新星）低信号被滤掉', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const lowStar = mkRepo({
    project_name: 'lowstar',
    repo_url: 'https://github.com/x/lowstar',
    stars: 10,                    // < 新星门槛 30
    created_at: daysAgo(3),       // 3 天前创建
    updated_at: daysAgo(1),
    description: 'An LLM helper',
  });
  const out = filterCandidates([lowStar], ctx);
  assert.equal(out.length, 0, `stars=10 的新星低于门槛应滤掉，实际 ${out.length}`);
});
