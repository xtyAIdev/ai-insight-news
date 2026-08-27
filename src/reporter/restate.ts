/**
 * 英文内容中文重述（报告层前置步骤）
 *
 * 目的：让日报以中文为第一语言 —— 对 TopN 事件做"理解后重述"而非机械翻译：
 *  - 标题：英文/机械标题 → 分析式中文标题（如 "Codex 订阅用量限制..."，不机械保留 "开源项目 X 更新"）
 *  - 正文：英文摘要/描述 → 中文重述（保留事实与数字，不逐字翻译）
 *
 * 降级链：
 *  ① 无 LLM（未配 Key）→ 规则模板兜底（标题仅做模板化改写，正文保留原文并标注）
 *  ② LLM 调用失败 / 输出异常 → 该条单独降级，不阻塞其他条
 * 并发：TopN 事件批量并发调用（默认 4 并发），单条超时 30s。
 */

import type { StandardEvent } from '../types/events.js';
import { getLLM, withLLMFallback } from '../llm/index.js';
import { buildFacts } from '../evaluator/evaluator.js';
import { logger } from '../utils/logger.js';

export interface RestateResult {
  /** 重述后的标题（中文） */
  title: string;
  /** 重述后的正文（中文）；空串表示无正文可重述 */
  body: string;
  /** 是否由 LLM 重述（false = 规则兜底） */
  byLLM: boolean;
  /** 快评（"发生了什么+快评"结构）；LLM 重述时生成，规则兜底可空 */
  comment?: string;
}

const CJK_RE = /[\u4e00-\u9fa5]/;
const CONCURRENCY = 4;

/** 判断标题是否已含中文（无需重述） */
function isChineseText(s: string): boolean {
  return CJK_RE.test(s || '');
}

/** 企业池（公司名 + 别名），用于规则翻译时提取主体 */
const KNOWN_AI_ORGS: Array<{ name: string; aliases: string[] }> = [
  { name: 'OpenAI', aliases: ['OpenAI Inc', 'OpenAI'] },
  { name: 'Anthropic', aliases: ['Anthropic'] },
  { name: 'Google', aliases: ['Google DeepMind', 'Google', 'Gemini', 'DeepMind'] },
  { name: 'Meta', aliases: ['Meta AI', 'Meta', 'Facebook'] },
  { name: 'Microsoft', aliases: ['Microsoft', '微软'] },
  { name: 'NVIDIA', aliases: ['NVIDIA', '英伟达'] },
  { name: '字节跳动', aliases: ['ByteDance', '字节跳动', '火山引擎', '豆包', 'Seed'] },
  { name: '阿里巴巴', aliases: ['Alibaba', '阿里巴巴', '阿里', '通义', '阿里云', 'Qwen'] },
  { name: '腾讯', aliases: ['Tencent', '腾讯', '混元', '腾讯云', '元宝'] },
  { name: '月之暗面', aliases: ['Moonshot AI', '月之暗面', 'Kimi'] },
  { name: 'DeepSeek', aliases: ['DeepSeek AI', 'DeepSeek', '深度求索'] },
  { name: 'Hugging Face', aliases: ['Hugging Face', 'HuggingFace'] },
  { name: 'Mistral', aliases: ['Mistral AI', 'Mistral'] },
  { name: 'xAI', aliases: ['xAI', 'Grok'] },
  { name: 'Amazon', aliases: ['Amazon', 'AWS', 'Bedrock'] },
];

/** 英文动作词 → 中文（用于模板翻译） */
const EN_ACTION_MAP: Array<{ re: RegExp; zh: string }> = [
  { re: /launch(es|ed)?|unveil(s|ed)?|introduc(e|es|ed)|announce(s|d)?|debut(s|ed)?|release(s|d)?|rolls?\s*out/i, zh: '发布' },
  { re: /updat(e|es|ed)|upgrad(e|es|ed)|improve(s|d)?|version/i, zh: '更新' },
  { re: /open[- ]?source(s|d)?|open-sourcing/i, zh: '开源' },
  { re: /partner(s|ed|ing)?|collaborat(e|es|ed|ion)?|integrat(e|es|ed|ion)?/i, zh: '合作' },
  { re: /rais(e|es|ed|ing)\b|secures?\b|funding|investment|invests?\b|acquires?\b|acquisition/i, zh: '融资' },
  { re: /research|paper|study/i, zh: '研究' },
  // 财报类放最后（learning/report 等日常词易误匹配，优先级必须低于发布/更新）
  { re: /\b(report|earning|earnings)\b/i, zh: '发布财报' },
];

/** 从英文标题提取公司主体（优先企业池，其次常见组织词） */
function extractCompany(title: string): string | undefined {
  const t = title.toLowerCase();
  for (const org of KNOWN_AI_ORGS) {
    for (const alias of org.aliases) {
      if (t.includes(alias.toLowerCase())) return org.name;
    }
  }
  return undefined;
}

/** 英文标题中的主题词提取（论文/技术方向/产品），用于规则模板翻译时保留核心信息 */
const EN_TOPIC_MAP: Array<{ re: RegExp; zh: string }> = [
  { re: /large language model|llm|foundation model|language model/i, zh: '大模型' },
  { re: /reasoning|chain.?of.?thought|inference/i, zh: '推理' },
  { re: /retrieval|rag|augmented generation/i, zh: 'RAG' },
  { re: /reinforcement|rlhf/i, zh: '强化学习' },
  { re: /multimodal|vision.?language|image|video/i, zh: '多模态' },
  { re: /agent|multi.?agent/i, zh: 'Agent' },
  { re: /quantization|fpga|edge|on.?device|small.?sat/i, zh: '边缘部署' },
  { re: /bioinformatics|biology|medical|health/i, zh: '生物医药' },
  { re: /search|learning/i, zh: '搜索学习' },
  { re: /robot|humanoid/i, zh: '机器人' },
  { re: /security|safety|watermark/i, zh: '安全' },
];

/** 常见 AI 产品/模型名（用于规则翻译保留产品名） */
const EN_PRODUCT_MAP: Array<{ re: RegExp; name: string }> = [
  { re: /claude opus \d/i, name: 'Claude Opus' },
  { re: /claude\b/i, name: 'Claude' },
  { re: /gpt-?\d/i, name: 'GPT' },
  { re: /gemini/i, name: 'Gemini' },
  { re: /qwen/i, name: 'Qwen' },
  { re: /llama/i, name: 'Llama' },
  { re: /deepseek/i, name: 'DeepSeek' },
  { re: /mistral/i, name: 'Mistral' },
  { re: /grok/i, name: 'Grok' },
  { re: /copilot/i, name: 'Copilot' },
];

/** 规则兜底：机械标题模板化改写 + 英文标题中文模板翻译（不再原样保留纯英文） */
function ruleRestate(evt: StandardEvent): RestateResult {
  let title = evt.title;
  // opensource 的机械标题 "开源项目 X 更新" → "开源项目 X 近期活跃更新（⭐N stars）"
  const m = title.match(/^开源项目\s+(.+?)\s+更新$/);
  if (m) {
    const raw = evt.raw_event;
    const stars = raw && raw.module === 'opensource' && raw.stars > 0 ? `，⭐ ${raw.stars.toLocaleString()}` : '';
    title = `开源项目 ${m[1]} 近期活跃更新${stars}`;
  } else if (isChineseText(title)) {
    // 中文标题保持原样
  } else if (evt.category === 'paper') {
    // 论文专用路径：提取核心实体 + 主题方向（不走企业动态的"公司+动作+主题"模板，
    // 避免 "Retrieval" 被误判成 "RAG领域"、论文标题里的 learning/forecasting 被当成动作）
    // 实体优先级：insight.what 里的核心词（"MetaCaster 提出..."）> 英文摘要 > 英文标题
    const whatText = evt.insight?.what && isChineseText(evt.insight.what || '') ? evt.insight.what : '';
    const entity = (whatText ? extractCjkEntity(whatText) : '') || extractDescEntity(evt.description || '') || extractTitleEntity(title);
    const direction = paperDirection(title, evt.description || '');
    title = entity
      ? (direction ? `${entity}：${direction}` : entity)
      : (direction ? `${direction}方向研究新进展` : 'AI 学术研究最新动态');
  } else {
    // 英文标题：模板化中文翻译（公司名 + 动作词 + 主题词/产品名）
    // 公司名优先取标准化事件 company 字段（采集端已归属），其次从标题文本提取
    const company = evt.company && /[\u4e00-\u9fa5A-Za-z]/.test(evt.company) ? evt.company : (extractCompany(title) || '');
    const action = EN_ACTION_MAP.find(({ re }) => re.test(title))?.zh;
    const topic = EN_TOPIC_MAP.find(({ re }) => re.test(title))?.zh;
    const product = EN_PRODUCT_MAP.find(({ re }) => re.test(title))?.name;
    const subject = product || topic;
    // 标题缺信息量时，尝试从正文摘要提取首句核心实体（CamelCase / UPPER 词，如 MetaCaster、Action-Aligned）
    const descEntity = subject ? '' : extractDescEntity(evt.description || '');
    if (company) {
      title = action
        ? `${company}${action}${subject ? `${subject}新动态` : (descEntity || '新动态')}`
        : `${company}发布${subject ? `${subject}新动态` : (descEntity || '最新动态')}`;
    } else if (subject) {
      title = action ? `${subject}领域${action}新进展` : `${subject}领域发布最新动态`;
    } else if (descEntity) {
      title = descEntity;
    } else {
      // 无公司名无主题词：取英文标题前 3-4 个实义词作为信息量（避免空泛标题）
      const words = title.split(/[^a-zA-Z0-9]+/).filter((w) => w.length >= 3 && !['the', 'and', 'with', 'from', 'that', 'this', 'into', 'your', 'you', 'are', 'for', 'new', 'how', 'what', 'why', 'can', 'not', 'its', 'has', 'had', 'was', 'were', 'will'].includes(w.toLowerCase())).slice(0, 3);
      title = words.length >= 2
        ? `${words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} 动态`
        : 'AI 行业最新动态';
    }
  }
  // 正文兜底：纯英文正文 → 优先用规则五维洞察 what（中文、信息密度高，如论文的"提出某方法解决某问题"），
  // 其次规则级粗翻英文摘要（首句 + 主题词中文标注），避免英文摘要原样进日报
  let body = '';
  const desc = (evt.description || '').trim();
  if (desc && !isChineseText(desc)) {
    const what = evt.insight?.what && evt.insight.what !== evt.title && isChineseText(evt.insight.what)
      ? evt.insight.what.trim()
      : '';
    if (what) {
      body = what;
    } else {
      const zh = ruleTranslateAbstract(desc, title);
      body = zh || `（原文为英文，LLM 重述失败，正文保留英文原文供核对）\n\n${desc.slice(0, 500)}`;
    }
  }
  return { title, body, byLLM: false };
}

/** 从英文标题提取核心实体（CamelCase / 连字符 / 冒号前主体） */
function extractTitleEntity(title: string): string {
  // "MetaCaster: ..." 冒号前主体
  const colon = title.split(/[:：]/)[0]?.trim();
  const candidates: string[] = [];
  if (colon && /[a-zA-Z]/.test(colon)) {
    // 取冒号前最后一个词（常是核心方法名）
    const words = colon.split(/\s+/).filter((w) => /^[A-Z][a-zA-Z0-9-]*$/.test(w));
    if (words.length > 0) candidates.push(words[words.length - 1]);
  }
  const camel: string[] = title.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  const dashed: string[] = title.match(/\b[A-Z][A-Za-z]*-[A-Za-z]+\b/g) || [];
  const all = candidates.concat(camel, dashed).filter((w) => !['AI', 'LLM', 'RAG', 'CV', 'NLP', 'Meta'].includes(w));
  return all.sort((a, b) => b.length - a.length)[0] || '';
}

/** 论文主题方向（中文）：标题/摘要命中的 AI 方向关键词，取最具体的 1-2 个 */
function paperDirection(title: string, abstract: string): string {
  const text = `${title} ${abstract}`.toLowerCase();
  const hits: string[] = [];
  for (const { re, zh } of EN_TOPIC_MAP) {
    if (re.test(text) && !hits.includes(zh)) hits.push(zh);
  }
  // 优先级排序：Agent/大模型/多模态/推理 等具体方向优先；RAG/检索 次之
  const priority = ['Agent', '大模型', '多模态', '推理', '强化学习', 'RAG', '搜索学习', '机器人', '安全', '边缘部署', '生物医药'];
  hits.sort((a, b) => {
    const ia = priority.indexOf(a); const ib = priority.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return hits.slice(0, 2).join('+') || '';
}

/** 英文摘要规则级粗翻：截取前 2 句 + 中文主题词标注 + 数字/机构保留（LLM 失败时的可读降级） */
function ruleTranslateAbstract(abstract: string, zhTitle: string): string {
  const sentences = abstract.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const lead = sentences.slice(0, 2).join(' ').slice(0, 260);
  if (!lead) return '';
  // 主题词 → 中文（让粗翻带上领域上下文）
  const topics: string[] = [];
  for (const { re, zh } of EN_TOPIC_MAP) {
    if (re.test(lead)) topics.push(zh);
  }
  const topicNote = topics.length > 0 ? `（方向：${Array.from(new Set(topics)).join('/')}）` : '';
  return `${zhTitle}。${topicNote}论文摘要：${lead}…（LLM 重述失败，以上为规则级粗翻，原文保留供核对）`;
}

/** 从英文正文提取核心实体（CamelCase / 连字符 / 大写字首），用于规则翻译标题补足信息量。
 *  全正文扫描（不限首句），并排除形容词化/介词短语里的非核心词 */
function extractDescEntity(desc: string): string {
  if (!desc) return '';
  // 扫描整个正文：优先提取真正的方法/框架名（CamelCase、带连字符、或大写缩写）
  const camel: string[] = desc.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  const dashed: string[] = desc.match(/\b[A-Z][A-Za-z]*-[A-Za-z]+\b/g) || [];
  const upper: string[] = desc.match(/\b[A-Z]{2,}\b/g) || [];
  const cand = camel.concat(dashed, upper)
    .filter((w) => !['AI', 'LLM', 'RAG', 'CV', 'NLP', 'API', 'ML'].includes(w)) // 通用缩写无信息量
    .filter((w) => !/^(Meta|Self|Cross|Multi|Large)-/.test(w)) // 形容词前缀（Meta-Optimized）非核心实体
    .sort((a, b) => b.length - a.length);
  return cand[0] || '';
}

/** 从中文 insight.what 提取首词核心实体（英文专名/方法名，如 "MetaCaster 提出..." → MetaCaster） */
function extractCjkEntity(what: string): string {
  if (!what) return '';
  // 匹配开头或句中的英文专名（CamelCase / 带连字符 / 大写缩写），取最长
  const camel: string[] = what.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  const dashed: string[] = what.match(/\b[A-Z][A-Za-z]*-[A-Za-z]+\b/g) || [];
  const upper: string[] = what.match(/\b[A-Z]{2,}\b/g) || [];
  const cand = camel.concat(dashed, upper)
    .filter((w) => !['AI', 'LLM', 'RAG', 'CV', 'NLP', 'API', 'ML', 'arXiv'].includes(w))
    .sort((a, b) => b.length - a.length);
  return cand[0] || '';
}

interface LlmRestateItem {
  title: string;
  body: string;
  module: string;
  facts?: string;
}

/**
 * 对 TopN 事件做中文重述，返回 Map<event_id, RestateResult>。
 * @param events 入选 TopN 的标准化事件
 */
export async function restateEvents(events: StandardEvent[]): Promise<Map<string, RestateResult>> {
  const result = new Map<string, RestateResult>();
  if (events.length === 0) return result;

  const llmAvailable = getLLM().available();

  // 1. 需要重述的条目：标题或正文含英文，且标题非纯中文
  const needRestate = events.filter((e) => !isChineseText(e.title) || !isChineseText(e.description || ''));
  logger.info(`[reporter] 中文重述：${events.length} 条 TopN 中 ${needRestate.length} 条需处理（LLM: ${llmAvailable ? '可用' : '降级'})`);

  if (!llmAvailable) {
    for (const e of events) result.set(e.event_id, ruleRestate(e));
    return result;
  }

  // 2. 并发执行 LLM 重述
  const tasks: Array<{ evt: StandardEvent; item: LlmRestateItem }> = needRestate.map((e) => ({
    evt: e,
    // 2026-08-27 修复截断：正文输入从 400 提到 1500 字符（论文摘要常 800-2000 字，400 截断导致重述信息不全）
    item: { title: e.title, body: (e.description || '').slice(0, 1500), module: e.category, facts: buildFacts(e) || undefined },
  }));

  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const r = await restateOne(task.item);
      result.set(task.evt.event_id, r ?? ruleRestate(task.evt));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

  // 3. 未处理的条目（如纯中文标题）→ 规则兜底
  for (const e of events) {
    if (!result.has(e.event_id)) result.set(e.event_id, ruleRestate(e));
  }
  return result;
}

/** 单条 LLM 重述；失败返回 null（调用方规则兜底） */
async function restateOne(item: LlmRestateItem): Promise<RestateResult | null> {
  const prompt = `你是 AI 行业市场洞察编辑。将以下事件改写成中文，要求：
1. 标题：信息密度高的分析式中文标题（10-25 字），保留关键主体与动作，不要机械直译，不要加引号
2. 正文：3-5 句中文重述，完整覆盖原文核心事实（方法/数据/结论/意义），保留数字、产品名（产品名可保留英文原名），不要逐字翻译，不要遗漏原文关键信息
3. 快评：1-2 句"点评"（解读这件事为什么值得关注、影响是什么、预示什么趋势），要有观点、拒绝空泛套话（禁止"值得关注""具有重要意义"这类），不要复述标题内容
【事实红线】只允许陈述给定材料中出现的事实：
- 原材料未提及发布/更新/版本变更时，严禁使用"发布了""更新了""新版本""此次更新"等表述（仓库近期有 push 不等于发布了新版本）
- 严禁编造性能数据、合作方、时间线等任何原材料没有的细节
- 快评中的判断须标注为推断（如"若…则可能…"），不得写成既成事实
只输出 JSON：{"title":"中文标题","body":"中文正文","comment":"快评"}

模块：${item.module}
${item.facts ? `量化数据：${item.facts}\n` : ''}原标题：${item.title}
原正文：${item.body || '（无）'}`;

  return withLLMFallback(
    async () => {
      const r = await getLLM().completeJson<{ title?: string; body?: string; comment?: string }>(prompt, 'generate', { maxTokens: 1000, retries: 1 });
      if (!r) return null;
      const title = (r.title || '').trim();
      const body = (r.body || '').trim();
      const comment = (r.comment || '').trim();
      if (!title || !isChineseText(title)) return null; // 标题无中文视为失败
      return { title, body: body || '', byLLM: true, comment: comment || undefined };
    },
    async () => null,
    `中文重述(${item.title.slice(0, 30)})`,
  );
}
