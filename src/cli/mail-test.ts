/**
 * mail:test —— 邮件配置自检命令
 * 用法：npm run mail:test
 * 校验 MAIL_ENABLED 后向 config.mail.to 发送一封测试邮件，
 * 收到即证明 SMTP（QQ 邮箱等）配置成功，可用于本地调试与 CI 验证。
 */

import { config } from '../config/index.js';
import { sendMailSMTP } from '../reporter/smtp.js';

export async function runMailTest(): Promise<void> {
  if (!config.mail.enabled) {
    throw new Error('MAIL_ENABLED=false，请先在 .env 中开启邮件配置（MAIL_ENABLED=true）');
  }
  if (!config.mail.host || !config.mail.user || !config.mail.pass || !config.mail.to) {
    throw new Error('邮件配置不完整：需要 MAIL_SMTP_HOST / MAIL_USER / MAIL_PASS / MAIL_TO');
  }

  console.log(`[mail:test] 连接 ${config.mail.host}:${config.mail.port} ...`);
  await sendMailSMTP({
    host: config.mail.host,
    port: config.mail.port,
    user: config.mail.user,
    pass: config.mail.pass,
    to: config.mail.to,
    subject: 'AI Insight News 邮件测试',
    body: `
AI Insight News

这是一封测试邮件。

如果你收到这封邮件，说明 SMTP 配置成功。
    `.trim(),
  });

  console.log(`✅ 邮件发送成功：${config.mail.to}`);
}

// 直接运行：node --experimental-strip-types src/cli/mail-test.ts
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runMailTest().catch((err) => {
    console.error('❌ 邮件发送失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
