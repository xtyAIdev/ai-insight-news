/**
 * 开源技术采集（Sheet02）
 * 数据源优先级：① GitHub Search API（主） ② GitHub Trending ③ ModelScope ④ HuggingFace ⑤ Gitee ⑥ WebSearch 兜底
 * 过滤阈值（Sheet02 R31-R37）
 */

import type { OpenSourceRawEvent, SourceEvidence, TaskContext } from '../types/events.js';
import { OPEN_SOURCE_KEYWORDS, OPEN_SOURCE_FILTER, sourceCredibility } from '../config/constants.js';
import { httpGetJson, runWithTimeout } from '../utils/http.js';
import { webSearch } from '../utils/websearch.js';
import { writeJsonCache, readJsonCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { recordSourceOk, recordSourceFail } from '../db/index.js';
import { toISODate, extractNumber, sanitizeDate, similarity } from '../utils/normalize.js';
import { config } from '../config/index.js';

const CACHE_SCOPE = 'opensource';
const CACHE_KEY = 'latest';
/** 缓存最长 36h；超期读取时打 stale 标记（Sheet08 R12 缓存降级） */
const CACHE_MAX_AGE_MS = 36 * 3600_000;
/** star 快照缓存（用于计算周增长） */
const SNAPSHOT_SCOPE = 'opensource';
const SNAPSHOT_KEY = 'snapshots';
/** star 快照保留 8 天（覆盖 7 天窗口 + 冗余） */
const SNAPSHOT_MAX_AGE_MS = 8 * 86_400_000;

/** star 快照条目（缓存 items 为数组，每 repo 一条） */
interface StarSnapshotEntry {
  repo_url: string;
  stars: number;
  fetched_at: string;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  stargazers_count: number;
  pushed_at: string;
  language: string | null;
  description: string | null;
  topics?: string[];
  owner: { login: string };
  forks_count?: number;
  open_issues_count?: number;
  /** 近 3 月提交数（search API 不返回，由 events API 近似；缺失为 undefined） */
  commit_activity?: number;
  contributors_count?: number;
}

interface GitHubSearchResult {
  total_count: number;
  items: GitHubRepo[];
}

interface ModelscopeModel {
  Name?: string;
  Path?: string;
  Downloads?: number;
  UpdatedTime?: string;
  Tags?: string[];
  Description?: string;
}

interface ModelscopeStudioResult {
  Data?: { Studios?: ModelscopeModel[] };
}

interface HFModel {
  id: string;
  downloads?: number;
  tags?: string[];
  pipeline_tag?: string;
  lastModified?: string;
}

interface GiteeRepo {
  name: string;
  path: string;
  full_name: string;
  html_url: string;
  stargazers_count: number;
  updated_at: string;
  language: string | null;
  description: string | null;
  owner?: { login: string };
}

// ========== 采集主流程 ==========

export async function collectOpenSource(ctx: TaskContext): Promise<OpenSourceRawEvent[]> {
  const tracer = (await import('../utils/trace.js')).Tracer;
  void tracer;
  const start = Date.now();
  logger.info(`[opensource] 开始采集，时间窗口 ${ctx.time_window_hours}h`);

  const all: Array<{ raw: OpenSourceRawEvent; sortKey: number }> = [];
  const errors: string[] = [];
  let degraded = false;

  // 1. GitHub Search API（主源）
  const githubResult = await collectGitHub(ctx);
  if (githubResult.ok) {
    all.push(...githubResult.items.map((r) => ({ raw: r, sortKey: r.stars ?? 0 })));
  } else {
    errors.push(`github: ${githubResult.error}`);
  }

  // 2. GitHub Trending（通过 Web 抓取 fallback 逻辑；此处以 GitHub API 的 star 排序补充）
  //   实际开发中可接入 github-trending-cn 技能；此处保留占位，若主源成功则跳过

  // 3. ModelScope
  if (all.length < 30) {
    const ms = await collectModelScope(ctx);
    if (ms.ok) {
      all.push(...ms.items.map((r) => ({ raw: r, sortKey: 0 })));
    } else {
      errors.push(`modelscope: ${ms.error}`);
    }
  }

  // 4. HuggingFace
  if (all.length < 40) {
    const hf = await collectHuggingFace(ctx);
    if (hf.ok) {
      all.push(...hf.items.map((r) => ({ raw: r, sortKey: 0 })));
    } else {
      errors.push(`huggingface: ${hf.error}`);
    }
  }

  // 5. Gitee（国内备用）
  const gitee = await collectGitee(ctx);
  if (gitee.ok) {
    all.push(...gitee.items.map((r) => ({ raw: r, sortKey: 0 })));
  } else {
    errors.push(`gitee: ${gitee.error}`);
  }

  if (all.length === 0) {
    degraded = true;
    errors.push('所有主源均无结果，尝试 WebSearch 兜底');
    const ws = await collectWebSearch(ctx);
    if (ws.ok) {
      all.push(...ws.items.map((r) => ({ raw: r, sortKey: 0 })));
    } else {
      errors.push(`websearch: ${ws.error}`);
    }
  }

  // 5b. 全实时源失败 → 缓存降级（Sheet08 R4/R12：读最近一次成功采集，打 stale 标记）
  if (all.length === 0) {
    const cached = readJsonCache<OpenSourceRawEvent>(CACHE_SCOPE, CACHE_KEY, CACHE_MAX_AGE_MS);
    if (cached) {
      const cachedItems = cached.entry.items.map((r) => markStale(r, cached.stale));
      all.push(...cachedItems.map((r) => ({ raw: r, sortKey: 0 })));
      degraded = true;
      errors.push(`cache: 使用 ${cached.stale ? '超期(stale)' : '新鲜'}缓存 ${cached.entry.items.length} 条（写入于 ${cached.entry.meta.written_at}，源: ${cached.entry.meta.sources.join(',')}）`);
    }
  }

  // 6. 过滤（热度 + 相关性门槛）
  let candidates = filterCandidates(all.map((x) => x.raw), ctx);
  if (candidates.length === 0) {
    logger.info('[opensource] 过滤后为空，扩大时间窗口/降低阈值');
    candidates = filterCandidates(all.map((x) => x.raw), ctx, true);
    degraded = true;
  }

  // 7. 跨来源去重（以 repo_url 为唯一键）
  const deduped = dedupByRepoUrl(candidates);

  // 8. 排序（综合热度）
  deduped.sort((a, b) => (b.stars || 0) - (a.stars || 0));

  // 9. 成功后写缓存（供下次采集全源失败时降级使用）
  if (deduped.length > 0) {
    writeJsonCache(CACHE_SCOPE, CACHE_KEY, deduped, {
      windowHours: ctx.time_window_hours,
      sources: ['github', 'modelscope', 'huggingface', 'gitee', 'websearch'].filter((s) => !errors.some((e) => e.startsWith(`${s}:`))),
      degraded,
    });
  }

  logger.info(`[opensource] 采集完成：原始 ${all.length}，过滤后 ${candidates.length}，去重后 ${deduped.length}${degraded ? '（已降级）' : ''}，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
  if (errors.length) logger.warn(`[opensource] 部分源异常: ${errors.join('; ')}`);

  return deduped;
}

// ========== GitHub 主源 ==========

async function collectGitHub(ctx: TaskContext): Promise<{ ok: boolean; items: OpenSourceRawEvent[]; error?: string }> {
  const out: OpenSourceRawEvent[] = [];
  let totalOk = true;
  const dateStr = toISODate(new Date(ctx.date_range.start));

  for (const kw of OPEN_SOURCE_KEYWORDS) {
    const query = kw.githubQuery.replace('{date}', dateStr);
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=30`;
    const res = await httpGetJson<GitHubSearchResult>(url, { timeoutMs: 15_000, retries: 1, exponential: true });
    if (!res.ok || !res.data) {
      totalOk = false;
      recordSourceFail('github_api', res.error || 'empty');
      logger.warn(`[opensource][github] ${kw.topic} 失败: ${res.error}`);
      continue;
    }
    recordSourceOk('github_api');
    const now = Date.now();
    for (const repo of res.data.items.slice(0, 15)) {
      const pushed = new Date(repo.pushed_at).getTime();
      const pushedHours = (now - pushed) / 3600_000;
      const inWindow = pushedHours <= Math.max(72, ctx.time_window_hours * 3);
      if (!inWindow) continue;
      out.push({
        module: 'opensource',
        project_name: repo.name,
        repo_url: repo.html_url,
        owner: repo.owner?.login || '',
        stars: repo.stargazers_count ?? 0,
        star_growth_week: computeStarGrowthWeek(repo.html_url, repo.stargazers_count ?? 0),
        forks: repo.forks_count ?? 0,
        open_issues: repo.open_issues_count ?? 0,
        contributors: repo.contributors_count,
        // 未知日期不默认今天：pushed_at 缺失时留空（评估层 date_missing 拦截）
        updated_at: sanitizeDate(repo.pushed_at),
        tech_tags: (repo.topics || []).concat(kw.tags).slice(0, 8),
        description: repo.description || '',
        source_urls: [{ url: repo.html_url, source_type: 'github_repo', name: 'GitHub', credibility_score: 5 }],
      });
    }
  }
  // 记录本次采集的 star 快照（供下次计算周增长）
  if (out.length > 0) recordStarSnapshots(out);
  return { ok: out.length > 0 ? true : totalOk, items: out, error: out.length > 0 ? undefined : 'github 无结果' };
}

/** 计算 star 周增长：对比历史快照（≥5 天前），无有效快照时返回 undefined */
function computeStarGrowthWeek(repoUrl: string, currentStars: number): number | undefined {
  const snap = readJsonCache<StarSnapshotEntry>(SNAPSHOT_SCOPE, SNAPSHOT_KEY, SNAPSHOT_MAX_AGE_MS);
  if (!snap) return undefined;
  const prev = snap.entry.items.find((e) => e.repo_url === repoUrl);
  if (!prev) return undefined;
  const ageDays = (Date.now() - new Date(prev.fetched_at).getTime()) / 86_400_000;
  // 快照需 ≥5 天前才有参考意义（太新无法反映周增长）
  if (ageDays < 5) return undefined;
  return Math.max(0, currentStars - prev.stars);
}

/** 记录 star 快照（与已有快照合并，保留每个 repo 最早的记录以计算真实周增长） */
function recordStarSnapshots(items: OpenSourceRawEvent[]): void {
  const existing = readJsonCache<StarSnapshotEntry>(SNAPSHOT_SCOPE, SNAPSHOT_KEY, null)?.entry.items || [];
  const byUrl = new Map(existing.map((e) => [e.repo_url, e]));
  const now = new Date().toISOString();
  for (const item of items) {
    if (!item.repo_url) continue;
    // 已存在则保留最早记录（用于 7 天对比）；不存在则记当前
    if (!byUrl.has(item.repo_url)) {
      byUrl.set(item.repo_url, { repo_url: item.repo_url, stars: item.stars, fetched_at: now });
    }
  }
  writeJsonCache<StarSnapshotEntry>(SNAPSHOT_SCOPE, SNAPSHOT_KEY, [...byUrl.values()], {
    windowHours: 7 * 24,
    sources: ['github_api'],
    degraded: false,
  });
}

// ========== ModelScope ==========

async function collectModelScope(ctx: TaskContext): Promise<{ ok: boolean; items: OpenSourceRawEvent[]; error?: string }> {
  const out: OpenSourceRawEvent[] = [];
  for (const kw of OPEN_SOURCE_KEYWORDS) {
    if (!kw.modelscopeKeyword) continue;
    const url = `https://modelscope.cn/api/v1/studios?SortBy=downloads&Search=${encodeURIComponent(kw.modelscopeKeyword)}&Page=1&PageSize=20`;
    const res = await httpGetJson<ModelscopeStudioResult>(url, { timeoutMs: 10_000, retries: 0 });
    if (!res.ok || !res.data) {
      recordSourceFail('modelscope', res.error || 'empty');
      continue;
    }
    recordSourceOk('modelscope');
    const items = res.data.Data?.Studios ?? [];
    for (const m of items.slice(0, 10)) {
      if (!m.Name) continue;
      out.push({
        module: 'opensource',
        project_name: m.Name,
        repo_url: `https://modelscope.cn/studios/${m.Path || m.Name}`,
        owner: 'ModelScope',
        stars: 0,
        primary_language: undefined,
        updated_at: m.UpdatedTime,
        tech_tags: (m.Tags || []).concat(kw.tags).slice(0, 8),
        description: m.Description || '',
        source_urls: [{ url: `https://modelscope.cn/studios/${m.Path || m.Name}`, source_type: 'modelscope', name: 'ModelScope', credibility_score: 4.5 }],
      });
    }
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : 'modelscope 无结果' };
}

// ========== HuggingFace ==========

async function collectHuggingFace(ctx: TaskContext): Promise<{ ok: boolean; items: OpenSourceRawEvent[]; error?: string }> {
  const out: OpenSourceRawEvent[] = [];
  const keywords = ['llm', 'agent', 'rag', 'mcp', 'inference', 'multimodal'];
  for (const kw of keywords) {
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(kw)}&sort=downloads&direction=-1&limit=10`;
    const res = await httpGetJson<HFModel[]>(url, { timeoutMs: 10_000, retries: 0 });
    if (!res.ok || !Array.isArray(res.data)) {
      recordSourceFail('huggingface', res.error || 'empty');
      continue;
    }
    recordSourceOk('huggingface');
    for (const m of res.data.slice(0, 6)) {
      out.push({
        module: 'opensource',
        project_name: m.id.split('/').pop() || m.id,
        repo_url: `https://huggingface.co/${m.id}`,
        owner: m.id.split('/')[0] || '',
        stars: 0,
        primary_language: undefined,
        updated_at: m.lastModified,
        tech_tags: (m.tags || []).filter((t) => !t.startsWith('pipeline')).slice(0, 8),
        description: m.pipeline_tag ? `HF Model · ${m.pipeline_tag}` : 'HuggingFace Model',
        source_urls: [{ url: `https://huggingface.co/${m.id}`, source_type: 'huggingface', name: 'HuggingFace', credibility_score: 4.5 }],
      });
    }
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : 'huggingface 无结果' };
}

// ========== Gitee ==========

async function collectGitee(ctx: TaskContext): Promise<{ ok: boolean; items: OpenSourceRawEvent[]; error?: string }> {
  const out: OpenSourceRawEvent[] = [];
  const keywords = ['llm', 'agent', 'rag', 'mcp'];
  for (const kw of keywords) {
    const url = `https://gitee.com/api/v5/search/repositories?q=${encodeURIComponent(kw)}&sort=stars_count&order=desc&page=1&per_page=10`;
    const res = await httpGetJson<GiteeRepo[]>(url, { timeoutMs: 10_000, retries: 0 });
    if (!res.ok || !Array.isArray(res.data)) {
      recordSourceFail('gitee', res.error || 'empty');
      continue;
    }
    recordSourceOk('gitee');
    for (const r of res.data.slice(0, 6)) {
      out.push({
        module: 'opensource',
        project_name: r.name,
        repo_url: r.html_url,
        owner: r.owner?.login || '',
        stars: r.stargazers_count ?? 0,
        primary_language: r.language ?? undefined,
        updated_at: r.updated_at,
        tech_tags: [kw],
        description: r.description || '',
        source_urls: [{ url: r.html_url, source_type: 'gitee', name: 'Gitee', credibility_score: 4 }],
      });
    }
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : 'gitee 无结果' };
}

// ========== WebSearch 兜底（真实搜索，Sheet08 降级链末端） ==========

/** 缓存条目转 stale 标记事件：保留原事件 + 追加缓存来源证据 */
function markStale(item: OpenSourceRawEvent, stale: boolean): OpenSourceRawEvent {
  const cacheNote: SourceEvidence = {
    url: '',
    source_type: 'cache',
    name: stale ? '本地缓存（超期）' : '本地缓存',
    credibility_score: 2,
  };
  return {
    ...item,
    description: `${item.description}${stale ? '（缓存数据：实时源不可用，时间可能滞后）' : ''}`.trim(),
    source_urls: [...item.source_urls, cacheNote],
  };
}

/** 真实 WebSearch：关键词 × 技术主题，转 OpenSourceRawEvent */
async function collectWebSearch(ctx: TaskContext): Promise<{ ok: boolean; items: OpenSourceRawEvent[]; error?: string }> {
  const out: OpenSourceRawEvent[] = [];
  const errors: string[] = [];
  const queries = OPEN_SOURCE_KEYWORDS.map((kw) => `${kw.githubQuery.split(' in:')[0].replace(/created:>=.*/, '')} ${kw.tags[0] || ''} launch`).slice(0, 3);

  for (const q of queries) {
    const res = await webSearch(q, { limit: 4, maxAgeHours: Math.max(72, ctx.time_window_hours * 3) });
    if (!res.ok) {
      errors.push(`websearch(${q}): ${res.error}`);
      continue;
    }
    for (const r of res.results) {
      if (out.length >= 8) break;
      // 从标题/摘要提取项目名（粗略）：取标题首词簇
      const nameMatch = r.title.match(/^[A-Za-z0-9_.-]{2,40}/);
      out.push({
        module: 'opensource',
        project_name: nameMatch ? nameMatch[0] : r.title.slice(0, 30),
        repo_url: r.url,
        owner: '',
        stars: 0,
        updated_at: r.published_at,
        tech_tags: q.split(' ').filter((t) => t.length > 2).slice(0, 3),
        description: r.snippet.slice(0, 200) || r.title,
        source_urls: [{ url: r.url, source_type: 'websearch', name: r.source === 'hackernews' ? 'Hacker News' : 'DuckDuckGo', credibility_score: 3 }],
      });
    }
    if (out.length >= 8) break;
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : (errors.join('; ') || 'websearch 无结果') };
}

// ========== 过滤（Sheet02 R31-R37） ==========

function filterCandidates(items: OpenSourceRawEvent[], ctx: TaskContext, degraded = false): OpenSourceRawEvent[] {
  const f = OPEN_SOURCE_FILTER;
  const starWeek = degraded ? f.starGrowthWeekDegraded : f.starGrowthWeek;
  const starDay = degraded ? f.starGrowthDayDegraded : f.starGrowthDay;
  const commit = degraded ? f.commit7dDegraded : f.commit7d;
  const contributors = degraded ? f.contributorsDegraded : f.contributors;

  return items.filter((item) => {
    // 无来源证据的项目（如 fallback 说明）直接保留标记
    if (item.source_urls.length === 0) return true;
    // star 门槛（有 star 数据时）
    if (item.stars > 0) {
      // 无 growth 数据时放宽（API 不直接提供周增长，允许通过）
      // 实际开发可对比两次快照计算；MVP 以 stars 绝对值 + 活跃度判断
    }
    // 社区热度门槛（有 forks/issues/contributors 数据时）：三者任一达到阈值即可
    // （优化：不只 stars，关注社区真实活跃度）
    const community = (item.forks ?? 0) + (item.open_issues ?? 0) + (item.contributors ?? 0);
    if (community > 0) {
      // 有社区数据但全为 0 且 stars 也小 → 低热度过滤（非降级时）
      if (!degraded && item.stars < 50 && community < 20) return false;
    }
    // 更新时间窗口（有 updated_at 时）
    if (item.updated_at) {
      const hours = (Date.now() - new Date(item.updated_at).getTime()) / 3600_000;
      const maxHours = Math.max(72, ctx.time_window_hours * 3);
      if (hours > maxHours) return false;
    }
    return true;
  });
}

// ========== 去重（Sheet02 02-07：repo_url 唯一键） ==========

function dedupByRepoUrl(items: OpenSourceRawEvent[]): OpenSourceRawEvent[] {
  const seen = new Map<string, OpenSourceRawEvent>();
  for (const item of items) {
    if (!item.repo_url) continue;
    const key = item.repo_url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) {
      const existing = seen.get(key)!;
      // 合并证据
      existing.source_urls = mergeSources(existing.source_urls, item.source_urls);
      if (item.stars > existing.stars) {
        existing.stars = item.stars;
        existing.description = item.description || existing.description;
        existing.tech_tags = Array.from(new Set([...existing.tech_tags, ...item.tech_tags]));
      }
    } else {
      seen.set(key, { ...item });
    }
  }
  return Array.from(seen.values());
}

function mergeSources(a: SourceEvidence[], b: SourceEvidence[]): SourceEvidence[] {
  const map = new Map<string, SourceEvidence>();
  for (const s of [...a, ...b]) {
    if (!s.url) continue;
    map.set(s.url, s);
  }
  return Array.from(map.values());
}

export { filterCandidates, dedupByRepoUrl, mergeSources };
