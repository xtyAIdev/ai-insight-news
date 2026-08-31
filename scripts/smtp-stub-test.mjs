/**
 * SMTP 桩服务器回归测试 —— 验证 base64 折行（RFC 2045 76 字符/行）
 * 本地不依赖外网，模拟 QQ 多行响应对话，检查客户端协议正确性
 * 重点：大正文（> 998 字节原始文本）发送后，服务器收到的 base64 行长度 ≤ 76，
 *      且解码还原后与原文一致。
 * 用法：node scripts/smtp-stub-test.mjs
 */
import net from 'node:net';
import { promisify } from 'node:util';
import { sendMailSMTP } from '../dist/reporter/smtp.js';

const sleep = promisify(setTimeout);

// 1. 构造大正文：模拟日报规模（> 20KB，含中文与超长行）
const longLine = '这是一个超长的句子用于测试行长限制。'.repeat(200); // 约 3.4K 字符
let body = '';
for (let i = 0; i < 30; i++) body += `## 第 ${i + 1} 节标题\n这是第 ${i + 1} 节的正文内容。${longLine}\n来源: https://example.com/${'x'.repeat(300)}\n\n`;
console.log('测试正文长度:', body.length, '字符');

// 2. 启动桩服务器（端口随机）
const received = { headers: '', data: '' };
const server = net.createServer((sock) => {
  let step = 1; // 连接即发 banner
  let inData = false;
  sock.write('220 smtp.qq.com ESMTP\r\n');
  sock.on('data', (chunk) => {
    const text = chunk.toString();
    if (inData) {
      received.data += text;
      if (received.data.includes('\r\n.\r\n')) {
        received.data = received.data.replace(/\r\n\.\r\n$/, '');
        sock.write('250 OK: queued\r\n');
        inData = false;
        step = 5;
      }
      return;
    }
    const lines = text.split('\r\n').filter(Boolean);
    for (const line of lines) {
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO')) {
        sock.write('250-smtp.qq.com\r\n250-PIPELINING\r\n250-SIZE 52428800\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n');
        step = 2;
      } else if (upper.startsWith('AUTH LOGIN')) {
        sock.write('334 VXNlcm5hbWU6\r\n'); // "Username:"
        step = 3;
      } else if (step === 3) {
        sock.write('334 UGFzc3dvcmQ6\r\n'); // "Password:"
        step = 4;
      } else if (step === 4) {
        sock.write('235 Authentication successful\r\n');
        step = 5;
      } else if (upper.startsWith('MAIL FROM')) {
        sock.write('250 OK\r\n');
      } else if (upper.startsWith('RCPT TO')) {
        sock.write('250 OK\r\n');
      } else if (upper.startsWith('DATA')) {
        sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        inData = true;
      } else if (upper === 'QUIT') {
        sock.write('221 Bye\r\n');
        sock.end();
      }
    }
  });
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const port = server.address().port;
console.log('桩服务器端口:', port);

// 3. 客户端发信（hostIp 直接指向桩服务器）
try {
  await sendMailSMTP({
    host: 'smtp.qq.com', // servername 用于 TLS 校验（桩服务器非 TLS，rejectUnauthorized=false 跳过）
    port,
    user: 'test@qq.com',
    pass: 'fake-pass',
    to: 'test@qq.com',
    subject: '回归测试：超长日报正文 base64 折行',
    body,
    hostIp: '127.0.0.1',
    rejectUnauthorized: false,
    timeoutMs: 10000,
  });
  console.log('✅ SMTP 会话完整走通（含 20KB+ 大正文）');
} catch (e) {
  console.error('❌ SMTP 会话失败:', e.message);
  server.close();
  process.exit(1);
}

// 4. 校验收到的数据
// 提取 base64 正文部分（最后一个空行之后）
const hdrEnd = received.data.indexOf('\r\n\r\n');
const headers = received.data.slice(0, hdrEnd);
const b64Body = received.data.slice(hdrEnd + 4);
const b64Lines = b64Body.split('\r\n');

let maxLen = 0;
for (const l of b64Lines) maxLen = Math.max(maxLen, l.length);
console.log('base64 行数:', b64Lines.length, '| 最大行长度:', maxLen, '字符');

const decoded = Buffer.from(b64Lines.join(''), 'base64').toString('utf8');
console.log('解码还原长度:', decoded.length, '| 与原文一致:', decoded === body);

const checks = {
  '头部包含 MIME-Version': headers.includes('MIME-Version: 1.0'),
  '头部包含 Content-Type charset=utf-8': headers.includes('Content-Type: text/plain; charset=utf-8'),
  'Subject 为 RFC2047 编码': headers.includes('Subject: =?UTF-8?B?'),
  'base64 最大行 ≤ 76 (RFC 2045)': maxLen <= 76,
  'base64 最大行 ≤ 998 (RFC 5321)': maxLen <= 998,
  '解码还原一致': decoded === body,
};

let allPass = true;
for (const [name, ok] of Object.entries(checks)) {
  console.log((ok ? '✅' : '❌') + ' ' + name);
  if (!ok) allPass = false;
}

server.close();
console.log(allPass ? '\n🎉 全部通过' : '\n❌ 存在失败项');
process.exit(allPass ? 0 : 1);
