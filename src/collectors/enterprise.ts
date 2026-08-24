/**
 * 企业动态采集（Sheet04）—— 单模块、双分支
 * 真实数据源：aihot.virxact.com 公开 API（AI 精选资讯，覆盖大厂前沿动态）
 * 核心约束（用户要求）：
 *  - 一个动态对应一家公司（企业合作/多企业事件单独成条）
 *  - 同一家公司最多 2 条（避免"4 条动态 3 条 OpenAI"）
 *  - 投融资分支用 WebSearch 兜底补充
 *  - 企业池持久化到 enterprise_pool 表
 */

import type { EnterpriseRawEvent, SourceEvidence, TaskContext } from '../types/events.js';
import { ENTERPRISE_POOL, INVESTMENT_KEYWORDS, PRODUCT_KEYWORDS, sourceCredibility } from '../config/constants.js';
import { httpGetJson } from '../utils/http.js';
import { webSearch } from '../utils/websearch.js';
import { wechatSearch } from '../utils/wechatSearch.js';
import { writeJsonCache, readJsonCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { recordSourceOk, recordSourceFail } from '../db/index.js';
import { normalizeCompany, parseFlexibleDate, similarity, toISODate } from '../utils/normalize.js';
import { classifyByRule } from '../llm/rules.js';
import { upsertEnterprisePool, listEnterprisePool } from '../db/index.js';

const CACHE_SCOPE = 'enterprise';
const CACHE_KEY = 'latest';
/** 企业动态时效性强，缓存 24h 内算新鲜；超期读取打 stale */
const CACHE_MAX_AGE_MS = 24 * 3600_000;

// ========== aihot API 类型 ==========

interface AihotItem {
  id: string;
  title: string;
  originalTitle?: string;
  summary?: string;
  source?: { name?: string };
  links?: { aihot?: string; original?: string };
  publishedAt?: string;
  discoveredAt?: string;
  category?: string;
  score?: number;
  selected?: boolean;
  reason?: string;
}

interface AihotResponse {
  items?: AihotItem[];
  data?: AihotItem[];
}

// ========== 主流程 ==========

export async function collectEnterprise(ctx: TaskContext): Promise<EnterpriseRawEvent[]> {
  const start = Date.now();
  // 企业池持久化：将常量写入 enterprise_pool 表
  persistEnterprisePool();
  const pool = listEnterprisePool().length > 0 ? listEnterprisePool() : ENTERPRISE_POOL.map(toPoolRow);
  logger.info(`[enterprise] 开始采集，企业池 ${pool.length} 家（aihot 真实源），时间窗口 ${ctx.time_window_hours}h`);

  const all: EnterpriseRawEvent[] = [];
  const errors: string[] = [];
  let invEvents: EnterpriseRawEvent[] = [];
  let degraded = false;

  // 1. aihot 全量精选（覆盖所有企业，防止逐家查询遗漏）
  const allItems = await fetchAihotSelected(ctx);
  if (allItems.length > 0) {
    recordSourceOk('aihot');
    logger.info(`[enterprise] aihot 精选 ${allItems.length} 条`);
    // 按企业归属分类
    const matched = matchItemsToCompanies(allItems, pool);
    all.push(...matched);
  } else {
    recordSourceFail('aihot', 'empty');
    errors.push('aihot: 无精选数据');
  }

  // 2. 逐企业查询补充（回验命中，防止"提及即归属"的误配；同一公司最多取 2 条在最终裁剪）
  for (const profile of pool) {
    const companyItems = await fetchAihotByCompany(ctx, profile.company);
    if (companyItems.length > 0) {
      const events = companyItems
        .filter((it) => {
          // 标题/摘要必须真正包含该公司名或别名（排除低区分度别名），否则不归属
          const text = `${it.title || ''} ${it.summary || ''}`.toLowerCase();
          const names = [profile.company, ...profile.aliases]
            .filter((n) => !LOW_DISCRIMINATIVE_ALIASES.has(n.toLowerCase()))
            .map((n) => n.toLowerCase());
          return names.some((n) => n.length >= 2 && text.includes(n));
        })
        .map((it) => toEnterpriseEvent(it, profile.company));
      all.push(...events);
    }
  }

  // 3. 微信公众号中文补充采集（国内企业动态/投融资，解决 HN/DDG 中文命中率低的问题）
  const wechatEvents = await collectWechatSupplement(ctx);
  all.push(...wechatEvents);

  // 4. 投融资 WebSearch 兜底（Sheet04 04-05 分支 A）
  if (ctx.modules.includes('enterprise')) {
    invEvents = await collectInvestmentFallback(ctx);
    all.push(...invEvents);
  }

  // 4b. aihot 与投融资全部失败 → 缓存降级（stale 标记）
  if (all.length === 0) {
    degraded = true;
    const cached = readJsonCache<EnterpriseRawEvent>(CACHE_SCOPE, CACHE_KEY, CACHE_MAX_AGE_MS);
    if (cached) {
      all.push(...cached.entry.items.map((e) => markEnterpriseStale(e, cached.stale)));
      errors.push(`cache: 使用 ${cached.stale ? '超期(stale)' : '新鲜'}缓存 ${cached.entry.items.length} 条（写入于 ${cached.entry.meta.written_at}）`);
    }
  }

  // 4. 分类 + 实体抽取
  const classified = all.map((e) => classifyAndExtract(e));

  // 5. 去重（标题相似度 ≥ 0.85 合并；aihot 同一条被多家公司命中时保留首次归属）
  const deduped = dedupEnterprise(classified);

  // 6. 按公司组织 + 同一公司最多 2 条（用户核心约束）
  const capped = capByCompany(deduped, 2);

  // 7. 时间排序
  capped.sort((a, b) => b.published_at.localeCompare(a.published_at));

  // 8. 成功后写缓存
  if (capped.length > 0) {
    const usedSources: string[] = [];
    if (allItems.length > 0) usedSources.push('aihot');
    if (wechatEvents.length > 0) usedSources.push('wechat');
    if (invEvents.length > 0) usedSources.push('websearch');
    writeJsonCache(CACHE_SCOPE, CACHE_KEY, capped, {
      windowHours: ctx.time_window_hours,
      sources: usedSources,
      degraded,
    });
  }

  logger.info(`[enterprise] 采集完成：原始 ${all.length}，去重后 ${deduped.length}，按公司裁剪后 ${capped.length}（每家≤2条）${errors.length ? '（异常: ' + errors.join(';') + '）' : ''}，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return capped;
}

// ========== 企业池持久化 ==========

function toPoolRow(p: { company: string; aliases: string[]; officialSources: string[]; domesticSources?: string[]; fallback: string[] }) {
  return {
    company: p.company,
    aliases: p.aliases,
    official_sources: p.officialSources,
    domestic_sources: p.domesticSources || [],
    fallback: p.fallback,
  };
}

function persistEnterprisePool(): void {
  try {
    upsertEnterprisePool(ENTERPRISE_POOL.map(toPoolRow));
  } catch (err) {
    logger.warn(`[enterprise] 企业池持久化失败: ${err instanceof Error ? err.message : err}`);
  }
}

// ========== aihot 采集 ==========

/** 拉取 aihot 精选（24h/7d） */
async function fetchAihotSelected(ctx: TaskContext): Promise<AihotItem[]> {
  const window = ctx.time_window_hours <= 48 ? '24h' : '7d';
  const url = `https://aihot.virxact.com/api/v1/items?mode=selected&window=${window}&limit=50`;
  const res = await httpGetJson<AihotResponse>(url, { timeoutMs: 15_000, retries: 1, exponential: true });
  if (!res.ok || !res.data) return [];
  return res.data.items || res.data.data || [];
}

/** 按公司关键词查询 */
async function fetchAihotByCompany(ctx: TaskContext, company: string): Promise<AihotItem[]> {
  const window = ctx.time_window_hours <= 48 ? '24h' : '7d';
  const url = `https://aihot.virxact.com/api/v1/items?mode=all&q=${encodeURIComponent(company)}&window=${window}&limit=5`;
  const res = await httpGetJson<AihotResponse>(url, { timeoutMs: 15_000, retries: 0 });
  if (!res.ok || !res.data) return [];
  return res.data.items || res.data.data || [];
}

/** 把 aihot item 转成 EnterpriseRawEvent */
function toEnterpriseEvent(item: AihotItem, company: string): EnterpriseRawEvent {
  const title = item.title || item.originalTitle || '';
  const published = parseFlexibleDate(item.publishedAt || item.discoveredAt || '') || toISODate(new Date());
  const sourceUrl = item.links?.original || item.links?.aihot || '';
  return {
    module: 'enterprise',
    sub_type: 'product', // 04-04 分流再判定
    company: normalizeCompany(company),
    title,
    published_at: published,
    content: item.summary || item.reason || '',
    fields: {},
    related_event_ids: [],
    source_urls: [{
      url: sourceUrl,
      source_type: item.links?.original ? 'aihot_original' : 'aihot',
      name: item.source?.name || 'AIHOT',
      credibility_score: sourceUrl ? sourceCredibility(sourceUrl, 'media') : 4,
    }],
  };
}

/**
 * 精选条目按企业归属匹配（用户核心约束：一个动态对应一家公司）
 * 匹配策略（从强到弱）：
 *  ① 标题命中公司名/别名 → 直接归属（标题是主语的最可靠信号）
 *  ② 标题无命中，仅摘要命中一家 → 归属该公司
 *  ③ 标题无命中，摘要命中多家 → 多企业事件，company 标 'multi'（企业合作单独成条）
 *  ④ 均无命中 → 不归属企业池（作为独立行业事件保留，company 用标题提取或 'AI 企业'）
 * 低区分度别名（如 Seed/阿里）不参与匹配，避免误配。
 */
const LOW_DISCRIMINATIVE_ALIASES = new Set(['seed', '阿里', 'facebook']);

function matchItemsToCompanies(items: AihotItem[], pool: Array<{ company: string; aliases: string[] }>): EnterpriseRawEvent[] {
  const out: EnterpriseRawEvent[] = [];
  const used = new Set<string>();

  const matchOne = (text: string): string | null => {
    let hits = pool.filter((p) => {
      const names = [p.company, ...p.aliases]
        .filter((n) => !LOW_DISCRIMINATIVE_ALIASES.has(n.toLowerCase()))
        .map((n) => n.toLowerCase());
      return names.some((n) => n.length >= 2 && text.includes(n));
    });
    // 标题精确命中优先：若某公司别名整体命中标题（如 "OpenAI 发布"），去掉"摘要提及"的噪声
    if (hits.length === 1) return hits[0].company;
    if (hits.length > 1) return 'multi';
    return null;
  };

  for (const item of items) {
    if (used.has(item.id)) continue;
    const title = (item.title || item.originalTitle || '').toLowerCase();
    const summary = (item.summary || '').toLowerCase();

    // ① 标题命中（强信号）
    const titleHit = matchOne(title);
    if (titleHit) {
      used.add(item.id);
      out.push(toEnterpriseEvent(item, titleHit === 'multi' ? '多企业合作' : titleHit));
      continue;
    }
    // ② 标题未命中企业池：若标题含其他明确机构名（池外公司），视为池外公司事件，不归属池内公司
    if (/亚马逊|微软|特斯拉|苹果|英伟达|nvidia|microsoft|amazon|tesla|apple|华为|小米|百度|京东|美团|字节跳动/i.test(title)) {
      used.add(item.id);
      out.push(toEnterpriseEvent(item, extractCompanyName(item.title || '') || 'AI 企业'));
      continue;
    }
    // ③ 摘要命中（弱信号）：仅单命中且标题无歧义时归属
    const summaryHit = matchOne(summary);
    if (summaryHit && summaryHit !== 'multi') {
      used.add(item.id);
      out.push(toEnterpriseEvent(item, summaryHit));
      continue;
    }
    // ④ 无命中：作为独立事件保留
    used.add(item.id);
    out.push(toEnterpriseEvent(item, extractCompanyName(item.title || '') || 'AI 企业'));
  }
  return out;
}

// ========== 投融资 WebSearch 采集（Sheet04 04-05 分支A） ==========

/** 缓存条目转 stale 标记 */
function markEnterpriseStale(e: EnterpriseRawEvent, stale: boolean): EnterpriseRawEvent {
  return {
    ...e,
    content: `${e.content}${stale ? '（缓存数据：实时源不可用，时间可能滞后）' : ''}`.trim(),
    source_urls: [...e.source_urls, { url: '', source_type: 'cache', name: stale ? '本地缓存（超期）' : '本地缓存', credibility_score: 2 }],
  };
}

/**
 * 投融资 WebSearch 兜底：
 *  ① DuckDuckGo / Hacker News 公开搜索（免 key）
 *  ② 命中企业池则归属该公司，否则独立成条（extractCompanyName 提取）
 */
async function collectInvestmentFallback(ctx: TaskContext): Promise<EnterpriseRawEvent[]> {
  const out: EnterpriseRawEvent[] = [];
  const queries = [
    'AI 融资 大模型 创业公司',
    'AI startup funding round',
  ];
  for (const q of queries) {
    const res = await webSearch(q, { limit: 6, maxAgeHours: Math.max(72, ctx.time_window_hours * 3) });
    if (!res.ok) {
      logger.warn(`[enterprise] 投融资 WebSearch 失败(${q}): ${res.error}`);
      continue;
    }
    for (const r of res.results) {
      if (out.length >= 6) break;
      const text = `${r.title} ${r.snippet}`;
      const isInvestment = INVESTMENT_KEYWORDS.some((k) => text.includes(k));
      if (!isInvestment) continue;
      const matched = ENTERPRISE_POOL.find((p) => [p.company, ...p.aliases].some((n) => n.length >= 2 && text.toLowerCase().includes(n.toLowerCase())));
      out.push({
        module: 'enterprise',
        sub_type: 'investment',
        company: normalizeCompany(matched?.company || extractCompanyName(r.title) || 'AI 企业'),
        title: r.title,
        published_at: r.published_at || toISODate(new Date()),
        content: r.snippet.slice(0, 300),
        fields: {},
        related_event_ids: [],
        source_urls: [{ url: r.url, source_type: 'websearch', name: r.source === 'hackernews' ? 'Hacker News' : 'DuckDuckGo', credibility_score: 3 }],
      });
    }
    if (out.length >= 6) break;
  }

  // 中文投融资兜底：HN/DDG 对中文命中率极低，用微信搜索补（脚本已内置项目 scripts/wechat-search/）
  if (out.length < 4) {
    for (const q of ['AI 融资 大模型', '大模型 融资 亿元']) {
      if (out.length >= 4) break;
      const res = await wechatSearch(q, { limit: 4, maxDays: Math.max(30, Math.ceil(ctx.time_window_hours / 24)) });
      if (!res.ok) {
        logger.warn(`[enterprise] 投融资 wechat 搜索失败(${q}): ${res.error}`);
        continue;
      }
      for (const a of res.results) {
        if (out.length >= 4) break;
        const text = `${a.title} ${a.summary}`;
        if (isWechatNoise(text)) continue; // 过滤面经/招聘/广告类噪音
        const isInvestment = INVESTMENT_KEYWORDS.some((k) => text.includes(k));
        if (!isInvestment) continue;
        // 池内企业优先归属；池外但属已知 AI 机构也保留（投融资是新增信息源，不强制企业池约束）
        const matched = ENTERPRISE_POOL.find((p) =>
          [p.company, ...p.aliases]
            .filter((n) => !LOW_DISCRIMINATIVE_ALIASES.has(n.toLowerCase()))
            .some((n) => n.length >= 2 && text.toLowerCase().includes(n.toLowerCase())),
        );
        const knownOrg = KNOWN_AI_ORGS.find((n) => text.toLowerCase().includes(n.toLowerCase()));
        if (!matched && !knownOrg) continue;
        out.push({
          module: 'enterprise',
          sub_type: 'investment',
          company: normalizeCompany(matched?.company || (knownOrg ? knownOrg.charAt(0).toUpperCase() + knownOrg.slice(1) : 'AI 企业')),
          title: a.title,
          published_at: a.datetime || toISODate(new Date()),
          content: a.summary.slice(0, 300),
          fields: {},
          related_event_ids: [],
          source_urls: [{ url: a.url, source_type: 'wechat', name: a.source || '微信公众号', credibility_score: 3 }],
        });
      }
    }
  }
  return out;
}

/** 已知 AI 机构（池外，但应保留真实机构名而非"AI 企业"） */
const KNOWN_AI_ORGS = ['hugging face', 'huggingface', 'stability ai', 'stability', 'mistral', 'cohere', 'x ai', 'xai', 'perplexity', 'nvidia', '英伟达', 'microsoft', '微软', 'amazon', '亚马逊', 'apple', '苹果', 'tesla', '特斯拉', 'meta', '百度', '华为', '小米', '京东', '美团', '字节跳动'];

function extractCompanyName(title: string): string | null {
  const lower = title.toLowerCase();
  // ① 已知机构直接命中（如 "Hugging Face 发布..."）
  const known = KNOWN_AI_ORGS.find((n) => lower.startsWith(n) || lower.includes(`${n} `) || lower.includes(`${n}：`) || lower.includes(`${n}:`));
  if (known) return known.charAt(0).toUpperCase() + known.slice(1);
  // ② 尝试从标题提取公司名（"XX 完成 YY 融资"）
  const m = title.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,20}?)(?:完成|宣布|获得|启动|发布|推出)/);
  return m ? m[1] : null;
}

/** 微信源噪音词（招聘/培训/面经/广告等，非企业动态） */
const WECHAT_NOISE_KEYWORDS = ['面经', '面试', 'offer', '求职', '招聘', '培训', '辅导', '陪跑', '学员', '简历', '上岸', '内推', '课程', '讲座', '报名', '咨询加', '加微信', '扫码'];

function isWechatNoise(text: string): boolean {
  const lower = text.toLowerCase();
  return WECHAT_NOISE_KEYWORDS.some((k) => lower.includes(k));
}

// ========== 微信公众号中文补充采集（国内企业动态/投融资） ==========

/**
 * 微信公号搜索补充（wechat-article-search 技能，搜狗微信源）：
 *  ① 对每家池内企业做一次"企业名+AI"检索（国内企业命中率显著高于 HN/DDG）
 *  ② 再做一次通用投融资检索（中文）
 *  ③ 严格归属：标题/摘要必须含公司名/别名才归属（沿用 matchItemsToCompanies 强信号逻辑）
 * 失败静默降级（不阻塞主流程），成功条数计入缓存 sources。
 */
async function collectWechatSupplement(ctx: TaskContext): Promise<EnterpriseRawEvent[]> {
  const out: EnterpriseRawEvent[] = [];
  const queries: string[] = [];
  // 国内企业优先（国外企业搜狗覆盖差），每家最多 1 条，避免过度补充
  for (const p of ENTERPRISE_POOL) {
    const isDomestic = /[\u4e00-\u9fa5]/.test(p.company) || (p.domesticSources?.length ?? 0) > 0;
    if (isDomestic) queries.push(`${p.company} AI`);
  }
  queries.push('AI 融资 大模型');

  for (const q of queries) {
    const res = await wechatSearch(q, { limit: 4, maxDays: Math.max(30, Math.ceil(ctx.time_window_hours / 24)) });
    if (!res.ok) {
      logger.warn(`[enterprise] wechat 搜索失败(${q}): ${res.error}`);
      continue;
    }
    for (const a of res.results) {
      if (out.length >= 6) break;
      const text = `${a.title} ${a.summary}`;
      if (isWechatNoise(text)) continue; // 过滤面经/招聘/广告类噪音
      const matched = ENTERPRISE_POOL.find((p) =>
        [p.company, ...p.aliases]
          .filter((n) => !LOW_DISCRIMINATIVE_ALIASES.has(n.toLowerCase()))
          .some((n) => n.length >= 2 && text.toLowerCase().includes(n.toLowerCase())),
      );
      if (!matched) continue; // 池外文章不采集（企业池约束）
      const subType = classifyByRule(a.title, a.summary);
      out.push({
        module: 'enterprise',
        sub_type: subType,
        company: matched.company,
        title: a.title,
        // 脚本输出即中国时区（UTC+8）YYYY-MM-DD HH:mm:ss，直接透传，与 aihot 的 published_at 格式一致
        published_at: a.datetime || toISODate(new Date()),
        content: a.summary.slice(0, 300),
        fields: {},
        related_event_ids: [],
        source_urls: [{ url: a.url, source_type: 'wechat', name: a.source || '微信公众号', credibility_score: 3 }],
      });
    }
    if (out.length >= 6) break;
  }
  if (out.length > 0) logger.info(`[enterprise] wechat 补充 ${out.length} 条`);
  return out;
}

// ========== 双分支分流 + 实体抽取（Sheet04 04-04/04-05/04-06） ==========

function classifyAndExtract(e: EnterpriseRawEvent): EnterpriseRawEvent {
  const text = `${e.title} ${e.content}`;
  const subType = classifyByRule(e.title, e.content);
  e.sub_type = subType;
  const fields: Record<string, unknown> = {};

  if (subType === 'investment') {
    const amountM = text.match(/(\d+(?:\.\d+)?)\s*亿\s*元?人民币?/) || text.match(/(\d+(?:\.\d+)?)\s*万\s*元?人民币?/) || text.match(/\$\s*(\d+(?:\.\d+)?)\s*(M|B)/i);
    if (amountM) {
      if (text.includes('亿')) fields.amount_wan = Math.round(+amountM[1] * 10000);
      else if (text.includes('万')) fields.amount_wan = Math.round(+amountM[1]);
      else fields.amount_wan = amountM[2].toUpperCase() === 'B' ? Math.round(+amountM[1] * 10000) : Math.round(+amountM[1] * 100);
    }
    const roundM = text.match(/(天使轮|种子轮|A\+?轮|B\+?轮|C\+?轮|D\+?轮|E\+?轮|Pre-?A轮|Pre-?B轮|Pre-?IPO轮|战略融资|IPO|并购)/);
    if (roundM) fields.round = roundM[1];
    const investorM = text.match(/由(.{2,30}?)(?:领投|参投|投资|注资)/);
    if (investorM) fields.investors = investorM[1].split(/、|,|，|和|及/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  } else {
    const productM = text.match(/(?:发布|推出|上线|开源)\s*[「『【]?([A-Za-z0-9\-\.]*(?:模型|大模型|版|框架|平台|套件|工具|API|Kit|Studio)[A-Za-z0-9\-\.]*)[」』】]?/i);
    if (productM) fields.product = productM[1] || productM[0];
  }

  e.fields = fields;
  return e;
}

// ========== 去重（标题相似度 ≥ 0.85 合并来源） ==========

function dedupEnterprise(events: EnterpriseRawEvent[]): EnterpriseRawEvent[] {
  const result: EnterpriseRawEvent[] = [];
  for (const evt of events) {
    const dupIdx = result.findIndex((e) => similarity(e.title, evt.title) >= 0.85);
    if (dupIdx >= 0) {
      // 合并来源证据
      const existing = result[dupIdx];
      const urlMap = new Map<string, SourceEvidence>();
      for (const s of [...existing.source_urls, ...evt.source_urls]) if (s.url) urlMap.set(s.url, s);
      existing.source_urls = Array.from(urlMap.values());
    } else {
      result.push(evt);
    }
  }
  return result;
}

// ========== 同一公司最多 N 条（用户核心约束：至多 2 条/公司） ==========

function capByCompany(events: EnterpriseRawEvent[], maxPerCompany: number): EnterpriseRawEvent[] {
  const counts = new Map<string, number>();
  const result: EnterpriseRawEvent[] = [];
  for (const evt of events) {
    const company = evt.company || '未知';
    const count = counts.get(company) || 0;
    if (count >= maxPerCompany) continue;
    counts.set(company, count + 1);
    result.push(evt);
  }
  return result;
}
