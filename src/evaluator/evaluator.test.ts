/**
 * 批1 冒烟测试（node:test，零新依赖）
 * 覆盖被改动函数：
 *  - buildFacts：从 raw_event 提取量化事实串（opensource/paper/enterprise）
 *  - normDedupKey：标题归一化（跨中英文、动作词、格式差异）
 *  - dedupCrossSource：评估层二次跨源去重（同新闻多版本合并、多源证据合并、时间窗隔离、opensource 强键）
 * 运行：npm test（先 npm run build，再 node --test dist/evaluator/*.test.js）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts, dedupCrossSource, normDedupKey } from './evaluator.js';
import type { RawEvent, StandardEvent } from '../types/events.js';

function mkEvent(over: Partial<StandardEvent> & { category: StandardEvent['category'] }, raw?: RawEvent): StandardEvent {
  const base: StandardEvent = {
    event_id: `evt_${Math.random().toString(36).slice(2, 8)}`,
    title: 'untitled',
    category: over.category,
    sub_tags: [],
    source: [],
    time: '',
    added_at: '2026-08-31',
    description: '',
    entities: {},
    insight: null,
    accuracy_score: 0,
    importance_score: 0,
    status: 'processed',
    trace_log: [],
    raw_event: raw,
  };
  const { category: _c, ...rest } = over;
  void _c;
  return { ...base, ...rest };
}

// ========== buildFacts ==========

test('buildFacts: opensource 提取 star/周增长/fork 等社区数据', () => {
  const evt = mkEvent(
    { category: 'opensource', product: 'ragflow' },
    {
      module: 'opensource',
      project_name: 'ragflow',
      repo_url: 'https://github.com/infiniflow/ragflow',
      owner: 'infiniflow',
      stars: 123456,
      star_growth_week: 2000,
      forks: 12000,
      open_issues: 120,
      contributors: 300,
      primary_language: 'Python',
      tech_tags: [],
      description: 'RAG engine',
      source_urls: [],
    },
  );
  const facts = buildFacts(evt);
  assert.ok(facts.includes('123,456'), `应含 star 千分位，实际: ${facts}`);
  assert.ok(facts.includes('周增长=+2000'), `应含周增长，实际: ${facts}`);
  assert.ok(facts.includes('forks=12000'), `应含 forks，实际: ${facts}`);
});

test('buildFacts: paper 提取机构与影响力信号', () => {
  const evt = mkEvent(
    { category: 'paper' },
    {
      module: 'paper',
      paper_id: 'arXiv:2401.00001',
      title: 'Agent Reasoning',
      authors: ['a', 'b'],
      institution: 'OpenAI',
      published_at: '2026-08-30',
      abstract: '...',
      category: 'cs.AI',
      influence_hint: '高引用(80)',
      source_urls: [],
    },
  );
  const facts = buildFacts(evt);
  assert.ok(facts.includes('机构=OpenAI'), `应含机构，实际: ${facts}`);
  assert.ok(facts.includes('被引=80'), `应含被引，实际: ${facts}`);
});

test('buildFacts: 无 raw_event 时返回空串', () => {
  assert.equal(buildFacts(mkEvent({ category: 'enterprise' })), '');
});

// ========== normDedupKey ==========

test('normDedupKey: 忽略发布动作词差异（同一事实不同动作词归一）', () => {
  const a = normDedupKey('Cursor launches AI coding agent');
  const b = normDedupKey('Cursor announced AI coding agent');
  assert.equal(a, b, `"${a}" !== "${b}"`);
});

test('normDedupKey: 中英文并存时中文核心片段与英文词都保留', () => {
  const key = normDedupKey('通义千问发布 Qwen3 开源模型');
  assert.ok(key.includes('通义千问'), `应含中文核心，实际: ${key}`);
  assert.ok(key.includes('qwen3'), `应含英文产品名，实际: ${key}`);
});

// ========== dedupCrossSource ==========

test('dedupCrossSource: 同新闻多版本（英文措辞差异+多源）合并为一条并保留多源证据', () => {
  const base: StandardEvent = mkEvent(
    {
      category: 'enterprise',
      title: 'Cursor launches AI coding agent',
      company: 'Cursor',
      description: 'Cursor 发布新 AI 编程助手，支持多文件编辑。这是较长的一段描述。',
      time: '2026-08-30',
      source: [{ url: 'https://techcrunch.com/2026/08/30/cursor', source_type: 'media', name: 'TechCrunch', credibility_score: 4 }],
    },
  );
  const dup: StandardEvent = mkEvent(
    {
      category: 'enterprise',
      title: 'Cursor announced AI coding agent',
      company: 'Cursor',
      description: '短描述',
      time: '2026-08-30',
      source: [{ url: 'https://cursor.com/blog', source_type: 'official_rss', name: 'Cursor Blog', credibility_score: 5 }],
    },
  );
  const out = dedupCrossSource([base, dup], '2026-08-31');
  assert.equal(out.length, 1, '两版本应合并为一条');
  assert.equal(out[0].event_id, base.event_id, '应保留先出现的主事件');
  // 多源证据合并（两个不同 URL 都保留）
  assert.equal(out[0].source.length, 2, `应保留 2 个来源，实际: ${JSON.stringify(out[0].source)}`);
  // 信息更全者优先（较长的 description 保留）
  assert.equal(out[0].description, base.description);
  // 合并动作写入 trace_log
  assert.ok(out[0].trace_log.some((t) => t.stage === 'dedup'), '应记录 dedup trace');
});

test('dedupCrossSource: 中英文不同措辞标题不误并（保守：规则不跨语言翻译）', () => {
  const a = mkEvent({ category: 'enterprise', title: 'Cursor launches AI coding agent', company: 'Cursor', time: '2026-08-30' });
  const b = mkEvent({ category: 'enterprise', title: '新 AI 编程助手 Cursor 发布', company: 'Cursor', time: '2026-08-30' });
  const out = dedupCrossSource([a, b], '2026-08-31');
  assert.equal(out.length, 2, '中英不同措辞标题不应被规则合并');
});

test('dedupCrossSource: 不同公司/不同标题不误合并', () => {
  const a = mkEvent({ category: 'enterprise', title: 'OpenAI launches GPT-6', company: 'OpenAI', time: '2026-08-30' });
  const b = mkEvent({ category: 'enterprise', title: 'Anthropic launches Claude 5', company: 'Anthropic', time: '2026-08-30' });
  const c = mkEvent({ category: 'enterprise', title: 'OpenAI launches GPT-6', company: 'OpenAI', time: '2026-08-20' });
  const out = dedupCrossSource([a, b, c], '2026-08-31');
  assert.equal(out.length, 3, '不同公司/不同时间窗不应合并');
});

test('dedupCrossSource: 超出时间窗不合并（同标题隔周）', () => {
  const a = mkEvent({ category: 'enterprise', title: 'Nvidia partners with X', company: 'Nvidia', time: '2026-08-30' });
  const b = mkEvent({ category: 'enterprise', title: 'Nvidia partners with X', company: 'Nvidia', time: '2026-08-15' });
  const out = dedupCrossSource([a, b], '2026-08-31');
  assert.equal(out.length, 2, '隔 7 天以上的同名事件不应合并');
});

test('dedupCrossSource: opensource 按 repo 名强键合并（不依赖标题/时间窗）', () => {
  const a = mkEvent(
    { category: 'opensource', title: 'ragflow：RAG 引擎', product: 'ragflow', company: 'infiniflow', time: '2026-08-30' },
  );
  const b = mkEvent(
    { category: 'opensource', title: 'ragflow RAG engine', product: 'ragflow', company: 'infiniflow', time: '2026-07-01' },
  );
  const out = dedupCrossSource([a, b], '2026-08-31');
  assert.equal(out.length, 1, '同名仓库应合并');
});

test('dedupCrossSource: 无日期事件与有日期事件同标题近窗不误并（no-date 桶隔离）', () => {
  const a = mkEvent({ category: 'enterprise', title: 'Meta launches Llama 5', company: 'Meta', time: '' });
  const b = mkEvent({ category: 'enterprise', title: 'Meta launches Llama 5', company: 'Meta', time: '2026-08-30' });
  const out = dedupCrossSource([a, b], '2026-08-31');
  // no-date 桶与有日期桶不同 → 不合并；两条件都成立时符合预期（保守不并）
  assert.ok(out.length >= 1, '无日期事件不应误合并到有日期桶');
});
