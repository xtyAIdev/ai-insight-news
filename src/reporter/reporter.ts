/**
 * 报告层（Sheet07）
 * 07-02 报告结构 → 07-03 LLM 内容生成 → 07-06 质量检查 → 07-08 生成文档
 * → 07-09 报告库归档 → 07-10 推送（邮件优先，失败仅入库）→ 07-12/13 反馈沉淀
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DailyReport, ModuleName, ReportSection, StandardEvent, WatchItem } from '../types/events.js';
import { getLLM, withLLMFallback } from '../llm/index.js';
import { restateEvents } from './restate.js';
import { logger } from '../utils/logger.js';
import { saveReport, saveFeedback, computeQualityMetrics, appendFeedbackToFile } from '../db/index.js';
import { config } from '../config/index.js';
import { genReportId } from '../utils/normalize.js';

export interface ReportInput {
  date: string;
  modules: ModuleName[];
  topN: Array<{ event: StandardEvent; reason: string; reason_en?: string }>;
  allEvents: StandardEvent[];
}

const MODULE_LABELS: Record<ModuleName, string> = {
  opensource: 'AI 开源技术',
  paper: 'AI 学术研究',
  enterprise: 'AI 企业动态',
};

// ========== 主流程 ==========

export async function generateReport(input: ReportInput): Promise<DailyReport> {
  const reportId = genReportId(input.date);
  const start = Date.now();
  logger.info(`[reporter] 生成日报 ${reportId}`);

  // 07-02b 中文重述（TopN 事件英文标题/正文 → 中文；无 LLM 规则兜底）
  // 注意：必须先重述、后 buildSections —— buildSections 用 {...event} 浅拷贝，
  // 若在其之前执行，title_zh/description_zh 等重述字段不会进入 sections 的拷贝。
  const restated = await restateEvents(input.topN.map((t) => t.event));
  if (restated.size > 0) {
    const applied = applyRestate(input.topN, restated);
    logger.info(`[reporter] 中文重述应用 ${applied} 条（LLM 可用: ${getLLM().available()}）`);
  }

  // 按模块组织 TopN（在重述应用之后，确保拷贝携带 title_zh/description_zh 等双语字段）
  const sections = buildSections(input);

  // 07-03 LLM 内容生成（含降级）——中英双语速览/观察名单
  const { summary, futureWatch, watchlist, summary_en, futureWatch_en, watchlist_en } = await generateNarrative(input, sections);

  const report: DailyReport = {
    report_id: reportId,
    date: input.date,
    summary,
    summary_en,
    sections,
    future_watch: futureWatch,
    future_watch_en: futureWatch_en,
    watchlist,
    watchlist_en,
    files: {},
    push_status: { channel: 'local', status: 'pending' },
  };

  // 07-06 质量检查 + 修复（默认英文版为主校验对象）
  let markdown = renderMarkdown(report, 'en');
  const qcIssues = qcCheck(report, markdown);
  if (qcIssues.length > 0) {
    logger.warn(`[reporter] 质量检查发现 ${qcIssues.length} 处问题，自动修复: ${qcIssues.join('; ')}`);
    markdown = autoFix(report, markdown, qcIssues);
  }

  // 07-08/09 生成文档（英文 Markdown 主文件 + 中文 Markdown 副文件 + HTML 网页版双语切换）+ 归档
  const markdownZh = renderMarkdown(report, 'zh');
  const html = renderHtml(report);
  const files = writeReportFiles(report, markdown, markdownZh, html);
  report.files = files;
  saveReport(report, markdown);

  // 07-10 推送（邮件优先，失败仅入库）
  await pushReport(report);

  logger.info(`[reporter] 日报完成 ${reportId}，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s，MD: ${files.markdown_path} ｜ HTML: ${files.html_path}`);
  return report;
}

// ========== 07-02 报告结构 ==========

function buildSections(input: ReportInput): ReportSection[] {
  const sections: ReportSection[] = [];
  for (const module of input.modules) {
    const moduleEvents = input.topN
      .filter((t) => t.event.category === module)
      .map((t) => ({ ...t.event, pick_reason: t.reason, pick_reason_en: t.reason_en }));
    sections.push({
      module,
      module_label: MODULE_LABELS[module],
      events: moduleEvents,
      empty_note: moduleEvents.length === 0 ? '今日无重大动态' : undefined,
    });
  }
  return sections;
}

// ========== 07-02b 中文重述应用 ==========

/** 把重述结果就地应用到 TopN 事件（sections 内引用的是同一批 StandardEvent 对象）。
 *  2026-08-27 双语化：中文重述写入 *_zh 字段，原始英文保留在 title/description ——
 *  日报渲染默认英文（原始字段），切换中文时用 *_zh（无则回退原始）。 */
function applyRestate(
  topN: Array<{ event: StandardEvent; reason: string }>,
  restated: Map<string, { title: string; body: string; byLLM: boolean; comment?: string }>,
): number {
  let applied = 0;
  for (const t of topN) {
    const r = restated.get(t.event.event_id);
    if (!r) continue;
    if (r.title && r.title !== t.event.title) {
      // 原文溯源：若原始标题为英文，把重述中文挂 title_zh，原始英文保留在 title
      if (r.byLLM) {
        if (isChineseText(r.title) && !isChineseText(t.event.title)) {
          t.event.title_zh = r.title;
        }
      } else if (isChineseText(r.title)) {
        // 规则兜底产出的中文标题（如 "开源项目 X 近期活跃更新"）
        t.event.title_zh = t.event.title_zh || r.title;
      }
      // 兼容：规则兜底路径下若原始标题是机械模板（"开源项目 X 更新"），英文渲染时也用不上，
      // 仍保留原 title 供英文展示（模板也是中文，直接显示）
      applied++;
    }
    if (r.body && !isChineseBody(t.event.description)) {
      // 中文重述正文 → description_zh；原始英文保留在 description
      t.event.description_zh = r.body;
    }
    // 快评：LLM 生成的 comment（中文）挂 quick_comment_zh；原始 quick_comment 保持英文（如有）
    if (r.comment) {
      t.event.quick_comment_zh = r.comment;
      t.event.quick_comment_by = 'llm';
    } else if (!t.event.quick_comment_zh) {
      const what = t.event.insight?.what;
      if (what && what !== t.event.title) {
        t.event.quick_comment_zh = what;
        t.event.quick_comment_by = 'rule';
      }
    }
  }
  return applied;
}

/** 是否含中文 */
function isChineseText(s: string): boolean {
  return /[\u4e00-\u9fa5]/.test(s || '');
}

/** 判断描述是否已主要是中文（避免重复重述） */
function isChineseBody(s: string): boolean {
  if (!s) return false;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk / Math.max(s.length, 1) > 0.4;
}

/**
 * 快评选取（2026-08-26 去噪）：规则引擎的 insight.what 是"事件为「标题」。正文截断"的复述拼接，
 * 与标题/正文完全重复，渲染出来是废话。此处统一过滤：
 *  - 模板复述（"事件为「"开头）→ 丢弃
 *  - 与正文前 50 字重复 → 丢弃
 */
function pickComment(evt: StandardEvent): string {
  const c = evt.quick_comment
    || (evt.insight?.what && evt.insight.what !== evt.title ? evt.insight.what : '')
    || '';
  if (!c) return '';
  if (/^事件为「/.test(c.trim())) return '';
  const body = (evt.description || '').trim();
  const head = c.trim().slice(0, Math.min(c.trim().length, 50));
  if (body && head && body.startsWith(head)) return '';
  return c;
}

// ========== 07-03 内容生成（LLM + 规则降级） ==========

async function generateNarrative(
  input: ReportInput,
  sections: ReportSection[],
): Promise<{ summary: string; futureWatch: string; watchlist: WatchItem[]; summary_en: string; futureWatch_en: string; watchlist_en: WatchItem[] }> {
  // 规则降级版（中英双语）
  const totalEvents = sections.reduce((n, s) => n + s.events.length, 0);
  const moduleSummary = sections.filter((s) => s.events.length > 0).map((s) => `${s.module_label} ${s.events.length} 条`).join('，');
  const ruleSummary = totalEvents === 0
    ? `今日 ${input.date} 未采集到重大 AI 行业动态，各模块均标注「今日无重大动态」。`
    : `今日 ${input.date} 共收录 ${totalEvents} 条 AI 行业高价值动态：${moduleSummary}。整体来看，开源生态与学术研究保持活跃，企业端以产品与战略动态为主。`;
  const ruleSummaryEn = totalEvents === 0
    ? `No major AI industry updates were collected on ${input.date}; all modules are marked "No major updates today".`
    : `${input.date}: ${totalEvents} high-value AI updates. ${moduleSummary.replace(/条/g, '')} in total — open source and research remain active, enterprise driven by product & strategy news.`;
  const ruleWatch = '建议持续关注入选事件主体的一周内后续动态，重点跟踪大模型、Agent、RAG 方向的迭代节奏。';
  const ruleWatchEn = 'Track follow-ups of featured entities over the next week; focus on LLM, Agent and RAG iteration cadence.';
  const ruleWatchlist: WatchItem[] = input.topN.slice(0, 3).map((t) => ({
    title: t.event.title,
    reason: `入选 TopN，综合评分 ${t.event.importance_score}`,
  }));
  const ruleWatchlistEn: WatchItem[] = input.topN.slice(0, 3).map((t) => ({
    title: t.event.title,
    reason: `TopN pick, composite score ${t.event.importance_score}`,
  }));

  if (!getLLM().available()) {
    return {
      summary: ruleSummary, futureWatch: ruleWatch, watchlist: ruleWatchlist,
      summary_en: ruleSummaryEn, futureWatch_en: ruleWatchEn, watchlist_en: ruleWatchlistEn,
    };
  }

  const eventsText = sections
    .filter((s) => s.events.length > 0)
    .map((s) => `【${s.module_label}】\n` + s.events.map((e) => `- ${e.title}（${e.company || e.product || ''}）`).join('\n'))
    .join('\n');

  // 中英双语输出：summary/summary_en 等成对返回
  const prompt = `你是 AI 行业市场洞察分析师。基于以下今日入选事件，生成日报的速览与观察名单，只输出 JSON。
要求：
- summary / future_watch / watchlist[].title / watchlist[].reason 使用简体中文
- summary_en / future_watch_en / watchlist[].title_en / watchlist[].reason_en 使用英文（面向全球读者）
- 中英内容语义一致，英文为地道表达而非直译
{"summary":"今日趋势总结（3-5句，中文）","summary_en":"Same in English","future_watch":"未来关注建议（2-3句，中文）","future_watch_en":"Same in English","watchlist":[{"title":"关注项1（中文）","title_en":"Same in English","reason":"理由（中文）","reason_en":"Same in English"}]}

日期：${input.date}
入选事件：
${eventsText || '（今日无重大动态）'}`;

  const result = await withLLMFallback(
    async () => {
      const r = await getLLM().completeJson<{
        summary?: string; summary_en?: string; future_watch?: string; future_watch_en?: string;
        watchlist?: Array<{ title?: string; title_en?: string; reason?: string; reason_en?: string }>;
      }>(prompt, 'generate');
      return r;
    },
    async () => null,
    '日报内容生成',
  );

  // —— 单侧语言缺失补齐：ds-flash 偶发只返回单语言（如只给中文 summary 没给 summary_en）——
  // 缺失侧用一次轻量翻译/改写请求补齐，避免英文版速览落到中文
  if (result) {
    const missingEn = !result.summary_en || !result.future_watch_en;
    const missingZh = !result.summary || !result.future_watch;
    if (missingEn !== missingZh) {
      const zhSummary = result.summary || ruleSummary;
      const enSummary = result.summary_en || ruleSummaryEn;
      const zhFuture = result.future_watch || ruleWatch;
      const enFuture = result.future_watch_en || ruleWatchEn;
      const target = missingEn ? 'English' : 'Chinese';
      const gapPrompt = missingEn
        ? `你是 AI 行业市场洞察分析师。请将以下中文日报速览改写为地道英文（面向全球读者，非直译），只输出 JSON：\n{"summary_en":"...","future_watch_en":"..."}\n\n中文速览：\n${zhSummary}\n\n中文未来关注：\n${zhFuture}`
        : `You are an AI industry market intelligence analyst. Rewrite the following English briefing into natural Simplified Chinese, output JSON only:\n{"summary":"...","future_watch":"..."}\n\nEnglish summary:\n${enSummary}\n\nEnglish future watch:\n${enFuture}`;
      const gap = await withLLMFallback(
        async () => getLLM().completeJson<{ summary?: string; summary_en?: string; future_watch?: string; future_watch_en?: string }>(gapPrompt, 'generate'),
        async () => null,
        `日报${target}速览补齐`,
      );
      if (gap) {
        if (gap.summary_en) result.summary_en = gap.summary_en;
        if (gap.future_watch_en) result.future_watch_en = gap.future_watch_en;
        if (gap.summary) result.summary = gap.summary;
        if (gap.future_watch) result.future_watch = gap.future_watch;
      }
    }
  }

  const watchlist = Array.isArray(result?.watchlist) && result.watchlist.length > 0
    ? result.watchlist.map((w) => ({ title: w.title || w.title_en || '', reason: w.reason || w.reason_en || '' }))
    : ruleWatchlist;
  const watchlistEn = Array.isArray(result?.watchlist) && result.watchlist.length > 0
    ? result.watchlist.map((w) => ({ title: w.title_en || w.title || '', reason: w.reason_en || w.reason || '' }))
    : ruleWatchlistEn;

  return {
    summary: result?.summary || ruleSummary,
    summary_en: result?.summary_en || result?.summary || ruleSummaryEn,
    futureWatch: result?.future_watch || ruleWatch,
    futureWatch_en: result?.future_watch_en || result?.future_watch || ruleWatchEn,
    watchlist,
    watchlist_en: watchlistEn,
  };
}

// ========== 07-06 质量检查清单（Sheet07 R18-R23） ==========

function qcCheck(report: DailyReport, markdown: string): string[] {
  const issues: string[] = [];
  // 字段完整性
  if (!report.summary || !report.future_watch) issues.push('summary/future_watch 缺失');
  // 引用检查：每条事件 ≥1 个来源 URL
  for (const s of report.sections) {
    for (const e of s.events) {
      if (!e.source || e.source.length === 0 || !e.source.some((src) => src.url)) {
        issues.push(`事件无来源: ${e.title}`);
        break;
      }
    }
  }
  // 格式检查：无残留占位符
  if (/\{\{|\}\}|TODO|TBD/.test(markdown)) issues.push('存在占位符');
  // 日期一致性
  if (!markdown.includes(report.date)) issues.push('日报日期缺失');
  // 无空模块
  for (const s of report.sections) {
    if (!s.empty_note && s.events.length === 0) issues.push(`模块 ${s.module_label} 无标注`);
  }
  return issues;
}

// ========== 07-06b 自动修复（最多 2 轮） ==========

function autoFix(report: DailyReport, markdown: string, issues: string[]): string {
  let md = markdown;
  // 空模块标注
  for (const s of report.sections) {
    if (s.events.length === 0 && !s.empty_note) s.empty_note = '今日无重大动态';
  }
  if (!report.future_watch) report.future_watch = '建议持续关注入选事件主体的后续动态。';
  // 重新渲染
  md = renderMarkdown(report);
  return md;
}

// ========== 07-08 渲染 Markdown（新闻简报模板） ==========
// 核心原则：日报是给读者看的新闻简报 —— 每模块按「标题 + 核心内容 + 来源」组织，
// 五维洞察（insight）仅用于评估阶段的排序判断，不渲染到日报正文。

export function renderMarkdown(report: DailyReport, lang: 'en' | 'zh' = 'en'): string {
  const L = lang === 'zh' ? zhTpl : enTpl;
  const lines: string[] = [];
  lines.push(`# ${L.title}`);
  lines.push('');
  lines.push(`> ${L.dateLabel}：${report.date} ｜ ${L.reportId}：${report.report_id}`);
  lines.push('');
  lines.push(`## ${L.summaryHead}`);
  lines.push('');
  lines.push(lang === 'en' ? report.summary_en || report.summary || L.noEvents : report.summary || L.noEvents);
  lines.push('');

  for (const section of report.sections) {
    const moduleLabel = lang === 'zh' ? section.module_label : enModuleLabel(section.module);
    lines.push(`## ${moduleLabel}`);
    lines.push('');
    if (section.events.length === 0) {
      lines.push(`> ${section.empty_note || L.noEvents}`);
      lines.push('');
      continue;
    }
    for (const [idx, evt] of section.events.entries()) {
      // 标题（带序号）：zh 用重述中文，en 用原始英文
      lines.push(`### ${idx + 1}. ${evtTitle(evt, lang)}`);
      lines.push('');
      const body = evtBody(evt, lang);
      if (body) {
        lines.push(body);
        lines.push('');
      }
      // 快评（"发生了什么+快评"结构）：zh 用中文快评，en 用英文快评（如无则空）
      const comment = evtComment(evt, lang);
      if (comment) {
        lines.push(`> *${comment}*`);
        lines.push('');
      }
      // 时间（用户要求时间要真：每条事件显式标注发生日期）
      if (evt.time) {
        lines.push(`**${L.timeLabel}**：${evt.time}`);
        lines.push('');
      }
      // 关键实体信息（公司/产品/标签），一行内联
      const meta = [];
      if (evt.company) meta.push(`**${L.subjectLabel}**：${evt.company}`);
      if (evt.product && evt.category === 'enterprise') meta.push(`**${L.productLabel}**：${evt.product}`);
      // 开源项目统一展示 star 数（此前仅规则标题路径带 ⭐，LLM 路径丢失）
      if (evt.category === 'opensource' && evt.raw_event?.module === 'opensource' && evt.raw_event.stars > 0) {
        meta.push(`⭐ ${evt.raw_event.stars.toLocaleString()}`);
      }
      if (evt.sub_tags.length > 0) meta.push(`**${L.tagsLabel}**：${evt.sub_tags.slice(0, 4).join(' / ')}`);
      if (meta.length) {
        lines.push(meta.join(' ｜ '));
        lines.push('');
      }
      // 入选理由（可解释排序：为什么是它上榜、为什么排这个位置）——按语言取中/英文
      const reason = lang === 'zh'
        ? (evt as { pick_reason?: string }).pick_reason
        : (evt as { pick_reason_en?: string }).pick_reason_en || (evt as { pick_reason?: string }).pick_reason;
      if (reason) {
        lines.push(`**${L.reasonLabel}**：${reason}`);
        lines.push('');
      }
      // 来源（可点击）
      const urls = evt.source.filter((s) => s.url);
      if (urls.length > 0) {
        lines.push(`**${L.sourceLabel}**：${urls.map((s) => `[${s.name}](${s.url})`).join(' ｜ ')}`);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
  }

  lines.push(`## ${L.futureHead}`);
  lines.push('');
  lines.push(lang === 'en' ? report.future_watch_en || report.future_watch || '' : report.future_watch || '');
  lines.push('');

  const watchlist = lang === 'en' && report.watchlist_en && report.watchlist_en.length > 0 ? report.watchlist_en : report.watchlist;
  if (watchlist.length > 0) {
    lines.push(`## ${L.watchHead}`);
    lines.push('');
    for (const w of watchlist) {
      lines.push(`- **${w.title}**：${w.reason}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`*${L.footer} ｜ ${new Date().toISOString()}`);
  return lines.join('\n');
}

// ========== 中英模板 ==========

const zhTpl = {
  title: 'AI 行业市场洞察日报',
  dateLabel: '日期',
  reportId: '报告编号',
  summaryHead: '📌 今日要闻速览',
  noEvents: '（今日无重大动态）',
  timeLabel: '时间',
  subjectLabel: '主体',
  productLabel: '产品',
  tagsLabel: '标签',
  reasonLabel: '入选理由',
  sourceLabel: '来源',
  futureHead: '🔭 未来关注建议',
  watchHead: '👀 观察名单',
  footer: '由 AI Insight Agent 自动生成',
};

const enTpl = {
  title: 'AI Industry Market Intelligence Daily',
  dateLabel: 'Date',
  reportId: 'Report ID',
  summaryHead: '📌 Today at a Glance',
  noEvents: '（No major updates today）',
  timeLabel: 'Time',
  subjectLabel: 'Entity',
  productLabel: 'Product',
  tagsLabel: 'Tags',
  reasonLabel: 'Why picked',
  sourceLabel: 'Source',
  futureHead: '🔭 What to Watch',
  watchHead: '👀 Watchlist',
  footer: 'Generated by AI Insight Agent',
};

function enModuleLabel(m: ModuleName): string {
  return { opensource: 'AI Open Source', paper: 'AI Research', enterprise: 'AI Enterprise' }[m];
}

/** 按语言取事件标题：zh 优先 title_zh，en 用原始 title */
function evtTitle(evt: StandardEvent, lang: 'en' | 'zh'): string {
  if (lang === 'zh') return evt.title_zh || evt.title;
  return evt.title;
}

/** 判断文本是否主要是中文（>40% 字符为 CJK） */
function isMostlyChinese(s: string): boolean {
  if (!s) return false;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk / Math.max(s.length, 1) > 0.4;
}

/** 按语言取事件正文：zh 优先 description_zh 回退 description/raw；en 用原始 description（中文重述则回退 raw 英文原文） */
function evtBody(evt: StandardEvent, lang: 'en' | 'zh'): string {
  if (lang === 'zh') {
    const zh = evt.description_zh;
    if (zh && zh !== evt.title) return zh;
    return evt.description && evt.description !== evt.title ? evt.description : (evt.raw_event ? rawEventBody(evt) : '');
  }
  // 英文版：优先原始 description；若 description 是中文重述（历史数据），回退 raw 英文原文
  const desc = evt.description || '';
  if (desc && desc !== evt.title) {
    return isMostlyChinese(desc) && evt.raw_event ? rawEventBody(evt) || desc : desc;
  }
  return evt.raw_event ? rawEventBody(evt) : '';
}

/** 按语言取快评：zh 用 quick_comment_zh（过滤规则噪音），en 用 quick_comment（英文原文，如无则空） */
function evtComment(evt: StandardEvent, lang: 'en' | 'zh'): string {
  const c = lang === 'zh' ? (evt.quick_comment_zh || evt.quick_comment || '') : (evt.quick_comment || '');
  if (!c) return '';
  if (/^事件为「/.test(c.trim())) return '';
  const body = evtBody(evt, lang).trim();
  const head = c.trim().slice(0, Math.min(c.trim().length, 50));
  if (body && head && body.startsWith(head)) return '';
  return c;
}


/** 提取原始事件的"新闻正文"（日报核心内容） */
function rawEventBody(evt: StandardEvent): string {
  const raw = evt.raw_event;
  if (!raw) return '';
  switch (raw.module) {
    case 'opensource':
      return `${raw.description || ''}${raw.primary_language ? `（主语言 ${raw.primary_language}）` : ''}${raw.stars > 0 ? `，⭐ ${raw.stars.toLocaleString()}` : ''}`.trim();
    case 'paper':
      // 2026-08-27 修复截断：论文摘要从 300 提到 800 字符（摘要常 800-2000 字）
      return `${raw.abstract?.slice(0, 800) || ''}${raw.institution ? `｜机构：${raw.institution}` : ''}${raw.influence_hint ? `｜${raw.influence_hint}` : ''}`.trim();
    case 'enterprise':
      return raw.content || '';
    default:
      return evt.description || '';
  }
}

/** 渲染 HTML 版日报（网页预览 + 归档）——2026-08-27 双语化：内嵌 en/zh 两份内容（data-lang），JS 切换，默认英文 */
export function renderHtml(report: DailyReport): string {
  const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // 三大模块锚点导航（用户要求：研究动态可直接跳转）
  const MODULE_ANCHORS: Array<{ id: string; label: string }> = [
    { id: 'module-opensource', label: 'AI Open Source' },
    { id: 'module-paper', label: 'AI Research' },
    { id: 'module-enterprise', label: 'AI Enterprise' },
  ];
  const navHtml = `
  <nav class="module-nav">
    ${MODULE_ANCHORS.map((m) => `<a href="#${m.id}">${m.label}</a>`).join('<span class="sep">｜</span>')}
  </nav>`;

  /** 渲染一个模块的 HTML（按语言） */
  const renderModule = (section: ReportSection, lang: 'en' | 'zh'): string => {
    let body = '';
    if (section.events.length === 0) {
      body = `<div class="empty-note">${esc(section.empty_note || (lang === 'zh' ? '今日无重大动态' : 'No major updates today'))}</div>`;
    } else {
      body = section.events.map((evt: StandardEvent & { pick_reason?: string; pick_reason_en?: string }, idx: number) => {
        const title = evtTitle(evt, lang);
        const bodyText = evtBody(evt, lang);
        const comment = evtComment(evt, lang);
        const meta = [];
        if (evt.time) meta.push(`<span class="tag tag-time">🕐 ${esc(evt.time)}</span>`);
        if (evt.company) meta.push(`<span class="tag">${esc(evt.company)}</span>`);
        if (evt.product && evt.category === 'enterprise') meta.push(`<span class="tag">${esc(evt.product)}</span>`);
        if (evt.category === 'opensource' && evt.raw_event?.module === 'opensource' && evt.raw_event.stars > 0) {
          meta.push(`<span class="tag tag-star">⭐ ${esc(evt.raw_event.stars.toLocaleString())}</span>`);
        }
        if (evt.sub_tags.length > 0) meta.push(`<span class="tag tag-gray">${esc(evt.sub_tags.slice(0, 4).join(' / '))}</span>`);
        const urls = evt.source.filter((s) => s.url);
        const sourceHtml = urls.length > 0
          ? `<div class="source">${lang === 'zh' ? '来源' : 'Source'}：${urls.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(' ｜ ')}</div>`
          : '';
        const reason = lang === 'zh'
          ? (evt as { pick_reason?: string }).pick_reason
          : (evt as { pick_reason_en?: string }).pick_reason_en || (evt as { pick_reason?: string }).pick_reason;
        return `
        <article class="news-item">
          <h3>${idx + 1}. ${esc(title)}</h3>
          ${bodyText ? `<p class="news-body">${esc(bodyText)}</p>` : ''}
          ${comment ? `<p class="comment">${esc(comment)}</p>` : ''}
          ${meta.length ? `<div class="meta">${meta.join(' ')}</div>` : ''}
          ${reason ? `<div class="pick-reason">${esc(reason)}</div>` : ''}
          ${sourceHtml}
        </article>`;
      }).join('');
    }
    const moduleLabel = lang === 'zh' ? section.module_label : enModuleLabel(section.module);
    return `
    <section class="module" id="module-${section.module}">
      <h2>${esc(moduleLabel)}</h2>
      ${body}
    </section>`;
  };

  // 中英两份完整内容（data-lang 标记，JS 切换显隐）
  const contentEn = `
  <section class="summary">
    <h2>📌 Today at a Glance</h2>
    <p>${esc(report.summary_en || report.summary)}</p>
  </section>
  ${report.sections.map((s) => renderModule(s, 'en')).join('')}
  ${report.watchlist_en && report.watchlist_en.length > 0
    ? `<section class="module"><h2>👀 Watchlist</h2>${report.watchlist_en.map((w) => `<div class="watch-item"><b>${esc(w.title)}</b> — ${esc(w.reason)}</div>`).join('')}</section>`
    : ''}`;

  const contentZh = `
  <section class="summary">
    <h2>📌 今日要闻速览</h2>
    <p>${esc(report.summary)}</p>
  </section>
  ${report.sections.map((s) => renderModule(s, 'zh')).join('')}
  ${report.watchlist.length > 0
    ? `<section class="module"><h2>👀 观察名单</h2>${report.watchlist.map((w) => `<div class="watch-item"><b>${esc(w.title)}</b> — ${esc(w.reason)}</div>`).join('')}</section>`
    : ''}`;

  // 右上角语言切换：En / 中文（默认英文）
  const langSwitch = `
  <div class="lang-switch" role="group" aria-label="Language">
    <button type="button" data-lang-btn="en" class="on">En</button>
    <button type="button" data-lang-btn="zh">中文</button>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title data-lang-title="en">AI Industry Market Intelligence Daily ${esc(report.date)}</title>
<title data-lang-title="zh">AI 行业市场洞察日报 ${esc(report.date)}</title>
<style>
:root { --bg:#f7f8fa; --card:#fff; --border:#e5e8ee; --text:#1a2233; --text-2:#3d4759; --muted:#6b7486; --accent:#2f54eb; --accent-soft:#eef2ff; --accent-border:#c7d2fe; --serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; background:var(--bg); color:var(--text); line-height:1.75; -webkit-font-smoothing:antialiased; font-size:15px; }
.wrap { max-width:900px; margin:0 auto; padding:40px 24px 70px; position:relative; }
header { text-align:center; padding:26px 0 20px; border-bottom:1px solid var(--border); margin-bottom:30px; position:relative; }
header h1 { font-family:var(--serif); font-size:27px; letter-spacing:0.5px; }
header .sub { color:var(--muted); font-size:13px; margin-top:6px; }
/* 语言切换按钮：右上角 */
.lang-switch { position:absolute; top:24px; right:0; display:inline-flex; border:1px solid var(--accent-border); border-radius:999px; overflow:hidden; background:var(--card); }
.lang-switch button { border:none; background:transparent; padding:5px 16px; font-size:13px; font-weight:600; color:var(--muted); cursor:pointer; transition:all .15s; }
.lang-switch button.on { background:var(--accent); color:#fff; }
.lang-switch button:not(.on):hover { color:var(--accent); background:var(--accent-soft); }
/* 双语内容：默认显示英文，中文隐藏，JS 切换 */
[data-lang-block] { display:none; }
[data-lang-block].active { display:block; }
.summary { background:var(--accent-soft); border:1px solid var(--accent-border); border-radius:12px; padding:20px 24px; margin-bottom:30px; }
.summary h2 { font-family:var(--serif); font-size:18px; margin-bottom:8px; }
.summary p { color:var(--text-2); font-size:14.5px; }
.module { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:24px 28px; margin-bottom:24px; }
.module h2 { font-family:var(--serif); font-size:20px; border-left:4px solid var(--accent); padding-left:12px; margin-bottom:16px; letter-spacing:0.3px; }
.news-item { padding:18px 0; border-bottom:1px solid var(--border); }
.news-item:last-child { border-bottom:none; }
.news-item h3 { font-size:16.5px; font-weight:650; margin-bottom:8px; color:var(--text); line-height:1.5; }
.news-body { font-size:14.5px; color:var(--text-2); margin-bottom:10px; white-space:pre-line; }
.comment { font-size:13.5px; color:#8a4baf; background:#f8f2fc; border-left:3px solid #c084fc; padding:8px 12px; border-radius:6px; margin-bottom:10px; line-height:1.6; }
.meta { margin-bottom:8px; }
.tag { display:inline-block; background:var(--accent-soft); color:var(--accent); border-radius:6px; padding:1px 10px; font-size:12px; margin-right:6px; font-weight:500; }
.tag-gray { background:#f1f3f7; color:var(--muted); }
.tag-star { background:#fffbe6; color:#ad8b00; border:1px solid #ffe58f; }
.tag-time { background:#fff7e6; color:#ad6800; border:1px solid #ffe58f; }
.pick-reason { font-size:13px; color:#2f54eb; background:#eef2ff; border-left:3px solid #2f54eb; padding:7px 12px; border-radius:6px; margin-bottom:10px; line-height:1.6; }
.module-nav { display:flex; justify-content:center; gap:14px; flex-wrap:wrap; margin:-8px 0 26px; }
.module-nav a { color:var(--accent); text-decoration:none; font-size:14px; font-weight:600; padding:6px 16px; border:1px solid var(--accent-border); border-radius:999px; background:var(--accent-soft); transition:all .15s; }
.module-nav a:hover { background:var(--accent); color:#fff; }
.module-nav .sep { color:var(--muted); align-self:center; }
.back-top { position:fixed; bottom:24px; right:24px; background:var(--accent); color:#fff; text-decoration:none; font-size:13px; padding:8px 14px; border-radius:999px; box-shadow:0 2px 10px rgba(47,84,235,.3); opacity:.85; }
.back-top:hover { opacity:1; }
.source { font-size:12.5px; color:var(--muted); }
.source a { color:var(--accent); text-decoration:none; margin-right:8px; }
.source a:hover { text-decoration:underline; }
.empty-note { color:var(--muted); font-style:italic; padding:10px 0; }
.watch-item { padding:8px 0; font-size:14px; border-bottom:1px solid var(--border); }
footer { text-align:center; color:var(--muted); font-size:12px; margin-top:34px; border-top:1px solid var(--border); padding-top:20px; }
</style>
</head>
<body>
<div class="wrap">
<header>
${langSwitch}
<h1 data-lang-title="en">AI Industry Market Intelligence Daily</h1>
<h1 data-lang-title="zh">AI 行业市场洞察日报</h1>
<div class="sub" data-lang-title="en">${esc(report.date)} ｜ ${esc(report.report_id)}</div>
<div class="sub" data-lang-title="zh">${esc(report.date)} ｜ ${esc(report.report_id)}</div>
</header>
${navHtml}
<div data-lang-block="en" class="active">
${contentEn}
</div>
<div data-lang-block="zh">
${contentZh}
</div>
<footer>Generated by AI Insight Agent ｜ ${new Date().toISOString()}</footer>
</div>
<a href="#" class="back-top" title="Back to top">↑ Top</a>
<script>
(function () {
  var btns = document.querySelectorAll('[data-lang-btn]');
  var blocks = document.querySelectorAll('[data-lang-block]');
  function setLang(lang) {
    btns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-lang-btn') === lang); });
    blocks.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-lang-block') === lang); });
    document.querySelectorAll('[data-lang-title]').forEach(function (el) {
      el.style.display = el.getAttribute('data-lang-title') === lang ? '' : 'none';
    });
    try { localStorage.setItem('ai-daily-lang', lang); } catch (e) {}
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }
  var saved = null; try { saved = localStorage.getItem('ai-daily-lang'); } catch (e) {}
  var initial = saved === 'zh' ? 'zh' : 'en'; // 默认英文
  btns.forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.getAttribute('data-lang-btn')); });
  });
  setLang(initial);
})();
</script>
</body>
</html>`;
}


// ========== 07-08/09 写文件（Markdown + HTML）+ 归档 ==========

function writeReportFiles(report: DailyReport, markdown: string, markdownZh: string, html: string): { markdown_path: string; html_path: string } {
  const dir = path.join(config.reportDir, report.date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${report.report_id}.md`);
  const htmlPath = path.join(dir, `${report.report_id}.html`);
  fs.writeFileSync(mdPath, markdown, 'utf-8');
  // 中文版 Markdown 副文件（归档保留；主文件为英文）
  fs.writeFileSync(path.join(dir, `${report.report_id}.zh.md`), markdownZh, 'utf-8');
  fs.writeFileSync(htmlPath, html, 'utf-8');
  return { markdown_path: mdPath, html_path: htmlPath };
}

// ========== 07-10 推送（邮件优先，失败仅入库） ==========

async function pushReport(report: DailyReport): Promise<void> {
  // 邮件推送（配置了 MAIL_* 且启用时）
  if (config.mail.enabled && config.mail.host && config.mail.user) {
    const ok = await sendMail(report);
    report.push_status = ok
      ? { channel: 'mail', status: 'sent', sent_at: new Date().toISOString() }
      : { channel: 'mail', status: 'failed', sent_at: new Date().toISOString() };
    if (!ok) {
      report.push_status = { channel: 'local', status: 'archived_only', sent_at: new Date().toISOString() };
      logger.warn(`[reporter] 邮件推送失败，仅入库归档`);
    }
  } else {
    report.push_status = { channel: 'local', status: 'archived_only', sent_at: new Date().toISOString() };
    logger.info(`[reporter] 未配置邮件，日报仅归档（路径: ${report.files.markdown_path}）`);
  }
  saveReport(report, fs.readFileSync(report.files.markdown_path!, 'utf-8'));
}

/** 邮件发送：使用 SMTP（Node 原生实现，无依赖）。生产可替换为 QQ Mail MCP。 */
async function sendMail(report: DailyReport): Promise<boolean> {
  try {
    // 简化实现：SMTP 直连（支持 TLS）
    const { sendMailSMTP } = await import('./smtp.js');
    await sendMailSMTP({
      host: config.mail.host,
      port: config.mail.port,
      user: config.mail.user,
      pass: config.mail.pass,
      to: config.mail.to,
      hostIp: config.mail.hostIp || undefined,
      subject: `AI 行业市场洞察日报 ${report.date}`,
      body: fs.readFileSync(report.files.markdown_path!, 'utf-8'),
    });
    return true;
  } catch (err) {
    logger.warn(`[reporter] 邮件发送异常: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ========== 07-12/13 反馈采集与沉淀 ==========

export function collectFeedback(input: {
  eventId: string;
  reportId: string;
  agentScore: number;
  humanScore: number;
  problemTags: string[];
  suggestion?: string;
}): void {
  const fb = {
    id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    event_id: input.eventId,
    report_id: input.reportId,
    agent_score: input.agentScore,
    human_score: input.humanScore,
    problem_tags: input.problemTags,
    suggestion: input.suggestion || '',
    created_at: new Date().toISOString(),
  };
  saveFeedback(fb);
  // 反馈闭环（2026-08-31 批3 任务⑥）：同步持久化到 data/feedback.json（跨 CI 留存，metrics 合并读）
  appendFeedbackToFile(fb);
  logger.info(`[reporter] 反馈已沉淀: event=${input.eventId} human=${input.humanScore} tags=${input.problemTags.join(',')}`);
}

// ========== 07-14 质量指标 ==========

export function getQualityMetrics(period: 'weekly' | 'monthly') {
  return computeQualityMetrics(period);
}
