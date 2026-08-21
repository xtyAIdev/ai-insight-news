/**
 * 调度器 —— 每日定时触发（Sheet01 01-01）
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { runPipeline } from './pipeline.js';

export function startScheduler(): void {
  const [hourStr, minuteStr] = config.scheduleTime.split(':');
  const targetHour = parseInt(hourStr, 10);
  const targetMinute = parseInt(minuteStr || '0', 10);

  logger.info(`[scheduler] 每日 ${config.scheduleTime} 自动触发已启动`);

  const check = () => {
    const now = new Date();
    if (now.getHours() === targetHour && now.getMinutes() === targetMinute) {
      logger.info('[scheduler] 触发每日日报任务');
      runPipeline({ trigger: 'scheduled' }).catch((err) => {
        logger.error(`[scheduler] 定时任务失败: ${err instanceof Error ? err.message : err}`);
      });
    }
  };

  // 每分钟检查一次
  setInterval(check, 60_000);
}
