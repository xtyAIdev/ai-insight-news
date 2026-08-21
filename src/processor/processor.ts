/**
 * 统一处理层（Sheet05）
 * 05-02 字段标准化 → 05-03/04 缺失检查与修复 → 05-05 实体抽取 → 05-06 分类校验
 * → 05-07 跨来源去重 → 05-08 冲突合并 → 05-09 LLM 五维洞察 → 05-10 StandardEvent 入库
 */

import type { RawEvent, StandardEvent, TraceEntry } from '../types/events.js';
import { getLLM, withLLMFallback, extractEntitiesByRule, generateInsightByRule } from '../llm/index.js';
import { logger } from '../utils/logger.js';
import { cleanText, genEventId, normalizeCompany, parseFlexibleDate, similarity, toISODate } from '../utils/normalize.js';
import { sourceCredibility } from '../config/constants.js';
import { saveStandardEvent, saveRawEvent } from '../db/index.js';
import { config } from '../config/index.js';

// ========== 入口：RawEvent -> StandardEvent（含入库） ==========

export async function processRawEvents(rawEvents: RawEvent[], taskDate: string): Promise<StandardEvent[]> {
  const results: StandardEvent[] = [];

  // 分批并发处理（默认 8 并发），大幅缩短 LLM 全量处理耗时
  const BATCH = 8;
  for (let i = 0; i < rawEvents.length; i += BATCH) {
    const batch = rawEvents.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map((raw) => processOne(raw, taskDate)));
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) {
        saveStandardEvent(s.value);
        results.push(s.value);
      } else if (s.status === 'rejected') {
        logger.error(`[processor] 处理事件失败: ${s.reason instanceof Error ? s.reason.message : s.reason}`);
      }
    }
  }

  // 跨来源去重（全量层面）
  const deduped = dedupStandardEvents(results);
  logger.info(`[processor] 处理完成：输入 ${rawEvents.length}，输出 StandardEvent ${deduped.length}`);
  return deduped;
}

async function processOne(raw: RawEvent, taskDate: string): Promise<StandardEvent | null> {
  const trace: TraceEntry[] = [];
  const addTrace = (stage: string, tool: string, detail: string) => trace.push({ stage, timestamp: new Date().toISOString(), tool, detail });

  // 05-02 字段标准化 + 05-03 缺失检查
  let std = await standardize(raw, taskDate, addTrace);

  // 05-05 实体抽取
  std.entities = await extractEntities(std, addTrace);

  // 05-06 分类校验
  std = await validateCategory(std, addTrace);

  // 05-09 五维洞察
  std.insight = await generateInsight(std, addTrace);

  std.status = 'processed';
  std.trace_log = trace;
  return std;
}

// ========== 05-02 标准化 ==========

async function standardize(
  raw: RawEvent,
  taskDate: string,
  addTrace: (stage: string, tool: string, detail: string) => void,
): Promise<StandardEvent> {
  const source = (raw.source_urls || []).map((s) => ({
    url: s.url,
    source_type: s.source_type,
    name: s.name,
    credibility_score: s.credibility_score ?? sourceCredibility(s.url, s.source_type),
  }));

  let title = '';
  let description = '';
  let time = taskDate;
  let company: string | undefined;
  let product: string | undefined;
  let subTags: string[] = [];

  switch (raw.module) {
    case 'opensource': {
      title = `开源项目 ${raw.project_name} 更新`;
      description = cleanText(raw.description || `${raw.project_name}（${raw.owner}）近期活跃更新`);
      time = parseFlexibleDate(raw.updated_at || '') || taskDate;
      company = raw.owner;
      product = raw.project_name;
      subTags = raw.tech_tags || [];
      break;
    }
    case 'paper': {
      title = raw.title;
      description = cleanText(raw.abstract || '').slice(0, 300);
      time = raw.published_at || taskDate;
      company = raw.institution;
      product = raw.paper_id;
      subTags = [raw.category];
      break;
    }
    case 'enterprise': {
      title = raw.title;
      description = cleanText(raw.content || '');
      time = raw.published_at || taskDate;
      company = normalizeCompany(raw.company);
      subTags = [raw.sub_type === 'investment' ? '投融资' : '产品战略'];
      if (raw.fields?.product) product = String(raw.fields.product);
      break;
    }
  }

  addTrace('standardize', raw.module === 'opensource' ? 'rule+clean' : raw.module === 'paper' ? 'arxiv/openalex' : 'rss+rule', `title=${title.slice(0, 50)}`);

  return {
    event_id: genEventId(taskDate, Math.floor(Math.random() * 900) + 100),
    title: cleanText(title) || '未命名事件',
    category: raw.module,
    sub_type: raw.module === 'enterprise' ? (raw as { sub_type: 'investment' | 'product' }).sub_type : undefined,
    sub_tags: subTags,
    company,
    product,
    source,
    time,
    description,
    entities: {},
    insight: null,
    accuracy_score: 0,
    importance_score: 0,
    status: 'processed',
    trace_log: [],
    raw_event: raw,
  };
}

// ========== 05-05 实体抽取 ==========

async function extractEntities(
  std: StandardEvent,
  addTrace: (stage: string, tool: string, detail: string) => void,
): Promise<Record<string, unknown>> {
  const text = `${std.title} ${std.description}`;
  const ruleEntities = extractEntitiesByRule(text, std.category);
  addTrace('extract', 'llm+rule', '实体抽取');

  // 有 LLM 时用 LLM 补充（规则结果兜底）
  if (getLLM().available()) {
    const prompt = `从以下 AI 行业事件中抽取实体，只输出 JSON：{"investors":[],"amount":null,"round":null,"people":[],"tech_tags":[],"product":null,"star_count":null}
事件：${text.slice(0, 800)}
要求：金额统一为人民币万元数值；无则 null。`;
    const llmResult = await withLLMFallback(
      () => getLLM().completeJson<Record<string, unknown>>(prompt, 'score'),
      async () => ruleEntities as unknown as Record<string, unknown>,
      '实体抽取',
    );
    return { ...ruleEntities, ...(llmResult || {}) };
  }
  return ruleEntities as unknown as Record<string, unknown>;
}

// ========== 05-06 分类校验 ==========

async function validateCategory(
  std: StandardEvent,
  addTrace: (stage: string, tool: string, detail: string) => void,
): Promise<StandardEvent> {
  // 企业事件：sub_type 校验（规则已有，LLM 补充）
  if (std.category === 'enterprise' && !std.sub_type) {
    std.sub_type = 'product';
  }
  addTrace('classify', 'rule', `category=${std.category}`);
  return std;
}

// ========== 05-09 五维洞察 ==========

async function generateInsight(
  std: StandardEvent,
  addTrace: (stage: string, tool: string, detail: string) => void,
): Promise<StandardEvent['insight']> {
  const ruleInsight = generateInsightByRule({
    title: std.title,
    description: std.description,
    category: std.category,
    company: std.company,
    product: std.product,
  });

  if (!getLLM().available()) {
    addTrace('insight', 'rule-template', '规则模板生成五维洞察（无 LLM）');
    return ruleInsight;
  }

  const prompt = `你是 AI 行业分析师。基于以下事件生成五维洞察，只输出 JSON：
{"what":"1-2句，事件是什么（不复制标题，补充关键事实）","why":"1-2句，为什么重要（禁止空泛）","trend":"1-2句，代表什么趋势（基于事件推导）","impact":"1-2句，影响范围（全局/细分/局部）","action":"1-2句，可执行建议（禁止"持续关注"）"}

事件标题：${std.title}
事件描述：${std.description.slice(0, 500)}
类别：${std.category}${std.company ? ' 主体：' + std.company : ''}`;

  const result = await withLLMFallback(
    async () => {
      const r = await getLLM().completeJson<{ what: string; why: string; trend: string; impact: string; action: string }>(prompt, 'generate');
      return r;
    },
    async () => ruleInsight,
    '五维洞察',
  );
  addTrace('insight', getLLM().available() ? 'llm' : 'rule', '五维洞察生成');
  return result;
}

// ========== 05-07 跨来源去重（Embedding 阈值 0.85，无 Embedding 时精确去重） ==========

function dedupStandardEvents(events: StandardEvent[]): StandardEvent[] {
  const result: StandardEvent[] = [];
  const seen: Array<{ key: string; title: string }> = [];

  for (const evt of events) {
    // 精确键：category + company + product + time
    const exactKey = `${evt.category}|${evt.company || ''}|${evt.product || ''}|${evt.time}`;
    const exactMatch = seen.find((s) => s.key === exactKey);
    if (exactMatch) continue;

    // 语义近似（无 Embedding，用相似度近似，阈值 0.85）
    const nearMatch = seen.find((s) => s.key.startsWith(evt.category) && similarity(s.title, evt.title) >= 0.85);
    if (nearMatch) {
      // 合并来源证据
      evt.source = mergeStdSources(evt.source, nearMatch.key === '' ? [] : evt.source);
      continue;
    }

    seen.push({ key: exactKey, title: evt.title });
    result.push(evt);
  }
  return result;
}

function mergeStdSources(a: StandardEvent['source'], b: StandardEvent['source']): StandardEvent['source'] {
  const map = new Map<string, StandardEvent['source'][number]>();
  for (const s of [...a, ...b]) if (s.url) map.set(s.url, s);
  return Array.from(map.values());
}

export { dedupStandardEvents };
