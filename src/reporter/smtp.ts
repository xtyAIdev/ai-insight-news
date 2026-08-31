/**
 * 极简 SMTP 客户端（零依赖，Node 原生）
 * 用于日报邮件推送（Sheet07 07-10）。生产环境可替换为 QQ Mail MCP。
 *
 * 2026-08-31 重写：修复多行响应步进 bug。
 *  旧实现：把 SMTP 响应的每一行都 count 成一步 —— EHLO 返回多行（250-... 续行 + 250 OK）
 *  会被算成 N 步，导致 step 跳变、AUTH 流程错乱。
 *  新实现：按「请求计数」推进 —— 每发一条命令期待一个最终响应，
 *  多行响应（'250-' 续行）只在最后一行（'250 '）才算完成。严格兼容
 *  RFC 5321：续行以 '-' 结尾，最终行以空格结尾。
 */

import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { promisify } from 'node:util';

const lookupAsync = promisify(dns.lookup);

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  to: string;
  subject: string;
  body: string;
  /** 是否校验证书（默认 false 兼容自签/内网；生产建议 true） */
  rejectUnauthorized?: boolean;
  /** 连接/响应超时 ms（默认 15s） */
  timeoutMs?: number;
  /** DNS 解析重试次数（默认 3，GitHub Actions 环境对 smtp.qq.com 偶发 EAI_AGAIN） */
  dnsRetries?: number;
  /** 预解析的服务器 IP（GitHub Actions 传入，逗号分隔可多个）。提供时跳过 DNS 解析，逐个 IP 尝试连接 */
  hostIp?: string;
}

const CRLF = '\r\n';

/** 解析一行 SMTP 响应：状态码 + 是否续行（'-' 结尾） */
function parseResponseLine(line: string): { code: number; multiline: boolean } {
  const code = parseInt(line.slice(0, 3), 10);
  const multiline = line.length > 3 && line[3] === '-';
  return { code: Number.isFinite(code) ? code : -1, multiline };
}

/** 解析主机名（带重试）：GitHub Actions runner 对 smtp.qq.com 偶发 EAI_AGAIN，重试可缓解 */
async function resolveHost(host: string, retries: number): Promise<string> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      const { address } = await lookupAsync(host);
      return address;
    } catch (err) {
      lastErr = err as Error;
      // 短暂退避后重试（250ms × 递增）
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr ?? new Error(`DNS 解析失败: ${host}`);
}

async function sendMailSMTP(opts: SmtpOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const rejectUnauthorized = opts.rejectUnauthorized ?? false;
  const dnsRetries = opts.dnsRetries ?? 3;

  // 候选连接地址：优先外部预解析 IP（逗号分隔可多个，GitHub Actions 传，绕过 runner DNS 封锁）；
  // 否则本地解析（带重试）。逐个 IP 尝试完整 SMTP 会话，直到成功。
  const candidates = opts.hostIp
    ? opts.hostIp.split(',').map((s) => s.trim()).filter(Boolean)
    : [await resolveHost(opts.host, dnsRetries)];

  let lastErr: Error | undefined;
  for (const ip of candidates) {
    try {
      await smtpSession(opts, ip, timeoutMs, rejectUnauthorized);
      return; // 该 IP 会话成功
    } catch (err) {
      lastErr = err as Error;
      // 记录失败 IP，继续尝试下一个
    }
  }
  throw lastErr ?? new Error(`SMTP 连接失败: ${opts.host}`);
}

/** 对单个 IP 执行完整 SMTP 会话（连接 → EHLO → AUTH → MAIL → RCPT → DATA → QUIT） */
function smtpSession(opts: SmtpOptions, ip: string, timeoutMs: number, rejectUnauthorized: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const connect = opts.port === 465 ? tls.connect : net.connect;
    const sock = (connect as (o: unknown, cb: () => void) => ReturnType<typeof net.connect>)(
      { host: ip, port: opts.port, rejectUnauthorized, servername: opts.host },
      () => {
        // connected
      },
    );

    let buffer = '';
    // 请求计数：0=等待服务器 banner；1=EHLO 后；2=AUTH LOGIN；3=发 user；4=发 pass；
    // 5=MAIL FROM；6=RCPT TO；7=DATA；8=等待 . 结束；9=QUIT
    let step = 0;
    // 注：无需 inData 标记 —— SMTP 响应是严格的一问一答（354→250→221），
    // step 计数足够。DATA 后服务器回执 250 就是 step 9（QUIT）的触发。

    const send = (cmd: string) => sock.write(cmd + CRLF);

    const fail = (msg: string) => {
      sock.destroy();
      reject(new Error(msg));
    };

    sock.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split(CRLF);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue; // 空行忽略
        const { code, multiline } = parseResponseLine(line);
        if (code === -1) continue; // 非响应行忽略

        // 错误：4xx/5xx 终态，直接失败（含多行错误的第一行）
        if (code >= 400) {
          fail(`SMTP error: ${line.trim()}`);
          return;
        }
        // 续行（如 250-PIPELINING / 250-AUTH LOGIN）：只是上一响应的扩展，不推进 step
        if (multiline) continue;

        // 非续行 = 一个请求的最终响应 → 推进
        step++;
        switch (step) {
          case 1:
            // 服务器 banner（220）→ EHLO
            send('EHLO ai-insight-agent');
            break;
          case 2:
            send('AUTH LOGIN');
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
            send('DATA');
            break;
          case 8: {
            // DATA 的 354 响应 → 发送头部 + 正文 + '.'（正文结束标记）
            const headers = [
              `From: ${opts.user}`,
              `To: ${opts.to}`,
              `Subject: =?UTF-8?B?${Buffer.from(opts.subject, 'utf-8').toString('base64')}?=`,
              `MIME-Version: 1.0`,
              `Content-Type: text/plain; charset=utf-8`,
              `Content-Transfer-Encoding: base64`,
              '',
            ].join(CRLF);
            // 正文按 base64 编码（避免中文/特殊字符被 SMTP 逐字节破坏，兼容 7bit 通道）
            const bodyB64 = Buffer.from(opts.body, 'utf-8').toString('base64');
            // 手动拼接：头部 + 空行 + base64 正文 + '.' 结束行（服务器会回 250 OK）
            sock.write(headers + CRLF + CRLF + bodyB64 + CRLF + '.' + CRLF);
            break;
          }
          case 9:
            // DATA 的 250 OK（正文已收）→ QUIT
            send('QUIT');
            break;
          case 10:
            // QUIT 的 221 → 结束
            sock.end();
            resolve();
            break;
          default:
            fail(`SMTP 协议状态异常: step=${step} line=${line.trim()}`);
            return;
        }
      }
    });

    sock.on('error', (err) => {
      sock.destroy();
      reject(err);
    });

    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error(`SMTP timeout after ${timeoutMs}ms (step=${step})`));
    });
  });
}

export { sendMailSMTP };
