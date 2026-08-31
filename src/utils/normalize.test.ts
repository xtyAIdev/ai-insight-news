/**
 * 批4 冒烟测试（node:test，零新依赖）
 * 覆盖 src/utils/normalize.ts 核心纯函数：
 *  - parseFlexibleDate / sanitizeDate / toISODate：多种日期格式解析，未知日期不默认今天
 *  - normalizeAmountToWan：金额归一为人民币万元
 *  - normalizeCompany：企业别名归一
 *  - similarity / extractCoreNoun：去重辅助
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFlexibleDate, sanitizeDate, toISODate, normalizeAmountToWan,
  normalizeCompany, similarity, extractCoreNoun, sourceHasDate,
} from './normalize.js';

// ========== parseFlexibleDate ==========

test('parseFlexibleDate: YYYY-MM-DD', () => {
  assert.equal(parseFlexibleDate('2026-08-31'), '2026-08-31');
  assert.equal(parseFlexibleDate('2026-8-5'), '2026-08-05', '补零');
});

test('parseFlexibleDate: RFC822 RSS pubDate', () => {
  assert.equal(parseFlexibleDate('Tue, 25 Aug 2026 00:30:00 GMT'), '2026-08-25');
  assert.equal(parseFlexibleDate('Mon, 24 Aug 2026 17:00:00 +0800'), '2026-08-24');
});

test('parseFlexibleDate: 中文日期', () => {
  assert.equal(parseFlexibleDate('2026年8月25日'), '2026-08-25');
});

test('parseFlexibleDate: ISO datetime', () => {
  assert.equal(parseFlexibleDate('2026-08-31T10:00:00Z'), '2026-08-31');
});

test('parseFlexibleDate: 相对时间（x小时前/x天前）', () => {
  const hoursAgo = parseFlexibleDate('5小时前');
  const daysAgo = parseFlexibleDate('3天前');
  const now = new Date();
  assert.equal(hoursAgo, toISODate(new Date(now.getTime() - 5 * 3600_000)));
  assert.equal(daysAgo, toISODate(new Date(now.getTime() - 3 * 86_400_000)));
});

test('parseFlexibleDate: 无法解析返回 null', () => {
  assert.equal(parseFlexibleDate(''), null);
  assert.equal(parseFlexibleDate('未知日期'), null);
});

// ========== sanitizeDate（不默认今天） ==========

test('sanitizeDate: 无日期返回空串（绝不默认今天）', () => {
  assert.equal(sanitizeDate(undefined), '');
  assert.equal(sanitizeDate(''), '');
  assert.equal(sanitizeDate('不是日期'), '');
});

test('sanitizeDate: 规整为纯日期', () => {
  assert.equal(sanitizeDate('2026-08-31T10:00:00Z'), '2026-08-31');
  assert.equal(sanitizeDate('2026/08/31'), '2026-08-31');
});

// ========== sourceHasDate ==========

test('sourceHasDate: 一手源类型视为有日期', () => {
  assert.equal(sourceHasDate({ source_type: 'github_repo' }), true);
  assert.equal(sourceHasDate({ source_type: 'arxiv' }), true);
  assert.equal(sourceHasDate({ source_type: 'official_rss' }), true);
});

test('sourceHasDate: URL 含日期路径视为有日期', () => {
  assert.equal(sourceHasDate({ url: 'https://example.com/2026/08/31/news' }), true);
  assert.equal(sourceHasDate({ url: 'https://example.com/news' }), false);
});

test('sourceHasDate: published_at 有值视为有日期', () => {
  assert.equal(sourceHasDate({ published_at: '2026-08-31' }), true);
});

// ========== normalizeAmountToWan ==========

test('normalizeAmountToWan: 人民币万元/亿', () => {
  assert.equal(normalizeAmountToWan('5000万人民币'), 5000);
  assert.equal(normalizeAmountToWan('1.5亿'), 15000);
});

test('normalizeAmountToWan: 美元 M/B 转人民币万元（汇率 7.2）', () => {
  assert.equal(normalizeAmountToWan('$100M'), 72000);
  assert.equal(normalizeAmountToWan('$2B'), 144000);
});

test('normalizeAmountToWan: 无法解析返回 null', () => {
  assert.equal(normalizeAmountToWan(''), null);
  assert.equal(normalizeAmountToWan('很多钱'), null);
});

// ========== normalizeCompany ==========

test('normalizeCompany: 别名归一到企业池标准名', () => {
  assert.equal(normalizeCompany('ByteDance'), '字节跳动');
  assert.equal(normalizeCompany('通义'), '阿里巴巴');
  assert.equal(normalizeCompany('Moonshot AI'), '月之暗面');
});

test('normalizeCompany: 池外保留原名', () => {
  assert.equal(normalizeCompany('Mistral'), 'Mistral');
  assert.equal(normalizeCompany(''), '');
});

// ========== similarity ==========

test('similarity: 完全相同为 1，完全不同为 0', () => {
  assert.equal(similarity('Cursor launches', 'Cursor launches'), 1);
  assert.equal(similarity('abc', 'xyz'), 0);
});

test('similarity: 部分重叠（英文不同动词）Jaccard 正确', () => {
  // 修复后：{cursor, launches, ai, agent} ∩ {cursor, releases, ai, agent} → 交集3/并集5 = 0.6
  const s = similarity('Cursor launches AI agent', 'Cursor releases AI agent');
  assert.equal(s, 0.6, `英文相似标题应 Jaccard=0.6，实际 ${s}`);
});

// ========== extractCoreNoun ==========

test('extractCoreNoun: 英文取最长实体序列（可含版本号）', () => {
  assert.equal(extractCoreNoun('Introducing Claude Opus 5'), 'claude opus 5');
});

test('extractCoreNoun: 中文取最长连续片段', () => {
  assert.ok(extractCoreNoun('通义千问 Qwen3 发布').includes('通义千问'));
});
