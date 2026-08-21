/**
 * WebSearch 兜底客户端（Sheet08 采集层降级链末端）
 *
 * 免 Key 公开源（按优先级，Hacker News 搜索能力 > DuckDuckGo 即时答案）：
 *  ① Hacker News Algolia API（https://hn.algolia.com/api/v1）—— JSON，无需 key，英文技术动态丰富
 *  ② DuckDuckGo Instant Answer API（https://api.duckduckgo.com）—— JSON，无需 key，覆盖面有限
 *  ③ 以上均失败 → 返回 ok=false，由调用方决定是否用缓存
 */

import { httpGetJson } from './http.js';
import { logger } from './logger.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: 'duckduckgo' | 'hackernews';
  published_at?: string; // 可选
}

interface DDGRelatedTopic {
  Text?: string;
  FirstURL?: string;
  Result?: string;
}

interface DDGResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<DDGRelatedTopic | { Topics?: DDGRelatedTopic[] }>;
}

interface HNItem {
  title?: string;
  url?: string;
  story_text?: string;
  objectID?: string;
  created_at?: string;
}

interface HNResponse {
  hits?: HNItem[];
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** 主入口：按优先级依次尝试各源，返回最多 limit 条结果 */
export async function webSearch(query: string, opts: { limit?: number; maxAgeHours?: number } = {}): Promise<{ ok: boolean; results: WebSearchResult[]; error?: string }> {
  const limit = opts.limit ?? 5;
  const errors: string[] = [];

  // ① Hacker News Algolia（搜索能力强、响应快）
  const hn = await searchHackerNews(query, opts.maxAgeHours);
  if (hn.ok && hn.results.length > 0) {
    return { ok: true, results: hn.results.slice(0, limit) };
  }
  if (!hn.ok) errors.push(`hackernews: ${hn.error}`);
  if (hn.ok && hn.results.length === 0) errors.push('hackernews: 无结果');

  // ② DuckDuckGo Instant Answer（覆盖率有限，作为补充）
  const ddg = await searchDuckDuckGo(query);
  if (ddg.ok && ddg.results.length > 0) {
    return { ok: true, results: ddg.results.slice(0, limit) };
  }
  if (!ddg.ok) errors.push(`duckduckgo: ${ddg.error}`);
  if (ddg.ok && ddg.results.length === 0) errors.push('duckduckgo: 无结果');

  return { ok: false, results: [], error: errors.join('; ') || 'websearch 无结果' };
}

async function searchDuckDuckGo(query: string): Promise<{ ok: boolean; results: WebSearchResult[]; error?: string }> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await httpGetJson<DDGResponse>(url, { timeoutMs: 5000, retries: 0 });
    if (!res.ok || !res.data) return { ok: false, results: [], error: res.error || 'empty' };
    const d = res.data;
    const results: WebSearchResult[] = [];
    if (d.AbstractText && d.AbstractURL) {
      results.push({ title: d.Heading || query, url: d.AbstractURL, snippet: d.AbstractText.slice(0, 300), source: 'duckduckgo' });
    }
    for (const t of d.RelatedTopics || []) {
      const topic: DDGRelatedTopic[] = 'Topics' in t && Array.isArray(t.Topics) ? t.Topics : [t as DDGRelatedTopic];
      for (const sub of topic) {
        if (!sub.Text || !sub.FirstURL) continue;
        results.push({ title: sub.Text.split(' - ')[0].slice(0, 200), url: sub.FirstURL, snippet: stripHtml(sub.Text).slice(0, 300), source: 'duckduckgo' });
        if (results.length >= 8) break;
      }
      if (results.length >= 8) break;
    }
    return { ok: results.length > 0, results, error: results.length ? undefined : 'duckduckgo 无结果' };
  } catch (err) {
    return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function searchHackerNews(query: string, maxAgeHours?: number): Promise<{ ok: boolean; results: WebSearchResult[]; error?: string }> {
  try {
    const numeric = maxAgeHours ?? 24;
    const fromTs = Math.floor(Date.now() / 1000) - numeric * 3600;
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i>${fromTs}&hitsPerPage=10`;
    const res = await httpGetJson<HNResponse>(url, { timeoutMs: 10_000, retries: 0 });
    if (!res.ok || !res.data) return { ok: false, results: [], error: res.error || 'empty' };
    const results: WebSearchResult[] = (res.data.hits || [])
      .filter((h) => h.title && (h.url || h.objectID))
      .map((h) => ({
        title: h.title!.slice(0, 200),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        snippet: stripHtml(h.story_text || h.title || '').slice(0, 300),
        source: 'hackernews' as const,
        published_at: h.created_at,
      }));
    return { ok: results.length > 0, results, error: results.length ? undefined : 'hackernews 无结果' };
  } catch (err) {
    logger.warn(`[websearch] hackernews 失败: ${err instanceof Error ? err.message : err}`);
    return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) };
  }
}
