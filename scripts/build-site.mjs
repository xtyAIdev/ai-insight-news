/**
 * 生成 GitHub Pages 静态站点（workflow 内运行）
 * 输出到 site/ 目录：
 *   - index.html    当日日报全文（卡片式分模块）+ 顶部归档入口
 *   - archive.html  独立历史归档页（全部日期）
 *   - <date>/<report_id>.html  每日日报网页版
 * 随后由 workflow 将 site/ 上传并部署到 GitHub Pages。
 *
 * 设计原则：浅色、克制的科技感 —— 白/浅灰底 + 单一强调色（靛蓝），
 * 细线分隔、留白充足、衬线标题与无衬线正文搭配，避免深色霓虹"AI 味"。
 * 2026-08-25：同步 site.ts 的卡片式分模块 —— 每板块独立卡片有边界，
 * 不再整段内嵌成"一篇文章"；首页底部历史归档移入独立 archive.html。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const reportsDir = path.join(projectRoot, 'reports');
const siteDir = path.join(projectRoot, 'site');

// ========== 数据收集 ==========

function collectReports() {
  if (!fs.existsSync(reportsDir)) return [];
  const out = [];
  for (const dateDir of fs.readdirSync(reportsDir).sort()) {
    const abs = path.join(reportsDir, dateDir);
    if (!fs.statSync(abs).isDirectory()) continue;
    for (const file of fs.readdirSync(abs)) {
      if (!file.endsWith('.html')) continue;
      const reportId = file.replace(/\.html$/, '');
      out.push({ date: dateDir, reportId, htmlFile: path.join(abs, file) });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** 从日报 HTML 拆分速览 + 各模块（卡片式分模块，与 site.ts splitModules 同语义） */
function splitModules(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf-8');
  const result = { summary: '', modules: [] };
  const summaryMatch = html.match(/<section class="summary">([\s\S]*?)<\/section>/);
  if (summaryMatch) result.summary = summaryMatch[1];
  const moduleRegex = /(<section class="module"[^>]*>)([\s\S]*?)<\/section>/g;
  let m;
  while ((m = moduleRegex.exec(html)) !== null) {
    result.modules.push(`${m[1]}${m[2]}</section>`);
  }
  return result;
}

/** 把最新一期日报渲染成独立卡片序列（速览卡 + 每模块卡），模块间有独立边界 */
function buildLatestCards(latest) {
  const parts = [];
  const split = splitModules(latest.htmlFile);
  if (split.summary) parts.push(`<div class="card summary-card">${split.summary}</div>`);
  for (const mod of split.modules) {
    parts.push(`<div class="card module-card">${mod}</div>`);
  }
  if (parts.length === 0) return '<p class="empty-note">暂无日报内容</p>';
  return parts.join('\n');
}

/** 解析日报标题（HTML 版 h1） */
function extractTitle(htmlFile, date) {
  const html = fs.readFileSync(htmlFile, 'utf-8');
  const m = html.match(/<title>([^<]*)<\/title>/);
  return m ? m[1].trim() : `AI 行业市场洞察日报 ${date}`;
}

// ========== 渲染 ==========

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE_CSS = `
:root {
  --bg:#f7f8fa; --card:#ffffff; --border:#e5e8ee; --border-strong:#d3d9e3;
  --text:#1a2233; --text-2:#3d4759; --muted:#6b7486; --muted-2:#98a1b3;
  --accent:#2f54eb; --accent-soft:#eef2ff; --accent-border:#c7d2fe;
  --green:#0e8a5f; --green-soft:#e6f6ef;
  --serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif;
  --sans:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --mono:"SF Mono","JetBrains Mono",Consolas,Menlo,monospace;
}
* { box-sizing:border-box; margin:0; padding:0; }
body {
  font-family:var(--sans); background:var(--bg); color:var(--text);
  line-height:1.75; -webkit-font-smoothing:antialiased; font-size:15px;
}
.wrap { max-width:960px; margin:0 auto; padding:0 24px 80px; }

/* 顶部栏 */
.topbar {
  display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding:18px 0; border-bottom:1px solid var(--border); flex-wrap:wrap;
  margin-bottom:36px;
}
.brand { display:flex; align-items:center; gap:12px; }
.brand .logo {
  width:36px; height:36px; border-radius:9px; flex:none;
  background:linear-gradient(135deg, #2f54eb, #5970f0);
  display:flex; align-items:center; justify-content:center; color:#fff; font-size:17px;
  box-shadow:0 2px 10px rgba(47,84,235,0.25);
}
.brand .name { font-size:16px; font-weight:650; letter-spacing:0.2px; }
.brand .sub { font-size:12px; color:var(--muted); }
.nav { display:flex; gap:6px; flex-wrap:wrap; }
.nav a {
  padding:6px 14px; border-radius:8px; font-size:13px; text-decoration:none;
  color:var(--text-2); border:1px solid transparent; transition:all .15s;
}
.nav a:hover { background:var(--accent-soft); color:var(--accent); }
.nav a.on { background:var(--accent-soft); color:var(--accent); border-color:var(--accent-border); }

/* 当日日报 */
.hero { margin-bottom:32px; }
.hero .date-line { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
.hero .date-line .dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 0 4px var(--green-soft); }
.hero .date-line .date { font-size:14px; color:var(--muted); font-weight:500; }
.hero h1 {
  font-family:var(--serif); font-size:30px; font-weight:700; letter-spacing:0.5px;
  color:var(--text); line-height:1.35;
}
.hero .lead { font-size:15.5px; color:var(--text-2); margin-top:6px; }
.hero .meta { display:flex; gap:18px; margin-top:14px; font-size:12.5px; color:var(--muted); flex-wrap:wrap; }

/* 报告正文（卡片式分模块：每模块独立卡片，有独立边界） */
.report-body { display:flex; flex-direction:column; gap:18px; }
.report-body .card {
  background:var(--card); border:1px solid var(--border); border-radius:14px;
  padding:24px 28px; box-shadow:0 1px 3px rgba(15,23,42,0.05);
}
.report-body .module-card section.module {
  background:transparent; border:none; border-radius:0; padding:0; margin:0;
}
.report-body h2 {
  font-family:var(--serif); font-size:19px; font-weight:700; margin:0 0 14px;
  padding-left:11px; border-left:4px solid var(--accent); line-height:1.4;
}
.report-body h3 { font-size:16px; font-weight:650; margin:0 0 6px; color:var(--text); line-height:1.5; }
.report-body .summary { background:var(--accent-soft); border:1px solid var(--accent-border); border-radius:10px; padding:16px 20px; margin-bottom:0; }
.report-body .summary-card h2 { border:none; margin:0 0 8px; padding:0; font-size:16px; }
.report-body .summary-card p { color:var(--text-2); font-size:14px; margin:0; }
.report-body .news-item { padding:14px 0; border-bottom:1px solid var(--border); }
.report-body .news-item:last-child { border-bottom:none; }
.report-body .news-body { color:var(--text-2); font-size:14px; margin:0 0 8px; line-height:1.75; }
.report-body .comment {
  color:#8a4baf; font-size:13px; font-style:italic;
  border-left:3px solid #c084fc; background:#f8f2fc;
  padding:7px 12px; border-radius:6px; margin:8px 0; line-height:1.65;
}
.report-body .meta { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; margin:0 0 8px; }
.report-body .tag {
  display:inline-flex; align-items:center; gap:4px; background:var(--accent-soft); color:var(--accent);
  border-radius:5px; padding:1px 9px; font-size:12px; margin:0; font-weight:500; line-height:1.6;
}
.report-body .tag-gray { background:#f1f5f9; color:var(--muted); font-weight:400; }
.report-body .tag-time { background:#fff7e6; color:#ad6800; border:1px solid #ffe58f; }
.report-body .source { font-size:12.5px; color:var(--muted); }
.report-body .source a { color:var(--accent); text-decoration:none; margin-right:8px; }
.report-body .source a:hover { text-decoration:underline; }
.report-body .empty-note { color:var(--muted); font-style:italic; }
.report-body .watch-item { padding:8px 0; font-size:13.5px; border-bottom:1px solid var(--border); }
.report-body .watch-item:last-child { border-bottom:none; }
.report-body .module-nav { display:flex; justify-content:center; gap:14px; flex-wrap:wrap; margin:0 0 4px; }
.report-body .module-nav a { color:var(--accent); text-decoration:none; font-size:14px; font-weight:600; padding:6px 16px; border:1px solid var(--accent-border); border-radius:999px; background:var(--accent-soft); transition:all .15s; }
.report-body .module-nav a:hover { background:var(--accent); color:#fff; }
.report-body .module-nav .sep { color:var(--muted); align-self:center; }

/* 归档 */
.section-title { font-family:var(--serif); font-size:19px; font-weight:700; margin:40px 0 16px; letter-spacing:0.3px; }
.archive { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; }
.archive a {
  display:block; padding:14px 16px; background:var(--card); border:1px solid var(--border);
  border-radius:10px; text-decoration:none; color:var(--text); transition:all .15s;
}
.archive a:hover { border-color:var(--accent-border); background:var(--accent-soft); transform:translateY(-1px); box-shadow:0 4px 14px rgba(47,84,235,0.08); }
.archive .d { font-size:14px; font-weight:600; font-family:var(--mono); }
.archive .t { font-size:11.5px; color:var(--muted); margin-top:3px; }
.archive a.today { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }

footer { text-align:center; color:var(--muted-2); font-size:12px; margin-top:56px; border-top:1px solid var(--border); padding-top:22px; }
footer a { color:var(--accent); text-decoration:none; }
.fade-in { animation:fadeIn .35s ease both; }
@keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
.back-top { position:fixed; bottom:24px; right:24px; background:var(--accent); color:#fff; text-decoration:none; font-size:13px; padding:8px 14px; border-radius:999px; box-shadow:0 2px 10px rgba(47,84,235,.3); opacity:.85; z-index:10; }
.back-top:hover { opacity:1; text-decoration:none; }
`;

function renderIndex(reports, latest, latestCards, latestTitle) {
  const today = latest ? latest.date : (reports[0]?.date || '');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(latestTitle)} · AI 行业市场洞察</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="topbar">
  <div class="brand">
    <div class="logo">◈</div>
    <div>
      <div class="name">AI 行业市场洞察</div>
      <div class="sub">Market Intelligence · 每日报告</div>
    </div>
  </div>
  <nav class="nav">
    <a href="archive.html">历史归档（${reports.length} 期）</a>
    <a href="https://github.com/xtyAIdev/ai-insight-news" target="_blank" rel="noopener">GitHub 仓库</a>
  </nav>
</header>

${reports.length === 0 ? '<div class="report-body"><p class="empty-note">暂无日报，等待首次自动运行…</p></div>' : `
<section class="hero">
  <div class="date-line"><span class="dot"></span><span class="date">${today} 更新</span></div>
  <h1>${esc(latestTitle)}</h1>
  <div class="meta">
    <span>由 AI Insight Agent 自动生成</span>
    <span>共 ${reports.length} 期归档</span>
  </div>
</section>

<div class="report-body">
${latestCards}
</div>
`}

<footer>
  AI 行业市场洞察日报 · 由 AI Insight Agent 自动生成 · 每日更新
</footer>
</div>
<a href="#" class="back-top" title="返回顶部">↑ 顶部</a>
</body>
</html>`;
}

/** 独立历史归档页（从首页移出 —— 对应 site.ts /reports 语义） */
function renderArchive(reports, latestDate) {
  const cards = reports
    .map((r) => `<a href="./${r.date}/${r.reportId}.html" class="${r.date === latestDate ? 'today' : ''}">
  <div class="d">${r.date}</div>
  <div class="t">${r.date === latestDate ? '今日日报' : '归档'}</div>
</a>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>历史归档 · AI 行业市场洞察</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="topbar">
  <div class="brand">
    <div class="logo">◈</div>
    <div>
      <div class="name">AI 行业市场洞察</div>
      <div class="sub">Market Intelligence · 每日报告</div>
    </div>
  </div>
  <nav class="nav">
    <a href="index.html">今日日报</a>
    <a href="https://github.com/xtyAIdev/ai-insight-news" target="_blank" rel="noopener">GitHub 仓库</a>
  </nav>
</header>

<h1 style="margin-bottom:6px">🗂 历史归档</h1>
<p class="muted" style="margin-bottom:22px">共 ${reports.length} 期日报</p>
<div class="archive">
${cards || '<p class="empty-note">暂无日报</p>'}
</div>

<footer>
  AI 行业市场洞察日报 · 由 AI Insight Agent 自动生成 · 每日更新
</footer>
</div>
<a href="#" class="back-top" title="返回顶部">↑ 顶部</a>
</body>
</html>`;
}

/** 每日独立页：复用日报 HTML（浅色样式由 reporter 渲染，这里仅补一个归档返回链接） */
function renderDaily(report, indexTitle) {
  const html = fs.readFileSync(report.htmlFile, 'utf-8');
  // 注入返回链接到 body 开头
  const injected = html.replace('<div class="wrap">', `<div class="wrap">\n<div style="margin-bottom:18px"><a href="../index.html" style="color:#2f54eb;text-decoration:none;font-size:13px">← 返回归档首页</a></div>`);
  return injected;
}

// ========== 主流程 ==========

const reports = collectReports();
if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(siteDir, { recursive: true });

// 当日 = 最新一期；首页嵌入其正文（卡片式分模块）
const latest = reports[0] || null;
const latestTitle = latest ? extractTitle(latest.htmlFile, latest.date) : 'AI 行业市场洞察日报';
const latestCards = latest ? buildLatestCards(latest) : '';

// 首页（今日日报，卡片式 + 无底部归档）
fs.writeFileSync(path.join(siteDir, 'index.html'), renderIndex(reports, latest, latestCards, latestTitle), 'utf-8');

// 独立归档页
fs.writeFileSync(path.join(siteDir, 'archive.html'), renderArchive(reports, latest?.date || ''), 'utf-8');

// 每日独立页
for (const r of reports) {
  const destDir = path.join(siteDir, r.date);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, `${r.reportId}.html`), renderDaily(r), 'utf-8');
}

console.log(`[site] 站点生成完成：${reports.length} 期日报，当日=${latest?.date || '无'} → site/`);
