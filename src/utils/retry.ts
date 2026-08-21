/**
 * 重试工具 —— 规格 Sheet00 R11 / Sheet08 异常矩阵
 * - 工具调用失败：重试 2 次（间隔 3s），之后切换备用源
 * - API 限流（429/403）：指数退避
 * - LLM 输出异常：重试 1 次
 */

import { config } from '../config/index.js';

export interface RetryOptions {
  retries?: number;          // 重试次数
  baseDelayMs?: number;      // 基础间隔
  exponential?: boolean;     // 指数退避（限流 429 时）
  retryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? config.retry.toolRetries;
  const baseDelay = opts.baseDelayMs ?? config.retry.toolRetryDelayMs;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      if (opts.retryable && !opts.retryable(err)) break;
      const delay = opts.exponential ? baseDelay * 2 ** attempt : baseDelay;
      if (opts.onRetry) opts.onRetry(attempt + 1, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** 判断是否为限流/超时类可重试错误 */
export function isRetryableHttp(status: number | undefined): boolean {
  if (status === undefined) return true; // 网络错误
  return status === 429 || status === 403 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** 带超时的 Promise */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
