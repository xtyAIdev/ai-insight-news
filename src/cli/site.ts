/**
 * Public Site 静态服务（只读，读者向 —— 面向 GitHub Pages 展示形态）
 *
 * 职责边界（用户明确要求）：
 *  - 前端展示页（今日日报 + 归档）与内部控制台分离 —— 本文件只服务"读者阅读"场景
 *  - 只读：无反馈提交、无事件详情、无任务/数据源管理（那些是本地调试台 console 的职责）
 *  - 本地可用 `site` 命令预览；生产由 GitHub Actions `build-site.mjs` 生成纯静态站点
 *
 * 页面：
 *  - /              今日日报全文（最新一期）+ 归档入口
 *  - /reports/<id>  单期日报（优先读归档 HTML，回退 DB）
 *  - /reports       归档列表
 *  视觉：白色专业卡片化（#1a56db 主色）—— 与 build-site.mjs 同一设计语言
 */

import http from 'node:http';
import fs from 'node:fs';
import { listReports, getReport } from '../db/index.js';
import { logger } from '../utils/logger.js';

export function startSiteServer(port: number): void {
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Server Error: ${err instanceof Error ? err.message : err}`);
    }
  });

  server.listen(port, () => {
    logger.info(`[site] Public Site 已启动 http://127.0.0.1:${port}（只读：今日日报 + 归档）`);
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHome());
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
    // 优先读归档 HTML（含模块锚点/快评样式），回退 DB content
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

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

// ========== 白色专业卡片化布局（读者向，只读） ==========

const SHELL_CSS = `
:root {
  --bg:#f5f7fb; --card:#ffffff; --card-border:#e2e8f0;
  --text:#1e293b; --muted:#64748b; --muted2:#94a3b8;
  --accent:#1a56db; --accent-soft:#eff4ff; --accent-border:#c7d7fe;
  --green:#059669;
  --radius:12px; --shadow:0 1px 3px rgba(15,23,42,0.06), 0 4px 14px rgba(15,23,42,0.05);
  --serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif;
  --mono:'SF Mono','JetBrains Mono',Consolas,Menlo,monospace;
}
* { box-sizing:border-box; margin:0; padding:0; }
body {
  font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  background:var(--bg); color:var(--text); line-height:1.75; min-height:100vh;
  -webkit-font-smoothing:antialiased; font-size:15px;
}
.wrap { max-width:960px; margin:0 auto; padding:28px 24px 80px; }
header.top {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:16px 20px; margin-bottom:24px; flex-wrap:wrap;
  background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius);
  box-shadow:var(--shadow);
}
.brand { display:flex; align-items:center; gap:12px; }
.brand .logo {
  width:36px; height:36px; border-radius:9px; flex:none;
  background:var(--accent); color:#fff;
  display:flex; align-items:center; justify-content:center; font-size:17px;
}
.brand .name { font-size:16px; font-weight:700; }
.brand .sub { font-size:12px; color:var(--muted); }
nav { display:flex; gap:6px; flex-wrap:wrap; }
nav a {
  padding:7px 14px; border-radius:8px; font-size:13.5px; text-decoration:none; color:var(--muted);
  border:1px solid transparent; transition:all .15s; font-weight:500;
}
nav a:hover { color:var(--accent); background:var(--accent-soft); }
nav a.active { color:var(--accent); background:var(--accent-soft); border-color:var(--accent-border); }
h1 { font-size:22px; margin-bottom:6px; font-weight:700; }
h2 { font-size:15.5px; margin:22px 0 12px; padding-left:10px; border-left:3px solid var(--accent); }
.muted { color:var(--muted); font-size:13px; }
.mono { font-family:var(--mono); }
.card {
  background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius);
  padding:18px 22px; margin-bottom:14px; box-shadow:var(--shadow);
}
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
table { width:100%; border-collapse:collapse; font-size:13.5px; }
th,td { padding:9px 11px; border-bottom:1px solid var(--card-border); text-align:left; vertical-align:top; }
th { background:#f8fafc; color:var(--muted); font-weight:600; font-size:12.5px; }
tr:hover td { background:#fafcff; }
pre {
  background:#f8fafc; border:1px solid var(--card-border); border-radius:10px;
  padding:16px; overflow-x:auto; font-size:13px; line-height:1.55; font-family:var(--mono);
}
code { font-family:var(--mono); background:var(--accent-soft); padding:1px 6px; border-radius:5px; font-size:12.5px; color:var(--accent); }
.badge { display:inline-block; padding:2px 11px; border-radius:999px; font-size:12px; font-weight:600; }
.badge-blue { background:var(--accent-soft); color:var(--accent); border:1px solid var(--accent-border); }
.badge-gray { background:#f1f5f9; color:var(--muted); border:1px solid #e2e8f0; }
.archive { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; }
.archive a {
  display:block; padding:14px 16px; background:var(--card); border:1px solid var(--card-border);
  border-radius:10px; text-decoration:none; color:var(--text); transition:all .15s;
}
.archive a:hover { border-color:var(--accent-border); background:var(--accent-soft); }
.archive .d { font-size:14px; font-weight:600; font-family:var(--mono); }
.archive .t { font-size:11.5px; color:var(--muted); margin-top:3px; }
.archive a.today { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.inner-report .module-nav a { color:var(--accent); border-color:var(--accent-border); }

/* ===== 今日日报卡片式分模块（用户要求：每板块独立卡片、有分隔边界） ===== */
.module-card { margin-bottom:18px; padding:22px 26px; }
/* 内嵌归档 section.module 自带的背景/圆角/内边距与外层卡片冲突 → 归零，让卡片样式接管 */
.module-card section.module { background:transparent; border:none; border-radius:0; padding:0; margin:0; }
.module-card h2 {
  font-size:17px; font-weight:700; margin:0 0 14px; padding-left:11px;
  border-left:4px solid var(--accent); line-height:1.4;
}
.module-card h3 { font-size:15.5px; font-weight:650; margin:0 0 6px; line-height:1.5; color:var(--text); }
.module-card .news-body { font-size:14px; color:#334155; margin:0 0 8px; line-height:1.75; }
.module-card .comment {
  font-size:13px; color:#8a4baf; background:#f8f2fc; border-left:3px solid #c084fc;
  padding:7px 12px; border-radius:6px; margin:8px 0; line-height:1.65;
}
/* 元信息：时间/公司/标签 作为标题下小字内嵌（用户要求"内嵌小字体跟之前一样"） */
.module-card .meta { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; margin:0 0 8px; }
.module-card .meta .tag {
  display:inline-flex; align-items:center; gap:4px; background:var(--accent-soft);
  color:var(--accent); border-radius:5px; padding:1px 9px; font-size:12px; font-weight:500; line-height:1.6;
}
.module-card .meta .tag-time { background:#fff7e6; color:#ad6800; border:1px solid #ffe58f; font-weight:500; }
.module-card .meta .tag-gray { background:#f1f5f9; color:var(--muted); font-weight:400; }
.module-card .source { font-size:12.5px; color:var(--muted); }
.module-card .source a { color:var(--accent); text-decoration:none; margin-right:8px; }
.module-card .source a:hover { text-decoration:underline; }
.module-card .news-item { padding:14px 0; border-bottom:1px solid var(--card-border); }
.module-card .news-item:last-child { border-bottom:none; }
.module-card .empty-note { color:var(--muted); font-style:italic; font-size:13.5px; }
.summary-card { background:var(--accent-soft); border-color:var(--accent-border); }
.summary-card h2 { font-size:16px; margin-bottom:8px; }
.summary-card p { color:#334155; font-size:14px; margin:0; }
.watch-item { padding:8px 0; font-size:13.5px; border-bottom:1px solid var(--card-border); color:var(--text); }
.watch-item:last-child { border-bottom:none; }
.watch-item b { color:var(--text); }
footer { text-align:center; color:var(--muted2); font-size:12px; margin-top:36px; border-top:1px solid var(--card-border); padding-top:20px; }
.fade-in { animation:fadeIn .35s ease both; }
@keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
.back-top { position:fixed; bottom:24px; right:24px; background:var(--accent); color:#fff; text-decoration:none; font-size:13px; padding:8px 14px; border-radius:999px; box-shadow:0 2px 10px rgba(26,86,219,.3); opacity:.85; z-index:10; }
.back-top:hover { opacity:1; text-decoration:none; }
`;

function layout(title: string, body: string, active: string): string {
  const navItems = [
    { href: '/', label: '📰 今日日报', key: 'home' },
    { href: '/reports', label: '🗂 历史归档', key: 'reports' },
  ];
  const nav = navItems
    .map((n) => `<a href="${n.href}" class="${n.key === active ? 'active' : ''}">${n.label}</a>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · AI 行业市场洞察</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top fade-in">
  <div class="brand">
    <div class="logo">📊</div>
    <div>
      <div class="name">AI 行业市场洞察</div>
      <div class="sub mono">Market Intelligence · 每日报告</div>
    </div>
  </div>
  <nav>${nav}</nav>
</header>
${body}
<footer class="fade-in">AI 行业市场洞察日报 · 由 AI Insight Agent 自动生成 · 每日更新</footer>
</div>
</body>
</html>`;
}

// ========== 页面 ==========

/** 主页 = 今日日报全文（最新一份），卡片式分模块展示 */
function renderHome(): string {
  const reports = listReports();
  const latest = reports[0]; // listReports 按 date DESC

  let reportHtml = '';
  if (latest) {
    const htmlPath = latest.markdown_path ? latest.markdown_path.replace(/\.md$/, '.html') : '';
    if (htmlPath && fs.existsSync(htmlPath)) {
      // 解析归档 HTML：按 <section class="module"> 拆成独立卡片（每个模块有自己的边界）
      // 保留 速览(summary) 整块；观察名单也独立成卡片 —— 不整段内嵌导致"像一篇文章"
      const raw = fs.readFileSync(htmlPath, 'utf-8');
      const modules = splitModules(raw);
      const parts: string[] = [];
      if (modules.summary) parts.push(`<div class="card summary-card">${modules.summary}</div>`);
      for (const m of modules.list) {
        parts.push(`<div class="card module-card">${m}</div>`);
      }
      reportHtml = parts.join('\n');
    } else {
      const detail = getReport(latest.report_id);
      if (detail) reportHtml = `<div class="card"><pre>${escapeHtml(detail.content)}</pre></div>`;
    }
  }

  const backTop = '<a href="#" class="back-top" title="返回顶部">↑ 顶部</a>';

  const body = `
<div class="fade-in">
${latest ? `
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px">
  <h1>📰 今日日报 <span class="muted" style="font-size:13px">${latest.date} ｜ ${latest.report_id}</span></h1>
  <span><a href="/reports/${latest.report_id}" class="badge badge-blue">网页版</a></span>
</div>
${reportHtml}
` : '<div class="card"><p class="muted">暂无日报，运行 <code>npm run</code> 生成</p></div>'}
</div>
${backTop}
`;
  return layout('今日日报', body, 'home');
}

/**
 * 从归档 HTML 中拆分各 <section class="module"> 区块与速览 summary。
 * 返回 { summary, list }：summary = 速览块（原始 HTML），list = 各模块块（含观察名单）。
 * 拆分后保留 section 的 id 锚点（module-opensource/paper/enterprise），供顶部模块导航跳转；
 * 并用 site 的卡片样式重新包裹，模块间有独立边界。
 */
function splitModules(raw: string): { summary: string; list: string[] } {
  const result: { summary: string; list: string[] } = { summary: '', list: [] };
  // 速览块：<section class="summary">...</section>
  const summaryMatch = raw.match(/<section class="summary">([\s\S]*?)<\/section>/);
  if (summaryMatch) result.summary = summaryMatch[1];
  // 模块块：<section class="module" id="...">...</section>（含观察名单）——保留开标签的 id 锚点
  const moduleRegex = /(<section class="module"[^>]*>)([\s\S]*?)<\/section>/g;
  let m: RegExpExecArray | null;
  while ((m = moduleRegex.exec(raw)) !== null) {
    // 只保留模块开标签（含 id），内容原样 —— 卡片样式由外层 .module-card 控制
    result.list.push(`${m[1]}${m[2]}</section>`);
  }
  return result;
}

/** 归档列表（简单分页） */
function renderReports(page = 1): string {
  const PAGE_SIZE = 12;
  const total = listReports().length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageClamped = Math.min(Math.max(1, page), totalPages);
  const reports = listReports(PAGE_SIZE, (pageClamped - 1) * PAGE_SIZE);

  const pagination = `
<div style="display:flex;justify-content:center;align-items:center;gap:14px;margin:20px 0 6px">
  ${pageClamped > 1 ? `<a href="/reports?page=${pageClamped - 1}" class="badge badge-blue">← 上一页</a>` : ''}
  <span class="muted mono">第 ${pageClamped} / ${totalPages} 页（共 ${total} 期）</span>
  ${pageClamped < totalPages ? `<a href="/reports?page=${pageClamped + 1}" class="badge badge-blue">下一页 →</a>` : ''}
</div>`;

  const body = `
<div class="fade-in">
<h1>🗂 历史归档</h1>
${pagination}
<div class="archive">
${reports.map((r) => `<a href="/reports/${r.report_id}">
  <div class="d">${r.date}</div><div class="t">${r.report_id}</div>
</a>`).join('') || '<p class="muted">暂无日报</p>'}
</div>
${pagination}
</div>
`;
  return layout('历史归档', body, 'reports');
}

function renderReportDetail(report: { report_id: string; date: string; content: string; markdown_path: string | null }): string {
  const body = `
<div class="fade-in">
<h1>📄 ${report.report_id}</h1>
<p class="muted">日期 ${report.date} ｜ <a href="/reports">← 返回归档</a></p>
<div class="card" style="margin-top:14px"><pre>${escapeHtml(report.content)}</pre></div>
</div>
`;
  return layout(report.report_id, body, 'reports');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { renderHome };
