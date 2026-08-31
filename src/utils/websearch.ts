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
  source: 'duckduckgo' | 'hackernews' | 'googlenews';
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

  // ③ Google News RSS 查询通道（免费稳定、覆盖长尾新闻源 —— 2026-08-31 批2 任务④：
  //    提升 Reflection 补证命中率；HN/DDG 免费档对"企业/融资/产品发布"类事件覆盖差）
  const gn = await searchGoogleNews(query, opts.maxAgeHours);
  if (gn.ok && gn.results.length > 0) {
    return { ok: true, results: gn.results.slice(0, limit) };
  }
  if (!gn.ok) errors.push(`googlenews: ${gn.error}`);
  if (gn.ok && gn.results.length === 0) errors.push('googlenews: 无结果');

  return { ok: false, results: [], error: errors.join('; ') || 'websearch 无结果' };
}

/** Google News RSS 搜索（news.google.com/rss/search，无需 key）。条目为新闻聚合，时效性强。 */
async function searchGoogleNews(query: string, maxAgeHours?: number): Promise<{ ok: boolean; results: WebSearchResult[]; error?: string }> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:7d`)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await httpGetJson<unknown>(url, { timeoutMs: 8000, retries: 0 });
    if (!res.ok || !res.text) return { ok: false, results: [], error: res.error || 'empty' };
    const results: WebSearchResult[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(res.text)) !== null) {
      const block = m[1];
      const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 200);
      // Google News 的链接是重定向 URL（news.google.com/rss/articles/...），保留原始链接供溯源
      const link = (block.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || '';
      if (!title || !link) continue;
      // 时间：RSS pubDate（RFC822）→ 取年月日
      const rawDate = (block.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i) || [])[1] || '';
      let publishedAt: string | undefined;
      if (rawDate) {
        const dm = rawDate.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/);
        if (dm) {
          const MONTH: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
          publishedAt = `${dm[3]}-${MONTH[dm[2]]}-${String(+dm[1]).padStart(2, '0')}`;
        }
      }
      // 按 maxAgeHours 过滤（默认 24h 放宽到 7 天）
      if (publishedAt && maxAgeHours) {
        const ageHours = (Date.now() - new Date(`${publishedAt}T00:00:00`).getTime()) / 3600_000;
        if (ageHours > maxAgeHours || ageHours < 0) continue;
      }
      const snippet = stripHtml((block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '').slice(0, 300);
      results.push({ title, url: link, snippet, source: 'googlenews', published_at: publishedAt });
      if (results.length >= 10) break;
    }
    return { ok: results.length > 0, results, error: results.length ? undefined : 'googlenews 无结果' };
  } catch (err) {
    logger.warn(`[websearch] googlenews 失败: ${err instanceof Error ? err.message : err}`);
    return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) };
  }
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
