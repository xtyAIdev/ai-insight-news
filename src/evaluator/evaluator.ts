/**
 * 评估层（Sheet06）
 * 06-02 规则过滤 → 06-04 LLM 真实性判断 → 06-06 Reflection（如需）
 * → 06-07 LLM 质量评分 → 06-08 排序建议 TopN → 06-09 高质量事件库
 */

import type { StandardEvent } from '../types/events.js';
import { getLLM, withLLMFallback, accuracyByRule, importanceByRule } from '../llm/index.js';
import { logger } from '../utils/logger.js';
import { saveHighQuality, updateEventStatus, recordSourceOk } from '../db/index.js';
import { webSearch } from '../utils/websearch.js';
import { sourceCredibility } from '../config/constants.js';
import { config } from '../config/index.js';

export interface EvalResult {
  events: StandardEvent[];        // 通过评估的事件（按 importance_score 降序）
  dropped: StandardEvent[];       // 被丢弃的事件
  topN: Array<{ event: StandardEvent; reason: string }>;
  topNByModule: Record<string, Array<{ event: StandardEvent; reason: string }>>;
}

// ========== 主流程 ==========

/**
 * 两阶段评估（性能优化）：
 *  Phase 1：规则粗评（真实性 + 重要性）—— 快速过滤，成本 O(1)/条
 *  Phase 2：仅对粗评 TopN×2 候选做 LLM 精评（真实性 + 重要性）—— LLM 调用量从 N 降到 2N
 *  Phase 3：按 reportDate 严格当天过滤 → 按模块 TopN 入选 + 排序理由
 * 规则分在 LLM 不可用/失败时自动兜底（与无 Key 路径一致）。
 *
 * @param reportDate 报告日期 YYYY-MM-DD；传入后 Phase 3 仅保留 time === reportDate 的事件
 *                   （用户硬约束：日报时间必须真实，不得混入历史事件）
 */
export async function evaluateEvents(events: StandardEvent[], topN: number, reportDate?: string): Promise<EvalResult> {
  const dropped: StandardEvent[] = [];

  // ---- Phase 1：规则过滤 + 规则粗评 ----
  const rough: Array<{ evt: StandardEvent; accuracy: { score: number; reason: string }; importance: number }> = [];
  for (const evt of events) {
    if (!ruleFilter(evt)) {
      evt.status = 'dropped';
      updateEventStatus(evt.event_id, 'dropped');
      dropped.push(evt);
      continue;
    }
    // 日期真实性：time 为空或已过期（非报告当天）→ date_missing（禁止未知日期默认今天）
    // 时间窗策略（2026-08-25 完善，解决企业模块当天无新闻导致整模块为空/旧闻混入）：
    //   - paper：近 7 天提交窗口（arXiv submittedDate 索引延迟，需求规格 3.4 按分类+日期检索）
    //   - enterprise：近 3 天窗口（官方源发布有 1-3 天延迟，当天往往无新动态；但超过 3 天的旧闻不混入日报）
    //   - opensource：严格当天（GitHub pushed_at 是实时的，不存在延迟）
    // 日报每条仍显式标注真实时间（如 8-24），绝不把历史事件标成"今天"。
    const windowOk = !reportDate ? true : evt.category === 'paper'
      ? !isOutsideWindow(evt.time, reportDate, 7)
      : evt.category === 'enterprise'
        ? !isOutsideWindow(evt.time, reportDate, 3)
        : evt.time === reportDate;
    const timeMissing = !evt.time || !windowOk;
    if (timeMissing && !reportDate) {
      // 未指定报告日时，以 added_at 兜底判断：time 必须存在
      evt.status = 'dropped';
      updateEventStatus(evt.event_id, 'dropped');
      dropped.push(evt);
      logger.debug(`[evaluator] 丢弃日期未知事件: ${evt.title}`);
      continue;
    }
    const accuracy = accuracyByRule(evt.source);
    const importance = importanceByRule({
      accuracy: accuracy.score,
      source: evt.source,
      sub_tags: evt.sub_tags,
      category: evt.category,
      hasInsight: !!evt.insight?.what,
      hasDate: !!evt.time,
    });
    rough.push({ evt, accuracy, importance });
  }

  // ---- Phase 2：仅对粗评靠前的候选做 LLM 精评（含真实性判断 + Reflection + 评分） ----
  rough.sort((a, b) => b.importance - a.importance);
  const candidateCount = Math.max(topN * 2, 6);
  const evaluated: StandardEvent[] = [];

  const BATCH = 6;
  for (let i = 0; i < rough.length; i += BATCH) {
    const batch = rough.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async ({ evt, accuracy: ruleAcc }) => {
      const isCandidate = i < candidateCount && getLLM().available();
      if (!isCandidate) {
        // 非候选：直接用规则分（不浪费 LLM 调用）
        evt.accuracy_score = ruleAcc.score;
        evt.importance_score = importanceByRule({
          accuracy: ruleAcc.score,
          source: evt.source,
          sub_tags: evt.sub_tags,
          category: evt.category,
          hasInsight: !!evt.insight?.what,
          hasDate: !!evt.time,
        });
        evt.status = 'evaluated';
        updateEventStatus(evt.event_id, 'evaluated', evt.importance_score);
        return evt;
      }
      // 候选：LLM 真实性判断 → 不足则 Reflection → LLM 评分
      const accuracy = await judgeAccuracy(evt, ruleAcc);
      evt.accuracy_score = accuracy.score;
      evt.trace_log.push({ stage: 'accuracy', timestamp: new Date().toISOString(), tool: accuracy.tool, detail: accuracy.reason });

      let finalAccuracy = accuracy;
      if (accuracy.score < 3) {
        finalAccuracy = await reflection(evt, accuracy);
        evt.accuracy_score = finalAccuracy.score;
        evt.trace_log.push({ stage: 'reflection', timestamp: new Date().toISOString(), tool: finalAccuracy.tool, detail: finalAccuracy.reason });
      }

      if (finalAccuracy.score < 3) {
        evt.status = 'dropped';
        updateEventStatus(evt.event_id, 'dropped');
        dropped.push(evt);
        logger.debug(`[evaluator] 候选事件丢弃（真实性不足）: ${evt.title} score=${finalAccuracy.score}`);
        return null;
      }

      const importance = await scoreImportance(evt);
      evt.importance_score = importance.score;
      evt.trace_log.push({ stage: 'score', timestamp: new Date().toISOString(), tool: importance.tool, detail: `importance=${importance.score}` });

      evt.status = 'evaluated';
      updateEventStatus(evt.event_id, 'evaluated', importance.score);
      return evt;
    }));    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) evaluated.push(s.value);
      else if (s.status === 'rejected') logger.warn(`[evaluator] 评估异常: ${s.reason instanceof Error ? s.reason.message : s.reason}`);
    }
  }

  // ---- Phase 3：排序 + 严格当天过滤 + 按模块 TopN（规格 Sheet06 06-09） ----
  evaluated.sort((a, b) => b.importance_score - a.importance_score);

  // 时间窗过滤：paper 近 7 天 / enterprise 近 3 天 / opensource 严格当天（与 Phase 1 一致）
  // 注意：过滤在排序后、按模块分组前执行，确保 TopN 都在各自窗口内且日期真实标注
  let pool = evaluated;
  if (reportDate) {
    const dayPool = evaluated.filter((e) => e.category === 'paper'
      ? !isOutsideWindow(e.time, reportDate, 7)
      : e.category === 'enterprise'
        ? !isOutsideWindow(e.time, reportDate, 3)
        : e.time === reportDate);
    if (dayPool.length > 0) {
      pool = dayPool;
    } else {
      logger.warn(`[evaluator] 报告日 ${reportDate} 各模块窗口内均无事件通过评估（共 ${evaluated.length} 条跨期），TopN 将为空 → 显示'今日无重大动态'`);
    }
  }

  const topNByModule: Record<string, Array<{ event: StandardEvent; reason: string }>> = {};
  const modules = Array.from(new Set(pool.map((e) => e.category)));
  const topNList: Array<{ event: StandardEvent; reason: string }> = [];

  for (const module of modules) {
    let moduleEvents = pool.filter((e) => e.category === module);
    // 企业动态模块：投融资与产品动态是双分支，保底 1 席投融资（避免被产品事件完全挤出）
    // 注意：必须在日期过滤之后执行，保证保底的是"当天"投融资
    if (module === 'enterprise') {
      const investment = moduleEvents.filter((e) => e.sub_type === 'investment');
      if (investment.length > 0) {
        moduleEvents = [...investment.slice(0, 1), ...moduleEvents.filter((e) => e.sub_type !== 'investment')];
      }
    }
    moduleEvents = moduleEvents.slice(0, topN);
    const moduleTop: Array<{ event: StandardEvent; reason: string }> = [];
    for (let i = 0; i < moduleEvents.length; i++) {
      const evt = moduleEvents[i];
      const reason = await rankReason(evt, i + 1);
      saveHighQuality(evt.event_id, evt.category, i + 1, reason);
      updateEventStatus(evt.event_id, 'reported');
      moduleTop.push({ event: evt, reason });
    }
    topNByModule[module] = moduleTop;
    topNList.push(...moduleTop);
  }

  logger.info(`[evaluator] 评估完成：通过 ${evaluated.length}，丢弃 ${dropped.length}，按模块 TopN ${modules.map((m) => `${m}:${(topNByModule[m] || []).length}`).join(',')}`);
  return { events: evaluated, dropped, topN: topNList, topNByModule };
}

/**
 * 时间窗判定：事件时间是否超出报告日指定天数窗口（用于 paper 7d / enterprise 3d）。
 * 超窗 = true（应滤掉）；窗口内 = false（时间有效）。
 * - 未来时间（时区/时差导致）一律滤掉
 * - 无日期一律视为超窗（绝不默认今天）
 */
function isOutsideWindow(time: string, reportDate: string, days: number): boolean {
  if (!time) return true; // 无真实日期 → 视为无效（绝不默认今天）
  const ref = new Date(`${reportDate}T12:00:00`).getTime();
  const t = new Date(`${time}T00:00:00`).getTime();
  if (Number.isNaN(ref) || Number.isNaN(t)) return true;
  const hours = (ref - t) / 3600_000;
  return hours < 0 || hours > days * 24;
}

// ========== 06-02 规则过滤（广告/重复/低价值） ==========

function ruleFilter(evt: StandardEvent): boolean {
  const text = `${evt.title} ${evt.description}`.toLowerCase();
  // 广告检测
  const adWords = ['限时优惠', '点击购买', '广告', 'sponsored', '推广合作', '加微信', '扫码咨询'];
  if (adWords.some((w) => text.includes(w))) return false;
  // 标题过短且无来源
  if (evt.title.length < 4 && evt.source.length === 0) return false;
  // 无来源证据
  if (evt.source.length === 0) return false;
  return true;
}

// ========== 06-04 真实性判断 ==========

async function judgeAccuracy(evt: StandardEvent, ruleAcc?: { score: number; reason: string }): Promise<{ score: number; reason: string; tool: string }> {
  const ruleResult = ruleAcc ?? accuracyByRule(evt.source);

  if (!getLLM().available()) {
    return { ...ruleResult, tool: 'rule-credibility' };
  }

  const prompt = `你是情报真实性审核员。基于以下事件及其来源证据，判断真实性并输出 0-5 分 JSON：
{"score":0.0,"reason":"一句话理由"}
评分标准：
- 5 分：官方公告/一手原文，信息具体可查证
- 4 分：权威媒体（TechCrunch/The Verge/路透/新华社等）报道
- 3 分：一般媒体报道，信息合理可信
- 2 分：来源不明或信息模糊
- 0-1 分：明显编造/谣言/标题党无实质内容
重要规则：以下"规则参考分"基于来源可信度自动计算，若规则分 >= 3，说明来源有基本可信度，除非信息本身明显矛盾或荒谬，否则不应判为 0-1 分（来源 URL 陌生不代表假新闻）。
规则参考分：${ruleResult.score}（${ruleResult.reason}）
事件：${evt.title}
描述：${evt.description.slice(0, 400)}
来源：${evt.source.map((s) => `${s.name}(${s.source_type}):${s.url}`).join('; ')}`;

  const result = await withLLMFallback(
    async () => {
      const r = await getLLM().completeJson<{ score: number; reason: string }>(prompt, 'judge');
      if (!r || typeof r.score !== 'number') return null;
      return { score: Math.max(0, Math.min(5, r.score)), reason: r.reason || '', tool: 'llm' };
    },
    async () => ({ ...ruleResult, tool: 'rule-fallback' }),
    '真实性判断',
  );
  return result;
}

// ========== 06-06 Reflection（搜索补证优先 + LLM 重判兜底，不再简单重评） ==========
// 优化（2026-08-25）：低可信事件 → ① webSearch 补证（命中权威源则追加证据+重算真实性）
//   → ② 搜索无权威源命中时，降级为 LLM 基于上下文重判（避免免费搜索源受限时误杀真实事件）
//   → ③ 仍低于阈值 → 丢弃

async function reflection(
  evt: StandardEvent,
  current: { score: number; reason: string; tool: string },
): Promise<{ score: number; reason: string; tool: string }> {
  let score = current.score;
  let reason = current.reason;
  let tool = current.tool;

  // ① 搜索补证：用事件核心信息构造查询，寻找权威源佐证
  const query = buildReflectionQuery(evt);
  const search = await webSearch(query, { limit: 5, maxAgeHours: 24 * 7 });
  if (search.ok && search.results.length > 0) {
    const credibleHits = search.results.filter((r) => sourceCredibilityOf(r.url) >= 4);
    if (credibleHits.length > 0) {
      const added: StandardEvent['source'] = credibleHits.slice(0, 3).map((r) => ({
        url: r.url,
        source_type: r.source === 'hackernews' ? 'hackernews' : 'websearch',
        name: r.source === 'hackernews' ? 'Hacker News' : r.title.slice(0, 40),
        credibility_score: sourceCredibilityOf(r.url),
        published_at: r.published_at,
      }));
      const existingUrls = new Set(evt.source.map((s) => s.url));
      const fresh = added.filter((s) => !existingUrls.has(s.url));
      if (fresh.length > 0) {
        evt.source.push(...fresh);
        recordSourceOk('reflection_websearch');
        const newAcc = accuracyByRule(evt.source);
        score = newAcc.score;
        reason = `${reason}；Reflection 搜索补证 ${fresh.length} 个权威来源，真实性重算为 ${newAcc.score}`;
        tool = 'reflection-search';
        if (score >= 3) {
          evt.trace_log.push({ stage: 'reflection', timestamp: new Date().toISOString(), tool: 'websearch', detail: `补证来源: ${fresh.map((s) => s.url).join(', ')}` });
          return { score, reason, tool };
        }
      }
    }
    // ② 无权威源命中：记录已查证，降级为 LLM 重判
    reason = `${reason}；Reflection 搜索 ${search.results.length} 条但无权威源佐证`;
    tool = 'reflection-searched';
  } else {
    reason = `${reason}；Reflection 搜索无结果（${search.error || 'empty'}）`;
    tool = 'reflection-noresult';
  }

  // ②③ LLM 重判兜底（避免免费搜索源受限时误杀真实事件）
  if (getLLM().available()) {
    const prompt = `重新评估该事件真实性（Reflection 查证后第 2 次判断）。事件：${evt.title}。来源：${evt.source.map((s) => s.url).join('; ')}。当前分 ${score}。规则参考分：${accuracyByRule(evt.source).score}（${accuracyByRule(evt.source).reason}）。注意：来源 URL 陌生不代表假新闻，若内容合理且来源有基本可信度应给 3 分以上。请判断是否可信，输出 JSON {"score":0.0,"reason":"..."}`;
    const r = await getLLM().completeJson<{ score: number; reason: string }>(prompt, 'judge');
    if (r && typeof r.score === 'number') {
      score = Math.max(0, Math.min(5, r.score));
      reason = r.reason || reason;
      tool = 'reflection-llm';
      if (score >= 3) return { score, reason, tool };
    }
  }

  // ③ 仍低于阈值 → 丢弃（低可信）
  score = Math.min(score, 2.9);
  return { score, reason: `${reason}；经 Reflection 补证/重判仍低于阈值`, tool };
}

/** 构造 Reflection 搜索查询：公司 + 核心名词 + 动作 */
function buildReflectionQuery(evt: StandardEvent): string {
  const parts: string[] = [];
  if (evt.company && /[\u4e00-\u9fa5A-Za-z]/.test(evt.company)) parts.push(evt.company);
  // 英文标题核心词（前 3 个实义词）或中文核心片段
  const words = (evt.title.match(/[a-z0-9][a-z0-9-]*/gi) || []).filter((w) => !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'new', 'how', 'why', 'what', 'are', 'was', 'were', 'has', 'had', 'its', 'into', 'you', 'your', 'can', 'not', 'will', 'announces', 'introduces', 'launching', 'releases'].includes(w.toLowerCase())).slice(0, 3);
  if (words.length > 0) parts.push(words.join(' '));
  if (parts.length === 0) parts.push(evt.title.slice(0, 40));
  return parts.join(' ');
}

/** 来源可信度（供 Reflection 判断命中是否为权威源） */
function sourceCredibilityOf(url: string): number {
  return sourceCredibility(url, '');
}

// ========== 06-07 质量评分（领域差异化判断，用户重点①） ==========
// 优化（2026-08-25）：不同领域采用不同判断标准，不再用固定 Importance prompt：
//   - opensource：社区热度（star 增长/forks/issues/contributors/讨论活跃）
//   - paper：影响力（机构/引用/顶会/SOTA/热议）
//   - enterprise：行业影响力（公司地位/市场影响/融资规模/竞争格局）

/** 各领域的评分 prompt（差异化标准） */
function importancePromptFor(evt: StandardEvent): string {
  const base = `事件：${evt.title}\n描述：${evt.description.slice(0, 300)}\n来源数：${evt.source.length} 真实性分：${evt.accuracy_score}`;
  switch (evt.category) {
    case 'opensource':
      return `你是 AI 开源生态分析师。评估该开源项目的社区热度与影响力，只输出 JSON：{"importance":0.0,"reason":"一句话理由"}
评分维度（0-5）：
- star 增长/总量（近期是否有显著增长）
- 社区活跃（forks/issues/contributors/讨论/PR）
- 技术方向热度（LLM/Agent/RAG/MCP 等当前热点）
- 潜在生态影响（是否可能成为事实标准/关键依赖）
${base}`;
    case 'paper':
      return `你是 AI 学术研究评审。评估该论文的学术影响力，只输出 JSON：{"importance":0.0,"reason":"一句话理由"}
评分维度（0-5）：
- 机构/作者声望（OpenAI/Anthropic/DeepMind/顶校等）
- 方法贡献（是否提出新方法/新架构/理论突破）
- 主题热度（LLM/Agent/多模态/推理 等当前热点）
- 潜在引用/应用影响（可能被大量跟进或产业化）
${base}`;
    case 'enterprise':
    default:
      return `你是 AI 行业市场分析师。评估该企业动态的行业重要性，只输出 JSON：{"importance":0.0,"reason":"一句话理由"}
评分维度（0-5）：
- 主体地位（OpenAI/Anthropic/Google/国内大厂等头部 vs 创业公司）
- 事件性质（产品发布/融资/战略合作/组织调整 vs 一般动态）
- 市场影响（可能改变竞争格局/行业标准/价格体系）
- 融资规模/产品体量（如有）
${base}`;
  }
}

async function scoreImportance(evt: StandardEvent): Promise<{ score: number; tool: string }> {
  const ruleScore = importanceByRule({
    accuracy: evt.accuracy_score,
    source: evt.source,
    sub_tags: evt.sub_tags,
    category: evt.category,
    hasInsight: !!evt.insight?.what,
    hasDate: !!evt.time,
  });

  if (!getLLM().available()) {
    return { score: ruleScore, tool: 'rule-score' };
  }

  const prompt = importancePromptFor(evt);

  const result = await withLLMFallback(
    async () => {
      const r = await getLLM().completeJson<{ importance?: number; reason?: string }>(prompt, 'score');
      if (!r || typeof r.importance !== 'number') return null;
      const s = Math.max(0, Math.min(5, r.importance));
      return { score: Math.round(s * 10) / 10, tool: 'llm-score' };
    },
    async () => ({ score: ruleScore, tool: 'rule-fallback' }),
    '质量评分',
  );
  return result;
}

// ========== 06-08 排序理由 ==========

async function rankReason(evt: StandardEvent, rank: number): Promise<string> {
  if (getLLM().available()) {
    const prompt = `一句话说明为什么该事件应入选 AI 行业日报 Top${config.topN}（第${rank}名）：${evt.title}。只输出理由本身。`;
    try {
      const r = await getLLM().complete(prompt, 'generate', { maxTokens: 100 });
      return r.slice(0, 120);
    } catch {
      return `综合评分 ${evt.importance_score}，真实性与质量经 LLM 校验通过`;
    }
  }
  return `综合评分 ${evt.importance_score}，真实性与质量经规则校验通过`;
}
