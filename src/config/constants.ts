/**
 * 全局常量与配置数据
 * - 关键词库（Sheet02 R13-R19）
 * - 企业关注池（Sheet04 R12-R21）
 * - 数据源清单（Sheet02 R22-R29 / Sheet03 R20-R24 / Sheet04）
 * - 过滤阈值（Sheet02 R31-R37 / Sheet03 R26-R30）
 * - 信源等级表（Sheet06 R12-R17）
 * - 分支关键词（Sheet04 R23-R25）
 */

import type { EnterpriseSubType, SourceEvidence } from '../types/events.js';

// ========== 开源技术关键词库（Sheet02 R13-R19） ==========

export interface OpenSourceKeyword {
  topic: string;          // 研究方向
  githubQuery: string;    // GitHub Query 模板（pushed:>DATE 运行时替换）
  trendingPeriod: 'daily' | 'weekly' | 'monthly';
  modelscopeKeyword: string;
  languages: string[];    // 语言偏好，默认 TypeScript/Python/Java 优先
  tags: string[];         // sub_tags
}

export const OPEN_SOURCE_KEYWORDS: OpenSourceKeyword[] = [
  { topic: 'LLM', githubQuery: 'topic:llm pushed:>{date}', trendingPeriod: 'weekly', modelscopeKeyword: 'llm', languages: ['TypeScript', 'Python', 'Java'], tags: ['大模型', 'LLM'] },
  { topic: 'Agent', githubQuery: 'topic:agent pushed:>{date}', trendingPeriod: 'daily', modelscopeKeyword: 'agent', languages: ['TypeScript', 'Python', 'Java'], tags: ['Agent', '智能体'] },
  { topic: 'RAG', githubQuery: 'topic:rag pushed:>{date}', trendingPeriod: 'weekly', modelscopeKeyword: 'rag', languages: ['TypeScript', 'Python'], tags: ['RAG', '检索增强'] },
  { topic: 'MCP', githubQuery: 'topic:mcp pushed:>{date}', trendingPeriod: 'daily', modelscopeKeyword: 'mcp', languages: ['TypeScript', 'Python', 'Java'], tags: ['MCP', '模型上下文协议'] },
  { topic: 'AI Infra', githubQuery: 'ai-infra inference in:name,description pushed:>{date}', trendingPeriod: 'weekly', modelscopeKeyword: 'inference', languages: ['Python', 'C++', 'Rust'], tags: ['AI Infra', '推理优化'] },
  { topic: '开源模型', githubQuery: 'topic:llm created:>{date} stars:>100', trendingPeriod: 'weekly', modelscopeKeyword: '', languages: ['Python'], tags: ['开源模型'] },
  { topic: 'CUDA/GPU', githubQuery: 'cuda gpu in:name,description pushed:>{date}', trendingPeriod: 'weekly', modelscopeKeyword: '', languages: ['C++', 'Python', 'CUDA'], tags: ['GPU', 'CUDA'] },
];

// 开源采集数据源优先级（Sheet02 R22-R29）
export const OPEN_SOURCE_SOURCES = [
  { key: 'github_api', name: 'GitHub Search API', priority: 1, type: 'api' },
  { key: 'github_trending', name: 'github-trending-cn 技能', priority: 2, type: 'skill' },
  { key: 'modelscope', name: 'ModelScope OpenAPI', priority: 3, type: 'api' },
  { key: 'huggingface', name: 'HuggingFace API', priority: 4, type: 'api' },
  { key: 'gitee', name: 'Gitee API', priority: 5, type: 'api' },
  { key: 'websearch', name: 'WebSearch 兜底', priority: 6, type: 'websearch' },
] as const;

// 开源过滤阈值（Sheet02 R31-R37）
export const OPEN_SOURCE_FILTER = {
  starGrowthWeek: 500,     // stars 周增长率 ≥ 500（降级后 ≥ 200）
  starGrowthWeekDegraded: 200,
  starGrowthDay: 50,       // 日增长率 ≥ 50（降级后 ≥ 30）
  starGrowthDayDegraded: 30,
  commit7d: 3,             // 近7日 commit ≥ 3（降级后 ≥ 1）
  commit7dDegraded: 1,
  contributors: 2,         // 贡献者 ≥ 2（降级后 ≥ 1）
  contributorsDegraded: 1,
};

// ========== 学术研究（Sheet03 R12-R18 / R20-R24 / R26-R30） ==========

export interface PaperTopic {
  topic: string;
  arxivCategories: string[]; // arXiv 分类
  tags: string[];
  searchKeywords: string[];
}

export const PAPER_TOPICS: PaperTopic[] = [
  { topic: 'LLM', arxivCategories: ['cs.CL', 'cs.LG'], tags: ['大模型'], searchKeywords: ['large language model', 'LLM', 'foundation model'] },
  { topic: 'Reasoning', arxivCategories: ['cs.AI', 'cs.LG'], tags: ['推理'], searchKeywords: ['reasoning', 'chain of thought', 'inference'] },
  { topic: 'RAG', arxivCategories: ['cs.IR', 'cs.CL', 'cs.AI'], tags: ['RAG'], searchKeywords: ['retrieval augmented', 'RAG', 'retrieval'] },
  { topic: 'RL', arxivCategories: ['cs.LG', 'cs.AI'], tags: ['强化学习'], searchKeywords: ['reinforcement learning', 'RLHF'] },
  { topic: '多模态', arxivCategories: ['cs.CV', 'cs.MM', 'cs.LG'], tags: ['多模态'], searchKeywords: ['multimodal', 'vision language', 'VL'] },
  { topic: 'Agent', arxivCategories: ['cs.AI', 'cs.MA'], tags: ['Agent'], searchKeywords: ['agent', 'multi-agent'] },
];

// 已知机构（影响力判断，Sheet03 R29）
export const KNOWN_INSTITUTIONS = [
  'openai', 'anthropic', 'google', 'deepmind', 'meta', 'microsoft', 'nvidia', 'stanford',
  'mit', 'berkeley', 'cmu', 'princeton', 'oxford', 'cambridge', '清华', '北大', '上海交大',
  '中科院', '浙大', '港大', '港中文', '哈工大', '复旦', '南大', '腾讯', '阿里', '字节',
];

// ========== 企业关注池（Sheet04 R12-R21，默认 9 家） ==========

export interface EnterpriseProfile {
  company: string;
  aliases: string[];
  officialSources: string[]; // 官方信源 URL（RSS/页面）
  domesticSources?: string[]; // 国内官方源
  fallback: string[];        // 补充信源（媒体/聚合）
}

export const ENTERPRISE_POOL: EnterpriseProfile[] = [
  // 海外官方源：2026-08-24 实测 —— OpenAI /news/rss.xml 可用(307→跟随)；Anthropic HTML 可用；Google 需用 /innovation-and-ai/ 新路径；Meta 超时/Microsoft 403(Cloudflare) 属网络不可达，采集时自动跳过
  { company: 'OpenAI', aliases: ['OpenAI Inc'], officialSources: ['https://openai.com/news/rss.xml'], fallback: ['techcrunch', 'theverge'] },
  { company: 'Anthropic', aliases: ['Anthropic'], officialSources: ['https://www.anthropic.com/news'], fallback: ['techcrunch'] },
  { company: 'Google', aliases: ['Google DeepMind', 'Gemini'], officialSources: ['https://blog.google/innovation-and-ai/technology/ai/rss/'], fallback: ['theverge'] },
  { company: 'Meta', aliases: ['Meta AI', 'Facebook'], officialSources: ['https://ai.meta.com/blog/rss/'], fallback: ['theverge'] },
  { company: '字节跳动', aliases: ['ByteDance', '火山引擎', '豆包', 'Seed'], officialSources: [], domesticSources: ['https://seed.bytedance.com/zh/blog'], fallback: ['36kr', '机器之心'] },
  { company: '阿里巴巴', aliases: ['阿里', '通义', '阿里云', 'Qwen', 'Alibaba'], officialSources: [], domesticSources: ['https://tongyi.aliyun.com/'], fallback: ['36kr', '机器之心'] },
  { company: '腾讯', aliases: ['Tencent', '混元', '腾讯云', '元宝'], officialSources: [], domesticSources: ['https://hunyuan.tencent.com/'], fallback: ['36kr', '机器之心'] },
  { company: '月之暗面', aliases: ['Moonshot AI', 'Kimi', '月之暗面'], officialSources: [], domesticSources: ['https://www.kimi.com/blog'], fallback: ['36kr'] },
  { company: 'DeepSeek', aliases: ['DeepSeek AI', '深度求索'], officialSources: [], domesticSources: ['https://api-docs.deepseek.com/news'], fallback: ['36kr', '机器之心'] },
];

// 投融资触发关键词（Sheet04 R24）
export const INVESTMENT_KEYWORDS = ['融资', '投资', '并购', '上市', '股权', '定增', 'IPO', '估值', '收购'];
// 产品与战略触发关键词（Sheet04 R25）
export const PRODUCT_KEYWORDS = ['发布', '更新', '上线', '产品', '版本', '合作', '战略', '组织调整', '开源', 'API', '定价', '模型'];

// ========== 信源等级表（Sheet06 R12-R17） ==========

export interface SourceLevelRule {
  level: 'S' | 'A' | 'B' | 'C' | 'D';
  score: number;
  match: (url: string, sourceType: string) => boolean;
  desc: string;
}

export const S_DOMAINS = ['openai.com', 'anthropic.com', 'github.com', 'arxiv.org', 'deepseek.com', 'qwen', 'modelscope.cn', 'huggingface.co', 'seed.bytedance.com', 'hunyuan.tencent.com', 'kimi.com'];
export const A_DOMAINS = ['crunchbase.com', 'itjuzi.com', 'openreview.net', 'semanticscholar.org', 'api.openalex.org', 'openalex.org', 'modelscope.cn', 'huggingface.co'];
export const B_DOMAINS = ['36kr.com', 'techcrunch.com', 'jiqizhixin.com', 'infoq.cn', 'theverge.com', 'sspai.com', 'geekpark.net', 'ifanr.com', 'woshipm.com', 'qq.com'];
export const C_DOMAINS = ['news.ycombinator.com', 'reddit.com', 'medium.com', 'zhihu.com', 'juejin.cn', 'csdn.net'];

export function sourceCredibility(url: string, sourceType: string): number {
  const u = (url || '').toLowerCase();
  if (sourceType === 'github_repo') return 5;
  if (sourceType === 'arxiv') return 5;
  if (sourceType === 'official_rss' || sourceType === 'official') return 5;
  if (S_DOMAINS.some((d) => u.includes(d))) return 5;
  if (A_DOMAINS.some((d) => u.includes(d))) return 4.5;
  if (B_DOMAINS.some((d) => u.includes(d))) return 4;
  if (C_DOMAINS.some((d) => u.includes(d))) return 3;
  if (!url) return 1;
  return 2;
}

export function sourceLevel(url: string, sourceType: string): SourceLevelRule['level'] {
  const s = sourceCredibility(url, sourceType);
  if (s >= 5) return 'S';
  if (s >= 4.5) return 'A';
  if (s >= 4) return 'B';
  if (s >= 3) return 'C';
  return 'D';
}

// ========== 五维洞察 Prompt 约束（Sheet05 R13-R18） ==========

export const INSIGHT_CONSTRAINTS = {
  what: '1-2 句话说明事件是什么（不可复制标题，补充关键事实）',
  why: '1-2 句话说明为什么重要（禁止泛泛而谈）',
  trend: '1-2 句话判断代表什么趋势（必须基于事件本身推导）',
  impact: '1-2 句话说明影响范围：全局/细分/局部（禁止未指明范围）',
  action: '1-2 句话给出可执行建议或产品启示（禁止"持续关注"等空话）',
};

// ========== 报告质量检查清单（Sheet07 R18-R23） ==========

export const REPORT_QC_RULES = [
  { key: 'fields', name: '字段完整性', rule: '四区块齐全、事件字段完整' },
  { key: 'citations', name: '引用检查', rule: '每条事件 ≥1 个可点击来源 URL' },
  { key: 'format', name: '格式检查', rule: '统一模板、无残留占位符' },
  { key: 'date', name: '日期一致性', rule: '日报日期与事件时间范围匹配' },
  { key: 'no_empty', name: '无空模块', rule: '每模块有内容或标注"今日无重大动态"' },
];

// ========== 演示/兜底数据标记 ==========

export const DEMO_TAG = 'demo';
