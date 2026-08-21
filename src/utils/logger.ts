/**
 * 轻量日志（写入 logs/ 目录 + 控制台）
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let logFile: string | null = null;

function getLogFile(): string {
  if (!logFile) {
    const today = new Date().toISOString().slice(0, 10);
    logFile = path.join(config.logDir, `agent_${today}.log`);
    if (!fs.existsSync(config.logDir)) fs.mkdirSync(config.logDir, { recursive: true });
  }
  return logFile;
}

function fmt(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}] ${msg}`;
}

export function log(level: LogLevel, msg: string): void {
  const line = fmt(level, msg);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    fs.appendFileSync(getLogFile(), line + '\n');
  } catch {
    // 日志写入失败不阻断主流程
  }
}

export const logger = {
  debug: (m: string) => log('debug', m),
  info: (m: string) => log('info', m),
  warn: (m: string) => log('warn', m),
  error: (m: string) => log('error', m),
};
