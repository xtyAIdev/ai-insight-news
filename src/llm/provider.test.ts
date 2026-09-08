/**
 * repairTruncatedJson 单元测试（2026-09-08 P3-1 截断修复）
 * 覆盖：完整 JSON 直通 / 字符串截断 / 嵌套括号截断 / 数组截断 / markdown 包裹 / 非 JSON 输入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairTruncatedJson } from './provider.js';

test('repairTruncatedJson: 完整 JSON 原样返回', () => {
  const raw = '{"title":"你好","body":"正文内容"}';
  assert.equal(repairTruncatedJson(raw), raw);
});

test('repairTruncatedJson: 字符串内截断 → 补引号+括号', () => {
  const raw = '{"title":"中文标题","body":"这是一段被截断的正';
  const fixed = repairTruncatedJson(raw);
  assert.ok(fixed, '应产出修复结果');
  const parsed = JSON.parse(fixed!);
  assert.equal(parsed.title, '中文标题');
  assert.ok(parsed.body.startsWith('这是一段'), '截断正文应保留已生成部分');
});

test('repairTruncatedJson: 嵌套对象截断 → 按栈序补齐', () => {
  const raw = '{"outer":{"inner":"值","n":3';
  const fixed = repairTruncatedJson(raw);
  assert.ok(fixed);
  const parsed = JSON.parse(fixed!);
  assert.equal(parsed.outer.inner, '值');
  assert.equal(parsed.outer.n, 3);
});

test('repairTruncatedJson: 数组截断', () => {
  const raw = '{"tags":["a","b"';
  const parsed = JSON.parse(repairTruncatedJson(raw)!);
  assert.deepEqual(parsed.tags, ['a', 'b']);
});

test('repairTruncatedJson: markdown 包裹的截断 JSON', () => {
  const raw = '```json\n{"title":"截断案例","body":"内容被切';
  const parsed = JSON.parse(repairTruncatedJson(raw)!);
  assert.equal(parsed.title, '截断案例');
});

test('repairTruncatedJson: 无 { 开头返回 null', () => {
  assert.equal(repairTruncatedJson('plain text no json'), null);
});

test('repairTruncatedJson: 值内含转义引号不误判', () => {
  const raw = '{"body":"他说：\\"你好\\" 然后继续';
  const parsed = JSON.parse(repairTruncatedJson(raw)!);
  assert.ok(typeof parsed.body === 'string');
});
