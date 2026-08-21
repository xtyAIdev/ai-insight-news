/**
 * 本地 Web 查看器（零依赖，Node http）
 * 功能：查看日报、事件、反馈、任务记录；提交人工反馈
 * 页面：/（仪表盘） /reports/<id> /events /feedback（POST） /metrics
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listReports, getReport, listStandardEvents, listFeedback, listTaskRuns, computeQualityMetrics, saveFeedback } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

export function startServer(port: number): void {
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Server Error: ${err instanceof Error ? err.message : err}`);
    }
  });

  server.listen(port, () => {
    logger.info(`[server] 已启动 http://localhost:${port}`);
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost`);
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/feedback') {
    await handleFeedback(req, res);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboard());
    return;
  }

  if (pathname === '/reports') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderReports());
    return;
  }

  if (pathname.startsWith('/reports/')) {
    const id = pathname.split('/').pop() || '';
    const report = getReport(id);
    if (!report) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('报告不存在');
      return;
    }
    // 原始 Markdown
    if (url.searchParams.get('raw') === '1') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(report.content);
      return;
    }
    // HTML 网页版：优先读取归档的 html 文件
    const htmlPath = report.markdown_path ? report.markdown_path.replace(/\.md$/, '.html') : '';
    if (htmlPath && fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderReportDetail(report));
    return;
  }

  if (pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderEvents());
    return;
  }

  if (pathname === '/feedback') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderFeedback());
    return;
  }

  if (pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderMetrics());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · AI Insight Agent</title>
<style>
:root { --bg:#f6f8fa; --card:#fff; --border:#d0d7de; --text:#1f2328; --muted:#59636e; --accent:#0969da; --accent2:#1f883d; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; background:var(--bg); color:var(--text); line-height:1.6; }
.wrap { max-width:1000px; margin:0 auto; padding:24px 16px 60px; }
nav { display:flex; gap:8px; margin-bottom:24px; flex-wrap:wrap; }
nav a { padding:6px 14px; border-radius:20px; background:var(--card); border:1px solid var(--border); color:var(--text); text-decoration:none; font-size:14px; }
nav a:hover { border-color:var(--accent); color:var(--accent); }
h1 { font-size:24px; margin-bottom:8px; }
h2 { font-size:18px; margin:20px 0 10px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 20px; margin-bottom:14px; }
.muted { color:var(--muted); font-size:13px; }
.badge { display:inline-block; padding:2px 10px; border-radius:12px; font-size:12px; font-weight:600; }
.badge-green { background:#dafbe1; color:#1a7f37; }
.badge-red { background:#ffebe9; color:#cf222e; }
.badge-gray { background:#eaeef2; color:#59636e; }
.badge-blue { background:#ddf4ff; color:#0969da; }
a { color:var(--accent); }
table { width:100%; border-collapse:collapse; font-size:14px; }
th,td { padding:8px 10px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }
th { background:#f6f8fa; font-weight:600; }
pre { background:#f6f8fa; border:1px solid var(--border); border-radius:8px; padding:14px; overflow-x:auto; font-size:13px; line-height:1.5; }
code { font-family:'SF Mono',Consolas,monospace; }
input,select,textarea { padding:8px 10px; border:1px solid var(--border); border-radius:8px; font-size:14px; font-family:inherit; width:100%; }
label { font-size:13px; color:var(--muted); display:block; margin-bottom:4px; }
.btn { display:inline-block; background:var(--accent); color:#fff; border:none; border-radius:8px; padding:10px 18px; font-size:14px; cursor:pointer; }
.btn:hover { opacity:0.9; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
.stat { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 18px; }
.stat b { font-size:26px; display:block; }
</style>
</head>
<body>
<div class="wrap">
<nav>
<a href="/">📊 仪表盘</a>
<a href="/reports">📰 日报</a>
<a href="/events">📡 事件</a>
<a href="/feedback">✍️ 反馈</a>
<a href="/metrics">📈 质量指标</a>
</nav>
${body}
</div>
</body>
</html>`;
}

function renderDashboard(): string {
  const reports = listReports();
  const events = listStandardEvents();
  const feedback = listFeedback();
  const runs = listTaskRuns(10);
  const today = new Date().toISOString().slice(0, 10);

  const body = `
<h1>📊 AI Insight Agent 仪表盘</h1>
<p class="muted">报告库 ${reports.length} 份 ｜ 标准化事件 ${events.length} 条 ｜ 反馈 ${feedback.length} 条 ｜ 日期 ${today}</p>

<h2>最近任务</h2>
<div class="card">
<table>
<tr><th>时间</th><th>触发</th><th>状态</th><th>日期</th><th>摘要</th></tr>
${runs.map((r) => `<tr><td class="muted">${r.started_at.slice(0, 19)}</td><td>${r.trigger_type}</td><td><span class="badge ${r.status === 'done' ? 'badge-green' : r.status === 'partial' ? 'badge-red' : 'badge-gray'}">${r.status}</span></td><td>${r.date}</td><td class="muted">${r.summary.slice(0, 80)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">暂无任务记录，运行 <code>npm run</code> 开始</td></tr>'}
</table>
</div>

<h2>最近日报</h2>
<div class="card">
${reports.slice(0, 5).map((r) => `<div style="margin-bottom:8px">📄 <a href="/reports/${r.report_id}">${r.report_id}</a> <span class="muted">${r.date} ｜ push=${r.push_status}</span></div>`).join('') || '<p class="muted">暂无日报</p>'}
</div>

<h2>最新事件</h2>
<div class="card">
${events.slice(0, 8).map((e) => `<div style="margin-bottom:8px"><span class="badge badge-blue">${e.category}</span> <a href="/events">${e.title}</a> <span class="muted">真实性 ${e.accuracy_score.toFixed(1)} ｜ 综合 ${e.importance_score.toFixed(1)}</span></div>`).join('') || '<p class="muted">暂无事件</p>'}
</div>
`;
  return layout('仪表盘', body);
}

function renderReports(): string {
  const reports = listReports();
  const body = `
<h1>📰 日报库</h1>
${reports.map((r) => `<div class="card"><b>${r.report_id}</b> <span class="muted">${r.date}</span><br><a href="/reports/${r.report_id}">📄 网页版预览</a> ｜ <a href="/reports/${r.report_id}?raw=1">查看 Markdown</a> ｜ <span class="muted">${r.markdown_path || ''}</span></div>`).join('') || '<p class="muted">暂无日报</p>'}
`;
  return layout('日报库', body);
}

function renderReportDetail(report: { report_id: string; date: string; content: string; markdown_path: string | null; push_status: string }): string {
  const body = `
<h1>📄 ${report.report_id}</h1>
<p class="muted">日期 ${report.date} ｜ push=${report.push_status} ｜ <a href="/reports/${report.report_id}?raw=1">原始 Markdown</a></p>
<div class="card" style="margin-top:16px"><pre>${escapeHtml(report.content)}</pre></div>
`;
  return layout(report.report_id, body);
}

function renderEvents(): string {
  const events = listStandardEvents();
  const body = `
<h1>📡 标准化事件（${events.length}）</h1>
${events.map((e) => `<div class="card">
<div><span class="badge badge-blue">${e.category}</span> ${e.sub_type ? `<span class="badge badge-gray">${e.sub_type}</span>` : ''} <b>${escapeHtml(e.title)}</b></div>
<p class="muted">${escapeHtml(e.description.slice(0, 160))}</p>
<p class="muted">公司: ${e.company || '-'} ｜ 产品: ${e.product || '-'} ｜ 时间: ${e.time} ｜ 状态: <span class="badge badge-gray">${e.status}</span></p>
<p class="muted">真实性 <b>${e.accuracy_score.toFixed(1)}</b> ｜ 综合 <b>${e.importance_score.toFixed(1)}</b> ｜ 来源 ${e.source.length} 个 ｜ <a href="/feedback?event=${e.event_id}">反馈</a></p>
</div>`).join('') || '<p class="muted">暂无事件</p>'}
`;
  return layout('事件', body);
}

function renderFeedback(): string {
  const feedback = listFeedback();
  const events = listStandardEvents();
  const eventOptions = events.map((e) => `<option value="${e.event_id}">${e.event_id} · ${escapeHtml(e.title.slice(0, 40))}</option>`).join('');
  const body = `
<h1>✍️ 人工反馈</h1>
<div class="card">
<h2>提交反馈</h2>
<form method="POST" action="/api/feedback">
<label>事件</label><select name="event_id" required>${eventOptions}</select><br><br>
<label>人工评分（0-5）</label><input type="number" name="human_score" min="0" max="5" step="0.5" required><br><br>
<label>问题标签（逗号分隔，如：不准确,标题党,重复）</label><input type="text" name="problem_tags"><br><br>
<label>建议</label><textarea name="suggestion" rows="3"></textarea><br><br>
<button class="btn" type="submit">提交</button>
</form>
</div>
<h2>历史反馈（${feedback.length}）</h2>
${feedback.map((f) => `<div class="card"><b>${f.event_id}</b> ｜ 人工 ${f.human_score ?? '-'} 分 ｜ 标签: ${f.problem_tags.join(', ') || '-'}<br><span class="muted">${f.suggestion || ''}</span></div>`).join('') || '<p class="muted">暂无反馈</p>'}
`;
  return layout('反馈', body);
}

function renderMetrics(): string {
  const weekly = computeQualityMetrics('weekly');
  const monthly = computeQualityMetrics('monthly');
  const stat = (m: { total_feedback: number; avg_agent_score: number; avg_human_score: number; consistency_rate: number; satisfaction_rate: number }) => `
<div class="stat"><b>${m.total_feedback}</b>反馈总数</div>
<div class="stat"><b>${m.avg_agent_score}</b>Agent 均分</div>
<div class="stat"><b>${m.avg_human_score}</b>人工均分</div>
<div class="stat"><b>${m.consistency_rate}%</b>一致率</div>
<div class="stat"><b>${m.satisfaction_rate}%</b>满意度</div>`;
  const body = `
<h1>📈 质量指标</h1>
<h2>近 7 天</h2>
<div class="grid">${stat(weekly)}</div>
<h2>近 30 天</h2>
<div class="grid">${stat(monthly)}</div>
<h2>低分原因分布（周）</h2>
<div class="card"><pre>${escapeHtml(JSON.stringify(weekly.low_score_reasons, null, 2))}</pre></div>
`;
  return layout('质量指标', body);
}

async function handleFeedback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const params = new URLSearchParams(raw);
  const eventId = params.get('event_id') || '';
  const humanScore = parseFloat(params.get('human_score') || '0');
  const tags = (params.get('problem_tags') || '').split(',').map((t) => t.trim()).filter(Boolean);

  saveFeedback({
    id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    event_id: eventId,
    report_id: '',
    agent_score: 0,
    human_score: humanScore,
    problem_tags: tags,
    suggestion: params.get('suggestion') || '',
    created_at: new Date().toISOString(),
  });

  res.writeHead(302, { Location: '/feedback' });
  res.end();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { renderDashboard };
