/**
 * 全链路 trace_log（规格 Sheet00 R32：{stage, timestamp, tool, detail}）
 */

import type { TraceEntry } from '../types/events.js';

export class Tracer {
  private entries: TraceEntry[] = [];

  add(stage: string, tool: string, detail: string): void {
    this.entries.push({
      stage,
      timestamp: new Date().toISOString(),
      tool,
      detail: detail.slice(0, 500),
    });
  }

  get(): TraceEntry[] {
    return this.entries;
  }

  toJSON(): TraceEntry[] {
    return this.entries;
  }
}
