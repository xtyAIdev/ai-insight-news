/**
 * 统一处理层（Sheet05）
 * 05-02 字段标准化 → 05-03/04 缺失检查与修复 → 05-05 实体抽取 → 05-06 分类校验
 * → 05-07 跨来源去重 → 05-08 冲突合并 → 05-09 LLM 五维洞察 → 05-10 StandardEvent 入库
 */

import type { RawEvent, StandardEvent, TraceEntry } from '../types/events.js';
import { getLLM, withLLMFallback, extractEntitiesByRule, generateInsightByRule } from '../llm/index.js';
import { logger } from '../utils/logger.js';
import { cleanText, genEventId, normalizeCompany, parseFlexibleDate, sanitizeDate, similarity, extractCoreNoun, toISODate } from '../utils/normalize.js';
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
  // 日期真实性：未知日期默认空字符串（绝不默认今天）；由评估层对 date_missing 事件扣分并阻止进入 TopN
  let time = '';
  let company: string | undefined;
  let product: string | undefined;
  let subTags: string[] = [];

  switch (raw.module) {
    case 'opensource': {
      title = `开源项目 ${raw.project_name} 更新`;
      description = cleanText(raw.description || `${raw.project_name}（${raw.owner}）近期活跃更新`);
      time = sanitizeDate(raw.updated_at);
      company = raw.owner;
      product = raw.project_name;
      subTags = raw.tech_tags || [];
      break;
    }
    case 'paper': {
      title = raw.title;
      description = cleanText(raw.abstract || '').slice(0, 300);
      time = sanitizeDate(raw.published_at);
      company = raw.institution;
      product = raw.paper_id;
      subTags = [raw.category];
      break;
    }
    case 'enterprise': {
      title = raw.title;
      description = cleanText(raw.content || '');
      time = sanitizeDate(raw.published_at);
      company = normalizeCompany(raw.company);
      subTags = [raw.sub_type === 'investment' ? '投融资' : '产品战略'];
      if (raw.fields?.product) product = String(raw.fields.product);
      break;
    }
  }

  addTrace('standardize', raw.module === 'opensource' ? 'rule+clean' : raw.module === 'paper' ? 'arxiv/openalex' : 'rss+rule', `title=${title.slice(0, 50)}${time ? '' : '，日期未知(未默认今天)'}`);

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
    added_at: taskDate,
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
// 优化（2026-08-25）：双通道去重 ——
//   ① 归一化键通道：category + normalizeCompany + 核心名词（提取产品/项目名），同键必合并
//   ② 相似度通道：正文/标题 Jaccard 阈值降至 0.72（原 0.85 过高，同一事实不同措辞漏合并）
// 合并取"信息更全者"（较长 description 优先），source 证据合并去重，trace 追加合并记录。

function dedupStandardEvents(events: StandardEvent[]): StandardEvent[] {
  const result: StandardEvent[] = [];
  const seen: Array<{ normKey: string; title: string; desc: string }> = [];

  for (const evt of events) {
    // 归一化键：
    //   - opensource：直接用 product（repo 名）作强键（机械标题"开源项目 X 更新"的 coreNoun 会误提取成"开源项目"，必须跳过）
    //   - 其他模块：category + 公司 + 核心名词
    const coreNoun = evt.category === 'opensource' ? (evt.product || '') : (extractCoreNoun(evt.title) || evt.product || '');
    const normKey = [evt.category, normalizeCompany(evt.company || ''), coreNoun].filter(Boolean).join('|');

    // ① 归一化键强匹配：同公司同核心名词 → 必合并（跨源同事实）
    const normMatch = normKey.length > 0 ? seen.find((s) => s.normKey === normKey) : undefined;
    // ② 相似度匹配：标题 Jaccard >= 0.55 → 合并（同事实不同措辞，Jaccard 对中文偏严，阈值保守）
    //    开源模块跳过相似度通道（机械标题"开源项目 X 更新"彼此高度相似，只能靠 product 强键区分）
    const nearMatch = evt.category === 'opensource'
      ? undefined
      : seen.find((s) => s.normKey.split('|')[0] === evt.category && similarity(s.title, evt.title) >= 0.55);

    const dup = normMatch || nearMatch;
    if (dup) {
      // 合并来源证据 + 取信息更全者（较长 description 优先）
      const existing = result[seen.indexOf(dup)];
      existing.source = mergeStdSources(existing.source, evt.source);
      if ((evt.description || '').length > (existing.description || '').length) {
        existing.description = evt.description;
      }
      if (!existing.entities || Object.keys(existing.entities).length === 0) existing.entities = evt.entities || {};
      existing.trace_log.push({ stage: 'dedup', timestamp: new Date().toISOString(), tool: 'rule', detail: `合并重复事件: ${evt.title} → ${existing.title}` });
      continue;
    }

    seen.push({ normKey, title: evt.title, desc: evt.description || '' });
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
