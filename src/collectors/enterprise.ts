/**
 * 企业动态采集（Sheet04 04-04/04-05）—— 双分支并行结构
 *
 * 按规格（workflow.txt 271-301 行 + prd.txt 63-86 行），企业动态与投融资是两个独立子 Agent：
 *  ┌─ 分支 A：企业动态 Agent（sub_type: product/strategy）
 *  │    源层次：海外官方 RSS/HTML（OpenAI/Anthropic/Google）→ 国内官方源直连（DeepSeek/Kimi）
 *  │            → 媒体 RSS（TechCrunch/36氪/机器之心）→ WebSearch 通用兜底（阿里/字节/腾讯 SPA）
 *  │
 *  └─ 分支 B：投融资 Agent（sub_type: investment）
 *       源层次：aihot 精选投融资条目 → WebSearch 兜底（英文 HN 为主）
 *       （企查查/IT桔子/Crunchbase 需付费或连接器，当前环境不可用，WebSearch 为唯一兜底通道）
 *
 * 2026-08-24 实测核验：
 *  - OpenAI /news/rss.xml ✅、Anthropic /news HTML ✅、Google innovation-and-ai rss ✅
 *  - DeepSeek /news HTML ✅（详情页有日期）、Kimi /blog HTML ✅（文章链接在 /en/blog/）
 *  - TechCrunch feed ✅、36氪 rsshub ✅、机器之心 rsshub 偶发 503（自动跳过）
 *  - Meta ai.meta.com 超时、Microsoft blogs 403(Cloudflare) —— 不可达，WebSearch 兜底
 *  - aihot API ✅（7d 窗口 47 条；24h 窗口常只有 1-2 条，投融资分支用 7d）
 *  - 微信源已按用户要求移除（时效性差）
 *
 * 核心约束（用户要求）：
 *  - 一个动态对应一家公司（企业合作/多企业事件单独成条）
 *  - 同一家公司最多 2 条（避免"4 条动态 3 条 OpenAI"）
 *  - 企业池持久化到 enterprise_pool 表
 *  - WebSearch 是通用兜底（四大模块统一降级机制，非投融资专属）
 */

import type { EnterpriseRawEvent, SourceEvidence, TaskContext } from '../types/events.js';
import { ENTERPRISE_POOL, INVESTMENT_KEYWORDS, PRODUCT_KEYWORDS, sourceCredibility, type EnterpriseProfile } from '../config/constants.js';
import { httpGetJson } from '../utils/http.js';
import { webSearch } from '../utils/websearch.js';
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
/** 采集超时控制：单源 12s，分支总预算 60s */
const SOURCE_TIMEOUT_MS = 12_000;
const BRANCH_BUDGET_MS = 60_000;

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

/** 采集结果汇总（双分支各自返回，便于日志与降级统计） */
interface BranchResult {
  events: EnterpriseRawEvent[];
  sourceUsed: string[];   // 实际命中来源（写入缓存 meta.sources）
  errors: string[];
  degraded: boolean;      // 该分支是否走了缓存降级
}

// ========== 主流程：双分支并行 ==========

export async function collectEnterprise(ctx: TaskContext): Promise<EnterpriseRawEvent[]> {
  const start = Date.now();
  persistEnterprisePool();
  const pool = resolvePool();
  logger.info(`[enterprise] 开始采集，企业池 ${pool.length} 家，双分支并行，时间窗口 ${ctx.time_window_hours}h`);

  // 分支 A（企业动态）与 分支 B（投融资）并行执行
  const [branchA, branchB] = await Promise.all([
    withBudget(collectCompanyBranch(ctx, pool), BRANCH_BUDGET_MS, '企业动态分支'),
    withBudget(collectInvestmentBranch(ctx), BRANCH_BUDGET_MS, '投融资分支'),
  ]);

  const all = [...branchA.events, ...branchB.events];
  const errors = [...branchA.errors, ...branchB.errors];
  let degraded = branchA.degraded || branchB.degraded;

  // 全量失败 → 缓存降级（stale 标记）
  if (all.length === 0) {
    degraded = true;
    const cached = readJsonCache<EnterpriseRawEvent>(CACHE_SCOPE, CACHE_KEY, CACHE_MAX_AGE_MS);
    if (cached) {
      all.push(...cached.entry.items.map((e) => markEnterpriseStale(e, cached.stale)));
      errors.push(`cache: 使用 ${cached.stale ? '超期(stale)' : '新鲜'}缓存 ${cached.entry.items.length} 条（写入于 ${cached.entry.meta.written_at}）`);
    }
  }

  // 分类 + 实体抽取
  const classified = all.map((e) => classifyAndExtract(e));

  // 去重（标题相似度 ≥ 0.85 合并；aihot 同一条被多家公司命中时保留首次归属）
  const deduped = dedupEnterprise(classified);

  // 按公司组织 + 同一公司最多 2 条（用户核心约束）
  const capped = capByCompany(deduped, 2);

  // 时间排序
  capped.sort((a, b) => b.published_at.localeCompare(a.published_at));

  // 成功后写缓存
  if (capped.length > 0) {
    writeJsonCache(CACHE_SCOPE, CACHE_KEY, capped, {
      windowHours: ctx.time_window_hours,
      sources: [...new Set([...branchA.sourceUsed, ...branchB.sourceUsed])],
      degraded,
    });
  }

  logger.info(
    `[enterprise] 采集完成：分支A(企业动态) ${branchA.events.length} 条[${branchA.sourceUsed.join('/') || '无'}]，` +
    `分支B(投融资) ${branchB.events.length} 条[${branchB.sourceUsed.join('/') || '无'}]，` +
    `去重后 ${deduped.length}，按公司裁剪后 ${capped.length}（每家≤2条）` +
    `${errors.length ? '（异常: ' + errors.join(';') + '）' : ''}，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
  return capped;
}

/** 分支执行预算包装：超时返回空结果 + 降级标记，不抛异常 */
async function withBudget(fn: Promise<BranchResult>, ms: number, label: string): Promise<BranchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BranchResult>((resolve) => {
    timer = setTimeout(() => resolve({ events: [], sourceUsed: [], errors: [`${label} 超时(>${ms / 1000}s)`], degraded: false }), ms);
  });
  try {
    const r = await Promise.race([fn, timeout]);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

// ========== 企业池持久化 ==========

/** 统一的企业池行形状（兼容常量与 DB 行） */
interface PoolProfile {
  company: string;
  aliases: string[];
  officialSources: string[];
  domesticSources: string[];
  fallback: string[];
}

function toPoolRow(p: EnterpriseProfile): PoolProfile {
  return {
    company: p.company,
    aliases: p.aliases,
    officialSources: p.officialSources || [],
    domesticSources: p.domesticSources || [],
    fallback: p.fallback || [],
  };
}

/** 从 DB 企业池表或常量解析企业池（DB 行为优先，字段名做适配） */
function resolvePool(): PoolProfile[] {
  try {
    const rows = listEnterprisePool();
    if (rows.length > 0) {
      return rows.map((r) => ({
        company: r.company,
        aliases: r.aliases || [],
        officialSources: (r.official_sources as string[]) || [],
        domesticSources: (r.domestic_sources as string[]) || [],
        fallback: (r.fallback as string[]) || [],
      }));
    }
  } catch (err) {
    logger.warn(`[enterprise] 读取企业池表失败，回退常量: ${err instanceof Error ? err.message : err}`);
  }
  return ENTERPRISE_POOL.map(toPoolRow);
}

function persistEnterprisePool(): void {
  try {
    upsertEnterprisePool(ENTERPRISE_POOL.map((p) => ({
      company: p.company,
      aliases: p.aliases,
      official_sources: p.officialSources,
      domestic_sources: p.domesticSources || [],
      fallback: p.fallback,
    })));
  } catch (err) {
    logger.warn(`[enterprise] 企业池持久化失败: ${err instanceof Error ? err.message : err}`);
  }
}

// ========== 分支 A：企业动态 Agent ==========

/**
 * 企业动态分支（Sheet04 04-04）：
 *  ① 海外官方源：OpenAI/Anthropic/Google RSS|HTML 直连（Meta 超时 / Microsoft 403 自动跳过）
 *  ② 国内官方源：DeepSeek/Kimi HTML 直连（阿里/字节/腾讯 SPA 不可解析，跳过）
 *  ③ 媒体源：TechCrunch/36氪/机器之心 RSS，按企业池别名匹配归属
 *  ④ WebSearch 通用兜底：针对池内无官方可解析源的企业（阿里/字节/腾讯/Meta/MS）按英文关键词搜索
 */
async function collectCompanyBranch(ctx: TaskContext, pool: PoolProfile[]): Promise<BranchResult> {
  const out: EnterpriseRawEvent[] = [];
  const sourceUsed: string[] = [];
  const errors: string[] = [];
  let degraded = false;
  const add = (es: EnterpriseRawEvent[], src: string) => {
    if (es.length > 0) { out.push(...es); if (!sourceUsed.includes(src)) sourceUsed.push(src); }
  };

  // ① 海外官方源（逐源失败静默，不阻塞）
  const overseas = await collectOverseasOfficial();
  add(overseas, 'official_rss');

  // ② 国内官方源直连（DeepSeek/Kimi）
  const domestic = await collectDomesticOfficial();
  add(domestic, 'domestic_official');

  // ③ 媒体 RSS（TechCrunch 英文 + 36氪/机器之心 中文）
  const media = await collectMediaRss(ctx, pool);
  add(media, 'media_rss');

  // ④ WebSearch 通用兜底（无官方源可解析的企业：阿里/字节/腾讯/Meta/Microsoft）
  const search = await collectWebSearchFallback(ctx, pool);
  add(search, 'websearch');

  if (out.length === 0) {
    degraded = true;
    errors.push('企业动态分支: 官方源/媒体源/WebSearch 均无结果');
  } else {
    recordSourceOk('enterprise_company');
  }
  return { events: out, sourceUsed, errors, degraded };
}

/** ① 海外官方 RSS/HTML 采集（规格 Sheet06 海外官方 Blog RSS） */
async function collectOverseasOfficial(): Promise<EnterpriseRawEvent[]> {
  const out: EnterpriseRawEvent[] = [];
  const tasks = [
    { name: 'OpenAI', url: 'https://openai.com/news/rss.xml', type: 'rss' as const },
    { name: 'Anthropic', url: 'https://www.anthropic.com/news', type: 'html' as const },
    { name: 'Google', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', type: 'rss' as const },
    { name: 'Meta', url: 'https://ai.meta.com/blog/rss/', type: 'rss' as const },
    { name: 'Microsoft', url: 'https://blogs.microsoft.com/feed/', type: 'rss' as const },
  ];
  const results = await Promise.allSettled(tasks.map((t) => fetchOfficialSource(t)));
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) out.push(...r.value);
  }
  return out;
}

/** 抓取单个官方源并转事件（RSS 或 HTML 卡片） */
async function fetchOfficialSource(t: { name: string; url: string; type: 'rss' | 'html' }): Promise<EnterpriseRawEvent[]> {
  try {
    const res = await httpGetJson<unknown>(t.url, { timeoutMs: SOURCE_TIMEOUT_MS, retries: 1, exponential: true });
    if (!res.ok || !res.text) {
      logger.warn(`[enterprise] ${t.name} 官方源失败: ${res.error || 'empty'}`);
      recordSourceFail(`official_${t.name.toLowerCase()}`, res.error || 'empty');
      return [];
    }
    if (res.status === 403 || res.status === 429) {
      logger.warn(`[enterprise] ${t.name} 官方源被反爬(HTTP ${res.status})，跳过`);
      recordSourceFail(`official_${t.name.toLowerCase()}`, `http_${res.status}`);
      return [];
    }
    const events = t.type === 'rss' ? parseRssEvents(res.text, t.name) : parseHtmlNewsEvents(res.text, t.name);
    if (events.length > 0) {
      recordSourceOk(`official_${t.name.toLowerCase()}`);
      logger.info(`[enterprise] ${t.name} 官方源 ${events.length} 条`);
    } else {
      recordSourceFail(`official_${t.name.toLowerCase()}`, 'no_items');
    }
    return events;
  } catch (err) {
    logger.warn(`[enterprise] ${t.name} 官方源异常: ${err instanceof Error ? err.message : err}`);
    recordSourceFail(`official_${t.name.toLowerCase()}`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** RSS 解析：OpenAI/Google/Meta/Microsoft/TechCrunch/36氪/机器之心 共用 */
function parseRssEvents(xml: string, company: string, sourceType = 'official_rss'): EnterpriseRawEvent[] {
  const items: EnterpriseRawEvent[] = [];
  const itemRe = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && items.length < 12) {
    const block = m[1];
    const title = stripTags((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    if (!title) continue;
    const link = (block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || '';
    const rawDate = (block.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i) || block.match(/<updated[^>]*>([^<]+)<\/updated>/i) || [])[1] || '';
    // 时间取真实发布日期：URL 含日期路径（/YYYY/MM/DD/）时以 URL 日期为准，
    // 因为 RSS pubDate 常是"最近更新时间"（旧文被重新推送/更新时 pubDate 会变新），
    // 会导致日报时间不真实（如微软 7/28 旧文被标成 8/24）。URL 无日期时回退 pubDate。
    const urlDate = urlDateOf(link);
    const published = urlDate || parseFlexibleDate(rawDate) || toISODate(new Date());
    items.push({
      module: 'enterprise',
      sub_type: 'product',
      company: normalizeCompany(company),
      title,
      published_at: published,
      content: title,
      fields: {},
      related_event_ids: [],
      source_urls: [{
        url: link.trim() || officialUrlOf(company),
        source_type: sourceType,
        name: `${company} 官方 Blog`,
        credibility_score: 5,
      }],
    });
  }
  return items;
}

/** 从 URL 路径提取日期（/YYYY/MM/DD/），如 blogs.microsoft.com/blog/2026/07/28/... → 2026-07-28 */
function urlDateOf(link: string): string | null {
  if (!link) return null;
  const m = link.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//);
  if (!m) return null;
  const y = m[1], mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0');
  const dt = new Date(`${y}-${mo}-${d}`);
  return Number.isNaN(dt.getTime()) ? null : `${y}-${mo}-${d}`;
}

/** HTML 新闻卡片解析：Anthropic /news（卡片带日期+链接） */
function parseHtmlNewsEvents(html: string, company: string): EnterpriseRawEvent[] {
  const out: EnterpriseRawEvent[] = [];
  const linkRe = /<a[^>]+href="(\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && out.length < 12) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    const blockText = stripTags(m[2]).replace(/\s+/g, ' ');
    // 卡片文本两种结构：
    //  新卡片: "Aug 14, 2026 Announcements How Claude's text watermark works"
    //  旧卡片: "Introducing Claude Opus 5 Product Jul 24, 2026 Opus 5 is a step change improvement..."
    const dateM = blockText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+20\d\d/);
    const dateStr = dateM?.[0] || '';
    // 去掉日期后，去头部分类词（Announcements/Product/...) —— 若日期在前则整体替换头部，若日期在后则截断到日期为止
    let titleRaw = dateStr ? blockText.replace(dateStr, '') : blockText;
    if (dateM && dateM.index !== undefined && dateM.index > 0) {
      // 旧卡片：日期在中间 → 标题是日期前的部分，描述是日期后的部分
      titleRaw = blockText.slice(0, dateM.index);
    }
    // 去头部/尾部残留：分类词（Announcements/Product/...) 循环清理开头 + 去尾部脏词
    // 例："Introducing Claude Opus 5 Product" → 循环去头分类词后为 "Introducing Claude Opus 5 Product"，再截尾部 "Product" → "Introducing Claude Opus 5"
    let title = titleRaw.trim().replace(/^[|>\-•\s]+/, '');
    // 循环清理开头分类词（可能连续出现）
    const HEAD_WORDS = /^(Announcements|Product|Economic Research|Research|Engineering|News|Press Release|Updates?|Blog)\s+/i;
    let guard = 0;
    while (HEAD_WORDS.test(title) && guard < 6) {
      title = title.replace(HEAD_WORDS, '');
      guard++;
    }
    // 清理尾部残留分类词/提示语
    title = title
      .replace(/\s+(Announcements|Product|Economic Research|Research|Engineering|News|Press Release|Updates?|Blog|Read more|Learn more)$/i, '')
      .replace(/\s+(Opus \d|Claude \d(\.\d+)?)\s+(is a|are a|represents|marks|delivers|sets|comes)\b.*$/i, '$1')
      .trim()
      .slice(0, 150);
    if (!title || title.length < 8) continue;
    const published = dateStr ? parseFlexibleDate(dateStr) || toISODate(new Date()) : toISODate(new Date());
    out.push({
      module: 'enterprise',
      sub_type: 'product',
      company: normalizeCompany(company),
      title,
      published_at: published,
      content: title,
      fields: {},
      related_event_ids: [],
      source_urls: [{
        url: `https://www.anthropic.com${href}`,
        source_type: 'official',
        name: 'Anthropic News',
        credibility_score: 5,
      }],
    });
  }
  return out;
}

/** ② 国内官方源直连（DeepSeek/Kimi，规格 Sheet06 国内大厂信息源） */
async function collectDomesticOfficial(): Promise<EnterpriseRawEvent[]> {
  const out: EnterpriseRawEvent[] = [];
  const [ds, kimi] = await Promise.allSettled([fetchDeepSeekNews(), fetchKimiBlog()]);
  if (ds.status === 'fulfilled') out.push(...ds.value);
  if (kimi.status === 'fulfilled') out.push(...kimi.value);
  return out;
}

/** DeepSeek /news：列表页取最新置顶链接 → 详情页 H1 + 日期（实测 2026/08/21 有 V4-Flash-Vision-Exp 发布） */
async function fetchDeepSeekNews(): Promise<EnterpriseRawEvent[]> {
  const listRes = await httpGetJson<unknown>('https://api-docs.deepseek.com/news', { timeoutMs: SOURCE_TIMEOUT_MS, retries: 1 });
  if (!listRes.ok || !listRes.text) return [];
  // 找 /news/newsXXXXXX 详情链接
  const links = [...listRes.text.matchAll(/href="(\/news\/news[a-zA-Z0-9]+)"/gi)].map((m) => m[1]);
  if (links.length === 0) {
    recordSourceFail('official_deepseek', 'no_news_link');
    return [];
  }
  const out: EnterpriseRawEvent[] = [];
  for (const link of links.slice(0, 3)) {
    const detail = await httpGetJson<unknown>(`https://api-docs.deepseek.com${link}`, { timeoutMs: SOURCE_TIMEOUT_MS, retries: 1 });
    if (!detail.ok || !detail.text) continue;
    const h1 = stripTags((detail.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
    if (!h1) continue;
    const dateM = detail.text.match(/20\d\d[-/]\d{1,2}[-/]\d{1,2}/);
    const published = dateM ? toISODate(dateM[0].replace(/\//g, '-')) : toISODate(new Date());
    out.push({
      module: 'enterprise',
      sub_type: 'product',
      company: 'DeepSeek',
      title: h1.slice(0, 150),
      published_at: published,
      content: h1.slice(0, 300),
      fields: {},
      related_event_ids: [],
      source_urls: [{
        url: `https://api-docs.deepseek.com${link}`,
        source_type: 'official',
        name: 'DeepSeek News',
        credibility_score: 5,
      }],
    });
  }
  if (out.length > 0) {
    recordSourceOk('official_deepseek');
    logger.info(`[enterprise] DeepSeek 官方源 ${out.length} 条`);
  }
  return out;
}

/** Kimi /blog：列表页文章卡片（实测 /en/blog/kimi-k3 等，日期在详情页 ISO 格式） */
async function fetchKimiBlog(): Promise<EnterpriseRawEvent[]> {
  const res = await httpGetJson<unknown>('https://www.kimi.com/blog', { timeoutMs: SOURCE_TIMEOUT_MS, retries: 1 });
  if (!res.ok || !res.text) return [];
  const links = [...res.text.matchAll(/href="(\/en\/blog\/[a-z0-9-]+)"/gi)].map((m) => m[1]);
  const uniq = [...new Set(links)].slice(0, 6);
  if (uniq.length === 0) {
    recordSourceFail('official_kimi', 'no_blog_link');
    return [];
  }
  const out: EnterpriseRawEvent[] = [];
  for (const link of uniq.slice(0, 3)) {
    const detail = await httpGetJson<unknown>(`https://www.kimi.com${link}`, { timeoutMs: SOURCE_TIMEOUT_MS, retries: 0 });
    if (!detail.ok || !detail.text) continue;
    const h1 = stripTags((detail.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
    if (!h1) continue;
    const dateM = detail.text.match(/20\d\d-\d{1,2}-\d{1,2}/);
    const published = dateM ? toISODate(dateM[0]) : toISODate(new Date());
    out.push({
      module: 'enterprise',
      sub_type: 'product',
      company: '月之暗面',
      title: h1.slice(0, 150),
      published_at: published,
      content: h1.slice(0, 300),
      fields: {},
      related_event_ids: [],
      source_urls: [{
        url: `https://www.kimi.com${link}`,
        source_type: 'official',
        name: 'Kimi Blog',
        credibility_score: 5,
      }],
    });
  }
  if (out.length > 0) {
    recordSourceOk('official_kimi');
    logger.info(`[enterprise] Kimi 官方源 ${out.length} 条`);
  }
  return out;
}

/** ③ 媒体 RSS：TechCrunch（英文）+ 36氪/机器之心（中文），按企业池别名匹配归属 */
async function collectMediaRss(ctx: TaskContext, pool: PoolProfile[]): Promise<EnterpriseRawEvent[]> {
  const out: EnterpriseRawEvent[] = [];
  const tasks = [
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', lang: 'en' as const },
    { name: '36氪', url: 'https://rsshub.rssforever.com/36kr/newsflashes', lang: 'zh' as const },
    { name: '机器之心', url: 'https://rsshub.rssforever.com/jiqizhixin', lang: 'zh' as const },
  ];
  const results = await Promise.allSettled(tasks.map((t) => fetchMediaSource(t, pool)));
  for (const r of results) if (r.status === 'fulfilled') out.push(...r.value);
  return out;
}

async function fetchMediaSource(t: { name: string; url: string; lang: 'en' | 'zh' }, pool: PoolProfile[]): Promise<EnterpriseRawEvent[]> {
  try {
    const res = await httpGetJson<unknown>(t.url, { timeoutMs: SOURCE_TIMEOUT_MS, retries: 1, exponential: true });
    if (!res.ok || !res.text) {
      logger.warn(`[enterprise] 媒体源 ${t.name} 失败: ${res.error || 'empty'}`);
      return [];
    }
    if (res.status === 503) {
      logger.warn(`[enterprise] 媒体源 ${t.name} 503（rsshub 偶发），跳过`);
      recordSourceFail(`media_${t.name}`, 'http_503');
      return [];
    }
    // 解析 RSS 条目
    const raw: Array<{ title: string; link: string; date: string; snippet: string }> = [];
    const itemRe = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(res.text)) && raw.length < 20) {
      const block = m[1];
      const title = stripTags((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
      if (!title) continue;
      const link = (block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || '';
      const date = (block.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i) || block.match(/<updated[^>]*>([^<]+)<\/updated>/i) || [])[1] || '';
      const snippet = stripTags((block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '').slice(0, 200);
      raw.push({ title, link: link.trim(), date: date.trim(), snippet });
    }
    // 按企业池别名匹配归属（严格归属：标题/摘要必须含公司名/别名）
    const events: EnterpriseRawEvent[] = [];
    for (const item of raw) {
      const text = `${item.title} ${item.snippet}`.toLowerCase();
      const matched = pool.find((p) =>
        [p.company, ...p.aliases]
          .filter((n) => !LOW_DISCRIMINATIVE_ALIASES.has(n.toLowerCase()))
          .some((n) => n.length >= 2 && text.includes(n.toLowerCase())),
      );
      if (!matched) continue; // 媒体源只采集企业池相关事件
      // 时间取真实发布日期：URL 含日期路径（/YYYY/MM/DD/）时以 URL 日期为准（RSS pubDate 常是更新时间）
      const urlDate = urlDateOf(item.link);
      events.push({
        module: 'enterprise',
        sub_type: 'product',
        company: normalizeCompany(matched.company),
        title: item.title.slice(0, 200),
        published_at: urlDate || parseFlexibleDate(item.date) || toISODate(new Date()),
        content: item.snippet,
        fields: {},
        related_event_ids: [],
        source_urls: [{
          url: item.link,
          source_type: 'media',
          name: t.name,
          credibility_score: sourceCredibility(item.link, 'media'),
        }],
      });
      if (events.length >= 6) break;
    }
    if (events.length > 0) {
      recordSourceOk(`media_${t.name}`);
      logger.info(`[enterprise] 媒体源 ${t.name} ${events.length} 条（企业池命中）`);
    } else {
      recordSourceFail(`media_${t.name}`, 'no_pool_match');
    }
    return events;
  } catch (err) {
    logger.warn(`[enterprise] 媒体源 ${t.name} 异常: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** ④ WebSearch 通用兜底：针对无官方可解析源的企业（阿里/字节/腾讯/Meta/Microsoft），按英文关键词搜索 */
async function collectWebSearchFallback(ctx: TaskContext, pool: PoolProfile[]): Promise<EnterpriseRawEvent[]> {
  const out: EnterpriseRawEvent[] = [];
  // 无官方可解析源的企业：domesticSources 为 SPA 或官方源为空（阿里/字节/腾讯）+ 海外不可达（Meta/Microsoft）
  const needFallback = pool.filter((p) => {
    const spa = (p.domesticSources || []).some((u) => /tongyi|volcengine|hunyuan|bytedance|seed/i.test(u));
    return spa;
  });
  if (needFallback.length === 0) return out;

  const queryMap: Array<{ company: string; query: string }> = [
    { company: '阿里巴巴', query: 'Qwen Alibaba new model release' },
    { company: '字节跳动', query: 'ByteDance Doubao AI model release' },
    { company: '腾讯', query: 'Tencent Hunyuan AI model release' },
  ];
  for (const q of queryMap) {
    if (!needFallback.some((p) => p.company === q.company)) continue;
    const res = await webSearch(q.query, { limit: 4, maxAgeHours: Math.max(72, ctx.time_window_hours * 3) });
    if (!res.ok) {
      logger.warn(`[enterprise] 企业动态 WebSearch 兜底失败(${q.company}): ${res.error}`);
      continue;
    }
    for (const r of res.results) {
      if (out.length >= 6) break;
      const text = `${r.title} ${r.snippet}`.toLowerCase();
      // 严格归属：标题/摘要必须含该企业别名（Qwen/Alibaba/ByteDance/Doubao/Tencent/Hunyuan）
      const aliases = needFallback.find((p) => p.company === q.company)?.aliases || [];
      const hit = aliases.some((n) => n.toLowerCase().length >= 3 && text.includes(n.toLowerCase()));
      if (!hit) continue;
      const isProduct = PRODUCT_KEYWORDS.some((k) => text.includes(k)) || /model|release|launch|api/i.test(text);
      if (!isProduct) continue;
      out.push({
        module: 'enterprise',
        sub_type: 'product',
        company: normalizeCompany(q.company),
        title: r.title.slice(0, 200),
        published_at: r.published_at || toISODate(new Date()),
        content: r.snippet.slice(0, 300),
        fields: {},
        related_event_ids: [],
        source_urls: [{ url: r.url, source_type: 'websearch', name: r.source === 'hackernews' ? 'Hacker News' : 'DuckDuckGo', credibility_score: 3 }],
      });
    }
  }
  return out;
}

// ========== 分支 B：投融资 Agent（Sheet04 04-05 分支A） ==========

/**
 * 投融资分支（独立子 Agent）：
 *  ① aihot 精选 7d 窗口 → 按投融资关键词过滤（融资/并购/上市/估值等）
 *  ② WebSearch 兜底：英文 HN 融资关键词（AI funding/raises），命中企业池或已知机构则保留
 *  ③ 企查查/IT桔子/Crunchbase 需付费连接器，当前环境不可用 → WebSearch 为唯一兜底通道
 */
async function collectInvestmentBranch(ctx: TaskContext): Promise<BranchResult> {
  const out: EnterpriseRawEvent[] = [];
  const sourceUsed: string[] = [];
  const errors: string[] = [];
  let degraded = false;

  // ① aihot 投融资条目（7d 窗口覆盖更全；24h 常为空）
  const aihotInv = await collectInvestmentFromAihot();
  if (aihotInv.length > 0) {
    out.push(...aihotInv);
    sourceUsed.push('aihot');
    recordSourceOk('investment_aihot');
  } else {
    recordSourceFail('investment_aihot', 'no_investment_items');
  }

  // ② WebSearch 兜底（英文 HN 对 AI 融资事件覆盖较好）
  if (out.length < 4) {
    const search = await collectInvestmentFromWebSearch(ctx);
    if (search.length > 0) {
      out.push(...search);
      sourceUsed.push('websearch');
    }
  }

  if (out.length === 0) {
    degraded = true;
    errors.push('投融资分支: aihot 无投融资条目且 WebSearch 无结果');
  }
  return { events: out, sourceUsed, errors, degraded };
}

/** ① aihot 精选 → 投融资关键词过滤 */
async function collectInvestmentFromAihot(): Promise<EnterpriseRawEvent[]> {
  const window = '7d';
  const url = `https://aihot.virxact.com/api/v1/items?mode=selected&window=${window}&limit=50`;
  const res = await httpGetJson<AihotResponse>(url, { timeoutMs: 15_000, retries: 1, exponential: true });
  if (!res.ok || !res.data) return [];
  const items = res.data.items || res.data.data || [];
  const out: EnterpriseRawEvent[] = [];
  for (const item of items) {
    const text = `${item.title || ''} ${item.summary || ''}`;
    const isInv = INVESTMENT_KEYWORDS.some((k) => text.includes(k));
    if (!isInv) continue;
    const company = extractCompanyName(item.title || '') || 'AI 企业';
    const published = parseFlexibleDate(item.publishedAt || item.discoveredAt || '') || toISODate(new Date());
    out.push({
      module: 'enterprise',
      sub_type: 'investment',
      company: normalizeCompany(company),
      title: item.title || item.originalTitle || '',
      published_at: published,
      content: item.summary || item.reason || '',
      fields: {},
      related_event_ids: [],
      source_urls: [{
        url: item.links?.original || item.links?.aihot || '',
        source_type: item.links?.original ? 'aihot_original' : 'aihot',
        name: item.source?.name || 'AIHOT',
        credibility_score: sourceCredibility(item.links?.original || '', 'media'),
      }],
    });
    if (out.length >= 6) break;
  }
  return out;
}

/** ② WebSearch 投融资兜底（英文 HN 融资关键词） */
async function collectInvestmentFromWebSearch(ctx: TaskContext): Promise<EnterpriseRawEvent[]> {
  const out: EnterpriseRawEvent[] = [];
  const queries = [
    'AI startup funding round',
    'AI startup raises series',
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
      const isInv = /(funding|raises|raised|series [a-z]|valuation|acquisition|融资)/i.test(text);
      if (!isInv) continue;
      out.push({
        module: 'enterprise',
        sub_type: 'investment',
        company: normalizeCompany(extractCompanyName(r.title) || 'AI 企业'),
        title: r.title.slice(0, 200),
        published_at: r.published_at || toISODate(new Date()),
        content: r.snippet.slice(0, 300),
        fields: {},
        related_event_ids: [],
        source_urls: [{ url: r.url, source_type: 'websearch', name: r.source === 'hackernews' ? 'Hacker News' : 'DuckDuckGo', credibility_score: 3 }],
      });
    }
    if (out.length >= 6) break;
  }
  return out;
}

// ========== 工具函数 ==========

/** 缓存条目转 stale 标记 */
function markEnterpriseStale(e: EnterpriseRawEvent, stale: boolean): EnterpriseRawEvent {
  return {
    ...e,
    content: `${e.content}${stale ? '（缓存数据：实时源不可用，时间可能滞后）' : ''}`.trim(),
    source_urls: [...e.source_urls, { url: '', source_type: 'cache', name: stale ? '本地缓存（超期）' : '本地缓存', credibility_score: 2 }],
  };
}

/** 已知 AI 机构（池外，但应保留真实机构名而非"AI 企业"） */
const KNOWN_AI_ORGS = ['hugging face', 'huggingface', 'stability ai', 'stability', 'mistral', 'cohere', 'x ai', 'xai', 'perplexity', 'nvidia', '英伟达', 'microsoft', '微软', 'amazon', '亚马逊', 'apple', '苹果', 'tesla', '特斯拉', 'meta', '百度', '华为', '小米', '京东', '美团', '字节跳动'];

/** 从标题提取公司名 */
function extractCompanyName(title: string): string | null {
  const lower = title.toLowerCase();
  const known = KNOWN_AI_ORGS.find((n) => lower.startsWith(n) || lower.includes(`${n} `) || lower.includes(`${n}：`) || lower.includes(`${n}:`));
  if (known) return known.charAt(0).toUpperCase() + known.slice(1);
  const m = title.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,20}?)(?:完成|宣布|获得|启动|发布|推出)/);
  return m ? m[1] : null;
}

/** 低区分度别名（避免误配） */
const LOW_DISCRIMINATIVE_ALIASES = new Set(['seed', '阿里', 'facebook']);

/** 取企业官方源 URL（RSS 条目缺 link 时的兜底溯源） */
function officialUrlOf(company: string): string {
  const p = ENTERPRISE_POOL.find((x) => x.company === company);
  return p?.officialSources?.[0] || p?.domesticSources?.[0] || '';
}

const stripTags = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

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
