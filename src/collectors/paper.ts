/**
 * 学术研究采集（Sheet03）
 * 主源：arXiv API（按分类拆分）；可选：OpenReview / Semantic Scholar；兜底：OpenAlex
 * 三门槛过滤（Sheet03 R26-R30）：时间 / 方向匹配 / 影响力
 */

import type { PaperRawEvent, SourceEvidence, TaskContext } from '../types/events.js';
import { PAPER_TOPICS, KNOWN_INSTITUTIONS } from '../config/constants.js';
import { httpGetJson } from '../utils/http.js';
import { webSearch } from '../utils/websearch.js';
import { writeJsonCache, readJsonCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { recordSourceOk, recordSourceFail } from '../db/index.js';
import { toISODate, parseFlexibleDate } from '../utils/normalize.js';

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

  // 1. OpenAlex 主源：无条件先采，严格当天（report_date 或 date_range.end 当天）
  //    OpenAlex 无索引延迟（实测当天即 132 篇），是"当天新论文"的可靠来源；
  //    arXiv submittedDate 有 6-24h 索引延迟（周末更久），当天查询必然扑空。
  const oa = await collectOpenAlex(ctx);
  if (oa.ok) {
    all.push(...oa.items);
  } else {
    logger.warn(`[paper] OpenAlex 异常: ${oa.error}`);
    degraded = true;
  }

  // 2. arXiv 补充源：7d submittedDate 拉近期提交（索引延迟内可回补），filterPapers 仍严格当天过滤
  const arxiv = await collectArxiv(ctx);
  if (arxiv.ok) {
    all.push(...arxiv.items);
  } else {
    logger.warn(`[paper] arXiv 异常: ${arxiv.error}`);
    degraded = true;
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

  // 5. 成功后写缓存
  if (deduped.length > 0) {
    writeJsonCache(CACHE_SCOPE, CACHE_KEY, deduped, {
      windowHours: ctx.time_window_hours,
      sources: [oa.ok ? 'openalex' : null, arxiv.ok ? 'arxiv' : null, hf.ok ? 'huggingface' : null].filter(Boolean) as string[],
      degraded,
    });
  }

  logger.info(`[paper] 采集完成：原始 ${all.length}，过滤 ${filtered.length}，去重 ${deduped.length}${degraded ? '（已降级）' : ''}，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return deduped;
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
        published_at: r.published_at || toISODate(new Date()),
        abstract: r.snippet.slice(0, 300),
        category: 'cs.AI',
        influence_hint: undefined,
        source_urls: [{ url: r.url, source_type: 'websearch', name: r.source === 'hackernews' ? 'Hacker News' : 'DuckDuckGo', credibility_score: 3 }],
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
        const published = parseFlexibleDate(e.published) || toISODate(new Date());
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

// ========== OpenAlex 主源（当天） ==========

async function collectOpenAlex(ctx: TaskContext): Promise<{ ok: boolean; items: PaperRawEvent[]; error?: string }> {
  const out: PaperRawEvent[] = [];
  // 严格当天：report_date 优先（日报日期），缺省回退 date_range.end
  const target = ctx.report_date || toISODate(new Date(ctx.date_range.end));
  // AI 概念 ID（C154945302 = Artificial Intelligence）
  // 注意：当天论文引用数几乎全为 0，按 cited_by_count 排序无意义且会把 AI 主题论文挤出 top-20，
  // 因此不排序、per-page=100 全量拉取，交给 filterPapers 做主题过滤（实测 100 篇中含 26 篇主题命中）
  const url = `https://api.openalex.org/works?filter=from_publication_date:${target},to_publication_date:${target},concepts.id:C154945302&per-page=100`;
  const res = await httpGetJson<OpenAlexResponse>(url, { timeoutMs: 15_000, retries: 1, exponential: true });
  if (!res.ok || !res.data?.results) {
    recordSourceFail('openalex', res.error || 'empty');
    return { ok: false, items: [], error: res.error || 'openalex empty' };
  }
  recordSourceOk('openalex');
  for (const w of res.data.results) {
    const authors = (w.authorships || []).map((a) => a.author.display_name).slice(0, 10);
    const institutions = (w.authorships || []).flatMap((a) => (a.institutions || []).map((i) => i.display_name));
    out.push({
      module: 'paper',
      paper_id: `OA:${w.id.split('/').pop()}`,
      title: w.title || '',
      authors,
      institution: institutions[0],
      published_at: parseFlexibleDate(w.publication_date || '') || toISODate(new Date()),
      abstract: reconstructAbstract(w.abstract_inverted_index || undefined),
      category: 'cs.AI',
      influence_hint: (w.cited_by_count || 0) > 50 ? `高引用(${w.cited_by_count})` : undefined,
      source_urls: [{ url: w.id, source_type: 'openalex', name: 'OpenAlex', credibility_score: 4.5 }],
    });
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : 'openalex 无结果' };
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
      const publishedAt = p.publishedAt ? parseFlexibleDate(p.publishedAt) || toISODate(new Date()) : toISODate(new Date());
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
  // OpenAlex 是当天源（published_at=报告日期）天然通过；arXiv 旧论文会被正确滤掉
  const windowHours = degraded ? Math.max(48, ctx.time_window_hours) : Math.max(24, ctx.time_window_hours);
  // 时间基准：report_date 当天正午（回补历史日报时论文 relative 该日期），缺省回退 now
  const ref = ctx.report_date ? new Date(`${ctx.report_date}T12:00:00`) : new Date();
  return items.filter((p) => {
    // ① 时间过滤：允许 [0, windowHours]，过滤未来时间（防时区导致 hours<0）
    const hours = (ref.getTime() - new Date(p.published_at).getTime()) / 3600_000;
    if (hours < 0 || hours > windowHours) return false;
    // ①b 正文完整性：无摘要（abstract 为空）的论文无法生成中文重述，价值低 → 滤掉
    //     （OpenAlex 部分条目 abstract_inverted_index 为空；空摘要会导致正文渲染兜底成 low_influence 噪音）
    if (!p.abstract || p.abstract.trim().length < 20) return false;
    // ② 方向匹配
    const text = `${p.title} ${p.abstract}`.toLowerCase();
    const matched = PAPER_TOPICS.some((t) => {
      // 标题命中或摘要命中
      const titleLower = p.title.toLowerCase();
      if (t.searchKeywords.some((k) => titleLower.includes(k))) return true;
      return t.searchKeywords.some((k) => text.includes(k));
    });
    if (!matched && !degraded) return false;
    // ③ 影响力判断
    if (!degraded) {
      const hasInfluence = p.influence_hint !== undefined || (p.institution && KNOWN_INSTITUTIONS.some((k) => (p.institution || '').toLowerCase().includes(k.toLowerCase())));
      if (!hasInfluence) {
        p.influence_hint = 'low_influence';
        return true; // 保留但标记
      }
    }
    return true;
  });
}

// ========== 去重（arXiv ID / DOI） ==========

function dedupPapers(items: PaperRawEvent[]): PaperRawEvent[] {
  const seen = new Map<string, PaperRawEvent>();
  for (const p of items) {
    const key = p.paper_id.toLowerCase().replace(/^arxiv:/, '');
    if (seen.has(key)) {
      const existing = seen.get(key)!;
      existing.source_urls = mergePaperSources(existing.source_urls, p.source_urls);
    } else {
      seen.set(key, { ...p });
    }
  }
  return Array.from(seen.values());
}

function mergePaperSources(a: SourceEvidence[], b: SourceEvidence[]): SourceEvidence[] {
  const map = new Map<string, SourceEvidence>();
  for (const s of [...a, ...b]) map.set(s.url, s);
  return Array.from(map.values());
}
