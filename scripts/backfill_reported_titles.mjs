/**
 * 一次性回填脚本（2026-09-08 P0-F2）：从已提交的日报 md 生成 state/reported_titles.json
 *
 * 背景：跨天去重记忆 state/reported_titles.json 是增量累积的，首次上线时无历史 → 去重空转。
 * 本脚本解析 git 仓库已提交的 reports/YYYY-MM-DD/*.md，把近 7 天已报道的标题 key 回填进记忆文件，
 * 使 9-08 当天运行的日报立即具备"前几日报过什么"的判断力（如 arXiv 2609.04180 连报 3 天应被压制）。
 *
 * 模块分节映射（与 reporter MODULE_LABELS 对齐）：
 *   "## AI Open Source"  → opensource
 *   "## AI Research"     → paper
 *   "## AI Enterprise"   → enterprise
 * 条目格式：### N. <标题>
 * 只回填 reportDate-7 天内的日报（与 paper 最宽窗口一致）；未来/过早日报忽略。
 *
 * 标题归一化复用 dist/utils/normalize.js 的 normDedupKey（与运行时一致，保证键可比）。
 * 运行：node scripts/backfill_reported_titles.mjs
 * 注意：脚本 import dist（编译产物），先 npm run build。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normDedupKey } from '../dist/utils/normalize.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const reportsDir = path.join(root, 'reports');
const stateFile = path.join(root, 'state', 'reported_titles.json');

const SECTION_MODULE = {
  'AI Open Source': 'opensource',
  'AI Research': 'paper',
  'AI Enterprise': 'enterprise',
};
const LOOKBACK_DAYS = 7;

function dayDiff(a, b) {
  const ta = new Date(`${a}T12:00:00`).getTime();
  const tb = new Date(`${b}T12:00:00`).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return NaN;
  return Math.round((tb - ta) / 86400000);
}

/** 解析单份 md → { module: string[]（原始标题） }（仅事件节，跳过 Glance/Watch） */
function parseReport(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf-8');
  const byModule = {};
  let currentModule = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, ''); // 去 CRLF 残留
    const sec = line.match(/^## (.+)$/);
    if (sec) {
      currentModule = SECTION_MODULE[sec[1].trim()] ?? null;
      continue;
    }
    const item = line.match(/^### \d+\.\s+(.+)$/);
    if (item && currentModule) {
      (byModule[currentModule] ||= []).push(item[1].trim());
    }
  }
  return byModule;
}

// 收集近 7 天日报文件（en 主版 .md，跳过 .zh.md 避免同一事件重复计入）
const dates = fs.readdirSync(reportsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const today = new Date().toISOString().slice(0, 10); // 本机今天（回填基准：运行当天）
const store = {};
let totalTitles = 0;
for (const d of dates) {
  const diff = dayDiff(d, today);
  if (Number.isNaN(diff) || diff < 0 || diff > LOOKBACK_DAYS) continue;
  const mdPath = path.join(reportsDir, d, `report_${d.replace(/-/g, '')}.md`);
  if (!fs.existsSync(mdPath)) continue;
  const byModule = parseReport(mdPath);
  const entry = {};
  for (const [module, titles] of Object.entries(byModule)) {
    // key 与运行时 reportedKeyOf 完全一致：`category|normDedupKey(title)`（统一走标题归一，
    // 不拼 repo/company —— 回填侧只能从日报 md 拿标题）
    const keys = titles.map((t) => `${module}|${normDedupKey(t)}`).filter((k) => !k.endsWith('|'));
    if (keys.length > 0) {
      entry[module] = keys;
      totalTitles += keys.length;
    }
  }
  if (Object.keys(entry).length > 0) store[d] = entry;
  console.log(`[backfill] ${d}: ${Object.entries(entry).map(([m, k]) => `${m}=${k.length}`).join(',') || '无事件节'}`);
}

fs.mkdirSync(path.dirname(stateFile), { recursive: true });
const tmp = `${stateFile}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf-8');
fs.renameSync(tmp, stateFile);
console.log(`\n[backfill] 完成：${Object.keys(store).length} 天，共 ${totalTitles} 条标题记忆 → ${path.relative(root, stateFile)}`);
