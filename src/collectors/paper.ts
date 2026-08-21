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

  // 1. arXiv 主源（按分类）
  const arxiv = await collectArxiv(ctx);
  if (arxiv.ok) {
    all.push(...arxiv.items);
  } else {
    logger.warn(`[paper] arXiv 异常: ${arxiv.error}`);
    degraded = true;
  }

  // 2. OpenAlex 兜底/补全
  if (all.length < 10) {
    const oa = await collectOpenAlex(ctx);
    if (oa.ok) {
      all.push(...oa.items);
    } else {
      logger.warn(`[paper] OpenAlex 异常: ${oa.error}`);
    }
  }

  // 2b. 实时源不足 → WebSearch 兜底（arXiv/OpenAlex 均失败时）
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
      sources: arxiv.ok ? ['arxiv'] : (all.length > 0 ? ['openalex', 'websearch'] : []),
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
  const dateStart = toISODate(new Date(ctx.date_range.start));
  const dateEnd = toISODate(new Date(ctx.date_range.end));

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

// ========== OpenAlex 兜底 ==========

async function collectOpenAlex(ctx: TaskContext): Promise<{ ok: boolean; items: PaperRawEvent[]; error?: string }> {
  const out: PaperRawEvent[] = [];
  const dateStart = toISODate(new Date(ctx.date_range.start));
  const dateEnd = toISODate(new Date(ctx.date_range.end));
  // AI 概念 ID（C154945302 = Artificial Intelligence）
  const url = `https://api.openalex.org/works?filter=publication_date:${dateStart},publication_date:${dateEnd},concepts.id:C154945302&sort=cited_by_count:desc&per-page=20`;
  const res = await httpGetJson<OpenAlexResponse>(url, { timeoutMs: 15_000, retries: 1, exponential: true });
  if (!res.ok || !res.data?.results) {
    recordSourceFail('openalex', res.error || 'empty');
    return { ok: false, items: [], error: res.error || 'openalex empty' };
  }
  recordSourceOk('openalex');
  for (const w of res.data.results.slice(0, 15)) {
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
  const windowHours = degraded ? Math.max(72, ctx.time_window_hours * 3) : ctx.time_window_hours;
  return items.filter((p) => {
    // ① 时间过滤
    const hours = (Date.now() - new Date(p.published_at).getTime()) / 3600_000;
    if (hours > windowHours) return false;
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
