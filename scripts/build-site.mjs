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

// ========== 反馈闭环（2026-08-31 批3 任务⑥） ==========
// 日报页脚"反馈/纠错"按钮 → 预填 GitHub Issue（标题带 [日报反馈] 前缀，
// 正文含结构化模板），由 .github/workflows/feedback-collect.yml 拉取解析写入
// data/feedback.json（git add -f 持久化到仓库，跨 CI 留存）。
const FEEDBACK_TEMPLATE = (date) => `**日报日期**：${date}

**反馈类型**（可多选）：不准确 / 标题党 / 重复 / 来源不可靠 / 缺事件 / 其他

**涉及事件**（可选，填事件标题或 event_id）：
（请填写日报中具体条目）

**评分**（0-5，你对这条内容的评价）：
（如不涉及具体事件可留空）

**具体说明**：
（请描述问题或改进建议）`;

/** 反馈/纠错按钮 HTML（读者向，跳转 issue 新建页预填模板） */
function feedbackLink(date) {
  const title = `[日报反馈] ${date} 内容纠错/建议`;
  const body = FEEDBACK_TEMPLATE(date);
  const href = `https://github.com/xtyAIdev/ai-insight-news/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return `<a href="${href}" target="_blank" rel="noopener" class="feedback-link">💬 反馈 / 纠错</a>`;
}

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

/** 从日报 HTML 拆分速览 + 各模块（卡片式分模块，与 site.ts splitModules 同语义）。
 *  2026-08-27 双语化：reporter 生成的 HTML 含 data-lang-block="en/zh" 两份内容，
 *  返回 { en: {summary, modules}, zh: {summary, modules} }。 */
function splitModules(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf-8');
  const result = { en: { summary: '', modules: [] }, zh: { summary: '', modules: [] } };

  function extractLang(lang) {
    // 取 data-lang-block="<lang>" 的内容（若无则整页，兼容旧版 HTML）。
    // 结束边界：独占一行的 </div> 后紧跟下一个 data-lang-block 或 <footer> ——
    // 日报内容内部嵌套 <section>/<div> 卡片，不能简单取第一个 </div>。
    const startTag = `<div data-lang-block="${lang}"`;
    const start = html.indexOf(startTag);
    let block = '';
    if (start !== -1) {
      const contentStart = html.indexOf('>', start) + 1;
      // 结束边界：闭合 </div> 后紧跟下一个 data-lang-block 或 <footer>（容忍有无换行/空白）
      const endMatch = html.slice(contentStart).match(/<\/div>\s*(?=<div data-lang-block|<footer)/);
      block = endMatch ? html.slice(contentStart, contentStart + endMatch.index) : html.slice(contentStart);
    } else if (lang === 'en') {
      block = html; // 旧版整页仅英文
    }
    const out = { summary: '', modules: [] };
    if (!block) return out;
    const summaryMatch = block.match(/<section class="summary">([\s\S]*?)<\/section>/);
    if (summaryMatch) out.summary = summaryMatch[1];
    const moduleRegex = /(<section class="module"[^>]*>)([\s\S]*?)<\/section>/g;
    let m;
    while ((m = moduleRegex.exec(block)) !== null) {
      out.modules.push(`${m[1]}${m[2]}</section>`);
    }
    return out;
  }

  // 新版：双 data-lang-block；旧版：整页仅英文（兼容）
  const hasLangBlocks = html.includes('data-lang-block="en"') && html.includes('data-lang-block="zh"');
  if (hasLangBlocks) {
    result.en = extractLang('en');
    result.zh = extractLang('zh');
  } else {
    const summaryMatch = html.match(/<section class="summary">([\s\S]*?)<\/section>/);
    if (summaryMatch) result.en.summary = summaryMatch[1];
    const moduleRegex = /(<section class="module"[^>]*>)([\s\S]*?)<\/section>/g;
    let m;
    while ((m = moduleRegex.exec(html)) !== null) {
      result.en.modules.push(`${m[1]}${m[2]}</section>`);
    }
  }
  return result;
}

/** 把最新一期日报渲染成双语卡片序列（速览卡 + 每模块卡 × 中英两份，data-lang 切换） */
function buildLatestCards(latest) {
  const split = splitModules(latest.htmlFile);
  const buildLang = (lang) => {
    const parts = [];
    const data = split[lang] || { summary: '', modules: [] };
    if (data.summary) parts.push(`<div class="card summary-card">${data.summary}</div>`);
    for (const mod of data.modules) {
      parts.push(`<div class="card module-card">${mod}</div>`);
    }
    return parts.length > 0 ? parts.join('\n') : '';
  };
  const en = buildLang('en');
  const zh = buildLang('zh');
  if (!en && !zh) return '<p class="empty-note">暂无日报内容</p>';
  // 双语：en 默认显示，zh 隐藏；按钮切换
  return `
<div data-lang-block="en" class="lang-active">${en || '<p class="empty-note">No content</p>'}</div>
<div data-lang-block="zh" style="display:none">${zh || '<p class="empty-note">暂无日报内容</p>'}</div>`;
}

/** 解析日报标题（HTML 版 h1）——2026-08-27 双语：优先取 data-lang-title="en"（英文默认），回退通用 <title> */
function extractTitle(htmlFile, date) {
  const html = fs.readFileSync(htmlFile, 'utf-8');
  const m = html.match(/<title[^>]*data-lang-title="en"[^>]*>([^<]*)<\/title>/)
    || html.match(/<title>([^<]*)<\/title>/);
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
/* 语言切换（右上角） */
.lang-switch { display:inline-flex; border:1px solid var(--accent-border); border-radius:999px; overflow:hidden; background:var(--card); }
.lang-switch button { border:none; background:transparent; padding:5px 16px; font-size:13px; font-weight:600; color:var(--muted); cursor:pointer; transition:all .15s; font-family:var(--sans); }
.lang-switch button.on { background:var(--accent); color:#fff; }
.lang-switch button:not(.on):hover { color:var(--accent); background:var(--accent-soft); }
/* 反馈/纠错按钮（页脚） */
.feedback-link {
  display:inline-block; margin-top:10px; padding:7px 16px; border-radius:999px;
  border:1px solid var(--accent-border); background:var(--accent-soft); color:var(--accent);
  font-size:13px; font-weight:600; text-decoration:none; transition:all .15s;
}
.feedback-link:hover { background:var(--accent); color:#fff; text-decoration:none; }
`;

function renderIndex(reports, latest, latestCards, latestTitle) {
  const today = latest ? latest.date : (reports[0]?.date || '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(latestTitle)} · AI Industry Market Intelligence</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="topbar">
  <div class="brand">
    <div class="logo">◈</div>
    <div>
      <div class="name">AI Industry Market Intelligence</div>
      <div class="sub">Market Intelligence · Daily Report</div>
    </div>
  </div>
  <nav class="nav">
    <span class="lang-switch">
      <button type="button" data-lang-btn="en" class="on">En</button>
      <button type="button" data-lang-btn="zh">中文</button>
    </span>
    <a href="archive.html">Archive（${reports.length}）</a>
    <a href="https://github.com/xtyAIdev/ai-insight-news" target="_blank" rel="noopener">GitHub</a>
  </nav>
</header>

${reports.length === 0 ? '<div class="report-body"><p class="empty-note">No reports yet — waiting for first scheduled run…</p></div>' : `
<section class="hero">
  <div class="date-line"><span class="dot"></span><span class="date">${today} Updated</span></div>
  <h1>${esc(latestTitle)}</h1>
  <div class="meta">
    <span>Generated by AI Insight Agent</span>
    <span>${reports.length} archived editions</span>
  </div>
</section>

<div class="report-body">
${latestCards}
</div>
`}

<footer>
  AI Industry Market Intelligence Daily · Generated by AI Insight Agent · Updated daily
  <div>${feedbackLink(today || '')}</div>
</footer>
</div>
<a href="#" class="back-top" title="Back to top">↑ Top</a>
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

/** 独立历史归档页（从首页移出 —— 对应 site.ts /reports 语义） */
function renderArchive(reports, latestDate) {
  const cards = reports
    .map((r) => `<a href="./${r.date}/${r.reportId}.html" class="${r.date === latestDate ? 'today' : ''}">
  <div class="d">${r.date}</div>
  <div class="t">${r.date === latestDate ? '今日日报' : '归档'}</div>
</a>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Archive · AI Industry Market Intelligence</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="topbar">
  <div class="brand">
    <div class="logo">◈</div>
    <div>
      <div class="name">AI Industry Market Intelligence</div>
      <div class="sub">Market Intelligence · Daily Report</div>
    </div>
  </div>
  <nav class="nav">
    <span class="lang-switch">
      <button type="button" data-lang-btn="en" class="on">En</button>
      <button type="button" data-lang-btn="zh">中文</button>
    </span>
    <a href="index.html">Today</a>
    <a href="https://github.com/xtyAIdev/ai-insight-news" target="_blank" rel="noopener">GitHub</a>
  </nav>
</header>

<h1 style="margin-bottom:6px">🗂 Archive</h1>
<p class="muted" style="margin-bottom:22px">${reports.length} editions</p>
<div class="archive">
${cards || '<p class="empty-note">No reports yet</p>'}
</div>

<footer>
  AI Industry Market Intelligence Daily · Generated by AI Insight Agent · Updated daily
</footer>
</div>
<a href="#" class="back-top" title="Back to top">↑ Top</a>
<script>
(function () {
  var btns = document.querySelectorAll('[data-lang-btn]');
  function setLang(lang) {
    btns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-lang-btn') === lang); });
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
</body>
</html>`;
}

/** 每日独立页：复用日报 HTML（浅色样式由 reporter 渲染，这里仅补一个归档返回链接 + 反馈按钮） */
function renderDaily(report, indexTitle) {
  const html = fs.readFileSync(report.htmlFile, 'utf-8');
  // 注入返回链接 + 反馈按钮到 body 开头
  const navHtml = `<div style="margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
    <a href="../index.html" style="color:#2f54eb;text-decoration:none;font-size:13px">← 返回归档首页</a>
    <a href="https://github.com/xtyAIdev/ai-insight-news/issues/new?title=${encodeURIComponent(`[日报反馈] ${report.date} 内容纠错/建议`)}&body=${encodeURIComponent(FEEDBACK_TEMPLATE(report.date))}" target="_blank" rel="noopener" style="color:#2f54eb;text-decoration:none;font-size:13px">💬 反馈 / 纠错</a>
  </div>`;
  const injected = html.replace('<div class="wrap">', `<div class="wrap">\n${navHtml}`);
  return injected;
}

// ========== 主流程 ==========

const reports = collectReports();
// 清空 site 目录（逐项删除；个别系统/沙箱环境 trash 偶发失败时跳过，旧文件会被覆盖，不影响产物正确性）
if (fs.existsSync(siteDir)) {
  for (const e of fs.readdirSync(siteDir)) {
    const p = path.join(siteDir, e);
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[site] 清理旧产物跳过 ${p}: ${err.message}`);
    }
  }
}
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
