/**
 * 极简 SMTP 客户端（零依赖，Node 原生）
 * 用于日报邮件推送（Sheet07 07-10）。生产环境可替换为 QQ Mail MCP。
 */

import net from 'node:net';
import tls from 'node:tls';

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  to: string;
  subject: string;
  body: string;
}

const CRLF = '\r\n';

async function sendMailSMTP(opts: SmtpOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const connect = opts.port === 465 ? tls.connect : net.connect;
    const sock = (connect as (o: unknown, cb: () => void) => ReturnType<typeof net.connect>)({ host: opts.host, port: opts.port, rejectUnauthorized: false }, () => {
      // connection established
    });

    let buffer = '';
    let step = 0;

    const send = (cmd: string) => sock.write(cmd + CRLF);

    sock.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split(CRLF);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (code >= 400) {
          sock.destroy();
          reject(new Error(`SMTP error: ${line}`));
          return;
        }
        if (code >= 200) {
          step++;
          switch (step) {
            case 1:
              send(`EHLO ai-insight-agent`);
              break;
            case 2:
              send(`AUTH LOGIN`);
              break;
            case 3:
              send(Buffer.from(opts.user).toString('base64'));
              break;
            case 4:
              send(Buffer.from(opts.pass).toString('base64'));
              break;
            case 5:
              send(`MAIL FROM:<${opts.user}>`);
              break;
            case 6:
              send(`RCPT TO:<${opts.to}>`);
              break;
            case 7:
              send(`DATA`);
              break;
            case 8: {
              const headers = [
                `From: ${opts.user}`,
                `To: ${opts.to}`,
                `Subject: ${opts.subject}`,
                `Content-Type: text/markdown; charset=utf-8`,
                `Content-Transfer-Encoding: 8bit`,
                '',
              ].join(CRLF);
              send(`${headers}${CRLF}${opts.body}${CRLF}.`);
              break;
            }
            case 9:
              send(`QUIT`);
              sock.end();
              resolve();
              break;
          }
        }
      }
    });

    sock.on('error', (err) => {
      sock.destroy();
      reject(err);
    });

    sock.setTimeout(15_000, () => {
      sock.destroy();
      reject(new Error('SMTP timeout'));
    });
  });
}

export { sendMailSMTP };
