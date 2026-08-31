/**
 * 批4 冒烟测试（node:test，零新依赖）
 * 覆盖 src/llm/rules.ts 规则引擎核心函数：
 *  - classifyByRule：中英文融资/产品动态分类
 *  - accuracyByRule：信源等级真实性评分（多源交叉/日期缺失惩罚）
 *  - importanceByRule：领域差异化质量评分（opensource/paper/enterprise + 日期降权）
 *  - extractEntitiesByRule：金额/轮次/投资方/star 提取
 *  - generateInsightByRule：五维洞察模板
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceEvidence } from '../types/events.js';
import { classifyByRule, accuracyByRule, importanceByRule, extractEntitiesByRule, generateInsightByRule } from './rules.js';

const src = (over: Partial<SourceEvidence> = {}): SourceEvidence => ({
  url: 'https://example.com/x',
  source_type: 'media',
  name: 'Example',
  credibility_score: 4,
  ...over,
});

// ========== classifyByRule ==========

test('classifyByRule: 中文融资关键词判为 investment', () => {
  assert.equal(classifyByRule('某公司完成亿元融资', ''), 'investment');
  assert.equal(classifyByRule('A公司收购B公司', ''), 'investment');
});

test('classifyByRule: 英文融资信号加权判为 investment', () => {
  assert.equal(classifyByRule('Ringg raises $10M Series A', ''), 'investment');
});

test('classifyByRule: 产品发布判为 product', () => {
  assert.equal(classifyByRule('OpenAI 发布 GPT-6 模型', ''), 'product');
});

// ========== accuracyByRule ==========

test('accuracyByRule: 官方源(cred>=4.5)基础 5', () => {
  const r = accuracyByRule([src({ url: 'https://openai.com/news', credibility_score: 5, source_type: 'official_rss', published_at: '2026-08-31' })]);
  assert.equal(r.score, 5);
});

test('accuracyByRule: 媒体源(cred=4)基础 4', () => {
  const r = accuracyByRule([src({ url: 'https://techcrunch.com/x', credibility_score: 4, published_at: '2026-08-31' })]);
  assert.equal(r.score, 4);
});

test('accuracyByRule: 多源交叉加分 +0.25（上限 0.5）', () => {
  // 两个媒体源（都有日期）：基础 4 + 0.25 = 4.25
  const r = accuracyByRule([
    src({ credibility_score: 4, published_at: '2026-08-31' }),
    src({ credibility_score: 4, published_at: '2026-08-31' }),
  ]);
  assert.equal(r.score, 4.3, '多源交叉应 +0.25（四舍五入到 0.1）');
});

test('accuracyByRule: 无日期扣 1.5（用户硬约束：禁止未知日期默认今天）', () => {
  // 单媒体源 + 无日期（无 published_at，非一手类型，URL 无日期路径）→ 4 - 1.5 = 2.5
  const r = accuracyByRule([src({ source_type: 'media', credibility_score: 4 })]);
  assert.equal(r.score, 2.5);
});

test('accuracyByRule: 无来源返回 1 分', () => {
  assert.equal(accuracyByRule([]).score, 1);
});

// ========== importanceByRule ==========

test('importanceByRule: 企业投融资标签加分（对比不含投融资/战略的标签）', () => {
  const base = { accuracy: 4, source: [src()], category: 'enterprise', hasInsight: true, hasDate: true };
  // '产品发布' 不含投融资/战略/头部，不触发 enterprise 额外加分
  const noInv = importanceByRule({ ...base, sub_tags: ['产品发布'] });
  const withInv = importanceByRule({ ...base, sub_tags: ['投融资'] });
  assert.equal(Number((withInv - noInv).toFixed(1)), 0.3, '投融资标签应 +0.3');
});

test('importanceByRule: 日期缺失降权 -1.5', () => {
  const withDate = importanceByRule({ accuracy: 4, source: [src()], sub_tags: [], category: 'enterprise', hasInsight: true, hasDate: true });
  const noDate = importanceByRule({ accuracy: 4, source: [src()], sub_tags: [], category: 'enterprise', hasInsight: true, hasDate: false });
  assert.equal(Number((withDate - noDate).toFixed(1)), 1.5, '日期缺失应 -1.5');
});

test('importanceByRule: 多信源丰富度加分（上限 +1）', () => {
  const one = importanceByRule({ accuracy: 4, source: [src()], sub_tags: [], category: 'enterprise', hasInsight: true, hasDate: true });
  const three = importanceByRule({ accuracy: 4, source: [src(), src(), src()], sub_tags: [], category: 'enterprise', hasInsight: true, hasDate: true });
  assert.ok(three > one, '多信源应加分');
});

test('importanceByRule: 上限 5 分', () => {
  const high = importanceByRule({ accuracy: 5, source: [src(), src(), src(), src()], sub_tags: ['大模型', '投融资', '头部'], category: 'enterprise', hasInsight: true, hasDate: true });
  assert.ok(high <= 5, `应封顶 5，实际 ${high}`);
});

// ========== extractEntitiesByRule ==========

test('extractEntitiesByRule: 提取金额/轮次/投资方', () => {
  const e = extractEntitiesByRule('某公司由红杉、高瓴领投完成 5 亿元 B 轮融资', 'enterprise');
  assert.equal(e.amount, 5 * 10000);
  assert.equal(e.round, 'B 轮', '轮次保留原文（含空格）');
  assert.deepEqual(e.investors, ['红杉', '高瓴']);
});

test('extractEntitiesByRule: 提取 star 数', () => {
  assert.equal(extractEntitiesByRule('该项目获得 1.2k stars', 'opensource').star_count, 1200);
});

// ========== generateInsightByRule ==========

test('generateInsightByRule: 返回五维洞察且不编造', () => {
  const i = generateInsightByRule({ title: 'OpenAI 发布新模型', description: '描述', category: 'enterprise', company: 'OpenAI', product: 'GPT-6' });
  assert.ok(i.what.includes('OpenAI'));
  assert.ok(i.why.length > 0);
  assert.ok(i.trend.length > 0);
  assert.ok(i.impact.length > 0);
  assert.ok(i.action.length > 0);
});
