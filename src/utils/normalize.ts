/**
 * 文本/日期/金额/公司别名归一化（规格 Sheet05 05-02 字段标准化）
 */

import { ENTERPRISE_POOL } from '../config/constants.js';

// ========== 文本清洗 ==========

export function cleanText(s: string): string {
  if (!s) return '';
  return s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。；：、！？）】」』])/g, '$1')
    .replace(/([（【「『])\s+/g, '$1')
    .trim();
}

export function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ========== 日期 ==========

export function toISODate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

export function toISODatetime(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString();
}

export function hoursAgoISO(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

export function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// RSS/Atom 标准日期格式（pubDate/updated），例：
//   Tue, 25 Aug 2026 00:30:00 GMT / Mon, 24 Aug 2026 17:00:00 +0800
// 这是 OpenAI/Google/36氪/机器之心/TechCrunch 等 RSS 的默认 pubDate 格式。
// 此前缺失该格式 → 官方/媒体 RSS 事件 published_at 解析失败 → time 为空 →
// 评估层 Phase 3 严格当天过滤会把企业动态整模块滤空（2026-08-25 事故根因）。
const RFC822_DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const RFC822_MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';

export function parseFlexibleDate(s: string): string | null {
  if (!s) return null;
  // YYYY-MM-DD
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  // YYYY年MM月DD日
  m = s.match(/(\d{4})[年./](\d{1,2})[月./](\d{1,2})日?/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  // ISO datetime
  m = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (m) return m[1];
  // RFC822/RFC2822（RSS pubDate）："Tue, 25 Aug 2026 00:30:00 GMT"
  m = s.match(new RegExp(`^\\s*(?:${RFC822_DAY},\\s*)?(\\d{1,2})\\s+(${RFC822_MONTH})\\s+(\\d{4})\\b`));
  if (m) {
    const MONTH_INDEX: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    return `${m[3]}-${MONTH_INDEX[m[2]]}-${String(+m[1]).padStart(2, '0')}`;
  }
  // 相对表达：x 小时前 / x 天前
  m = s.match(/(\d+)\s*(小时|天|周|个月)前/);
  if (m) {
    const n = +m[1];
    const unit = m[2];
    const hours = unit === '小时' ? n : unit === '天' ? n * 24 : unit === '周' ? n * 24 * 7 : n * 24 * 30;
    return toISODate(new Date(Date.now() - hours * 3600_000));
  }
  return null;
}

/**
 * 日期真实性守卫（用户硬约束：禁止"未知日期默认今天"）。
 * 解析日期，失败/为空时返回 fallback（缺省 ''，绝不默认今天）。
 * 会把带时间戳的日期规整为纯日期（YYYY-MM-DD）。
 * 调用方（采集/处理层）必须显式决定：无真实日期的事件应标记 date_missing，
 * 由评估层扣分并阻止进入 TopN，而不是静默标成"今天"。
 */
export function sanitizeDate(s: string | undefined | null, fallback: string = ''): string {
  if (!s) return fallback;
  const parsed = parseFlexibleDate(s);
  if (!parsed) return fallback;
  // 规整为纯日期（去掉时间部分）
  return parsed.slice(0, 10);
}

/** 判断来源证据是否携带真实日期（URL 路径日期 / pubDate / 已知一手源类型） */
const OFFICIAL_TYPES = new Set(['official', 'official_rss', 'github_repo', 'arxiv', 'openalex', 'modelscope', 'huggingface', 'domestic_official']);
export function sourceHasDate(src: { url?: string; source_type?: string; published_at?: string }): boolean {
  if (src.published_at) return true;
  // 已知一手源类型（官方/仓库/论文库）：采集层保证日期，或本身即一手源 → 视为有日期
  if (src.source_type && OFFICIAL_TYPES.has(src.source_type)) return true;
  // URL 含 /YYYY/MM/DD/ 日期路径
  if (src.url && /\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//.test(src.url)) return true;
  return false;
}

// ========== 金额归一化（统一人民币万元，Sheet05 05-02②） ==========

/**
 * 把各种金额表达转成人民币万元
 * 支持：5000万人民币 / $100M / 1.5亿美元 / 10亿 / 2000万元 / ¥1.2亿
 */
export function normalizeAmountToWan(input: string): number | null {
  if (!input) return null;
  const s = input.trim();
  // 中文：X亿元 / X万元 / X元
  let m = s.match(/(\d+(?:\.\d+)?)\s*亿/);
  if (m) return +(m[1]) * 10000;
  m = s.match(/(\d+(?:\.\d+)?)\s*万/);
  if (m) return +(m[1]);
  // 美元 $X M / $X B / X百万 / X千万
  m = s.match(/\$\s*(\d+(?:\.\d+)?)\s*(M|B|K)/i);
  if (m) {
    const n = +m[1];
    const unit = m[2].toUpperCase();
    const wan = unit === 'M' ? n * 100 : unit === 'B' ? n * 10000 : n * 0.1;
    return Math.round(wan * 7.2); // 粗略汇率，正式场景用当日汇率
  }
  m = s.match(/(\d+(?:\.\d+)?)\s*(?:百万|M)\s*美元?/i);
  if (m) return Math.round(+m[1] * 100 * 7.2);
  m = s.match(/(\d+(?:\.\d+)?)\s*(?:千万)\s*美元?/i);
  if (m) return Math.round(+m[1] * 1000 * 7.2);
  m = s.match(/(\d+(?:\.\d+)?)\s*亿\s*美元/);
  if (m) return Math.round(+m[1] * 10000 * 7.2);
  m = s.match(/(\d+(?:\.\d+)?)\s*美元/);
  if (m) return +(m[1]);
  return null;
}

export function formatWan(v: number): string {
  if (v >= 10000) return `${(v / 10000).toFixed(2)}亿元`;
  return `${Math.round(v)}万元`;
}

// ========== 公司别名归一（Sheet05 05-02③） ==========

export function normalizeCompany(name: string): string {
  if (!name) return '';
  const lower = name.toLowerCase().trim();
  for (const p of ENTERPRISE_POOL) {
    if (p.company === name) return p.company;
    for (const alias of p.aliases) {
      if (lower.includes(alias.toLowerCase())) return p.company;
    }
  }
  return name.trim();
}

// ========== 数字提取 ==========

export function extractNumber(input: string): number | null {
  if (!input) return null;
  const m = input.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? +m[0] : null;
}

// ========== 相似度（简单 Jaccard / 字符重叠，供去重与融合使用） ==========

/**
 * 英文 Jaccard 相似度（2026-08-31 批4 测试发现修复）：
 * 原实现 `replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')` 把空格也删掉，英文标题被压成单个单词
 * （"cursor launches ai agent" → "cursorlaunchesaiagent"），导致两个相似英文标题的 Jaccard=0，
 * 相似度通道去重完全失效。修复：连续非中英数字替换为单个空格，保留词边界。
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  const setA = new Set(la.replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean));
  const setB = new Set(lb.replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/**
 * 从标题提取"核心名词"（去重归一化用）：
 * 英文取最长连续 token（通常是项目/产品名），中文取连续中文片段中最长一段。
 * 例： "Introducing Claude Opus 5" → "claude opus"；"通义千问 Qwen3 发布" → "通义千问"
 */
export function extractCoreNoun(title: string): string {
  if (!title) return '';
  const lower = title.toLowerCase();
  // 英文：剔除动作/发布词后，取最长的连续实体 token 序列（>=2 词）
  const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'new', 'how', 'why', 'what', 'are', 'was', 'were', 'has', 'had', 'its', 'into', 'you', 'your', 'can', 'not', 'will', 'introducing', 'introduces', 'announcing', 'announces', 'launching', 'launches', 'launched', 'releasing', 'releases', 'released', 'updating', 'updates', 'updated', 'unveils', 'unveiling', 'debuted', 'debuts', 'opens', 'opensourcing']);
  const enWords = lower.match(/[a-z0-9][a-z0-9-]*/g) || [];
  let bestEn = '';
  for (let i = 0; i < enWords.length; i++) {
    if (STOP.has(enWords[i])) continue; // 跳过动作/停用词
    for (let j = i + 2; j <= Math.min(i + 5, enWords.length); j++) {
      const seq = enWords.slice(i, j);
      const joined = seq.join(' ');
      if (joined.length > bestEn.length) bestEn = joined;
    }
  }
  if (bestEn.length >= 6) return bestEn;
  // 中文：取最长连续中文片段
  const zhSeq = (title.match(/[\u4e00-\u9fa5]{2,}/g) || []);
  let bestZh = '';
  for (const s of zhSeq) if (s.length > bestZh.length) bestZh = s;
  if (bestZh.length >= 2) return bestZh;
  return bestEn;
}

// ========== UUID / ID 生成 ==========

export function genEventId(date: string, seq: number, prefix = 'evt'): string {
  return `${prefix}_${date.replace(/-/g, '')}_${String(seq).padStart(3, '0')}`;
}

export function genReportId(date: string): string {
  return `report_${date.replace(/-/g, '')}`;
}

export function genTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
