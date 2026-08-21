/**
 * HTTP 客户端 —— 带超时与重试（规格 Sheet08 采集层异常处理）
 */

import { withRetry, isRetryableHttp, withTimeout } from './retry.js';
import { logger } from './logger.js';

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  exponential?: boolean;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
}

export interface HttpResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  text: string;
  error?: string;
  fromCache?: boolean;
}

const DEFAULT_TIMEOUT = 15_000;

/**
 * 通用 HTTP GET（JSON），自动重试 + 指数退避
 * 返回结构化结果而非抛异常，便于上层做降级决策
 */
export async function httpGetJson<T = unknown>(
  url: string,
  opts: HttpOptions = {},
): Promise<HttpResult<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  try {
    const res = await withRetry(
      async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const resp = await fetch(url, {
            method: opts.method ?? 'GET',
            headers: { 'User-Agent': 'ai-insight-agent/1.0', Accept: 'application/json', ...opts.headers },
            body: opts.body,
            signal: ctrl.signal,
          });
          const text = await resp.text();
          if (!resp.ok && !isRetryableHttp(resp.status)) {
            throw new HttpStatusError(resp.status, text.slice(0, 300), url);
          }
          if (!resp.ok) {
            // 可重试状态码
            const err = new HttpStatusError(resp.status, text.slice(0, 300), url);
            (err as { retryable?: boolean }).retryable = true;
            throw err;
          }
          let data: T | null = null;
          try { data = text ? (JSON.parse(text) as T) : null; } catch { data = null; }
          return { status: resp.status, text, data } as { status: number; text: string; data: T | null };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        retries: opts.retries ?? 1,
        exponential: opts.exponential ?? true,
        retryable: (err) => {
          if (err instanceof HttpStatusError) return (err as { retryable?: boolean }).retryable !== false;
          return true; // 网络错误可重试
        },
      },
    );
    return { ok: true, status: res.status, data: res.data, text: res.text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`HTTP 请求失败: ${url} -> ${msg}`);
    return { ok: false, status: 0, data: null, text: '', error: msg };
  }
}

export class HttpStatusError extends Error {
  status: number;
  url: string;
  constructor(status: number, message: string, url: string) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
    this.url = url;
  }
}

/** 带超时的通用任务执行（用于 LLM 调用、模块执行等） */
export async function runWithTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return withTimeout(fn(), ms, label);
}
