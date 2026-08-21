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

export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  const setA = new Set(la.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '').match(/[\u4e00-\u9fa5]|[a-z0-9]+/g) || []);
  const setB = new Set(lb.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '').match(/[\u4e00-\u9fa5]|[a-z0-9]+/g) || []);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / (setA.size + setB.size - inter);
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
