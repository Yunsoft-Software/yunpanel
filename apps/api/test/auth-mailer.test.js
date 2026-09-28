import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createAuthMailer, validateEmail } from '../src/auth-mailer.js';

test('createAuthMailer with custom transport sends mail with proper envelope and headers', async () => {
  const sent = [];
  const mailer = createAuthMailer({
    from: 'YunPanel Security <security@yunpanel.test>',
    transport: async (mail) => {
      sent.push(mail);
      return { messageId: 'custom-id', accepted: [mail.to] };
    },
  });

  assert.equal(await mailer.isAvailable(), true);

  const res = await mailer.sendPasswordResetEmail({
    to: 'owner@example.com',
    username: 'admin',
    resetUrl: 'https://panel.example.com/#reset-token=test-token-123',
  });

  assert.equal(res.messageId, 'custom-id');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.equal(sent[0].from, 'YunPanel Security <security@yunpanel.test>');
  assert.match(sent[0].text, /admin/);
  assert.match(sent[0].text, /test-token-123/);
});

test('createAuthMailer reports isAvailable false when SMTP port is unreachable', async () => {
  // Use a port that won't be listening
  const mailer = createAuthMailer({
    host: '127.0.0.1',
    port: 29999,
  });

  const available = await mailer.isAvailable();
  assert.equal(available, false);
});

test('createAuthMailer communicates with SMTP server mock', async (t) => {
  let commandsReceived = [];
  const server = net.createServer((socket) => {
    socket.write('220 smtp.local ESMTP Mock\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const lineIdx = buffer.indexOf('\r\n');
        const line = buffer.slice(0, lineIdx);
        buffer = buffer.slice(lineIdx + 2);
        commandsReceived.push(line);

        if (line.startsWith('EHLO') || line.startsWith('HELO')) {
          socket.write('250-smtp.local Hello\r\n250 HELP\r\n');
        } else if (line.startsWith('MAIL FROM:')) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (line.startsWith('RCPT TO:')) {
          socket.write('250 2.1.5 Ok\r\n');
        } else if (line === 'DATA') {
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === '.') {
          socket.write('250 2.0.0 Ok: queued as 12345\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        }
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const mailer = createAuthMailer({
    host: '127.0.0.1',
    port,
    from: 'noreply@yunpanel.test',
  });

  assert.equal(await mailer.isAvailable(), true);

  const result = await mailer.sendMail({
    to: 'owner@example.com',
    subject: 'Test Subject',
    text: 'Hello world!',
  });

  assert.equal(result.accepted[0], 'owner@example.com');
  assert.ok(commandsReceived.some((c) => c.startsWith('MAIL FROM:<noreply@yunpanel.test>')));
  assert.ok(commandsReceived.some((c) => c.startsWith('RCPT TO:<owner@example.com>')));
});
