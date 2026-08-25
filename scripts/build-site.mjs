/**
 * 生成 GitHub Pages 静态站点（workflow 内运行）
 * 输出到 site/ 目录：
 *   - index.html    当日日报全文 + 归档导航（浅色高雅科技风）
 *   - <date>/<report_id>.html  每日日报网页版
 * 随后由 workflow 将 site/ 上传并部署到 GitHub Pages。
 *
 * 设计原则：浅色、克制的科技感 —— 白/浅灰底 + 单一强调色（靛蓝），
 * 细线分隔、留白充足、衬线标题与无衬线正文搭配，避免深色霓虹"AI 味"。
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

/** 从日报 HTML 中提取正文（去掉 header/footer，保留正文区） */
function extractBody(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf-8');
  const body = html.match(/<div class="wrap">([\s\S]*?)<\/div>\s*<\/body>/i);
  if (!body) return html;
  // 去掉 header（标题区），保留 summary + 各模块
  return body[1].replace(/<header[\s\S]*?<\/header>/, '');
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

/* 报告正文（reporter 渲染的 HTML 内嵌） */
.report-body { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:36px 40px; }
.report-body h2 {
  font-family:var(--serif); font-size:21px; font-weight:700; margin:30px 0 14px;
  padding-bottom:8px; border-bottom:2px solid var(--accent); display:inline-block;
}
.report-body h3 { font-size:16.5px; font-weight:650; margin:22px 0 8px; color:var(--text); }
.report-body .summary { background:var(--accent-soft); border:1px solid var(--accent-border); border-radius:10px; padding:16px 20px; margin-bottom:24px; }
.report-body .summary h2 { border:none; margin:0 0 6px; padding:0; }
.report-body .summary p { color:var(--text-2); font-size:14.5px; }
.report-body .news-item { padding:18px 0; border-bottom:1px solid var(--border); }
.report-body .news-item:last-child { border-bottom:none; }
.report-body .news-body { color:var(--text-2); font-size:14.5px; margin:6px 0 10px; }
.report-body .comment {
  color:var(--text-2); font-size:13.5px; font-style:italic;
  border-left:3px solid var(--accent-border); background:var(--accent-soft);
  padding:8px 14px; border-radius:8px; margin:6px 0 12px; line-height:1.65;
}
.report-body .meta { margin-bottom:8px; }
.report-body .tag {
  display:inline-block; background:var(--accent-soft); color:var(--accent);
  border-radius:6px; padding:1px 10px; font-size:12px; margin-right:6px; font-weight:500;
}
.report-body .tag-gray { background:#f1f3f7; color:var(--muted); }
.report-body .source { font-size:12.5px; color:var(--muted); }
.report-body .source a { color:var(--accent); text-decoration:none; }
.report-body .source a:hover { text-decoration:underline; }
.report-body .empty-note { color:var(--muted); font-style:italic; }
.report-body .watch-item { padding:8px 0; font-size:14px; border-bottom:1px solid var(--border); }
.report-body .module { margin-bottom:28px; }

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
`;

function renderIndex(reports, latest, latestBody, latestTitle) {
  const today = latest ? latest.date : (reports[0]?.date || '');
  const archiveHtml = reports
    .map((r) => {
      const isToday = r.date === today;
      return `<a href="./${r.date}/${r.reportId}.html" class="${isToday ? 'today' : ''}">
  <div class="d">${r.date}</div>
  <div class="t">${isToday ? '今日日报' : '归档'}</div>
</a>`;
    })
    .join('');

  const bodyHtml = latestBody || '<p class="empty-note">暂无日报，等待首次自动运行…</p>';

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
    <a href="https://github.com/xtyAIdev/ai-insight-news" target="_blank" rel="noopener">GitHub 仓库</a>
    <a href="#archive">历史归档</a>
  </nav>
</header>

${reports.length === 0 ? '' : `
<section class="hero">
  <div class="date-line"><span class="dot"></span><span class="date">${today} 更新</span></div>
  <h1>${esc(latestTitle)}</h1>
  <div class="meta">
    <span>日报编号 ${esc(latest?.reportId || '')}</span>
    <span>由 AI Insight Agent 自动生成</span>
    <span>共 ${reports.length} 期归档</span>
  </div>
</section>
`}

<div class="report-body">
${bodyHtml}
</div>

<h2 class="section-title" id="archive">📁 历史归档（${reports.length} 期）</h2>
<div class="archive">
${archiveHtml}
</div>

<footer>
  AI 行业市场洞察日报 · 由 AI Insight Agent 自动生成 · 每日更新
</footer>
</div>
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

// 当日 = 最新一期；首页嵌入其正文
const latest = reports[0] || null;
const latestTitle = latest ? extractTitle(latest.htmlFile, latest.date) : 'AI 行业市场洞察日报';
const latestBody = latest ? extractBody(latest.htmlFile) : '';

// 首页
fs.writeFileSync(path.join(siteDir, 'index.html'), renderIndex(reports, latest, latestBody, latestTitle), 'utf-8');

// 每日独立页
for (const r of reports) {
  const destDir = path.join(siteDir, r.date);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, `${r.reportId}.html`), renderDaily(r), 'utf-8');
}

console.log(`[site] 站点生成完成：${reports.length} 期日报，当日=${latest?.date || '无'} → site/`);
