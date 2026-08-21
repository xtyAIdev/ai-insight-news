/**
 * CLI 入口
 * 用法：
 *   node dist/cli/index.js run [--date YYYY-MM-DD] [--modules a,b] [--trigger manual|scheduled]
 *   node dist/cli/index.js serve [--port 8787]
 *   node dist/cli/index.js db:init
 *   node dist/cli/index.js feedback --event <id> --score <n> --tags <t1,t2> [--suggestion <s>]
 *   node dist/cli/index.js metrics --period weekly|monthly
 *   node dist/cli/index.js list:events [--date YYYY-MM-DD]
 *   node dist/cli/index.js list:reports
 */

import { runPipeline } from '../orchestrator/pipeline.js';
import { startScheduler } from '../orchestrator/scheduler.js';
import { collectFeedback, getQualityMetrics } from '../reporter/index.js';
import { getDb } from '../db/index.js';
import { listStandardEvents, listReports, listTaskRuns } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { config, ensureDirs as ensureConfigDirs } from '../config/index.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      out[key] = val;
      if (val !== 'true') i++;
    }
  }
  return out;
}

async function cmdRun(args: Record<string, string>): Promise<void> {
  const modules = args.modules && args.modules !== 'true'
    ? args.modules.split(',').map((m) => m.trim()) as Array<'opensource' | 'paper' | 'enterprise'>
    : undefined;
  const result = await runPipeline({
    date: args.date && args.date !== 'true' ? args.date : undefined,
    modules,
    trigger: args.trigger && args.trigger !== 'true' ? (args.trigger as 'scheduled' | 'manual') : 'manual',
  });

  console.log('\n===== 运行结果 =====');
  console.log(`任务ID:   ${result.task_id}`);
  console.log(`日期:     ${result.date}`);
  console.log(`原始事件: ${result.total_raw}`);
  console.log(`标准化:   ${result.total_standard}`);
  console.log(`TopN:     ${result.topN_count}`);
  console.log(`报告:     ${result.report_path || '（未生成）'}`);
  console.log(`降级:     ${result.degraded ? '是' : '否'}`);
  if (result.errors.length) {
    console.log(`异常:     ${result.errors.join('; ')}`);
  }
  console.log(`耗时:     ${result.duration_sec.toFixed(1)}s`);
}

async function cmdServe(args: Record<string, string>): Promise<void> {
  const port = parseInt(args.port || '8787', 10);
  ensureConfigDirs();
  // 启动 HTTP 服务
  const { startServer } = await import('./server.js');
  startServer(port);
  // 同时启动调度器
  startScheduler();
  console.log(`\n✅ Web 查看器已启动: http://localhost:${port}`);
  console.log(`   每日定时触发: ${config.scheduleTime}（已加载配置）\n`);
}

async function cmdDbInit(): Promise<void> {
  ensureConfigDirs();
  getDb();
  console.log('✅ 数据库初始化完成');
}

async function cmdFeedback(args: Record<string, string>): Promise<void> {
  const eventId = args.event;
  const score = parseFloat(args.score || '');
  const tags = args.tags ? args.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  if (!eventId || Number.isNaN(score)) {
    console.error('用法: feedback --event <event_id> --score <0-5> [--tags a,b] [--suggestion <text>]');
    process.exit(1);
  }
  collectFeedback({
    eventId,
    reportId: args.report || '',
    agentScore: 0, // 由系统查库填入
    humanScore: score,
    problemTags: tags,
    suggestion: args.suggestion,
  });
  console.log(`✅ 反馈已记录: event=${eventId} human_score=${score} tags=${tags.join(',')}`);
}

async function cmdMetrics(args: Record<string, string>): Promise<void> {
  const period = args.period === 'monthly' ? 'monthly' : 'weekly';
  const m = getQualityMetrics(period);
  console.log(`\n===== 质量指标（${period}） =====`);
  console.log(`反馈总数:     ${m.total_feedback}`);
  console.log(`Agent均分:    ${m.avg_agent_score}`);
  console.log(`人工均分:     ${m.avg_human_score}`);
  console.log(`评分一致率:   ${m.consistency_rate}%`);
  console.log(`人工满意度:   ${m.satisfaction_rate}%`);
  console.log(`低分原因分布: ${JSON.stringify(m.low_score_reasons, null, 2)}`);
}

async function cmdListEvents(args: Record<string, string>): Promise<void> {
  const events = listStandardEvents(args.date && args.date !== 'true' ? { date: args.date } : {});
  console.log(`\n===== 标准化事件（${events.length} 条） =====`);
  for (const e of events) {
    console.log(`[${e.status}] ${e.time} | ${e.title} | 真实性=${e.accuracy_score} 综合=${e.importance_score}`);
  }
}

async function cmdListReports(): Promise<void> {
  const reports = listReports();
  console.log(`\n===== 报告库（${reports.length} 份） =====`);
  for (const r of reports) {
    console.log(`${r.date} | ${r.report_id} | push=${r.push_status} | ${r.markdown_path || ''}`);
  }
}

async function cmdListRuns(): Promise<void> {
  const runs = listTaskRuns(10);
  console.log(`\n===== 任务记录（最近 ${runs.length} 条） =====`);
  for (const r of runs) {
    console.log(`${r.started_at} | ${r.status} | ${r.trigger_type} | ${r.date} | ${r.summary.slice(0, 120)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'run';
  const isLongRunning = cmd === 'serve';

  switch (cmd) {
    case 'run': {
      const rest = args.slice(1);
      await cmdRun(parseArgs(rest));
      break;
    }
    case 'serve':
      await cmdServe(parseArgs(args.slice(1)));
      break;
    case 'db:init':
      await cmdDbInit();
      break;
    case 'feedback':
      await cmdFeedback(parseArgs(args.slice(1)));
      break;
    case 'metrics':
      await cmdMetrics(parseArgs(args.slice(1)));
      break;
    case 'list:events':
      await cmdListEvents(parseArgs(args.slice(1)));
      break;
    case 'list:reports':
      await cmdListReports();
      break;
    case 'list:runs':
      await cmdListRuns();
      break;
    default:
      console.log(`未知命令: ${cmd}\n可用命令: run / serve / db:init / feedback / metrics / list:events / list:reports / list:runs`);
      process.exit(1);
  }

  // serve 模式为常驻进程，不主动退出
  if (!isLongRunning) {
    process.exit(0);
  }
}

main().catch((err) => {
  logger.error(`CLI 异常: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
