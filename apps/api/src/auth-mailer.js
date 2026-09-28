import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { AuthError } from './auth-error.js';

const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function validateEmail(email) {
  if (typeof email !== 'string') {
    throw new AuthError('invalid_email', 'Geçerli bir e-posta adresi girin.', 400);
  }
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) {
    throw new AuthError('invalid_email', 'Geçerli bir e-posta adresi girin.', 400);
  }
  return trimmed.toLowerCase();
}

function createSmtpSession({ host, port, secure = false, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket.destroy(); } catch {}
      reject(error);
    };

    const connectOptions = { host, port };
    const socket = secure
      ? tls.connect({ ...connectOptions, rejectUnauthorized: false })
      : net.createConnection(connectOptions);

    timer = setTimeout(() => {
      fail(new Error('SMTP connection timed out'));
    }, timeoutMs);

    let buffer = '';
    let pendingCallback = null;

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      if (lines.length > 1) {
        // Find if the last received response is complete (e.g. "250 ..." or multi-line "250-...")
        const completeIndex = lines.slice(0, -1).findLastIndex((line) => /^\d{3} /.test(line));
        if (completeIndex !== -1 && pendingCallback) {
          const responseText = lines.slice(0, completeIndex + 1).join('\r\n');
          buffer = lines.slice(completeIndex + 1).join('\r\n');
          const cb = pendingCallback;
          pendingCallback = null;
          cb(null, responseText);
        }
      }
    });

    socket.on('error', fail);
    socket.on('close', () => {
      if (!settled && pendingCallback) {
        fail(new Error('SMTP connection closed unexpectedly'));
      }
    });

    function readResponse() {
      return new Promise((res, rej) => {
        const lines = buffer.split('\r\n');
        const completeIndex = lines.slice(0, -1).findLastIndex((line) => /^\d{3} /.test(line));
        if (completeIndex !== -1) {
          const responseText = lines.slice(0, completeIndex + 1).join('\r\n');
          buffer = lines.slice(completeIndex + 1).join('\r\n');
          return res(responseText);
        }
        pendingCallback = (err, response) => {
          if (err) rej(err);
          else res(response);
        };
      });
    }

    async function sendCommand(cmd, expectedCode) {
      socket.write(`${cmd}\r\n`);
      const response = await readResponse();
      const code = Number(response.slice(0, 3));
      if (code !== expectedCode) {
        throw new Error(`SMTP command failed: ${cmd.split(' ')[0]} -> expected ${expectedCode}, got ${code} (${response})`);
      }
      return response;
    }

    // Wait for 220 banner
    readResponse().then((greeting) => {
      const code = Number(greeting.slice(0, 3));
      if (code !== 220) {
        fail(new Error(`Invalid SMTP greeting banner: ${greeting}`));
        return;
      }
      cleanup();
      resolve({
        sendCommand,
        close: () => {
          try {
            socket.write('QUIT\r\n');
            socket.end();
          } catch {}
        },
        destroy: () => {
          try { socket.destroy(); } catch {}
        },
      });
    }).catch(fail);
  });
}

export function createAuthMailer({
  host = process.env.YUNPANEL_SMTP_HOST ?? '127.0.0.1',
  port = Number(process.env.YUNPANEL_SMTP_PORT ?? 25),
  from = process.env.YUNPANEL_SMTP_FROM ?? 'noreply@yunpanel.local',
  user = process.env.YUNPANEL_SMTP_USER ?? null,
  pass = process.env.YUNPANEL_SMTP_PASS ?? null,
  secure = process.env.YUNPANEL_SMTP_SECURE === 'true',
  timeoutMs = 10_000,
  transport = null,
} = {}) {
  async function isAvailable() {
    if (transport) {
      if (typeof transport.isAvailable === 'function') {
        try {
          return await transport.isAvailable();
        } catch {
          return false;
        }
      }
      return true;
    }
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        try { socket.destroy(); } catch {}
        resolve(false);
      }, 3000);

      socket.setEncoding('utf8');
      socket.once('data', (chunk) => {
        clearTimeout(timer);
        const code = Number(chunk.slice(0, 3));
        const ok = code === 220;
        try {
          socket.write('QUIT\r\n');
          socket.end();
        } catch {}
        resolve(ok);
      });

      socket.once('error', () => {
        clearTimeout(timer);
        try { socket.destroy(); } catch {}
        resolve(false);
      });
    });
  }

  async function sendMail({ to, subject, text, html = null, fromAddress = from }) {
    const validatedTo = validateEmail(to);
    if (transport) {
      if (typeof transport.sendMail === 'function') {
        return transport.sendMail({ to: validatedTo, from: fromAddress, subject, text, html });
      }
      if (typeof transport === 'function') {
        return transport({ to: validatedTo, from: fromAddress, subject, text, html });
      }
      throw new Error('Invalid transport provided to AuthMailer');
    }

    const session = await createSmtpSession({ host, port, secure, timeoutMs });
    try {
      await session.sendCommand('EHLO localhost', 250);
      if (user && pass) {
        await session.sendCommand('AUTH LOGIN', 334);
        await session.sendCommand(Buffer.from(user).toString('base64'), 334);
        await session.sendCommand(Buffer.from(pass).toString('base64'), 235);
      }
      await session.sendCommand(`MAIL FROM:<${fromAddress}>`, 250);
      await session.sendCommand(`RCPT TO:<${validatedTo}>`, 250);
      await session.sendCommand('DATA', 354);

      const messageId = `<${randomUUID()}@yunpanel.local>`;
      const date = new Date().toUTCString();
      const headers = [
        `From: ${fromAddress}`,
        `To: ${validatedTo}`,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: ${messageId}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
      ].join('\r\n');

      const body = `${headers}\r\n\r\n${text}\r\n.`;
      await session.sendCommand(body, 250);
      session.close();
      return { sent: true, messageId };
    } catch (error) {
      session.destroy();
      throw error;
    }
  }

  async function sendPasswordResetEmail({ to, username, token, expiresAt, origin = 'http://localhost:5173' }) {
    const resetUrl = `${origin}/#reset-token=${encodeURIComponent(token)}`;
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
    const subject = 'YunPanel — Parola Sıfırlama Bağlantısı';
    const text = [
      `Merhaba ${username},`,
      '',
      'YunPanel Owner hesabınız için parola sıfırlama talebinde bulunuldu.',
      'Parolanızı yenilemek için aşağıdaki bağlantıyı kullanabilirsiniz:',
      '',
      resetUrl,
      '',
      `Bu bağlantı ${minutes} dakika boyunca geçerlidir ve yalnızca tek bir kez kullanılabilir.`,
      'Eğer bu talebi siz yapmadıysanız, bu e-postayı dikkate almayınız. Parolanız değiştirilmeyecektir.',
      '',
      'YunPanel Güvenlik Ekibi',
    ].join('\n');

    return sendMail({ to, subject, text });
  }

  return Object.freeze({
    isAvailable,
    sendMail,
    sendPasswordResetEmail,
    validateEmail,
  });
}
