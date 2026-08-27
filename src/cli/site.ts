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
/* 语言切换（右上角） */
.lang-switch { display:inline-flex; border:1px solid var(--accent-border); border-radius:999px; overflow:hidden; background:var(--card); align-self:center; }
.lang-switch button { border:none; background:transparent; padding:5px 16px; font-size:13px; font-weight:600; color:var(--muted); cursor:pointer; transition:all .15s; }
.lang-switch button.on { background:var(--accent); color:#fff; }
.lang-switch button:not(.on):hover { color:var(--accent); background:var(--accent-soft); }
`;

function layout(title: string, body: string, active: string): string {
  const navItems = [
    { href: '/', label: '📰 Today', key: 'home' },
    { href: '/reports', label: '🗂 Archive', key: 'reports' },
  ];
  const nav = navItems
    .map((n) => `<a href="${n.href}" class="${n.key === active ? 'active' : ''}">${n.label}</a>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · AI Industry Market Intelligence</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top fade-in">
  <div class="brand">
    <div class="logo">📊</div>
    <div>
      <div class="name">AI Industry Market Intelligence</div>
      <div class="sub mono">Market Intelligence · Daily Report</div>
    </div>
  </div>
  <nav>
    <span class="lang-switch">
      <button type="button" data-lang-btn="en" class="on">En</button>
      <button type="button" data-lang-btn="zh">中文</button>
    </span>
    ${nav}
  </nav>
</header>
${body}
<footer class="fade-in">
  <div>AI Industry Market Intelligence Daily · Generated by AI Insight Agent · Updated daily</div>
  <div style="margin-top:10px">
    <a href="https://github.com/xtyAIdev/ai-insight-news" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:13px;text-decoration:none;transition:color .15s" onmouseover="this.style.color='#1a56db'" onmouseout="this.style.color=''">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      GitHub · xtyAIdev/ai-insight-news
    </a>
  </div>
</footer>
</div>
</body>
</html>`;
}

// ========== 页面 ==========

/** 主页 = 今日日报全文（最新一份），卡片式分模块展示（双语：默认英文，可切中文） */
function renderHome(): string {
  const reports = listReports();
  const latest = reports[0]; // listReports 按 date DESC

  let reportHtml = '';
  if (latest) {
    const htmlPath = latest.markdown_path ? latest.markdown_path.replace(/\.md$/, '.html') : '';
    if (htmlPath && fs.existsSync(htmlPath)) {
      // 解析归档 HTML：双语（en/zh）各拆成独立卡片
      const raw = fs.readFileSync(htmlPath, 'utf-8');
      const modules = splitModules(raw);
      const buildLang = (lang: 'en' | 'zh') => {
        const parts: string[] = [];
        const data = modules[lang];
        if (!data) return '';
        if (data.summary) parts.push(`<div class="card summary-card">${data.summary}</div>`);
        for (const m of data.list) {
          parts.push(`<div class="card module-card">${m}</div>`);
        }
        return parts.join('\n');
      };
      const en = buildLang('en');
      const zh = buildLang('zh');
      reportHtml = `
<div data-lang-block="en" class="lang-active">${en || '<p class="empty-note">No content</p>'}</div>
<div data-lang-block="zh" style="display:none">${zh || '<p class="empty-note">暂无日报内容</p>'}</div>`;
    } else {
      const detail = getReport(latest.report_id);
      if (detail) reportHtml = `<div class="card"><pre>${escapeHtml(detail.content)}</pre></div>`;
    }
  }

  const backTop = '<a href="#" class="back-top" title="Back to top">↑ Top</a>';

  const body = `
<div class="fade-in">
${latest ? `
<div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:8px">
  <h1>📰 Today <span class="muted" style="font-size:13px">${latest.date}</span></h1>
</div>
${reportHtml}
` : '<div class="card"><p class="muted">No reports yet — run <code>npm run</code> to generate</p></div>'}
</div>
${backTop}
<script>
(function () {
  var btns = document.querySelectorAll('[data-lang-btn]');
  var blocks = document.querySelectorAll('[data-lang-block]');
  function setLang(lang) {
    btns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-lang-btn') === lang); });
    blocks.forEach(function (b) {
      var show = b.getAttribute('data-lang-block') === lang;
      b.classList.toggle('lang-active', show);
      b.style.display = show ? '' : 'none';
    });
    try { localStorage.setItem('ai-daily-lang', lang); } catch (e) {}
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }
  var saved = null; try { saved = localStorage.getItem('ai-daily-lang'); } catch (e) {}
  setLang(saved === 'zh' ? 'zh' : 'en');
  btns.forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.getAttribute('data-lang-btn')); });
  });
})();
</script>
`;
  return layout('今日日报', body, 'home');
}

/**
 * 从归档 HTML 中拆分各 <section class="module"> 区块与速览 summary。
 * 2026-08-27 双语化：reporter HTML 含 data-lang-block="en/zh"，返回 { en, zh } 两份。
 * 返回 { en: {summary, list}, zh: {summary, list} }；旧版 HTML 仅 en 有值。
 */
function splitModules(raw: string): { en: { summary: string; list: string[] }; zh: { summary: string; list: string[] } } {
  const result = {
    en: { summary: '', list: [] as string[] },
    zh: { summary: '', list: [] as string[] },
  };

  function extractLang(lang: string) {
    // 取 data-lang-block="<lang>" 内容（不含闭合 div 后续）；旧版 HTML 无 lang-block 时整页视为 en。
    // 结束边界：独占一行的 </div> 后紧跟下一个 data-lang-block 或 <footer> ——
    // 日报内容内部嵌套 <section>/<div> 卡片，不能简单取第一个 </div>。
    let block = '';
    if (raw.includes('data-lang-block')) {
      const start = raw.indexOf(`<div data-lang-block="${lang}"`);
      if (start !== -1) {
        const contentStart = raw.indexOf('>', start) + 1;
        // 结束边界：闭合 </div> 后紧跟下一个 data-lang-block 或 <footer>（容忍有无换行/空白）
        const tail = raw.slice(contentStart);
        const endMatch = tail.match(/<\/div>\s*(?=<div data-lang-block|<footer)/);
        block = endMatch ? tail.slice(0, endMatch.index) : tail;
      }
    } else {
      block = lang === 'en' ? raw : '';
    }
    const out = { summary: '', list: [] as string[] };
    if (!block) return out;
    const summaryMatch = block.match(/<section class="summary">([\s\S]*?)<\/section>/);
    if (summaryMatch) out.summary = summaryMatch[1];
    const moduleRegex = /(<section class="module"[^>]*>)([\s\S]*?)<\/section>/g;
    let m: RegExpExecArray | null;
    while ((m = moduleRegex.exec(block)) !== null) {
      out.list.push(`${m[1]}${m[2]}</section>`);
    }
    return out;
  }

  if (raw.includes('data-lang-block')) {
    result.en = extractLang('en');
    result.zh = extractLang('zh');
  } else {
    result.en = extractLang('en');
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
