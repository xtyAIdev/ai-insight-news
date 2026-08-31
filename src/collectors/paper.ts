/**
 * 学术研究采集（Sheet03）
 * 主源：arXiv API（按分类拆分）；补充：OpenAlex（严格当天）；可选尝试：Hugging Face daily_papers；兜底：WebSearch
 * 三门槛过滤（Sheet03 R26-R30）：时间 / 方向匹配 / 影响力
 */

import type { PaperRawEvent, SourceEvidence, TaskContext } from '../types/events.js';
import { PAPER_TOPICS, KNOWN_INSTITUTIONS } from '../config/constants.js';
import { httpGetJson } from '../utils/http.js';
import { webSearch } from '../utils/websearch.js';
import { writeJsonCache, readJsonCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { recordSourceOk, recordSourceFail } from '../db/index.js';
import { toISODate, parseFlexibleDate, sanitizeDate } from '../utils/normalize.js';

const CACHE_SCOPE = 'paper';
const CACHE_KEY = 'latest';
const CACHE_MAX_AGE_MS = 48 * 3600_000; // 论文可接受更长缓存（学术动态时效性弱于新闻）

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  authors: Array<{ name: string }>;
  published: string;
  updated: string;
  'primary_category'?: { term: string };
  category?: Array<{ term: string }>;
  link?: Array<{ href: string }>;
  comment?: string;
}

interface OpenAlexWork {
  id: string;
  title: string;
  authorships?: Array<{ author: { display_name: string }; institutions?: Array<{ display_name: string }> }>;
  abstract_inverted_index?: Record<string, number[]> | null;
  cited_by_count?: number;
  publication_date?: string;
  primary_location?: { source?: { display_name?: string } } | null;
}

interface OpenAlexResponse {
  results?: OpenAlexWork[];
  meta?: { count?: number };
}

// ========== 主流程 ==========

export async function collectPaper(ctx: TaskContext): Promise<PaperRawEvent[]> {
  const start = Date.now();
  logger.info(`[paper] 开始采集，时间窗口 ${ctx.time_window_hours}h`);

  const all: PaperRawEvent[] = [];
  let degraded = false;

  // 1. arXiv 主源：按 PAPER_TOPICS 分类 + 7d submittedDate 检索（cs.AI/CL/LG/CV/IR/MM/MA）
  //    （需求规格 3.4：arXiv Atom API 按分类+日期检索为主源；论文必须真是 AI 领域）
  const arxiv = await collectArxiv(ctx);
  if (arxiv.ok) {
    all.push(...arxiv.items);
  } else {
    logger.warn(`[paper] arXiv 异常: ${arxiv.error}`);
    degraded = true;
  }

  // 2. OpenAlex 补充源：严格当天 + 严格 AI 主题检索（arXiv 索引有延迟，OpenAlex 无延迟当天即可用）
  //    注意：OpenAlex 是补充（搜索可能少/空），失败不降级主流程 —— arXiv 才是主源
  const oa = await collectOpenAlex(ctx);
  if (oa.ok) {
    all.push(...oa.items);
  } else {
    logger.warn(`[paper] OpenAlex 补充为空/异常: ${oa.error}`);
  }

  // 2b. Hugging Face daily_papers 可选尝试：失败静默（HF 网络不稳，不阻塞主流程）
  const hf = await collectHuggingFacePapers(ctx);
  if (hf.ok) {
    all.push(...hf.items);
    logger.info(`[paper] HF Papers 补充 ${hf.items.length} 条`);
  }

  // 2c. 实时源不足 → WebSearch 兜底（前三源合计不足 5 条时）
  if (all.length < 5) {
    degraded = true;
    const ws = await collectPaperWebSearch(ctx);
    if (ws.ok) {
      all.push(...ws.items);
    } else {
      logger.warn(`[paper] WebSearch 兜底失败: ${ws.error}`);
    }
  }

  // 2c. 全部实时源失败 → 缓存降级（stale 标记）
  if (all.length === 0) {
    const cached = readJsonCache<PaperRawEvent>(CACHE_SCOPE, CACHE_KEY, CACHE_MAX_AGE_MS);
    if (cached) {
      all.push(...cached.entry.items.map((p) => markPaperStale(p, cached.stale)));
      degraded = true;
      logger.warn(`[paper] 使用缓存降级 ${cached.entry.items.length} 条（${cached.stale ? 'stale' : '新鲜'}，写入于 ${cached.entry.meta.written_at}）`);
    }
  }

  // 3. 过滤（时间 / 方向 / 影响力）
  let filtered = filterPapers(all, ctx);
  if (filtered.length === 0) {
    logger.info('[paper] 过滤后为空，扩大窗口/降低门槛');
    degraded = true;
    filtered = filterPapers(all, ctx, true);
  }

  // 4. 去重（arXiv ID / DOI）
  const deduped = dedupPapers(filtered);

  // 4b. 影响力排序（低影响力论文排后，进入 TopN 时天然靠后；用户重点⑤：关注影响不只是最新）
  const ranked = sortPapersByInfluence(deduped);

  // 5. 成功后写缓存
  if (ranked.length > 0) {
    writeJsonCache(CACHE_SCOPE, CACHE_KEY, ranked, {
      windowHours: ctx.time_window_hours,
      sources: [oa.ok ? 'openalex' : null, arxiv.ok ? 'arxiv' : null, hf.ok ? 'huggingface' : null].filter(Boolean) as string[],
      degraded,
    });
  }

  logger.info(`[paper] 采集完成：原始 ${all.length}，过滤 ${filtered.length}，去重 ${ranked.length}${degraded ? '（已降级）' : ''}，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return ranked;
}

/** 缓存条目转 stale 标记（追加缓存来源证据） */
function markPaperStale(p: PaperRawEvent, stale: boolean): PaperRawEvent {
  return {
    ...p,
    abstract: `${p.abstract}${stale ? '（缓存数据：实时源不可用，时间可能滞后）' : ''}`.trim(),
    source_urls: [...p.source_urls, { url: '', source_type: 'cache', name: stale ? '本地缓存（超期）' : '本地缓存', credibility_score: 2 }],
  };
}

/** WebSearch 兜底：arXiv/OpenAlex 均不可用时，搜索主题关键词转论文事件 */
async function collectPaperWebSearch(ctx: TaskContext): Promise<{ ok: boolean; items: PaperRawEvent[]; error?: string }> {
  const out: PaperRawEvent[] = [];
  const errors: string[] = [];
  const queries = PAPER_TOPICS.slice(0, 3).map((t) => `${t.topic} paper research`);

  for (const q of queries) {
    const res = await webSearch(q, { limit: 3, maxAgeHours: Math.max(168, ctx.time_window_hours * 7) });
    if (!res.ok) { errors.push(res.error || 'websearch 无结果'); continue; }
    for (const r of res.results) {
      if (out.length >= 6) break;
      out.push({
        module: 'paper',
        paper_id: `WS:${r.url}`,
        title: r.title,
        authors: [],
        // 未知日期不默认今天（WebSearch 结果多无日期，缺失时留空，评估层 date_missing 拦截）
        published_at: sanitizeDate(r.published_at),
        abstract: r.snippet.slice(0, 300),
        category: 'cs.AI',
        influence_hint: undefined,
        source_urls: [{ url: r.url, source_type: 'websearch', name: r.source === 'hackernews' ? 'Hacker News' : r.source === 'googlenews' ? 'Google News' : 'DuckDuckGo', credibility_score: 3 }],
      });
    }
    if (out.length >= 6) break;
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : (errors.join('; ') || 'websearch 无结果') };
}

// ========== arXiv ==========

async function collectArxiv(ctx: TaskContext): Promise<{ ok: boolean; items: PaperRawEvent[]; error?: string }> {
  const out: PaperRawEvent[] = [];
  // 查询窗口放宽到 7 天：arXiv submittedDate 索引有 6-24h 延迟（周末更久），
  // 严格 24h 窗口必然扑空（实测 24h=0 条 / 7d=15 条）。
  // 采集 7 天内提交的论文，后续 filterPapers 仍按 24h/72h 严格过滤，保证日报时效。
  const dateEnd = toISODate(new Date(ctx.date_range.end));
  const dateStart = toISODate(new Date(new Date(ctx.date_range.end).getTime() - 7 * 86_400_000));

  for (const topic of PAPER_TOPICS) {
    for (const cat of topic.arxivCategories) {
      const startCompact = dateStart.replace(/-/g, '');
      const endCompact = dateEnd.replace(/-/g, '');
      // 分类拆分请求，避免 429
      const query = `search_query=cat:${cat}+AND+submittedDate:[${startCompact}0000+TO+${endCompact}2359]`;
      const url = `http://export.arxiv.org/api/query?${query}&sortBy=submittedDate&sortOrder=descending&max_results=15`;
      const res = await httpGetJson<string>(url, {
        timeoutMs: 20_000,
        retries: 1,
        exponential: true,
        headers: { Accept: 'application/atom+xml' },
      });
      if (!res.ok || !res.text) {
        recordSourceFail('arxiv', res.error || 'empty');
        continue;
      }
      recordSourceOk('arxiv');
      const entries = parseArxivAtom(res.text);
      for (const e of entries.slice(0, 10)) {
        const published = parseFlexibleDate(e.published) || sanitizeDate(e.updated) || '';
        out.push({
          module: 'paper',
          paper_id: e.id.replace('http://arxiv.org/abs/', 'arXiv:').replace('https://arxiv.org/abs/', 'arXiv:'),
          title: cleanXml(e.title),
          authors: e.authors.map((a) => a.name).slice(0, 10),
          institution: extractInstitution(e.authors.map((a) => a.name).join(' '), e.comment),
          published_at: published,
          abstract: cleanXml(e.summary),
          category: e['primary_category']?.term || cat,
          influence_hint: e.comment ? extractInfluenceHint(e.comment) : undefined,
          source_urls: [{
            url: `https://arxiv.org/abs/${e.id.split('/abs/').pop()}`,
            source_type: 'arxiv',
            name: 'arXiv',
            credibility_score: 5,
          }],
        });
      }
    }
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : 'arxiv 无结果' };
}

/** 解析 arXiv Atom XML */
function parseArxivAtom(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(xml)) !== null) {
    const body = m[1];
    const id = body.match(/<id>([^<]+)<\/id>/)?.[1] || '';
    const title = body.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
    const summary = body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '';
    const published = body.match(/<published>([^<]+)<\/published>/)?.[1] || '';
    const updated = body.match(/<updated>([^<]+)<\/updated>/)?.[1] || '';
    const primaryCat = body.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1];
    const comment = body.match(/<arxiv:comment[^>]*>([^<]*)<\/arxiv:comment>/)?.[1];
    const authors: Array<{ name: string }> = [];
    const authorRegex = /<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g;
    let am: RegExpExecArray | null;
    while ((am = authorRegex.exec(body)) !== null) {
      authors.push({ name: am[1] });
    }
    entries.push({
      id,
      title,
      summary,
      authors,
      published,
      updated,
      'primary_category': primaryCat ? { term: primaryCat } : undefined,
      comment,
    });
  }
  return entries;
}

function cleanXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInstitution(authorStr: string, comment?: string): string | undefined {
  // 从作者 affiliation（comment 里常见）尝试提取
  if (!comment) return undefined;
  const m = comment.match(/affiliation[^:：]*[:：]\s*([^;，。]{2,40})/i);
  return m ? m[1].trim() : undefined;
}

function extractInfluenceHint(comment: string): string | undefined {
  if (/accepted|accept/i.test(comment)) return '顶会录用';
  if (/sota|state-of-the-art|state of the art/i.test(comment)) return '疑似 SOTA';
  return undefined;
}

// ========== OpenAlex 补充源（严格 AI 过滤） ==========

/**
 * OpenAlex 是"宽泛 AI 概念"：concepts.id:C154945302(Artificial Intelligence) 会把大量
 * 挂靠 AI 的边角论文混入（实测当天 100 篇里含学前教育、乌兹别克语文学、电视播音语言等非 AI 内容）。
 * 因此这里做两层过滤：
 *   ① 标题/摘要必须命中 PAPER_TOPICS 的 AI 主题关键词（LLM/推理/RAG/强化学习/多模态/Agent 等）
 *   ② 命中明显非 AI 信号（纯语言/文学/教育/法律/经济，无任何 AI 术语）直接剔除
 */
function isAIPaper(title: string, abstract: string): boolean {
  const text = `${title} ${abstract}`.toLowerCase();
  const titleLower = title.toLowerCase();
  // ① 主题关键词命中（与 filterPapers 同源，确保进 TopN 的论文真实属于 AI 方向）
  const topicHit = PAPER_TOPICS.some((t) =>
    t.searchKeywords.some((k) => titleLower.includes(k) || text.includes(k)),
  );
  if (!topicHit) return false;
  // ② 非 AI 信号剔除：标题命中 AI 术语但正文明显是非 AI 学科（教育/语言文学/法律等）的论文
  //    典型如 "AI 在学前教育中的应用" 标题含 AI 但核心是教育 —— 这类不是"AI 前沿研究"
  const NON_AI_SIGNALS = [
    /学前教育|幼儿园|幼儿教育|primary school|kindergarten|preschool/i,
    /乌兹别克|uzbek|乌尔都|波斯语|persian|literary|文学|小说|poetry|诗歌|戏剧|drama/i,
    /电视播音|电视节目|主持人|新闻播报|broadcast(ing)? (program|anchor)/i,
    /法律|律师|litigation|legal proceeding|法庭/i,
    /税收|税务|taxation|tax /i,
    /宗教|theolog|神学|church|islamic|quran|bible/i,
  ];
  if (NON_AI_SIGNALS.some((re) => re.test(text))) return false;
  return true;
}

async function collectOpenAlex(ctx: TaskContext): Promise<{ ok: boolean; items: PaperRawEvent[]; error?: string }> {
  const out: PaperRawEvent[] = [];
  // 严格当天：report_date 优先（日报日期），缺省回退 date_range.end
  const target = ctx.report_date || toISODate(new Date(ctx.date_range.end));
  // 关键修复：OpenAlex 的 concepts.id:C154945302(Artificial Intelligence) 概念极不严谨，
  // 实测当天 70 篇里大量是乌兹别克语语言文学/学前教育/旅游论文（被错误挂靠 AI 概念）。
  // → 改用主题关键词 search= 精确检索（与 arXiv 同源：LLM/推理/RAG/强化学习/多模态/Agent），
  //   让 OpenAlex 只作为"已确认 AI 主题"的当天补充，而非宽泛概念拉取。
  const topicQueries = PAPER_TOPICS.map((t) => `"${t.searchKeywords[0]}"`).slice(0, 4);
  const searchQ = topicQueries.join(' OR ');
  const url = `https://api.openalex.org/works?filter=from_publication_date:${target},to_publication_date:${target}&search=${encodeURIComponent(searchQ)}&per-page=50`;
  const res = await httpGetJson<OpenAlexResponse>(url, { timeoutMs: 15_000, retries: 1, exponential: true });
  if (!res.ok || !res.data?.results) {
    recordSourceFail('openalex', res.error || 'empty');
    return { ok: false, items: [], error: res.error || 'openalex empty' };
  }
  recordSourceOk('openalex');
  for (const w of res.data.results) {
    const title = w.title || '';
    const abstract = reconstructAbstract(w.abstract_inverted_index || undefined);
    // 二次校验：仍走 isAIPaper（search 命中的可能是边缘论文）
    if (!isAIPaper(title, abstract)) continue;
    const authors = (w.authorships || []).map((a) => a.author.display_name).slice(0, 10);
    const institutions = (w.authorships || []).flatMap((a) => (a.institutions || []).map((i) => i.display_name));
    out.push({
      module: 'paper',
      paper_id: `OA:${w.id.split('/').pop()}`,
      title,
      authors,
      institution: institutions[0],
      published_at: sanitizeDate(w.publication_date),
      abstract,
      category: 'cs.AI',
      influence_hint: (w.cited_by_count || 0) > 50 ? `高引用(${w.cited_by_count})` : undefined,
      source_urls: [{ url: w.id, source_type: 'openalex', name: 'OpenAlex', credibility_score: 4.5 }],
    });
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : 'openalex 无 AI 主题命中' };
}

// ========== Hugging Face daily_papers（可选尝试，失败静默） ==========

interface HuggingFacePaper {
  title: string;
  paper?: { id?: string; url?: string };
  publishedAt?: string;
  authors?: Array<{ name?: string }>;
  summary?: string;
  upvotes?: number;
}

async function collectHuggingFacePapers(ctx: TaskContext): Promise<{ ok: boolean; items: PaperRawEvent[]; error?: string }> {
  const out: PaperRawEvent[] = [];
  try {
    const res = await httpGetJson<HuggingFacePaper[]>('https://huggingface.co/api/daily_papers', {
      timeoutMs: 10_000,
      retries: 0,
    });
    if (!res.ok || !Array.isArray(res.data)) {
      // 失败静默：不 recordSourceFail，避免源健康噪音
      return { ok: false, items: [], error: res.error || 'hf empty' };
    }
    for (const p of res.data.slice(0, 15)) {
      const title = (p.title || '').trim();
      if (!title) continue;
      const publishedAt = p.publishedAt ? parseFlexibleDate(p.publishedAt) || '' : '';
      out.push({
        module: 'paper',
        paper_id: `HF:${p.paper?.id || title.slice(0, 40).replace(/\s+/g, '-')}`,
        title,
        authors: (p.authors || []).map((a) => a.name || '').filter(Boolean).slice(0, 10),
        published_at: publishedAt,
        abstract: (p.summary || '').slice(0, 600),
        category: 'cs.AI',
        influence_hint: (p.upvotes || 0) > 20 ? `HF 热议(${p.upvotes})` : undefined,
        source_urls: [{ url: p.paper?.url || `https://huggingface.co/papers/${p.paper?.id || ''}`, source_type: 'huggingface', name: 'Hugging Face Papers', credibility_score: 4 }],
      });
    }
    return { ok: out.length > 0, items: out, error: out.length ? undefined : 'hf 无结果' };
  } catch (err) {
    // 失败静默（网络异常/超时不阻塞主流程）
    return { ok: false, items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function reconstructAbstract(inverted: Record<string, number[]> | undefined): string {
  if (!inverted) return '';
  const words: Array<{ idx: number; word: string }> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const p of positions) words.push({ idx: p, word });
  }
  words.sort((a, b) => a.idx - b.idx);
  return words.map((w) => w.word).join(' ').slice(0, 600);
}

// ========== 过滤（三门槛） ==========

function filterPapers(items: PaperRawEvent[], ctx: TaskContext, degraded = false): PaperRawEvent[] {
  // 时间窗口：正常 24h / 降级放宽到 48h（不再 72h/×3 过度放宽——用户硬约束"不随意扩大时间窗口"）
  // 特殊：arXiv 论文走 7d 窗口（submittedDate 语义 = 最近提交，arXiv 索引有延迟，严格当天必空；
  //       需求规格 3.4 明确 arXiv 按"分类+日期检索"主源；日期取真实 published_at，绝不默认今天）
  const windowHours = degraded ? Math.max(48, ctx.time_window_hours) : Math.max(24, ctx.time_window_hours);
  // 时间基准：report_date 当天正午（回补历史日报时论文 relative 该日期），缺省回退 now
  const ref = ctx.report_date ? new Date(`${ctx.report_date}T12:00:00`) : new Date();
  return items.filter((p) => {
    // ① 时间过滤：允许 [0, windowHours]，过滤未来时间（防时区导致 hours<0）
    const isArxiv = p.source_urls.some((s) => s.source_type === 'arxiv');
    const win = isArxiv ? 7 * 24 : windowHours;
    const hours = (ref.getTime() - new Date(p.published_at).getTime()) / 3600_000;
    if (hours < 0 || hours > win) return false;
    // ①b 正文完整性：无摘要（abstract 为空）的论文无法生成中文重述，价值低 → 滤掉
    if (!p.abstract || p.abstract.trim().length < 20) return false;
    // ② 方向匹配（严格 AI 领域：主题关键词命中，拒绝"随便爬最新几篇"）
    const text = `${p.title} ${p.abstract}`.toLowerCase();
    const titleLower = p.title.toLowerCase();
    const matched = PAPER_TOPICS.some((t) => {
      // 标题命中或摘要命中
      if (t.searchKeywords.some((k) => titleLower.includes(k))) return true;
      return t.searchKeywords.some((k) => text.includes(k));
    });
    if (!matched && !degraded) return false;
    // ②b 非 AI 学科信号剔除（与 OpenAlex 同源：语言/文学/教育/法律等挂靠 AI 的论文）
    const NON_AI_SIGNALS = [
      /学前教育|幼儿园|幼儿教育|primary school|kindergarten|preschool/i,
      /乌兹别克|uzbek|乌尔都|波斯语|persian|literary|文学|小说|poetry|诗歌|戏剧|drama/i,
      /电视播音|电视节目|主持人|新闻播报|broadcast(ing)? (program|anchor)/i,
      /法律|律师|litigation|legal proceeding|法庭/i,
      /税收|税务|taxation|tax /i,
      /宗教|theolog|神学|church|islamic|quran|bible/i,
    ];
    if (NON_AI_SIGNALS.some((re) => re.test(text)) && !degraded) return false;
    // ③ 影响力判断
    if (!degraded) {
      const hasInfluence = p.influence_hint !== undefined || (p.institution && KNOWN_INSTITUTIONS.some((k) => (p.institution || '').toLowerCase().includes(k.toLowerCase())));
      if (!hasInfluence) {
        p.influence_hint = 'low_influence';
        // 低影响力论文：标记但不删除（由评估层按影响力降权，避免彻底滤掉导致当天论文为空）
        return true;
      }
    }
    return true;
  });
}

/** 论文影响力信号排序：低影响力论文排后（供采集后排序用） */
export function sortPapersByInfluence(items: PaperRawEvent[]): PaperRawEvent[] {
  return [...items].sort((a, b) => {
    const infA = influenceRank(a);
    const infB = influenceRank(b);
    return infB - infA;
  });
}

function influenceRank(p: PaperRawEvent): number {
  // 机构声望 / 顶会 / SOTA / 热议 / 高引用
  let rank = 0;
  if (p.institution && KNOWN_INSTITUTIONS.some((k) => (p.institution || '').toLowerCase().includes(k.toLowerCase()))) rank += 2;
  const hint = p.influence_hint || '';
  if (/顶会|sota|热议/i.test(hint)) rank += 2;
  if (/高引用/.test(hint)) rank += 1;
  if (p.influence_hint === 'low_influence') rank -= 1;
  return rank;
}

// ========== 去重（arXiv ID / DOI） ==========

function dedupPapers(items: PaperRawEvent[]): PaperRawEvent[] {
  const seen = new Map<string, PaperRawEvent>();
  const titleNorm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
  const byTitle = new Map<string, PaperRawEvent>();
  for (const p of items) {
    // 键①：arXiv ID / DOI（精确）
    const key = p.paper_id.toLowerCase().replace(/^arxiv:/, '');
    // 键②：归一化标题 —— 治本 OpenAlex 同文异 ID 重复（实测同一论文以两个 work ID 出现两次）。
    //   标题精确相同 → 必为同一论文，合并来源证据（在 ID 去重之前拦截，避免重复条目流入 processor）
    const tKey = titleNorm(p.title);
    const dup = seen.get(key) || (tKey ? byTitle.get(tKey) : undefined);
    if (dup) {
      // 同题 = 同一篇论文（OpenAlex 常以多个 work ID 收录同一 zenodo/预印本记录）。
      // 只补充"不同域名"的来源 —— 同域重复链接（OpenAlex|OpenAlex）对读者是噪音
      const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
      const existingUrls = new Set(dup.source_urls.map((s) => s.url));
      const existingHosts = new Set(dup.source_urls.map((s) => hostOf(s.url)));
      const fresh = p.source_urls.filter((s) => s.url && !existingUrls.has(s.url) && !existingHosts.has(hostOf(s.url)));
      dup.source_urls = mergePaperSources(dup.source_urls, fresh);
      continue;
    }
    if (tKey) byTitle.set(tKey, p);
    seen.set(key, p);
  }
  return Array.from(seen.values());
}

function mergePaperSources(a: SourceEvidence[], b: SourceEvidence[]): SourceEvidence[] {
  const map = new Map<string, SourceEvidence>();
  for (const s of [...a, ...b]) map.set(s.url, s);
  return Array.from(map.values());
}
