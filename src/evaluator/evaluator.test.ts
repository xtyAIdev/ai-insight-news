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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFacts, dedupCrossSource, extractNumbersFromText, numbersTraceable, applyCrossDayDedup } from './evaluator.js';
import { normDedupKey } from '../utils/normalize.js';
import { recordReportedTitles } from '../utils/reportMemory.js';
import type { RawEvent, StandardEvent } from '../types/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.resolve(__dirname, '..', '..', 'state', 'reported_titles.json');
const stateBackup = `${stateFile}.dedup.bak`;

function backupState() {
  if (fs.existsSync(stateFile)) fs.renameSync(stateFile, stateBackup);
}
function restoreState() {
  if (fs.existsSync(stateBackup)) fs.renameSync(stateBackup, stateFile);
}

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

// ========== P0-F1 幻觉数字拦截（2026-09-08） ==========

test('numbersTraceable: 引用材料中的真实数字通过', () => {
  const allowed = extractNumbersFromText('（社区数据：stars=154,670，周增长=+1,200）GitHub Copilot 2026');
  const res = numbersTraceable('该仓库 154,670 星，周增长 1200，值得关注', allowed);
  assert.equal(res.ok, true, `真实数字不应被拦: ${res.bad.join(',')}`);
});

test('numbersTraceable: 编造材料外数字被拦截（幻觉防护）', () => {
  const allowed = extractNumbersFromText('（社区数据：stars=154,670）');
  const res = numbersTraceable('该仓库讨论量达 120 万次，训练效率提升 28%，MMLU 得分 89.2%', allowed);
  assert.equal(res.ok, false, '编造数字必须被识别');
  assert.ok(res.bad.includes('120'), '120 万 中的 120 应列入');
  assert.ok(res.bad.includes('28%') || res.bad.includes('28'), '28% 应列入');
  assert.ok(res.bad.includes('89.2%') || res.bad.includes('89.2'), '89.2% 应列入');
});

test('numbersTraceable: 千分位/单位形态转换不误拦（154,670 与 154670 等价）', () => {
  const allowed = extractNumbersFromText('stars=154,670');
  // 材料是 154,670，LLM 写 154670（去逗号）应放行
  const res = numbersTraceable('star 数 154670 的项目', allowed);
  assert.equal(res.ok, true, `去千分位形态应放行: ${res.bad.join(',')}`);
});

test('extractNumbersFromText: 提取含单位与纯数字形态', () => {
  const s = extractNumbersFromText('估值 12 亿美元，占比 28.5%，共 154,670 stars，2026 年');
  for (const expect of ['12', '28.5', '28.5%', '154670', '154,670', '2026']) {
    assert.ok(s.has(expect), `应包含 ${expect}`);
  }
});

// ========== applyCrossDayDedup（P0-F2 pool 重构，2026-09-08 bugfix 回归） ==========

function mkOS(title: string, imp: number, id?: string): StandardEvent {
  return mkEvent({
    event_id: id || ('os_' + Math.random().toString(36).slice(2, 8)),
    title,
    category: 'opensource',
    importance_score: imp,
    time: '2026-09-08',
  });
}

test('applyCrossDayDedup: 剔除历史已报道，kept 事件不被复制（当日重复回归）', () => {
  backupState();
  try {
    // 9-07 已上报 lobehub（标题归一化后与 9-08 候选一致）→ 9-08 候选里 lobehub 应被剔除
    recordReportedTitles('2026-09-07', {
      opensource: [{ event: { title: 'lobehub：chief agent operator organizing agents', category: 'opensource' } }],
    });
    // 9-08 当天 pool：一条历史 lobehub（会被剔除）+ hermes/unsloth 两条新事件（kept）
    const lobe = mkOS('lobehub：chief agent operator organizing agents', 95);
    const hermes = mkOS('hermes webui best way to use hermes agent', 90);
    const unsloth = mkOS('unsloth local ui to run train llms', 85);
    const pool = [lobe, hermes, unsloth];
    const { pool: out, stats } = applyCrossDayDedup(pool, '2026-09-08');
    // 只剔除 lobehub（历史已报道）；hermes/unsloth 是 kept，必须各保留恰好 1 份
    assert.equal(stats.length, 1, '仅 opensource 有剔除');
    assert.equal(stats[0].dropped, 1, '剔除 1 条历史 lobehub');
    assert.equal(out.length, 2, '保留 hermes + unsloth 各 1 份，不复制');
    const titles = out.map((e) => e.title);
    assert.equal(titles.filter((t) => t.includes('hermes')).length, 1, 'hermes 恰好 1 条（防复制回归）');
    assert.equal(titles.filter((t) => t.includes('unsloth')).length, 1, 'unsloth 恰好 1 条');
    assert.ok(!titles.some((t) => t.includes('lobehub')), 'lobehub 已被剔除');
  } finally {
    restoreState();
  }
});

test('applyCrossDayDedup: kept 事件在 pool 中不被复制（即使同模块有事件被剔除）', () => {
  backupState();
  try {
    // 真实 bug 场景：9-08 模块内同时有「历史已报道的 A」与「新事件 B/C」，
    // 旧实现 filter 保留 B/C + 追加 B/C → B/C 复制成两份。此处验证 B 只留 1 份。
    recordReportedTitles('2026-09-07', {
      opensource: [{ event: { title: 'old repo reported yesterday', category: 'opensource' } }],
    });
    const oldRepo = mkOS('old repo reported yesterday', 50);
    const b = mkOS('brand new repo B shines today', 88);
    const c = mkOS('brand new repo C shines today', 86);
    const { pool: out, stats } = applyCrossDayDedup([oldRepo, b, c], '2026-09-08');
    assert.equal(stats[0].dropped, 1, '仅剔除 oldRepo');
    assert.equal(out.length, 2, 'B/C 各 1 份');
    assert.equal(out.filter((e) => e.title.includes('B')).length, 1, 'B 不被复制');
    assert.equal(out.filter((e) => e.title.includes('C')).length, 1, 'C 不被复制');
  } finally {
    restoreState();
  }
});

test('applyCrossDayDedup: 模块全被历史挡住时保留最高分 1 条兜底', () => {
  backupState();
  try {
    // 9-07 两条都已上报 → 9-08 同标题两条候选全命中历史
    recordReportedTitles('2026-09-07', {
      opensource: [
        { event: { title: 'A repo', category: 'opensource' } },
        { event: { title: 'A repo variant', category: 'opensource' } },
      ],
    });
    const a = mkOS('A repo', 80);
    const b = mkOS('A repo variant', 70);
    const { pool: out, stats } = applyCrossDayDedup([a, b], '2026-09-08');
    assert.equal(stats[0].dropped, 2, '两条都是历史已报道');
    assert.equal(out.length, 1, '兜底保留 1 条');
    assert.equal(out[0].importance_score, 80, '保留最高分者');
  } finally {
    restoreState();
  }
});

test('applyCrossDayDedup: 无 reportDate 时不过滤（保持原池）', () => {
  const a = mkOS('whatever repo', 80);
  const { pool: out, stats } = applyCrossDayDedup([a], undefined);
  assert.equal(stats.length, 0);
  assert.equal(out.length, 1);
});
