/**
 * 本地 Web 查看器（零依赖，Node http）
 * 功能：查看日报、事件、反馈、任务记录；提交人工反馈
 * 页面：/（仪表盘） /reports/<id> /events /feedback（POST） /metrics
 * 视觉：深色科技风 —— 暗色渐变背景 + 霓虹渐变点缀 + 玻璃拟态卡片 + 数据光效
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listReports, countReports, getReport, listStandardEvents, listFeedback, listTaskRuns, computeQualityMetrics, saveFeedback } from '../db/index.js';
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
    res.end(renderHome());
    return;
  }

  if (pathname === '/reports') {
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderReports(page));
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
    res.end(renderEvents(url.searchParams.get('module') || ''));
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

// ========== 深色科技风布局 ==========

const SHELL_CSS = `
:root {
  --bg0:#070b14; --bg1:#0c1322; --bg2:#111a2e;
  --card:rgba(17,26,46,0.72); --card-border:rgba(94,129,244,0.18);
  --text:#e8edf7; --muted:#8a94a8; --muted2:#5c6580;
  --accent:#4f7cff; --accent2:#22d3ee; --accent3:#a78bfa; --green:#34d399; --red:#fb7185; --amber:#fbbf24;
  --glow1:rgba(79,124,255,0.35); --glow2:rgba(34,211,238,0.25);
  --radius:14px; --font-mono:'SF Mono','JetBrains Mono',Consolas,Menlo,monospace;
}
* { box-sizing:border-box; margin:0; padding:0; }
body {
  font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  background:
    radial-gradient(1000px 500px at 85% -10%, rgba(79,124,255,0.16), transparent 60%),
    radial-gradient(800px 420px at -10% 10%, rgba(34,211,238,0.10), transparent 55%),
    linear-gradient(160deg, var(--bg0) 0%, var(--bg1) 55%, var(--bg2) 100%);
  background-attachment:fixed;
  color:var(--text); line-height:1.6; min-height:100vh;
}
body::before {
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
  background-image:linear-gradient(rgba(94,129,244,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(94,129,244,0.04) 1px, transparent 1px);
  background-size:42px 42px;
}
.wrap { max-width:1080px; margin:0 auto; padding:28px 20px 80px; position:relative; z-index:1; }
header.top {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:18px 22px; margin-bottom:24px; flex-wrap:wrap;
  background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius);
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  box-shadow:0 8px 32px rgba(0,0,0,0.35);
}
.brand { display:flex; align-items:center; gap:12px; }
.brand .logo {
  width:38px; height:38px; border-radius:10px; flex:none;
  background:linear-gradient(135deg, var(--accent), var(--accent2));
  display:flex; align-items:center; justify-content:center; font-size:19px;
  box-shadow:0 0 18px var(--glow1);
}
.brand .name { font-size:17px; font-weight:700; letter-spacing:0.3px; }
.brand .sub { font-size:12px; color:var(--muted); }
nav { display:flex; gap:8px; flex-wrap:wrap; }
nav a {
  padding:7px 16px; border-radius:22px; font-size:13.5px; text-decoration:none; color:var(--muted);
  border:1px solid var(--card-border); background:rgba(15,23,42,0.5); transition:all .18s;
}
nav a:hover, nav a.active { color:#fff; border-color:transparent; background:linear-gradient(135deg, var(--accent), #3b5bdb); box-shadow:0 0 14px var(--glow1); }
h1 { font-size:22px; margin-bottom:6px; letter-spacing:0.3px; }
h2 { font-size:16px; margin:22px 0 12px; padding-left:10px; border-left:3px solid var(--accent); }
h1 .grad, h2 .grad {
  background:linear-gradient(90deg, var(--accent2), var(--accent3), var(--accent));
  -webkit-background-clip:text; background-clip:text; color:transparent;
}
.muted { color:var(--muted); font-size:13px; }
.mono { font-family:var(--font-mono); }
.card {
  background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius);
  padding:18px 22px; margin-bottom:14px;
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  transition:border-color .2s, transform .2s;
}
.card:hover { border-color:rgba(94,129,244,0.4); }
.badge { display:inline-block; padding:2px 11px; border-radius:12px; font-size:12px; font-weight:600; letter-spacing:0.2px; }
.badge-green { background:rgba(52,211,153,0.14); color:var(--green); border:1px solid rgba(52,211,153,0.35); }
.badge-red   { background:rgba(251,113,133,0.14); color:var(--red); border:1px solid rgba(251,113,133,0.35); }
.badge-gray  { background:rgba(138,148,168,0.14); color:var(--muted); border:1px solid rgba(138,148,168,0.3); }
.badge-blue  { background:rgba(79,124,255,0.15); color:var(--accent2); border:1px solid rgba(79,124,255,0.4); }
.badge-amber { background:rgba(251,191,36,0.14); color:var(--amber); border:1px solid rgba(251,191,36,0.35); }
a { color:var(--accent2); text-decoration:none; }
a:hover { text-decoration:underline; }
table { width:100%; border-collapse:collapse; font-size:13.5px; }
th,td { padding:9px 11px; border-bottom:1px solid rgba(94,129,244,0.12); text-align:left; vertical-align:top; }
th { background:rgba(15,23,42,0.6); color:var(--muted); font-weight:600; font-size:12.5px; letter-spacing:0.3px; }
tr:hover td { background:rgba(79,124,255,0.05); }
pre {
  background:rgba(7,11,20,0.8); border:1px solid var(--card-border); border-radius:10px;
  padding:16px; overflow-x:auto; font-size:13px; line-height:1.55; color:#c9d4ea; font-family:var(--font-mono);
}
code { font-family:var(--font-mono); background:rgba(79,124,255,0.12); padding:1px 6px; border-radius:5px; font-size:12.5px; color:#9ec5ff; }
input,select,textarea {
  padding:10px 13px; border:1px solid rgba(94,129,244,0.25); border-radius:9px; font-size:14px; font-family:inherit;
  background:rgba(7,11,20,0.65); color:var(--text); width:100%; transition:border-color .18s, box-shadow .18s;
}
input:focus,select:focus,textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(79,124,255,0.15); }
label { font-size:12.5px; color:var(--muted); display:block; margin-bottom:5px; letter-spacing:0.2px; }
.btn {
  display:inline-block; background:linear-gradient(135deg, var(--accent), #3b5bdb); color:#fff; border:none;
  border-radius:9px; padding:11px 22px; font-size:14px; cursor:pointer; letter-spacing:0.3px;
  box-shadow:0 4px 16px rgba(79,124,255,0.3); transition:all .18s;
}
.btn:hover { opacity:0.92; transform:translateY(-1px); box-shadow:0 6px 22px rgba(79,124,255,0.45); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; }
.stat {
  background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius);
  padding:16px 18px; position:relative; overflow:hidden; backdrop-filter:blur(12px);
}
.stat::after {
  content:''; position:absolute; top:0; left:0; right:0; height:2px;
  background:linear-gradient(90deg, var(--accent), var(--accent2), transparent);
}
.stat b { font-size:27px; display:block; font-family:var(--font-mono); }
.stat .lbl { font-size:12.5px; color:var(--muted); margin-top:2px; }
.stat.hl b { background:linear-gradient(90deg, var(--accent2), var(--accent3)); -webkit-background-clip:text; background-clip:text; color:transparent; }
.divider { height:1px; background:linear-gradient(90deg, transparent, rgba(94,129,244,0.35), transparent); margin:18px 0; }
footer { text-align:center; color:var(--muted2); font-size:12px; margin-top:36px; }
.fade-in { animation:fadeIn .45s ease both; }
@keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
.status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
.status-dot.on { background:var(--green); box-shadow:0 0 8px var(--green); }
.status-dot.off { background:var(--muted2); }
.filter-chip {
  display:inline-block; padding:5px 15px; border-radius:18px; font-size:13px; text-decoration:none;
  color:var(--muted); border:1px solid var(--card-border); background:rgba(15,23,42,0.5); margin-right:8px; margin-bottom:6px;
  transition:all .18s;
}
.filter-chip:hover { color:#fff; border-color:var(--accent); }
.filter-chip.on { color:#fff; background:linear-gradient(135deg, var(--accent), #3b5bdb); border-color:transparent; box-shadow:0 0 12px var(--glow1); }
.back-top { position:fixed; bottom:24px; right:24px; background:linear-gradient(135deg, var(--accent), #3b5bdb); color:#fff; text-decoration:none; font-size:13px; padding:8px 14px; border-radius:999px; box-shadow:0 2px 10px rgba(47,84,235,.35); opacity:.85; z-index:10; }
.back-top:hover { opacity:1; text-decoration:none; }
.inner-report .module-nav a { color:var(--accent2); border-color:rgba(79,124,255,0.4); }
.inner-report .module-nav a:hover { color:#fff; }
`;

function layout(title: string, body: string, active: string): string {
  const navItems = [
    { href: '/', label: '📰 今日日报', key: 'dash' },
    { href: '/reports', label: '🗂 归档', key: 'reports' },
    { href: '/events', label: '📡 事件', key: 'events' },
    { href: '/feedback', label: '✍️ 反馈', key: 'feedback' },
    { href: '/metrics', label: '📈 质量指标', key: 'metrics' },
  ];
  const nav = navItems
    .map((n) => `<a href="${n.href}" class="${n.key === active ? 'active' : ''}">${n.label}</a>`)
    .join('');
  const llmOk = !!config.llm.apiKey;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · AI Insight Agent</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top fade-in">
  <div class="brand">
    <div class="logo">⚡</div>
    <div>
      <div class="name">AI Insight Agent</div>
      <div class="sub mono">Market Intelligence · Daily Report</div>
    </div>
  </div>
  <nav>${nav}</nav>
</header>
${body}
<footer class="fade-in">
  <span class="status-dot ${llmOk ? 'on' : 'off'}"></span>
  LLM: ${llmOk ? config.llm.model : '规则引擎（降级）'}
  <span style="margin:0 10px">|</span> AI Insight Agent · 零依赖 · Node ${process.version}
</footer>
</div>
</body>
</html>`;
}

// ========== 页面渲染 ==========

/** 主页 = 今日日报全文（最新一份）+ 最近日报快捷入口 */
function renderHome(): string {
  const reports = listReports();
  const events = listStandardEvents();
  const feedback = listFeedback();
  const runs = listTaskRuns(10);
  const today = new Date().toISOString().slice(0, 10);
  const done = runs.filter((r) => r.status === 'done').length;
  const latest = reports[0]; // listReports 按 date DESC

  let reportHtml = '';
  if (latest) {
    // 优先读归档 HTML（含模块锚点导航），否则读 DB content 渲染
    const htmlPath = latest.markdown_path ? latest.markdown_path.replace(/\.md$/, '.html') : '';
    if (htmlPath && fs.existsSync(htmlPath)) {
      // 内嵌归档 HTML：去掉其 <!DOCTYPE>/<html>/<head>/<body> 骨架，只保留内容区（含导航条/锚点/返回顶部）
      const raw = fs.readFileSync(htmlPath, 'utf-8');
      // 以 <footer> 为结束锚点（footer 前是全部内容区），footer 后只剩返回顶部按钮（一并截掉，主页导航已够用）
      const contentMatch = raw.match(/<div class="wrap">([\s\S]*?)<footer>/);
      reportHtml = contentMatch ? `<div class="inner-report">${contentMatch[1]}</div>` : raw;
    } else {
      const detail = getReport(latest.report_id);
      if (detail) reportHtml = `<div class="card"><pre>${escapeHtml(detail.content)}</pre></div>`;
    }
  }

  const recentLinks = reports.slice(0, 8).map((r) => `
    <div style="margin-bottom:10px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <span>📄 <a href="/reports/${r.report_id}">${r.report_id}</a> <span class="muted mono">${r.date}</span></span>
      <span class="muted">push=${r.push_status}</span>
    </div>`).join('') || '<p class="muted">暂无日报，运行 <code>npm run</code> 生成</p>';

  // 主页返回顶部按钮（独立于内嵌日报）
  const backTop = '<a href="#" class="back-top" title="返回顶部">↑ 顶部</a>';

  const body = `
<div class="fade-in">
<div class="grid" style="margin-bottom:18px">
  <div class="stat hl"><b>${reports.length}</b><div class="lbl">日报（归档分页查看）</div></div>
  <div class="stat"><b>${events.length}</b><div class="lbl">标准化事件</div></div>
  <div class="stat"><b>${feedback.length}</b><div class="lbl">人工反馈</div></div>
  <div class="stat"><b>${done}/${runs.length}</b><div class="lbl">成功任务</div></div>
</div>

${latest ? `
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px">
  <h1><span class="grad">📰 今日日报</span> <span class="muted" style="font-size:13px">${latest.date} ｜ <a href="/reports/${latest.report_id}">${latest.report_id}</a></span></h1>
  <span><a href="/reports/${latest.report_id}" class="badge badge-blue">网页版预览</a> <a href="/reports/${latest.report_id}?raw=1" class="badge badge-gray">Markdown</a></span>
</div>
<div class="card" style="padding:8px 6px">${reportHtml}</div>
` : '<div class="card"><p class="muted">暂无日报，运行 <code>npm run</code> 生成</p></div>'}

<h2>最近任务</h2>
<div class="card">
<table>
<tr><th>时间</th><th>触发</th><th>状态</th><th>日期</th><th>摘要</th></tr>
${runs.map((r) => `<tr><td class="muted mono">${r.started_at.slice(0, 19)}</td><td>${r.trigger_type}</td><td><span class="badge ${r.status === 'done' ? 'badge-green' : r.status === 'partial' ? 'badge-amber' : r.status === 'failed' ? 'badge-red' : 'badge-gray'}">${r.status}</span></td><td class="mono">${r.date}</td><td class="muted">${r.summary.slice(0, 90)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">暂无任务记录，运行 <code>npm run</code> 开始</td></tr>'}
</table>
</div>

<h2>最近日报</h2>
<div class="card">${recentLinks}
<div class="divider"></div>
<div style="text-align:center"><a href="/reports" class="badge badge-blue">查看全部归档 →</a></div>
</div>
</div>
${backTop}
`;
  return layout('今日日报', body, 'dash');
}

/** 归档分页：每页 10 份 */
function renderReports(page = 1): string {
  const PAGE_SIZE = 10;
  const total = countReports();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageClamped = Math.min(Math.max(1, page), totalPages);
  const reports = listReports(PAGE_SIZE, (pageClamped - 1) * PAGE_SIZE);

  const paginationHtml = `
<div class="pagination" style="display:flex;justify-content:center;align-items:center;gap:14px;margin:20px 0 6px">
  ${pageClamped > 1 ? `<a href="/reports?page=${pageClamped - 1}" class="filter-chip">← 上一页</a>` : '<span class="filter-chip" style="opacity:.45;cursor:not-allowed">← 上一页</span>'}
  <span class="muted mono">第 ${pageClamped} / ${totalPages} 页（共 ${total} 份）</span>
  ${pageClamped < totalPages ? `<a href="/reports?page=${pageClamped + 1}" class="filter-chip">下一页 →</a>` : '<span class="filter-chip" style="opacity:.45;cursor:not-allowed">下一页 →</span>'}
</div>`;

  const body = `
<div class="fade-in">
<h1><span class="grad">🗂 日报归档</span> <span class="muted" style="font-size:13px">共 ${total} 份，按日期倒序</span></h1>
${paginationHtml}
${reports.map((r) => `<div class="card">
<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center">
  <b class="mono">${r.report_id}</b>
  <span class="muted">${r.date} ｜ push=${r.push_status}</span>
</div>
<div style="margin-top:8px"><a href="/reports/${r.report_id}">📄 网页版预览</a> ｜ <a href="/reports/${r.report_id}?raw=1">查看 Markdown</a></div>
<div class="muted mono" style="margin-top:6px;font-size:12px">${r.markdown_path || ''}</div>
</div>`).join('') || '<div class="card"><p class="muted">暂无日报，运行 <code>npm run</code> 生成</p></div>'}
${paginationHtml}
</div>
`;
  return layout('日报归档', body, 'reports');
}

function renderReportDetail(report: { report_id: string; date: string; content: string; markdown_path: string | null; push_status: string }): string {
  const body = `
<div class="fade-in">
<h1><span class="grad">📄 ${report.report_id}</span></h1>
<p class="muted">日期 ${report.date} ｜ push=${report.push_status} ｜ <a href="/reports/${report.report_id}?raw=1">原始 Markdown</a></p>
<div class="divider"></div>
<div class="card"><pre>${escapeHtml(report.content)}</pre></div>
</div>
`;
  return layout(report.report_id, body, 'reports');
}

function renderEvents(moduleFilter = ''): string {
  const opts = moduleFilter ? { module: moduleFilter } : {};
  const events = listStandardEvents(opts);
  const visible = events.slice(0, 200);
  const modules = [
    { key: '', label: '全部' },
    { key: 'opensource', label: 'AI 开源技术' },
    { key: 'paper', label: 'AI 学术研究' },
    { key: 'enterprise', label: 'AI 企业动态' },
  ];
  const filterHtml = modules.map((m) =>
    `<a href="/events${m.key ? `?module=${m.key}` : ''}" class="filter-chip ${m.key === moduleFilter ? 'on' : ''}">${m.label}</a>`,
  ).join('');
  const body = `
<div class="fade-in">
<h1><span class="grad">📡 标准化事件</span> <span class="muted">（${events.length} 条，显示前 ${visible.length} 条）</span></h1>
<div style="margin:14px 0">${filterHtml}</div>
${visible.map((e) => `<div class="card">
<div><span class="badge badge-blue">${e.category}</span> ${e.sub_type ? `<span class="badge badge-gray">${e.sub_type}</span>` : ''} <b>${escapeHtml(e.title)}</b></div>
<p class="muted" style="margin-top:6px">${escapeHtml(e.description.slice(0, 160))}</p>
<div class="muted" style="margin-top:8px">公司: ${e.company || '-'} ｜ 产品: ${e.product || '-'} ｜ 时间: <span class="mono">${e.time}</span> ｜ 状态: <span class="badge badge-gray">${e.status}</span></div>
<div class="muted" style="margin-top:6px">真实性 <b class="mono">${e.accuracy_score.toFixed(1)}</b> ｜ 综合 <b class="mono">${e.importance_score.toFixed(1)}</b> ｜ 来源 ${e.source.length} 个 ｜ <a href="/feedback?event=${e.event_id}">反馈</a></div>
</div>`).join('') || '<div class="card"><p class="muted">暂无事件</p></div>'}
</div>
`;
  return layout('事件', body, 'events');
}

function renderFeedback(): string {
  const feedback = listFeedback();
  const events = listStandardEvents();
  const eventOptions = events.map((e) => `<option value="${e.event_id}">${e.event_id} · ${escapeHtml(e.title.slice(0, 40))}</option>`).join('');
  const body = `
<div class="fade-in">
<h1><span class="grad">✍️ 人工反馈</span></h1>
<div class="card">
<h2>提交反馈</h2>
<form method="POST" action="/api/feedback">
<label>事件</label><select name="event_id" required>${eventOptions}</select>
<div style="height:12px"></div>
<label>人工评分（0-5）</label><input type="number" name="human_score" min="0" max="5" step="0.5" required>
<div style="height:12px"></div>
<label>问题标签（逗号分隔，如：不准确,标题党,重复）</label><input type="text" name="problem_tags">
<div style="height:12px"></div>
<label>建议</label><textarea name="suggestion" rows="3"></textarea>
<div style="height:14px"></div>
<button class="btn" type="submit">提交反馈</button>
</form>
</div>
<h2>历史反馈（${feedback.length}）</h2>
${feedback.map((f) => `<div class="card"><b class="mono">${f.event_id}</b> ｜ 人工 <b class="mono">${f.human_score ?? '-'}</b> 分 ｜ 标签: ${f.problem_tags.join(', ') || '-'}<br><span class="muted">${f.suggestion || ''}</span></div>`).join('') || '<div class="card"><p class="muted">暂无反馈</p></div>'}
</div>
`;
  return layout('反馈', body, 'feedback');
}

function renderMetrics(): string {
  const weekly = computeQualityMetrics('weekly');
  const monthly = computeQualityMetrics('monthly');
  const stat = (m: { total_feedback: number; avg_agent_score: number; avg_human_score: number; consistency_rate: number; satisfaction_rate: number }) => `
<div class="stat hl"><b>${m.total_feedback}</b><div class="lbl">反馈总数</div></div>
<div class="stat"><b>${m.avg_agent_score}</b><div class="lbl">Agent 均分</div></div>
<div class="stat"><b>${m.avg_human_score}</b><div class="lbl">人工均分</div></div>
<div class="stat"><b>${m.consistency_rate}%</b><div class="lbl">一致率</div></div>
<div class="stat"><b>${m.satisfaction_rate}%</b><div class="lbl">满意度</div></div>`;
  const body = `
<div class="fade-in">
<h1><span class="grad">📈 质量指标</span></h1>
<h2>近 7 天</h2>
<div class="grid">${stat(weekly)}</div>
<h2>近 30 天</h2>
<div class="grid">${stat(monthly)}</div>
<h2>低分原因分布（周）</h2>
<div class="card"><pre>${escapeHtml(JSON.stringify(weekly.low_score_reasons, null, 2))}</pre></div>
</div>
`;
  return layout('质量指标', body, 'metrics');
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

export { renderHome };
