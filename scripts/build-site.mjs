/**
 * 生成 GitHub Pages 静态站点（workflow 内运行）
 * 输出到 site/ 目录：
 *   - index.html   日报归档索引（列出所有日报，链接到每日 HTML）
 *   - <date>/<report_id>.html  每日日报网页版
 * 随后由 workflow 将 site/ 内容推送到 gh-pages 分支。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const reportsDir = path.join(projectRoot, 'reports');
const siteDir = path.join(projectRoot, 'site');

// 收集所有日报（reports/<date>/<report_id>.html）
function collectReports() {
  if (!fs.existsSync(reportsDir)) return [];
  const out = [];
  for (const dateDir of fs.readdirSync(reportsDir).sort().reverse()) {
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderIndex(reports) {
  const rows = reports
    .map(
      (r) => `<tr>
<td class="mono">${r.date}</td>
<td><a href="./${r.date}/${r.reportId}.html">${r.reportId}</a></td>
</tr>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 行业市场洞察日报 · 归档</title>
<style>
:root { --bg0:#070b14; --bg1:#0c1322; --bg2:#111a2e; --card:rgba(17,26,46,0.72); --border:rgba(94,129,244,0.18); --text:#e8edf7; --muted:#8a94a8; --accent:#4f7cff; --accent2:#22d3ee; --accent3:#a78bfa; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; background:radial-gradient(1000px 500px at 85% -10%, rgba(79,124,255,0.16), transparent 60%), radial-gradient(800px 420px at -10% 10%, rgba(34,211,238,0.10), transparent 55%), linear-gradient(160deg, var(--bg0), var(--bg1), var(--bg2)); background-attachment:fixed; color:var(--text); line-height:1.7; min-height:100vh; }
.wrap { max-width:880px; margin:0 auto; padding:40px 20px 80px; }
header { text-align:center; padding:28px 0 20px; }
header h1 { font-size:26px; background:linear-gradient(90deg, var(--accent2), var(--accent3), var(--accent)); -webkit-background-clip:text; background-clip:text; color:transparent; }
header .sub { color:var(--muted); font-size:13px; margin-top:6px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:20px 24px; margin-top:24px; backdrop-filter:blur(12px); }
table { width:100%; border-collapse:collapse; font-size:14px; }
th,td { padding:10px 12px; border-bottom:1px solid rgba(94,129,244,0.12); text-align:left; }
th { background:rgba(15,23,42,0.6); color:var(--muted); font-size:12.5px; }
a { color:var(--accent2); text-decoration:none; }
a:hover { text-decoration:underline; }
.mono { font-family:'SF Mono',Consolas,monospace; }
.muted { color:var(--muted); font-size:13px; }
footer { text-align:center; color:var(--muted); font-size:12px; margin-top:32px; }
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>⚡ AI 行业市场洞察日报</h1>
<div class="sub">Market Intelligence · 每日自动生成 ｜ 开源技术 · 学术研究 · 企业动态</div>
</header>
<div class="card">
<h2 style="margin-bottom:12px">📰 日报归档（${reports.length} 份）</h2>
${
  reports.length === 0
    ? '<p class="muted">暂无日报，等待首次自动运行…</p>'
    : `<table>
<tr><th>日期</th><th>报告</th></tr>
${rows}
</table>`
}
</div>
<footer>由 AI Insight Agent 自动生成 ｜ <a href="https://github.com/xtyAIdev/ai-insight-news">GitHub</a></footer>
</div>
</body>
</html>`;
}

// 主流程
const reports = collectReports();
if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(siteDir, { recursive: true });

// 索引页
fs.writeFileSync(path.join(siteDir, 'index.html'), renderIndex(reports), 'utf-8');

// 每日日报
for (const r of reports) {
  const destDir = path.join(siteDir, r.date);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(r.htmlFile, path.join(destDir, `${r.reportId}.html`));
}

console.log(`[site] 站点生成完成：${reports.length} 份日报 → site/`);
