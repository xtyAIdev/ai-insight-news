/**
 * 编排器 —— 端到端主流程（Sheet01）
 * 01-01 触发 → 01-02 任务计划 → 01-03 并行调度三大模块 → 01-04 采集
 * → 01-05 统一处理 → 01-06 质量评估 → 01-07 报告生成 → 01-08 推送归档
 * → 01-11 任务完成 → 01-12 feedback
 */

import type { ModuleName, ModuleResult, RawEvent, StandardEvent, TaskContext } from '../types/events.js';
import { collectOpenSource } from '../collectors/opensource.js';
import { collectPaper } from '../collectors/paper.js';
import { collectEnterprise } from '../collectors/enterprise.js';
import { processRawEvents } from '../processor/index.js';
import { evaluateEvents } from '../evaluator/index.js';
import { generateReport } from '../reporter/index.js';
import { config, ensureDirs } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { genTaskId, toISODate } from '../utils/normalize.js';
import { withGlobalTimeout, withModuleTimeout, AgentError } from './errors.js';
import { saveTaskRun, saveRawEvent, listStandardEvents } from '../db/index.js';

export interface OrchestratorResult {
  task_id: string;
  date: string;
  modules: ModuleResult[];
  total_raw: number;
  total_standard: number;
  topN_count: number;
  report_id?: string;
  report_path?: string;
  degraded: boolean;
  errors: string[];
  started_at: string;
  finished_at: string;
  duration_sec: number;
}

// ========== 入口 ==========

export async function runPipeline(opts: {
  date?: string;
  modules?: ModuleName[];
  trigger?: 'scheduled' | 'manual';
} = {}): Promise<OrchestratorResult> {
  ensureDirs();

  const taskId = genTaskId();
  const date = opts.date || toISODate(new Date());
  const trigger = opts.trigger || 'manual';
  const modules: ModuleName[] = opts.modules && opts.modules.length > 0 ? opts.modules : ['opensource', 'paper', 'enterprise'];

  const startedAt = new Date();
  const startISO = startedAt.toISOString();
  // 时间窗口起点（默认 24h，可配置）
  const windowStart = new Date(startedAt.getTime() - config.timeWindowHours * 3600_000);
  const endISO = startedAt.toISOString();

  const ctx: TaskContext = {
    task_id: taskId,
    trigger_type: trigger,
    date_range: { start: windowStart.toISOString(), end: endISO },
    time_window_hours: config.timeWindowHours,
    top_n: config.topN,
    modules,
    started_at: startISO,
    deadline: new Date(startedAt.getTime() + config.globalTimeoutMin * 60_000).toISOString(),
  };

  logger.info(`===== 任务启动 ${taskId}（${trigger}，日期 ${date}，模块 ${modules.join(',')}） =====`);

  try {
    return await withGlobalTimeout(() => execute(ctx, date), config.globalTimeoutMin * 60_000, '全流程');
  } catch (err) {
    // 全局超时/致命错误：输出已完成部分
    const e = err instanceof AgentError ? err : new AgentError('global', 'fatal', err instanceof Error ? err.message : String(err));
    logger.error(`===== 任务中断: ${e.message} =====`);
    return {
      task_id: taskId,
      date,
      modules: [],
      total_raw: 0,
      total_standard: 0,
      topN_count: 0,
      degraded: true,
      errors: [e.message],
      started_at: startISO,
      finished_at: new Date().toISOString(),
      duration_sec: (Date.now() - startedAt.getTime()) / 1000,
    };
  }
}

// ========== 执行主体 ==========

async function execute(ctx: TaskContext, date: string): Promise<OrchestratorResult> {
  const errors: string[] = [];
  let degraded = false;
  let totalRaw = 0;
  let totalStandard = 0;

  // 01-03 并行调度三大采集模块
  const moduleResults: ModuleResult[] = [];
  const rawEventsByModule = new Map<ModuleName, RawEvent[]>();

  await Promise.all(ctx.modules.map(async (module) => {
    const mStart = new Date().toISOString();
    const result: ModuleResult = { module, status: 'running', raw_count: 0, start_time: mStart };
    try {
      const raws = await withModuleTimeout(
        () => collectModule(module, ctx),
        config.moduleTimeoutMin * 60_000,
        module,
      );
      rawEventsByModule.set(module, raws);
      // 原始事件入池
      raws.forEach((raw, i) => {
        saveRawEvent(`raw_${module}_${date.replace(/-/g, '')}_${i}`, module, raw);
      });
      result.raw_count = raws.length;
      result.status = raws.length > 0 ? 'done' : 'failed';
      result.end_time = new Date().toISOString();
      totalRaw += raws.length;
      logger.info(`[orchestrator] 模块 ${module} 完成：原始事件 ${raws.length}`);
    } catch (err) {
      result.status = 'failed';
      result.error = err instanceof Error ? err.message : String(err);
      result.end_time = new Date().toISOString();
      errors.push(`[${module}] ${result.error}`);
      degraded = true;
      logger.error(`[orchestrator] 模块 ${module} 失败: ${result.error}`);
    }
    moduleResults.push(result);
  }));

  // 01-05 统一处理层（各模块 RawEvent → StandardEvent）
  const allRaw = ctx.modules.flatMap((m) => rawEventsByModule.get(m) || []);
  let standardEvents: StandardEvent[] = [];
  if (allRaw.length > 0) {
    try {
      standardEvents = await processRawEvents(allRaw, date);
      totalStandard = standardEvents.length;
    } catch (err) {
      errors.push(`[process] ${err instanceof Error ? err.message : err}`);
      degraded = true;
    }
  }

  // 01-06 质量评估（按模块 TopN）
  let topNList: Array<{ event: StandardEvent; reason: string }> = [];
  if (standardEvents.length > 0) {
    try {
      const evalResult = await evaluateEvents(standardEvents, ctx.top_n);
      topNList = evalResult.topN;
      if (evalResult.dropped.length > 0) logger.info(`[orchestrator] 评估丢弃 ${evalResult.dropped.length} 条`);
    } catch (err) {
      errors.push(`[evaluate] ${err instanceof Error ? err.message : err}`);
      degraded = true;
    }
  }

  // 01-07/08 报告生成与推送归档
  let reportId: string | undefined;
  let reportPath: string | undefined;
  if (topNList.length > 0 || ctx.modules.length > 0) {
    try {
      const report = await generateReport({
        date,
        modules: ctx.modules,
        topN: topNList,
        allEvents: standardEvents,
      });
      reportId = report.report_id;
      reportPath = report.files.markdown_path;
    } catch (err) {
      errors.push(`[report] ${err instanceof Error ? err.message : err}`);
      degraded = true;
    }
  }

  // 01-11 任务完成汇总
  const finishedAt = new Date();
  const summary = {
    date,
    raw_count: totalRaw,
    standard_count: totalStandard,
    topN: topNList.length,
    report_id: reportId,
    module_results: moduleResults,
  };

  saveTaskRun({
    task_id: ctx.task_id,
    trigger_type: ctx.trigger_type,
    date,
    status: errors.length ? 'partial' : 'done',
    summary: JSON.stringify(summary),
    started_at: ctx.started_at,
    finished_at: finishedAt.toISOString(),
  });

  const duration = (Date.now() - new Date(ctx.started_at).getTime()) / 1000;
  logger.info(`===== 任务完成 ${ctx.task_id}：raw=${totalRaw} std=${totalStandard} topN=${topNList.length} degraded=${degraded} 耗时=${duration.toFixed(1)}s =====`);

  return {
    task_id: ctx.task_id,
    date,
    modules: moduleResults,
    total_raw: totalRaw,
    total_standard: totalStandard,
    topN_count: topNList.length,
    report_id: reportId,
    report_path: reportPath,
    degraded,
    errors,
    started_at: ctx.started_at,
    finished_at: finishedAt.toISOString(),
    duration_sec: duration,
  };
}

// ========== 模块调度（带缓存降级，Sheet02 02-09） ==========

async function collectModule(module: ModuleName, ctx: TaskContext): Promise<RawEvent[]> {
  switch (module) {
    case 'opensource':
      return collectOpenSource(ctx);
    case 'paper':
      return collectPaper(ctx);
    case 'enterprise':
      return collectEnterprise(ctx);
  }
}

// ========== 查看已生成事件/报告 ==========

export function queryEvents(date?: string): StandardEvent[] {
  return listStandardEvents(date ? { date } : {});
}

export { saveTaskRun };
