/**
 * 通用 JSON 文件缓存 —— 采集结果降级兜底（规格 Sheet08 R4/R12：缓存降级 + stale 标记）
 *
 * 用途：当某模块全部实时数据源不可用时，读取最近一次成功采集的缓存，
 *      保证日报仍有内容可展示；缓存条目通过 source_type='cache' 证据 + 时间窗
 *      标注（stale）向读者明示「数据来自缓存，非实时」。
 *
 * 设计：
 *  - 缓存文件：data/cache/<scope>/<key>.json，含 meta（写入时间/窗口/来源）与 items
 *  - 原子写入：先写 .tmp 再 rename，避免半截文件
 *  - 读取时可带 maxAgeMs，超期视为无效（由调用方决定是否仍用）
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

export interface CacheEntry<T> {
  meta: {
    key: string;
    written_at: string;   // ISO
    window_hours: number; // 采集时间窗口
    sources: string[];    // 成功来源列表
    degraded: boolean;    // 写入时是否已降级
  };
  items: T[];
}

const CACHE_ROOT = path.join(path.dirname(config.dbPath), 'cache');

function cacheFile(scope: string, key: string): string {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_ROOT, scope, `${safeKey}.json`);
}

/** 写入缓存（原子） */
export function writeJsonCache<T>(scope: string, key: string, items: T[], opts: { windowHours?: number; sources?: string[]; degraded?: boolean } = {}): void {
  try {
    const file = cacheFile(scope, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry: CacheEntry<T> = {
      meta: {
        key,
        written_at: new Date().toISOString(),
        window_hours: opts.windowHours ?? 24,
        sources: opts.sources ?? [],
        degraded: opts.degraded ?? false,
      },
      items,
    };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    // 缓存失败不影响主流程
    // eslint-disable-next-line no-console
    console.warn(`[cache] 写入失败 ${scope}/${key}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 读取缓存。
 * @param maxAgeMs 缓存最大存活时间；null 表示不限（仍检查文件存在）
 * @returns 命中返回 { entry, stale }，未命中返回 null
 */
export function readJsonCache<T>(scope: string, key: string, maxAgeMs: number | null = 36 * 3600_000): { entry: CacheEntry<T>; stale: boolean } | null {
  try {
    const file = cacheFile(scope, key);
    if (!fs.existsSync(file)) return null;
    const entry = JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheEntry<T>;
    if (!Array.isArray(entry.items)) return null;
    const age = Date.now() - new Date(entry.meta.written_at).getTime();
    const stale = maxAgeMs !== null && age > maxAgeMs;
    return { entry, stale };
  } catch {
    return null;
  }
}

/** 删除缓存（用于调试/清理） */
export function clearCache(scope: string, key?: string): void {
  const dir = path.join(CACHE_ROOT, scope);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!key || f.startsWith(key)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* noop */ }
    }
  }
}
