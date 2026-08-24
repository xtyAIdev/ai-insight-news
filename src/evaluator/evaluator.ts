/**
 * 评估层（Sheet06）
 * 06-02 规则过滤 → 06-04 LLM 真实性判断 → 06-06 Reflection（如需）
 * → 06-07 LLM 质量评分 → 06-08 排序建议 TopN → 06-09 高质量事件库
 */

import type { StandardEvent } from '../types/events.js';
import { getLLM, withLLMFallback, accuracyByRule, importanceByRule } from '../llm/index.js';
import { logger } from '../utils/logger.js';
import { saveHighQuality, updateEventStatus } from '../db/index.js';
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
 *  Phase 3：按模块 TopN 入选 + 排序理由
 * 规则分在 LLM 不可用/失败时自动兜底（与无 Key 路径一致）。
 */
export async function evaluateEvents(events: StandardEvent[], topN: number): Promise<EvalResult> {
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
    const accuracy = accuracyByRule(evt.source);
    const importance = importanceByRule({
      accuracy: accuracy.score,
      source: evt.source,
      sub_tags: evt.sub_tags,
      category: evt.category,
      hasInsight: !!evt.insight?.what,
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
        evt.importance_score = ruleAcc.score > 0 ? Math.round(Math.min(5, ruleAcc.score) * 10) / 10 : 0;
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
    }));
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) evaluated.push(s.value);
      else if (s.status === 'rejected') logger.warn(`[evaluator] 评估异常: ${s.reason instanceof Error ? s.reason.message : s.reason}`);
    }
  }

  // ---- Phase 3：排序 + 按模块 TopN（规格 Sheet06 06-09） ----
  evaluated.sort((a, b) => b.importance_score - a.importance_score);

  const topNByModule: Record<string, Array<{ event: StandardEvent; reason: string }>> = {};
  const modules = Array.from(new Set(evaluated.map((e) => e.category)));
  const topNList: Array<{ event: StandardEvent; reason: string }> = [];

  for (const module of modules) {
    let moduleEvents = evaluated.filter((e) => e.category === module);
    // 企业动态模块：投融资与产品动态是双分支，保底 1 席投融资（避免被产品事件完全挤出）
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

// ========== 06-06 Reflection（局部修正，最多 2 次） ==========

async function reflection(
  evt: StandardEvent,
  current: { score: number; reason: string; tool: string },
): Promise<{ score: number; reason: string; tool: string }> {
  let score = current.score;
  let reason = current.reason;
  let tool = current.tool;

  for (let attempt = 0; attempt < 2; attempt++) {
    // 规则路径：补充来源后重新计算（无 WebSearch 时使用现有证据重估）
    const ruleResult = accuracyByRule(evt.source);
    if (ruleResult.score >= 3) {
      return { ...ruleResult, tool: 'reflection-rule' };
    }
    // LLM 路径：让 LLM 基于上下文重新判断
    if (getLLM().available()) {
      const prompt = `重新评估该事件真实性（这是第 ${attempt + 1} 次修正）。事件：${evt.title}。来源：${evt.source.map((s) => s.url).join('; ')}。当前分 ${score}。规则参考分：${ruleResult.score}（${ruleResult.reason}）。注意：来源 URL 陌生不代表假新闻，若内容合理且来源有基本可信度应给 3 分以上。请判断是否可信，输出 JSON {"score":0.0,"reason":"..."}`;
      const r = await getLLM().completeJson<{ score: number; reason: string }>(prompt, 'judge');
      if (r && typeof r.score === 'number') {
        score = Math.max(0, Math.min(5, r.score));
        reason = r.reason || reason;
        tool = 'reflection-llm';
        if (score >= 3) return { score, reason, tool };
      }
    } else {
      break;
    }
  }
  return { score: Math.min(score, 2.9), reason: `${reason}；经 ${2} 次修正仍低于阈值`, tool };
}

// ========== 06-07 质量评分 ==========

async function scoreImportance(evt: StandardEvent): Promise<{ score: number; tool: string }> {
  const ruleScore = importanceByRule({
    accuracy: evt.accuracy_score,
    source: evt.source,
    sub_tags: evt.sub_tags,
    category: evt.category,
    hasInsight: !!evt.insight?.what,
  });

  if (!getLLM().available()) {
    return { score: ruleScore, tool: 'rule-score' };
  }

  const prompt = `你是 AI 行业情报质量评分员。基于以下事件，从 4 个维度评分（每维 0-5）：时效性、重要性、洞察质量、信息完整度。
只输出 JSON：{"importance":0.0}
事件：${evt.title}
描述：${evt.description.slice(0, 300)}
五维洞察：${evt.insight ? JSON.stringify(evt.insight).slice(0, 400) : '无'}
来源数：${evt.source.length} 真实性分：${evt.accuracy_score}`;

  const result = await withLLMFallback(
    async () => {
      const r = await getLLM().completeJson<{ importance?: number }>(prompt, 'score');
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
