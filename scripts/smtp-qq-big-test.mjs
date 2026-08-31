/** 本地真实 QQ SMTP 大正文发信验证（验证折行修复对真实服务器生效） */
import { config } from '../dist/config/index.js';
import { sendMailSMTP } from '../dist/reporter/smtp.js';

const longLine = '这是一个超长的句子用于测试行长限制，模拟日报正文中的长句与长 URL。'.repeat(150);
let body = '【AI 行业日报 · 本地大正文测试】\n\n';
for (let i = 0; i < 25; i++) {
  body += `## 第 ${i + 1} 节\n正文内容：${longLine}\n来源：https://example.com/article/${i}/${'x'.repeat(250)}\n\n`;
}
console.log('测试正文长度:', body.length, '字符');

try {
  await sendMailSMTP({
    host: config.mail.host,
    port: config.mail.port,
    user: config.mail.user,
    pass: config.mail.pass,
    to: config.mail.to,
    subject: '【回归测试】大正文 base64 折行验证（' + new Date().toISOString() + '）',
    body,
    hostIp: config.mail.hostIp || undefined,
    rejectUnauthorized: false,
    timeoutMs: 30000,
  });
  console.log('✅ 本地真实 QQ SMTP 大正文发送成功（请查收 QQ 邮箱）');
} catch (e) {
  console.error('❌ 发送失败:', e.message);
  process.exit(1);
}
