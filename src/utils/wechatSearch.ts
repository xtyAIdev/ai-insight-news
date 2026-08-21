/**
 * 微信公众号搜索封装（中文企业动态/投融资补充源）
 *
 * 通过子进程调用 wechat-article-search 技能脚本（搜狗微信搜索）：
 *   ~/.workbuddy/skills/wechat-article-search/scripts/search_wechat.js
 * 项目保持零运行时依赖（cheerio 装在技能目录，不污染项目 node_modules）。
 *
 * 输出：{ title, url, summary, datetime, source }[]（按 datetime 降序，可过滤旧文）
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { logger } from './logger.js';

export interface WechatArticle {
  title: string;
  url: string;
  summary: string;
  datetime: string;      // YYYY-MM-DD HH:mm:ss（中国时区）
  date_description: string;
  source: string;        // 公众号名称
}

/** 技能脚本可能的位置（用户级技能目录） */
function findSkillScript(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.workbuddy', 'skills', 'wechat-article-search', 'scripts', 'search_wechat.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 搜索微信公众号文章。
 * @param query 关键词（中文效果最佳）
 * @param opts { limit, maxDays } 数量上限、只保留最近 N 天（默认 30 天）
 */
export async function wechatSearch(
  query: string,
  opts: { limit?: number; maxDays?: number; timeoutMs?: number } = {},
): Promise<{ ok: boolean; results: WechatArticle[]; error?: string }> {
  const script = findSkillScript();
  if (!script) {
    return { ok: false, results: [], error: 'wechat-article-search 技能未安装（缺少 search_wechat.js）' };
  }

  const limit = opts.limit ?? 8;
  const maxDays = opts.maxDays ?? 30;
  const timeoutMs = opts.timeoutMs ?? 45_000;

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, query, '-n', String(limit)],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, cwd: path.dirname(script) },
      (err, stdout) => {
        if (err) {
          // 超时 / 执行失败（反爬、网络等）
          resolve({ ok: false, results: [], error: err.message });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { total?: number; articles?: WechatArticle[] };
          const articles = Array.isArray(parsed.articles) ? parsed.articles : [];
          // 按时间过滤：只保留最近 N 天
          const cutoff = Date.now() - maxDays * 24 * 3600_000;
          const fresh = articles
            .filter((a) => {
              const t = a.datetime ? new Date(a.datetime.replace(' ', 'T') + '+08:00').getTime() : 0;
              return t >= cutoff;
            })
            .sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
          resolve({ ok: fresh.length > 0, results: fresh, error: fresh.length ? undefined : 'wechat: 无近期文章（搜狗返回的多为旧文）' });
        } catch (e) {
          resolve({ ok: false, results: [], error: `wechat: 解析失败 ${e instanceof Error ? e.message : e}` });
        }
      },
    );
  });
}
