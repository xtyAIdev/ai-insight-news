/**
 * reportMemory（跨天已报道记忆）单元测试（2026-09-08 P0-F2）
 * 验证：键生成、回看窗口过滤、记录写入/清理。
 * 注意：测试会把 state/reported_titles.json 临时替换，跑完还原；全程幂等。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportedKeyOf, filterAlreadyReported, recordReportedTitles } from './reportMemory.js';
import { normDedupKey } from '../utils/normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.resolve(__dirname, '..', '..', 'state', 'reported_titles.json');
const backup = `${stateFile}.bak`;

function backupState() {
  if (fs.existsSync(stateFile)) fs.renameSync(stateFile, backup); // 移动而非复制，避免双份
}
function restoreState() {
  if (fs.existsSync(backup)) {
    fs.renameSync(backup, stateFile); // 移动还原，不触发删除
  }
}

beforeEach(() => backupState());
afterEach(() => restoreState());

// ========== reportedKeyOf ==========

test('reportedKeyOf: paper/enterprise 统一 类别|标题归一（不含 company/repo）', () => {
  const p = reportedKeyOf({ title: 'Multi-Step Tool-Calling over Korean Open Public APIs', category: 'paper', company: 'KAIST' });
  assert.equal(p, `paper|${normDedupKey('Multi-Step Tool-Calling over Korean Open Public APIs')}`);
  const e = reportedKeyOf({ title: 'OpenAI 发布 GPT-5.2', category: 'enterprise', company: 'OpenAI' });
  assert.equal(e, `enterprise|${normDedupKey('OpenAI 发布 GPT-5.2')}`, '不含 company 前缀，与回填键一致');
});

test('reportedKeyOf: opensource 也走标题归一（与回填一致，非 repo 强键）', () => {
  const k = reportedKeyOf({ title: 'dify：Build Agentic workflows', category: 'opensource', product: 'langgenius/dify' });
  assert.equal(k, `opensource|${normDedupKey('dify：Build Agentic workflows')}`);
});

test('reportedKeyOf: 空标题返回空串', () => {
  assert.equal(reportedKeyOf({ title: '', category: 'paper' }), '');
});

// ========== filterAlreadyReported ==========

test('filterAlreadyReported: 命中窗口内历史 → 剔除；窗口外 → 保留', () => {
  recordReportedTitles('2026-09-06', {
    paper: [{ event: { title: 'Korean Benchmark Paper Title Here', category: 'paper' } }],
  });
  // 同标题 9-07 → 剔除
  const same = filterAlreadyReported(
    [{ title: 'Korean Benchmark Paper Title Here', category: 'paper' }],
    '2026-09-07',
  );
  assert.equal(same.dropped.length, 1, '7 天内同标题应剔除');
  // 不同标题 → 保留
  const diff = filterAlreadyReported(
    [{ title: 'A Brand New Paper', category: 'paper' }],
    '2026-09-07',
  );
  assert.equal(diff.kept.length, 1, '不同标题应保留');
});

test('filterAlreadyReported: 超出回看窗口的历史不剔除（paper 7d）', () => {
  recordReportedTitles('2026-09-01', {
    paper: [{ event: { title: 'Old Paper Title', category: 'paper' } }],
  });
  const out = filterAlreadyReported([{ title: 'Old Paper Title', category: 'paper' }], '2026-09-09');
  assert.equal(out.dropped.length, 0, '9-01 距 9-09 已 8 天 > paper 7d 窗口，不应剔除');
  assert.equal(out.kept.length, 1);
});

test('filterAlreadyReported: 无历史文件/无匹配 → 全部保留（fail-open）', () => {
  const out = filterAlreadyReported([{ title: 'Whatever', category: 'enterprise' }], '2026-09-08');
  assert.equal(out.kept.length, 1);
  assert.equal(out.dropped.length, 0);
});

test('recordReportedTitles: 清理超 14 天旧记录 + 写入当日', () => {
  recordReportedTitles('2026-08-01', { enterprise: [{ event: { title: 'Ancient', category: 'enterprise' } }] });
  recordReportedTitles('2026-09-08', { paper: [{ event: { title: 'Today Paper', category: 'paper' } }] });
  const store = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  assert.equal(store['2026-08-01'], undefined, '超 14 天应清理');
  assert.ok(store['2026-09-08'].paper.includes(`paper|${normDedupKey('Today Paper')}`), '当日应写入');
});
