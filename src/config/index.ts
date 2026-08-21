/**
 * 配置中心 —— 全局默认配置（规格 Sheet00 R8-R15）
 * .env 加载 + 默认值兜底
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 项目根目录（src/config -> 项目根）
export const ROOT_DIR = path.resolve(__dirname, '../../');

export interface AppConfig {
  // LLM
  llm: {
    apiKey: string;
    baseUrl: string;
    model: string;
    tempScore: number;      // 评分类 0.1
    tempGenerate: number;   // 生成类 0.3
    tempJudge: number;      // 真实性判断 0.1
  };
  // 调度
  scheduleTime: string;     // 每日 08:00
  globalTimeoutMin: number; // 30 分钟
  moduleTimeoutMin: number; // 20 分钟
  // 采集窗口
  timeWindowHours: number;  // 24
  topN: number;             // 5
  // 路径
  dbPath: string;
  reportDir: string;
  logDir: string;
  // 邮件
  mail: {
    enabled: boolean;
    host: string;
    port: number;
    user: string;
    pass: string;
    to: string;
  };
  // 重试参数（规格 Sheet00 R11）
  retry: {
    toolRetries: number;    // 工具调用失败重试 2 次
    toolRetryDelayMs: number; // 3s
    llmRetries: number;     // LLM 输出异常重试 1 次
  };
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      // 去掉首尾引号
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  }
  // 进程环境变量优先
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

const env = loadEnv();

function num(key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(key: string, def: string): string {
  const v = env[key];
  return v === undefined || v === '' ? def : v;
}

export const config: AppConfig = {
  llm: {
    apiKey: str('LLM_API_KEY', ''),
    baseUrl: str('LLM_BASE_URL', 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: str('LLM_MODEL', 'deepseek-chat'),
    tempScore: num('LLM_TEMP_SCORE', 0.1),
    tempGenerate: num('LLM_TEMP_GENERATE', 0.3),
    tempJudge: num('LLM_TEMP_JUDGE', 0.1),
  },
  scheduleTime: str('SCHEDULE_TIME', '08:00'),
  globalTimeoutMin: num('GLOBAL_TIMEOUT_MIN', 30),
  moduleTimeoutMin: num('MODULE_TIMEOUT_MIN', 20),
  timeWindowHours: num('TIME_WINDOW_HOURS', 24),
  topN: num('TOP_N', 5),
  dbPath: path.isAbsolute(str('DB_PATH', 'data/ai_insight.db'))
    ? str('DB_PATH', 'data/ai_insight.db')
    : path.join(ROOT_DIR, str('DB_PATH', 'data/ai_insight.db')),
  reportDir: path.isAbsolute(str('REPORT_DIR', 'reports'))
    ? str('REPORT_DIR', 'reports')
    : path.join(ROOT_DIR, str('REPORT_DIR', 'reports')),
  logDir: path.isAbsolute(str('LOG_DIR', 'logs'))
    ? str('LOG_DIR', 'logs')
    : path.join(ROOT_DIR, str('LOG_DIR', 'logs')),
  mail: {
    enabled: str('MAIL_ENABLED', 'false') === 'true',
    host: str('MAIL_SMTP_HOST', ''),
    port: num('MAIL_SMTP_PORT', 465),
    user: str('MAIL_USER', ''),
    pass: str('MAIL_PASS', ''),
    to: str('MAIL_TO', ''),
  },
  retry: {
    toolRetries: num('TOOL_RETRIES', 2),
    toolRetryDelayMs: num('TOOL_RETRY_DELAY_MS', 3000),
    llmRetries: num('LLM_RETRIES', 1),
  },
};

// 确保目录存在
export function ensureDirs(): void {
  for (const dir of [config.reportDir, config.logDir, path.dirname(config.dbPath)]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function hasLLM(): boolean {
  return config.llm.apiKey.length > 0;
}
