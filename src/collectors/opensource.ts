/**
 * 开源技术采集（Sheet02）
 * 数据源优先级：① GitHub Search API（主） ② GitHub Trending ③ ModelScope ④ HuggingFace ⑤ Gitee ⑥ WebSearch 兜底
 * 过滤阈值（Sheet02 R31-R37）
 */

import type { OpenSourceRawEvent, SourceEvidence, TaskContext } from '../types/events.js';
import { OPEN_SOURCE_KEYWORDS, type OpenSourceKeyword } from '../config/constants.js';
import { httpGetJson, runWithTimeout } from '../utils/http.js';
import { webSearch } from '../utils/websearch.js';
import { writeJsonCache, readJsonCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { recordSourceOk, recordSourceFail } from '../db/index.js';
import { toISODate, sanitizeDate } from '../utils/normalize.js';
import { config } from '../config/index.js';

const CACHE_SCOPE = 'opensource';
const CACHE_KEY = 'latest';
/** 缓存最长 36h；超期读取时打 stale 标记（Sheet08 R12 缓存降级） */
const CACHE_MAX_AGE_MS = 36 * 3600_000;

/**
 * star 快照持久化（2026-08-26 重构）：
 * 存储从 data/cache（gitignore，CI 每日清零 → 周增长永远 undefined）迁移到
 * state/star_snapshots.json —— 随仓库提交，跨 CI 运行积累，
 * 使"star 周增长"这一核心动向信号在生产环境真正可用（workflow 中 git add -f state/）。
 */
import fs from 'node:fs';
import path from 'node:path';

interface StarSnapshotEntry {
  repo_url: string;
  stars: number;
  fetched_at: string;
}

function snapshotFile(): string {
  return path.join(config.dbPath, '..', '..', 'state', 'star_snapshots.json');
}

function readSnapshots(): StarSnapshotEntry[] {
  try {
    const raw = fs.readFileSync(snapshotFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSnapshots(entries: StarSnapshotEntry[]): void {
  try {
    const file = snapshotFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn(`[opensource] star 快照写入失败: ${err instanceof Error ? err.message : err}`);
  }
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  stargazers_count: number;
  pushed_at: string;
  created_at?: string;
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

  // 1. GitHub Search API（主源，双轨：成熟活跃 + 新星）
  const githubResult = await collectGitHub(ctx);
  if (githubResult.ok) {
    all.push(...githubResult.items.map((r) => ({ raw: r, sortKey: r.stars ?? 0 })));
  } else {
    errors.push(`github: ${githubResult.error}`);
  }

  // 2. Gitee（国内备用，真实仓库带 star）
  const gitee = await collectGitee(ctx);
  if (gitee.ok) {
    all.push(...gitee.items.map((r) => ({ raw: r, sortKey: 0 })));
  } else {
    errors.push(`gitee: ${gitee.error}`);
  }

  // 3. ModelScope / HuggingFace（模型目录，非事件语义 —— 仅作全源失败时的最后兜底）
  if (all.length === 0) {
    const ms = await collectModelScope(ctx);
    if (ms.ok) {
      all.push(...ms.items.map((r) => ({ raw: r, sortKey: 0 })));
    } else {
      errors.push(`modelscope: ${ms.error}`);
    }
    const hf = await collectHuggingFace(ctx);
    if (hf.ok) {
      all.push(...hf.items.map((r) => ({ raw: r, sortKey: 0 })));
    } else {
      errors.push(`huggingface: ${hf.error}`);
    }
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

  // 查询策略（2026-08-26 重构，实测驱动）：
  //   原查询 `topic:X pushed:>DATE sort=updated` 是"最近几小时恰好 push 过"的随机抽样器
  //   （实测 topic:llm 前 15 名混着大量 0★ 个人仓库），不是动向探测。
  //   现拆双轨：
  //   A. 活跃成熟项目：topic + pushed:>DATE + stars:>100（push 但有社区基本盘，可能有大动作）
  //   B. 新星项目：(topic 组合) created:>DATE-14d stars:>30（真正的新发布/新崛起——这才是新闻）
  //   合计 ≤8 次/分钟请求（GitHub 匿名 search 限额 10/min）
  const seenUrls = new Set<string>();
  for (const kw of OPEN_SOURCE_KEYWORDS) {
    // 先替换 {date} 占位符（pushed:>{date}/created:>{date}），再剥离 in:name,description 限定
    const expanded = kw.githubQuery.replace(/\{date\}/g, dateStr);
    const base = expanded.split(' in:')[0].trim();
    // A 轨：成熟活跃项目（star 门槛过滤掉 push 即采的零信号仓库；模板自带 stars 限定时不重复追加）
    const queryA = /stars:>\d+/.test(base) ? base : `${base} stars:>100`;
    const urlA = `https://api.github.com/search/repositories?q=${encodeURIComponent(queryA)}&sort=updated&order=desc&per_page=20`;
    const resA = await httpGetJson<GitHubSearchResult>(urlA, { timeoutMs: 15_000, retries: 1, exponential: true });
    if (!resA.ok || !resA.data) {
      totalOk = false;
      recordSourceFail('github_api', resA.error || 'empty');
      logger.warn(`[opensource][github] ${kw.topic} 失败: ${resA.error}`);
    } else {
      recordSourceOk('github_api');
      collectGithubRepos(resA.data.items, kw, out, seenUrls);
    }
  }

  // B 轨：新星项目（一次组合查询覆盖全部主题；created 在近 14 天且有初始社区认可）
  const risingDate = toISODate(new Date(Date.now() - 14 * 86_400_000));
  const topicsOr = OPEN_SOURCE_KEYWORDS.map((kw) => `topic:${kw.topic.toLowerCase().replace(/[^a-z]/g, '')}`).filter((t) => t.length > 6).slice(0, 4).join(' OR ');
  if (topicsOr) {
    const queryB = `(${topicsOr}) created:>${risingDate} stars:>30`;
    const urlB = `https://api.github.com/search/repositories?q=${encodeURIComponent(queryB)}&sort=stars&order=desc&per_page=20`;
    const resB = await httpGetJson<GitHubSearchResult>(urlB, { timeoutMs: 15_000, retries: 1, exponential: true });
    if (resB.ok && resB.data) {
      recordSourceOk('github_api');
      // B 轨（新星）：rising=true —— 独立于 push 窗口，防止"创建≤14天但最近未 push"的新星被统一 push 过滤误杀
      collectGithubRepos(resB.data.items, null, out, seenUrls, true);
    } else {
      logger.warn(`[opensource][github] 新星查询失败: ${resB.error}`);
    }
  }

  // 记录本次采集的 star 快照（供下次计算周增长）
  if (out.length > 0) recordStarSnapshots(out);
  return { ok: out.length > 0 ? true : totalOk, items: out, error: out.length > 0 ? undefined : 'github 无结果' };
}

/** GitHub repo 列表 → RawEvent（去重 + 时间窗过滤）；kw 非空时附加主题标签。
 *  rising=true（B 轨新星）：跳过 push 窗口过滤 —— 新星仓库由 created_at+star 门槛（查询层已加）
 *  保证时效，不要求最近 push（创建 2-8 天、最近未 push 的新星不应被误杀）。 */
function collectGithubRepos(repos: GitHubRepo[], kw: OpenSourceKeyword | null, out: OpenSourceRawEvent[], seenUrls: Set<string>, rising = false): void {
  const now = Date.now();
  for (const repo of repos.slice(0, 15)) {
    const key = repo.html_url.toLowerCase().replace(/\/+$/, '');
    if (seenUrls.has(key)) continue;
    const pushed = new Date(repo.pushed_at).getTime();
    const pushedHours = (now - pushed) / 3600_000;
    const inWindow = pushedHours <= Math.max(72, ctxWindowHours() * 3);
    // A 轨要求 push 窗口内；B 轨新星独立于 push 窗口（只有 pushed_at 缺失时才过滤）
    if (!inWindow && !rising) continue;
    seenUrls.add(key);
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
      created_at: sanitizeDate(repo.created_at),
      // 未知日期不默认今天：pushed_at 缺失时留空（评估层 date_missing 拦截）
      updated_at: sanitizeDate(repo.pushed_at),
      tech_tags: ((repo.topics || []).concat(kw ? kw.tags : [])).slice(0, 8),
      description: repo.description || '',
      source_urls: [{ url: repo.html_url, source_type: 'github_repo', name: 'GitHub', credibility_score: 5 }],
    });
  }
}

/** 当前配置的时间窗口小时数（供 collectGithubRepos 使用） */
function ctxWindowHours(): number {
  return config.timeWindowHours;
}

/** 计算 star 周增长：对比历史快照（≥5 天前），无有效快照时返回 undefined */
function computeStarGrowthWeek(repoUrl: string, currentStars: number): number | undefined {
  const prev = readSnapshots().find((e) => e.repo_url === repoUrl);
  if (!prev) return undefined;
  const ageDays = (Date.now() - new Date(prev.fetched_at).getTime()) / 86_400_000;
  // 快照需 ≥5 天前才有参考意义（太新无法反映周增长）
  if (ageDays < 5) return undefined;
  return Math.max(0, currentStars - prev.stars);
}

/** 记录 star 快照（与已有快照合并，保留每个 repo 最早的记录以计算真实周增长；清理 >8 天旧条目） */
function recordStarSnapshots(items: OpenSourceRawEvent[]): void {
  const byUrl = new Map(readSnapshots().map((e) => [e.repo_url, e]));
  const now = new Date().toISOString();
  for (const item of items) {
    if (!item.repo_url) continue;
    // 已存在则保留最早记录（用于 7 天对比）；不存在则记当前
    if (!byUrl.has(item.repo_url)) {
      byUrl.set(item.repo_url, { repo_url: item.repo_url, stars: item.stars, fetched_at: now });
    }
  }
  const eightDaysAgo = Date.now() - 8 * 86_400_000;
  const entries = [...byUrl.values()].filter((e) => new Date(e.fetched_at).getTime() >= eightDaysAgo);
  writeSnapshots(entries);
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
        source_urls: [{ url: r.url, source_type: 'websearch', name: r.source === 'hackernews' ? 'Hacker News' : r.source === 'googlenews' ? 'Google News' : 'DuckDuckGo', credibility_score: 3 }],
      });
    }
    if (out.length >= 8) break;
  }
  return { ok: out.length > 0, items: out, error: out.length ? undefined : (errors.join('; ') || 'websearch 无结果') };
}

// ========== 过滤（Sheet02 R31-R37） ==========

function filterCandidates(items: OpenSourceRawEvent[], ctx: TaskContext, degraded = false): OpenSourceRawEvent[] {
  // 真实准入门槛（2026-08-26 接线：此前阈值表定义了但从未执行，导致 0★ 仓库进日报）
  //   - 成熟项目：stars ≥ 100（降级 ≥50）
  //   - 新星项目：创建 ≤14 天且 stars ≥ 30（降级 ≥10）—— 新发布本身就是新闻
  const minStars = degraded ? 50 : 100;
  const risingMaxAgeDays = 14;
  const risingMinStars = degraded ? 10 : 30;
  // AI 相关性门控（2026-08-26 实测驱动）：topic:agent 会命中 APM agent 等非 AI 仓库
  //   （实测 pinpoint-apm/pinpoint 入选日报）。要求 tags+description 命中强 AI 信号；
  //   刻意不含裸词 "agent"（歧义太大），含具体产品名与领域词。
  const OPEN_AI_SIGNALS = /\b(ai|aigc|llms?|gpt|rag|mcp|generative|agentic|inference|transformers?|diffusion|neural|machine[- ]?learning|deep[- ]?learning|nlp|computer[- ]?vision|claude|openai|gemini|llama|qwen|mistral|chatbot|copilot|embeddings?|fine[- ]?tun\w*|prompt|deepseek|kimi)\b/i;

  return items.filter((item) => {
    // 无来源证据的项目（如 fallback 说明）直接保留标记
    if (item.source_urls.length === 0) return true;

    const isGithub = item.source_urls.some((s) => s.source_type === 'github_repo');
    if (isGithub && !degraded) {
      const text = `${(item.tech_tags || []).join(' ')} ${item.description}`;
      if (!OPEN_AI_SIGNALS.test(text)) {
        logger.debug(`[opensource] 过滤非 AI 仓库: ${item.project_name} (${item.description.slice(0, 50)})`);
        return false;
      }
    }

    const ageDays = item.created_at
      ? (Date.now() - new Date(item.created_at).getTime()) / 86_400_000
      : undefined;
    const isRising = ageDays !== undefined && ageDays <= risingMaxAgeDays && item.stars >= risingMinStars;

    // star 准入（GitHub 主源有真实数据时执行；ModelScope/HF/Gitee/WebSearch 兜底源 stars=0 走社区热度通道）
    if (isGithub) {
      if (item.stars < minStars && !isRising) {
        logger.debug(`[opensource] 过滤低信号仓库: ${item.project_name} stars=${item.stars} age=${ageDays?.toFixed(1) ?? '?'}d`);
        return false;
      }
    }
    // 社区热度兜底门槛（非 GitHub 源）：forks/issues/contributors 任一有值即可通过，全零则过滤
    const community = (item.forks ?? 0) + (item.open_issues ?? 0) + (item.contributors ?? 0);
    if (!isGithub && community === 0 && item.stars === 0) {
      return false;
    }
    // 更新时间窗口（有 updated_at 时）：新星豁免（2026-08-31 批2 任务③ —— 新星轨道独立于
    // push/更新时间窗口，创建≤14天+stars≥30 即为有效新发布，不要求最近有 push/更新）
    if (item.updated_at && !isRising) {
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
