/**
 * 跨天"已报道"记忆（2026-09-08 P0-F2 跨天去重）
 *
 * 背景：evaluator 只统计当天事件池，不记得"昨天/前几天上报过什么"。
 * 结果 arXiv 论文（7 天提交窗口）、企业官方旧闻重复入榜，GitHub 高星项目天天上榜
 * （9-04/05/06 arXiv 2609.04180/04168 连续 3 天入选学术 Top5）。
 *
 * 方案：state/reported_titles.json 随仓库提交（与 state/star_snapshots.json 同模式，
 * workflow 中 git add -f state/ 已持久化），记录"每天上报的 TopN 事件标题 key"。
 * - 结构：{ "YYYY-MM-DD": { "paper": ["key"...], "enterprise": [...], "opensource": [...] } }
 * - key 带模块前缀 + 公司前缀（见 reportedKeyOf）
 *
 * 回看窗口与各模块采集窗口一致：
 *   - paper      回看近 7 天（arXiv 提交窗口 7d，同篇论文连周重复的根因）
 *   - enterprise 回看近 3 天（官方源发布延迟窗口 3d）
 *   - opensource 回看近 1 天（GitHub repo 天天活跃；只挡"昨日报过"，避免高星 repo 被永久压制）
 *
 * 注意：这里记录与比对的都是 evaluator 视角的**原始标题**（英文原题），
 * 中文重述发生在 reporter 阶段且不回流 evaluator → 不存在中英版本错配。
 *
 * 读失败 / 文件不存在 → fail-open 返回空（不影响当天产出）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { normDedupKey } from './normalize.js';

/** 模块回看窗口（天）：与 evaluator Phase 3 展示窗口一致，控制"多久内的已报道算重复"
 *  - enterprise 2026-09-08 P2-2：展示窗放宽到 5 天后，回看也 3→5，避免 3-5 天前事件隔天重报 */
const LOOKBACK_DAYS: Record<string, number> = {
  paper: 7,
  enterprise: 5,
  opensource: 1,
};

type ReportedStore = Record<string, Record<string, string[]>>;

function memoryFile(): string {
  return path.join(config.dbPath, '..', '..', 'state', 'reported_titles.json');
}

function readStore(): ReportedStore {
  try {
    const raw = fs.readFileSync(memoryFile(), 'utf-8');
    const parsed = JSON.parse(raw) as ReportedStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: ReportedStore): void {
  try {
    const file = memoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn(`[reportMemory] 已报道记忆写入失败: ${err instanceof Error ? err.message : err}`);
  }
}

/** 生成事件的"跨天去重键"：统一 `category|normDedupKey(title)`（2026-09-08 修正——
 *  opensource 原用 repo 名强键，但回填脚本只能从日报 md 拿标题拿不到 repo 名，两侧不一致永不命中。
 *  统一走标题归一键后，运行期与回填期键完全可比；opensource 标题里含 repo 名（如 "dify：..."），
 *  归一化后跨天命中可靠。company 同理不拼入（回填拿不到）。） */
export function reportedKeyOf(evt: { title: string; category: string; company?: string; product?: string }): string {
  const category = evt.category || 'enterprise';
  const titleKey = normDedupKey(evt.title);
  if (!titleKey) return '';
  return `${category}|${titleKey}`;
}

/** 日期间隔天数（b - a），解析失败返回 NaN */
function dayDiff(a: string, b: string): number {
  const ta = new Date(`${a}T12:00:00`).getTime();
  const tb = new Date(`${b}T12:00:00`).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return NaN;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * 过滤掉"各自窗口内已上报"的重复事件（按事件类别独立回看）。
 * @returns kept/dropped 两组（均保持原相对顺序）
 */
export function filterAlreadyReported<T extends { title: string; category: string; company?: string; product?: string }>(
  events: T[],
  reportDate: string,
): { kept: T[]; dropped: T[] } {
  if (!reportDate || events.length === 0) return { kept: events, dropped: [] };
  const store = readStore();
  const storeDates = Object.keys(store);
  if (storeDates.length === 0) return { kept: events, dropped: [] };

  // 预构建：每个历史日期 → { module → keys[] }，按日期升序供窗口切片
  const sortedDates = storeDates.filter((d) => !Number.isNaN(dayDiff(d, reportDate))).sort();

  const kept: T[] = [];
  const dropped: T[] = [];

  for (const evt of events) {
    const category = evt.category || 'enterprise';
    const lookback = LOOKBACK_DAYS[category] ?? 3;
    // 收集该类别在窗口内的历史 key
    let hit = false;
    for (const d of sortedDates) {
      const diff = dayDiff(d, reportDate);
      if (diff < 0 || diff > lookback) continue; // 未来日期或超出回看窗口
      const moduleKeys = (store[d] || {})[category];
      if (!moduleKeys || moduleKeys.length === 0) continue;
      const key = reportedKeyOf(evt);
      if (!key) break; // 无键事件放行
      if (moduleKeys.includes(key)) { hit = true; break; }
    }
    if (hit) dropped.push(evt);
    else kept.push(evt);
  }
  return { kept, dropped };
}

/**
 * 记录"当日上报 TopN"的标题 key（Phase 3 定稿后调用）。
 * 只保留近 14 天（窗口最宽 7 天 + 缓冲），防文件无限增长。
 */
export function recordReportedTitles(
  date: string,
  topNByModule: Record<string, Array<{ event: { title: string; category: string; company?: string; product?: string } }>>,
): void {
  if (!date) return;
  const store = readStore();
  // 清理 >14 天的旧记录
  for (const d of Object.keys(store)) {
    const diff = dayDiff(d, date);
    if (!Number.isNaN(diff) && diff > 14) delete store[d];
  }
  const byModule: Record<string, string[]> = {};
  for (const [module, entries] of Object.entries(topNByModule)) {
    const keys = entries.map((t) => reportedKeyOf(t.event)).filter(Boolean);
    if (keys.length > 0) byModule[module] = keys;
  }
  if (Object.keys(byModule).length > 0) {
    store[date] = byModule;
    writeStore(store);
    const total = Object.values(byModule).reduce((n, a) => n + a.length, 0);
    logger.info(`[reportMemory] 已记录 ${date} 上报 ${total} 条标题记忆（${Object.keys(byModule).join(',')}）`);
  }
}
