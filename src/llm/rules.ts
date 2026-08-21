/**
 * 规则引擎规则函数 —— LLM 降级时的确定性实现
 * 覆盖：实体抽取、五维洞察、真实性判断、质量评分、事件分类、报告模板
 */

import type { Insight, SourceEvidence, StandardEvent } from '../types/events.js';
import { sourceCredibility } from '../config/constants.js';
import { similarity, cleanText } from '../utils/normalize.js';

// ========== 事件分类（Sheet04 04-04 / Sheet05 05-06） ==========

const INVESTMENT_WORDS = ['融资', '投资', '并购', '上市', '股权', '定增', 'IPO', '估值', '收购', '轮'];
const PRODUCT_WORDS = ['发布', '更新', '上线', '产品', '版本', '合作', '战略', '开源', 'API', '定价', '模型', '推出', '宣布'];

export function classifyByRule(title: string, content: string): 'investment' | 'product' {
  const text = `${title} ${content}`;
  let inv = 0;
  let prod = 0;
  for (const w of INVESTMENT_WORDS) if (text.includes(w)) inv++;
  for (const w of PRODUCT_WORDS) if (text.includes(w)) prod++;
  if (inv > prod) return 'investment';
  return 'product';
}

// ========== 实体抽取（正则，Sheet05 05-05） ==========

export interface RuleEntities {
  investors?: string[];
  amount?: number;
  round?: string;
  star_count?: number;
  tech_tags?: string[];
  product?: string;
  people?: string[];
  [k: string]: unknown;
}

export function extractEntitiesByRule(text: string, category: string): RuleEntities {
  const entities: RuleEntities = {};
  // 金额：X亿元 / X万元 / $X M
  const amountM = text.match(/(\d+(?:\.\d+)?)\s*亿\s*元?人民币?/) || text.match(/(\d+(?:\.\d+)?)\s*万\s*元?人民币?/) || text.match(/\$\s*(\d+(?:\.\d+)?)\s*(M|B)/i);
  if (amountM) {
    const n = +amountM[1];
    if (text.includes('亿')) entities.amount = n * 10000;
    else if (text.includes('万')) entities.amount = n;
    else entities.amount = amountM[2].toUpperCase() === 'B' ? n * 10000 : n * 100;
  }
  // 轮次
  const roundM = text.match(/(天使轮|种子轮|A\+?轮|B\+?轮|C\+?轮|D\+?轮|E\+?轮|Pre-?A轮|Pre-?B轮|Pre-?IPO轮|战略融资|IPO|并购)/);
  if (roundM) entities.round = roundM[1];
  // 投资方（“由X、Y领投/参投”）
  const investorM = text.match(/由(.{2,30}?)(?:领投|参投|投资|注资)/);
  if (investorM) entities.investors = investorM[1].split(/、|,|，|和|及/).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 5);
  // star 数
  const starM = text.match(/(\d+(?:\.\d+)?)\s*[kK万]?\s*star/i);
  if (starM) {
    let v = +starM[1];
    if (text.toLowerCase().includes('k star')) v *= 1000;
    if (text.includes('万star') || text.includes('万 star')) v *= 10000;
    entities.star_count = v;
  }
  // 技术标签
  const techTags: string[] = [];
  for (const t of ['LLM', 'Agent', 'RAG', 'MCP', '多模态', '推理', '强化学习', 'GPU', '大模型', '开源模型']) {
    if (text.includes(t)) techTags.push(t);
  }
  if (techTags.length) entities.tech_tags = techTags;
  return entities;
}

// ========== 五维洞察（规则模板，基于事实，Sheet05 R13-R18） ==========

export function generateInsightByRule(evt: {
  title: string;
  description: string;
  category: string;
  company?: string;
  product?: string;
}): Insight {
  const t = evt.title;
  const company = evt.company || '相关企业';
  const product = evt.product || '';
  const categoryLabel = evt.category === 'opensource' ? '开源项目' : evt.category === 'paper' ? '学术研究' : '企业动态';
  return {
    what: `事件为「${t}」。${evt.description ? cleanText(evt.description).slice(0, 80) : ''}`.slice(0, 120),
    why: `该事件属于${categoryLabel}领域的重要进展，主体为${company}${product ? '（' + product + '）' : ''}，对关注 AI 行业动态的受众具有参考价值。`,
    trend: `事件反映出 AI ${evt.category === 'opensource' ? '开源生态' : evt.category === 'paper' ? '学术研究' : '产业竞争'}仍在快速演进。`,
    impact: '影响范围：细分赛道。具体影响需结合后续数据验证。',
    action: '建议关注该主体的后续动态，并评估其与自身业务的关联度。',
  };
}

// ========== 真实性判断（信源等级换算，Sheet06 06-04） ==========

export function accuracyByRule(source: SourceEvidence[]): { score: number; reason: string } {
  if (!source || source.length === 0) return { score: 1, reason: '无来源证据，无法溯源' };
  const scores = source.map((s) => s.credibility_score ?? sourceCredibility(s.url, s.source_type));
  const max = Math.max(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  // 信息一致性：多源交叉加分
  const multiSourceBonus = source.length >= 2 ? Math.min(0.5, (source.length - 1) * 0.25) : 0;
  const score = Math.min(5, Math.round((max * 0.7 + avg * 0.3 + multiSourceBonus) * 10) / 10);
  return { score, reason: `规则计算：最高信源分 ${max}，${source.length >= 2 ? '多源交叉验证' : '单源'}，最终 ${score}` };
}

// ========== 质量评分（Sheet06 06-07） ==========

export function importanceByRule(evt: {
  accuracy: number;
  source: SourceEvidence[];
  sub_tags: string[];
  category: string;
  hasInsight: boolean;
}): number {
  let score = evt.accuracy * 0.6;
  // 信源丰富度
  score += Math.min(1, evt.source.length * 0.3);
  // 赛道热度
  const hotTags = ['大模型', 'Agent', 'RAG', 'MCP', '多模态', 'AI Infra', '开源模型'];
  score += evt.sub_tags.filter((t) => hotTags.includes(t)).length * 0.2;
  // 洞察完整
  if (evt.hasInsight) score += 0.3;
  return Math.min(5, Math.round(score * 10) / 10);
}

// ========== 去重相似度辅助 ==========

export function dedupSimilarity(a: string, b: string): number {
  return similarity(a, b);
}

export type { StandardEvent };
