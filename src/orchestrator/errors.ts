/**
 * 异常矩阵（Sheet08）
 * 统一异常处理：重试 → 备用源 → 缓存降级 → 部分输出
 */

import { logger } from '../utils/logger.js';

export type ExceptionPhase = 'collect' | 'process' | 'evaluate' | 'report' | 'global';

export interface ExceptionInfo {
  phase: ExceptionPhase;
  type: string;
  message: string;
  retried: number;
  degraded: boolean;
  aborted: boolean;
}

export class AgentError extends Error {
  phase: ExceptionPhase;
  type: string;
  degraded: boolean;

  constructor(phase: ExceptionPhase, type: string, message: string, degraded = false) {
    super(message);
    this.phase = phase;
    this.type = type;
    this.degraded = degraded;
  }
}

/** 全局超时包装（Sheet08 R14：硬超时 30 分钟输出已完成部分） */
export function withGlobalTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new AgentError('global', 'timeout', `${label} 全局超时（${timeoutMs / 60000}分钟），输出已完成部分`);
      logger.warn(err.message);
      reject(err);
    }, timeoutMs);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 模块级超时包装（Sheet00 R13：模块超时 20 分钟） */
export function withModuleTimeout<T>(fn: () => Promise<T>, timeoutMs: number, module: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AgentError('collect', 'module_timeout', `模块 ${module} 超时（${timeoutMs / 60000}分钟）`));
    }, timeoutMs);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
