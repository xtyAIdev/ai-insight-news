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
import { saveReport, saveFeedback, computeQualityMetrics } from '../db/index.js';
import { config } from '../config/index.js';
import { genReportId } from '../utils/normalize.js';

export interface ReportInput {
  date: string;
  modules: ModuleName[];
  topN: Array<{ event: StandardEvent; reason: string }>;
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

  // 按模块组织 TopN
  const sections = buildSections(input);

  // 07-02b 中文重述（TopN 事件英文标题/正文 → 中文；无 LLM 规则兜底）
  const restated = await restateEvents(input.topN.map((t) => t.event));
  if (restated.size > 0) {
    const applied = applyRestate(input.topN, restated);
    logger.info(`[reporter] 中文重述应用 ${applied} 条（LLM 可用: ${getLLM().available()}）`);
  }

  // 07-03 LLM 内容生成（含降级）
  const { summary, futureWatch, watchlist } = await generateNarrative(input, sections);

  const report: DailyReport = {
    report_id: reportId,
    date: input.date,
    summary,
    sections,
    future_watch: futureWatch,
    watchlist,
    files: {},
    push_status: { channel: 'local', status: 'pending' },
  };

  // 07-06 质量检查 + 修复
  let markdown = renderMarkdown(report);
  const qcIssues = qcCheck(report, markdown);
  if (qcIssues.length > 0) {
    logger.warn(`[reporter] 质量检查发现 ${qcIssues.length} 处问题，自动修复: ${qcIssues.join('; ')}`);
    markdown = autoFix(report, markdown, qcIssues);
  }

  // 07-08/09 生成文档（Markdown + HTML 网页版）+ 归档
  const html = renderHtml(report);
  const files = writeReportFiles(report, markdown, html);
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
      .map((t) => t.event);
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

/** 把重述结果就地应用到 TopN 事件（sections 内引用的是同一批 StandardEvent 对象） */
function applyRestate(
  topN: Array<{ event: StandardEvent; reason: string }>,
  restated: Map<string, { title: string; body: string; byLLM: boolean; comment?: string }>,
): number {
  let applied = 0;
  for (const t of topN) {
    const r = restated.get(t.event.event_id);
    if (!r) continue;
    if (r.title && r.title !== t.event.title) {
      // 原文溯源：英文原标题保留到描述末尾（仅 LLM 重述时），便于核对
      if (r.byLLM && !/[\u4e00-\u9fa5]/.test(t.event.title)) {
        const orig = t.event.title;
        if (!t.event.description.includes(orig)) {
          t.event.description = `${t.event.description || ''}\n\n（原标题：${orig}）`.trim();
        }
      }
      t.event.title = r.title;
      applied++;
    }
    if (r.body && !isChineseBody(t.event.description)) {
      t.event.description = r.body;
    }
    // 快评：LLM 生成的 comment 优先，否则用规则五维洞察的 what（发生了什么）
    if (r.comment) {
      t.event.quick_comment = r.comment;
      t.event.quick_comment_by = 'llm';
    } else if (!t.event.quick_comment) {
      const what = t.event.insight?.what;
      if (what && what !== t.event.title) {
        t.event.quick_comment = what;
        t.event.quick_comment_by = 'rule';
      }
    }
  }
  return applied;
}

/** 判断描述是否已主要是中文（避免重复重述） */
function isChineseBody(s: string): boolean {
  if (!s) return false;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk / Math.max(s.length, 1) > 0.4;
}

// ========== 07-03 内容生成（LLM + 规则降级） ==========

async function generateNarrative(
  input: ReportInput,
  sections: ReportSection[],
): Promise<{ summary: string; futureWatch: string; watchlist: WatchItem[] }> {
  // 规则降级版
  const totalEvents = sections.reduce((n, s) => n + s.events.length, 0);
  const ruleSummary = totalEvents === 0
    ? `今日 ${input.date} 未采集到重大 AI 行业动态，各模块均标注「今日无重大动态」。`
    : `今日 ${input.date} 共收录 ${totalEvents} 条 AI 行业高价值动态：${sections.filter((s) => s.events.length > 0).map((s) => `${s.module_label} ${s.events.length} 条`).join('，')}。整体来看，开源生态与学术研究保持活跃，企业端以产品与战略动态为主。`;
  const ruleWatch = '建议持续关注入选事件主体的一周内后续动态，重点跟踪大模型、Agent、RAG 方向的迭代节奏。';
  const ruleWatchlist: WatchItem[] = input.topN.slice(0, 3).map((t) => ({
    title: t.event.title,
    reason: `入选 TopN，综合评分 ${t.event.importance_score}`,
  }));

  if (!getLLM().available()) {
    return { summary: ruleSummary, futureWatch: ruleWatch, watchlist: ruleWatchlist };
  }

  const eventsText = sections
    .filter((s) => s.events.length > 0)
    .map((s) => `【${s.module_label}】\n` + s.events.map((e) => `- ${e.title}（${e.company || e.product || ''}）`).join('\n'))
    .join('\n');

  const prompt = `你是 AI 行业市场洞察分析师。基于以下今日入选事件，生成日报的三个部分，只输出 JSON：
{"summary":"今日趋势总结（3-5句，概括整体动态与关键趋势）","future_watch":"未来关注建议（2-3句）","watchlist":[{"title":"关注项1","reason":"理由"}]}

日期：${input.date}
入选事件：
${eventsText || '（今日无重大动态）'}`;

  const result = await withLLMFallback(
    async () => {
      const r = await getLLM().completeJson<{ summary: string; future_watch: string; watchlist: Array<{ title: string; reason: string }> }>(prompt, 'generate');
      return r;
    },
    async () => ({ summary: ruleSummary, future_watch: ruleWatch, watchlist: ruleWatchlist }),
    '日报内容生成',
  );

  return {
    summary: result?.summary || ruleSummary,
    futureWatch: result?.future_watch || ruleWatch,
    watchlist: Array.isArray(result?.watchlist) && result.watchlist.length > 0 ? result.watchlist : ruleWatchlist,
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

export function renderMarkdown(report: DailyReport): string {
  const lines: string[] = [];
  lines.push(`# AI 行业市场洞察日报`);
  lines.push('');
  lines.push(`> 日期：${report.date} ｜ 报告编号：${report.report_id}`);
  lines.push('');
  lines.push(`## 📌 今日要闻速览`);
  lines.push('');
  lines.push(report.summary || '（今日无重大动态）');
  lines.push('');

  for (const section of report.sections) {
    lines.push(`## ${section.module_label}`);
    lines.push('');
    if (section.events.length === 0) {
      lines.push(`> ${section.empty_note || '今日无重大动态'}`);
      lines.push('');
      continue;
    }
    for (const [idx, evt] of section.events.entries()) {
      // 标题（带序号）
      lines.push(`### ${idx + 1}. ${evt.title}`);
      lines.push('');
      // 核心内容：优先中文重述后的 description（LLM/规则已转中文），raw.content 仅作兜底
      // （修复：此前优先 rawEventBody 读 raw.content 英文原文，导致中文重述不生效）
      const body = evt.description && evt.description !== evt.title
        ? evt.description
        : (evt.raw_event ? rawEventBody(evt) : '');
      if (body) {
        lines.push(body);
        lines.push('');
      }
      // 快评（"发生了什么+快评"结构，阶段 4）：LLM 生成或规则五维洞察 what 兜底
      const comment = evt.quick_comment || (evt.insight?.what && evt.insight.what !== evt.title ? evt.insight.what : '');
      if (comment) {
        lines.push(`> 💬 快评：${comment}`);
        lines.push('');
      }
      // 时间（用户要求时间要真：每条事件显式标注发生日期）
      if (evt.time) {
        lines.push(`**时间**：${evt.time}`);
        lines.push('');
      }
      // 关键实体信息（公司/产品/标签），一行内联
      const meta = [];
      if (evt.company) meta.push(`**主体**：${evt.company}`);
      if (evt.product && evt.category === 'enterprise') meta.push(`**产品**：${evt.product}`);
      if (evt.sub_tags.length > 0) meta.push(`**标签**：${evt.sub_tags.slice(0, 4).join(' / ')}`);
      if (meta.length) {
        lines.push(meta.join(' ｜ '));
        lines.push('');
      }
      // 来源（可点击）
      const urls = evt.source.filter((s) => s.url);
      if (urls.length > 0) {
        lines.push(`**来源**：${urls.map((s) => `[${s.name}](${s.url})`).join(' ｜ ')}`);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
  }

  lines.push(`## 🔭 未来关注建议`);
  lines.push('');
  lines.push(report.future_watch || '');
  lines.push('');

  if (report.watchlist.length > 0) {
    lines.push(`## 👀 观察名单`);
    lines.push('');
    for (const w of report.watchlist) {
      lines.push(`- **${w.title}**：${w.reason}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`*由 AI Insight Agent 自动生成 ｜ ${new Date().toISOString()}`);

  return lines.join('\n');
}

/** 提取原始事件的"新闻正文"（日报核心内容） */
function rawEventBody(evt: StandardEvent): string {
  const raw = evt.raw_event;
  if (!raw) return '';
  switch (raw.module) {
    case 'opensource':
      return `${raw.description || ''}${raw.primary_language ? `（主语言 ${raw.primary_language}）` : ''}${raw.stars > 0 ? `，⭐ ${raw.stars.toLocaleString()}` : ''}`.trim();
    case 'paper':
      return `${raw.abstract?.slice(0, 300) || ''}${raw.institution ? `｜机构：${raw.institution}` : ''}${raw.influence_hint ? `｜${raw.influence_hint}` : ''}`.trim();
    case 'enterprise':
      return raw.content || '';
    default:
      return evt.description || '';
  }
}

/** 渲染 HTML 版日报（网页预览 + 归档） */
export function renderHtml(report: DailyReport): string {
  const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // 三大模块锚点导航（用户要求：研究动态可直接跳转）
  const MODULE_ANCHORS: Array<{ id: string; label: string }> = [
    { id: 'module-opensource', label: 'AI 开源' },
    { id: 'module-paper', label: 'AI 论文' },
    { id: 'module-enterprise', label: 'AI 企业' },
  ];
  const navHtml = `
  <nav class="module-nav">
    ${MODULE_ANCHORS.map((m) => `<a href="#${m.id}">${m.label}</a>`).join('<span class="sep">｜</span>')}
  </nav>`;
  const sectionsHtml = report.sections.map((section) => {
    let body = '';
    if (section.events.length === 0) {
      body = `<div class="empty-note">${esc(section.empty_note || '今日无重大动态')}</div>`;
    } else {
      body = section.events.map((evt, idx) => {
        // 核心内容：优先中文重述后的 description，raw.content 仅兜底（修复英文残留）
        const bodyText = evt.description && evt.description !== evt.title
          ? evt.description
          : (evt.raw_event ? rawEventBody(evt) : '');
        const comment = evt.quick_comment || (evt.insight?.what && evt.insight.what !== evt.title ? evt.insight.what : '');
        const meta = [];
        if (evt.time) meta.push(`<span class="tag tag-time">🕐 ${esc(evt.time)}</span>`);
        if (evt.company) meta.push(`<span class="tag">${esc(evt.company)}</span>`);
        if (evt.product && evt.category === 'enterprise') meta.push(`<span class="tag">${esc(evt.product)}</span>`);
        if (evt.sub_tags.length > 0) meta.push(`<span class="tag tag-gray">${esc(evt.sub_tags.slice(0, 4).join(' / '))}</span>`);
        const urls = evt.source.filter((s) => s.url);
        const sourceHtml = urls.length > 0
          ? `<div class="source">来源：${urls.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(' ｜ ')}</div>`
          : '';
        return `
        <article class="news-item">
          <h3>${idx + 1}. ${esc(evt.title)}</h3>
          ${bodyText ? `<p class="news-body">${esc(bodyText)}</p>` : ''}
          ${comment ? `<p class="comment">💬 快评：${esc(comment)}</p>` : ''}
          ${meta.length ? `<div class="meta">${meta.join(' ')}</div>` : ''}
          ${sourceHtml}
        </article>`;
      }).join('');
    }
    // 模块锚点：id="module-<module>"（opensource/paper/enterprise）
    return `
    <section class="module" id="module-${section.module}">
      <h2>${esc(section.module_label)}</h2>
      ${body}
    </section>`;
  }).join('');

  const watchlistHtml = report.watchlist.length > 0
    ? `<section class="module"><h2>👀 观察名单</h2>${report.watchlist.map((w) => `<div class="watch-item"><b>${esc(w.title)}</b> — ${esc(w.reason)}</div>`).join('')}</section>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 行业市场洞察日报 ${esc(report.date)}</title>
<style>
:root { --bg:#f7f8fa; --card:#fff; --border:#e5e8ee; --text:#1a2233; --text-2:#3d4759; --muted:#6b7486; --accent:#2f54eb; --accent-soft:#eef2ff; --accent-border:#c7d2fe; --serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; background:var(--bg); color:var(--text); line-height:1.75; -webkit-font-smoothing:antialiased; font-size:15px; }
.wrap { max-width:900px; margin:0 auto; padding:40px 24px 70px; }
header { text-align:center; padding:26px 0 20px; border-bottom:1px solid var(--border); margin-bottom:30px; }
header h1 { font-family:var(--serif); font-size:27px; letter-spacing:0.5px; }
header .sub { color:var(--muted); font-size:13px; margin-top:6px; }
.summary { background:var(--accent-soft); border:1px solid var(--accent-border); border-radius:12px; padding:20px 24px; margin-bottom:30px; }
.summary h2 { font-family:var(--serif); font-size:18px; margin-bottom:8px; }
.summary p { color:var(--text-2); font-size:14.5px; }
.module { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:24px 28px; margin-bottom:24px; }
.module h2 { font-family:var(--serif); font-size:20px; border-left:4px solid var(--accent); padding-left:12px; margin-bottom:16px; letter-spacing:0.3px; }
.news-item { padding:18px 0; border-bottom:1px solid var(--border); }
.news-item:last-child { border-bottom:none; }
.news-item h3 { font-size:16.5px; font-weight:650; margin-bottom:8px; color:var(--text); line-height:1.5; }
.news-body { font-size:14.5px; color:var(--text-2); margin-bottom:10px; }
.comment { font-size:13.5px; color:#8a4baf; background:#f8f2fc; border-left:3px solid #c084fc; padding:8px 12px; border-radius:6px; margin-bottom:10px; line-height:1.6; }
.meta { margin-bottom:8px; }
.tag { display:inline-block; background:var(--accent-soft); color:var(--accent); border-radius:6px; padding:1px 10px; font-size:12px; margin-right:6px; font-weight:500; }
.tag-gray { background:#f1f3f7; color:var(--muted); }
.tag-time { background:#fff7e6; color:#ad6800; border:1px solid #ffe58f; }
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
<h1>AI 行业市场洞察日报</h1>
<div class="sub">${esc(report.date)} ｜ ${esc(report.report_id)}</div>
</header>
${navHtml}
<section class="summary">
<h2>📌 今日要闻速览</h2>
<p>${esc(report.summary)}</p>
</section>
${sectionsHtml}
${watchlistHtml}
<footer>由 AI Insight Agent 自动生成 ｜ ${new Date().toISOString()}</footer>
</div>
<a href="#" class="back-top" title="返回顶部">↑ 顶部</a>
</body>
</html>`;
}

// ========== 07-08/09 写文件（Markdown + HTML）+ 归档 ==========

function writeReportFiles(report: DailyReport, markdown: string, html: string): { markdown_path: string; html_path: string } {
  const dir = path.join(config.reportDir, report.date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${report.report_id}.md`);
  const htmlPath = path.join(dir, `${report.report_id}.html`);
  fs.writeFileSync(mdPath, markdown, 'utf-8');
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
  logger.info(`[reporter] 反馈已沉淀: event=${input.eventId} human=${input.humanScore} tags=${input.problemTags.join(',')}`);
}

// ========== 07-14 质量指标 ==========

export function getQualityMetrics(period: 'weekly' | 'monthly') {
  return computeQualityMetrics(period);
}
