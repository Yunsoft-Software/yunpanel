import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { Button, ErrorNotice, Section } from './PanelKit.jsx';
import { createTerminalWebSocket, parseTerminalMessage, terminalClientInternals } from './terminal-client.js';
import './terminal.css';

const statusLabels = {
  idle: 'Bağlantı kapalı',
  issuing: 'Yetki hazırlanıyor',
  connecting: 'Bağlanıyor',
  open: 'Bağlı',
  closed: 'Bağlantı kapandı',
  error: 'Bağlantı hatası',
};

function issueBody(target) {
  if (target?.scope === 'server' && typeof target.serverId === 'string') return { scope: 'server', serverId: target.serverId };
  if (target?.scope === 'site' && typeof target.websiteId === 'string') return { scope: 'site', websiteId: target.websiteId };
  return null;
}

function closeMessage(code) {
  if (code === 4001) return 'Oturum veya Owner yetkisi değiştiği için terminal kapatıldı.';
  if (code === 4008) return 'Terminal süre sınırı nedeniyle kapatıldı.';
  if (code === 4009) return 'Terminal güvenli çıktı sınırı nedeniyle kapatıldı.';
  if (code === 1012) return 'Panel servisi yeniden başlatıldığı için terminal kapatıldı.';
  return 'Terminal bağlantısı kapandı.';
}

function safeLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);
}

export default function TerminalPanel({ target, title, description, unavailable = null }) {
  const container = useRef(null);
  const terminal = useRef(null);
  const fit = useRef(null);
  const socket = useRef(null);
  const connected = useRef(false);
  const attempt = useRef(0);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [context, setContext] = useState(null);
  const body = issueBody(target);

  function writeNotice(message) {
    terminal.current?.write(`\r\n\u001b[90m[YunPanel] ${safeLine(message)}\u001b[0m\r\n`);
  }

  useEffect(() => {
    const instance = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      screenReaderMode: true,
      scrollback: 5_000,
      theme: { background: '#0b1020', foreground: '#e5e7eb' },
    });
    const fitAddon = new FitAddon();
    instance.loadAddon(fitAddon);
    instance.open(container.current);
    terminal.current = instance;
    fit.current = fitAddon;
    try { fitAddon.fit(); } catch {}

    const input = instance.onData((data) => {
      if (connected.current && socket.current?.readyState === WebSocket.OPEN) {
        socket.current.send(JSON.stringify({ type: 'input', data }));
      }
    });
    const resize = instance.onResize(({ cols, rows }) => {
      if (connected.current && socket.current?.readyState === WebSocket.OPEN) {
        socket.current.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      try { fitAddon.fit(); } catch {}
    }) : null;
    observer?.observe(container.current);
    return () => {
      attempt.current += 1;
      connected.current = false;
      const active = socket.current;
      socket.current = null;
      if (active && active.readyState < WebSocket.CLOSING) active.close(1000, 'view_closed');
      observer?.disconnect();
      input.dispose();
      resize.dispose();
      instance.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, []);

  async function connect() {
    if (!body || ['issuing', 'connecting', 'open'].includes(status)) return;
    const currentAttempt = attempt.current + 1;
    attempt.current = currentAttempt;
    connected.current = false;
    setError(null);
    setContext(null);
    setStatus('issuing');
    terminal.current?.reset();
    writeNotice('Terminal yetkisi hazırlanıyor…');
    try {
      const capability = await panelRequest('/terminal/capabilities', { method: 'POST', body });
      if (attempt.current !== currentAttempt) return;
      const websocket = createTerminalWebSocket(capability);
      socket.current = websocket;
      setStatus('connecting');
      websocket.addEventListener('message', (event) => {
        if (socket.current !== websocket) return;
        let message;
        try { message = parseTerminalMessage(event.data); }
        catch {
          setError('Terminal sunucusundan geçersiz ileti alındı.');
          websocket.close(1008, 'invalid_message');
          return;
        }
        if (message.type === 'ready') {
          if (terminalClientInternals.targetIdentity(message.target) !== terminalClientInternals.targetIdentity(capability.target)) {
            setError('Terminal hedefi doğrulanamadı.');
            websocket.close(1008, 'target_mismatch');
            return;
          }
          connected.current = true;
          setContext(message.target);
          setStatus('open');
          terminal.current?.reset();
          writeNotice(`${message.target.user} · ${message.target.cwd}`);
          try { fit.current?.fit(); } catch {}
          if (terminal.current && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({ type: 'resize', cols: terminal.current.cols, rows: terminal.current.rows }));
            terminal.current.focus();
          }
        } else if (message.type === 'output') terminal.current?.write(message.data);
        else if (message.type === 'exit') writeNotice(`Shell kapandı (kod ${message.exitCode ?? '—'}, sinyal ${message.signal ?? '—'}).`);
        else if (message.type === 'revoked') writeNotice('Oturum yetkisi kaldırıldı.');
        else if (message.type === 'error') writeNotice(`Terminal hatası: ${message.code}`);
      });
      websocket.addEventListener('close', (event) => {
        if (socket.current !== websocket) return;
        connected.current = false;
        socket.current = null;
        setContext(null);
        setStatus(event.wasClean ? 'closed' : 'error');
        writeNotice(closeMessage(event.code));
      });
      websocket.addEventListener('error', () => {
        if (socket.current === websocket) setError('Terminal bağlantısı kurulamadı.');
      });
    } catch (failure) {
      if (attempt.current !== currentAttempt || failure.name === 'AbortError') return;
      setStatus('error');
      setError(failure.message);
      writeNotice('Terminal açılamadı.');
    }
  }

  function disconnect() {
    attempt.current += 1;
    connected.current = false;
    const active = socket.current;
    socket.current = null;
    if (active && active.readyState < WebSocket.CLOSING) active.close(1000, 'owner_closed');
    setStatus('closed');
    setContext(null);
    writeNotice('Terminal kullanıcı tarafından kapatıldı.');
  }

  return <Section title={title} description={description} actions={<div className="ws-actions"><span className="ws-muted" role="status">{statusLabels[status]}</span>{status === 'open' ? <Button onClick={disconnect}>Bağlantıyı kapat</Button> : <Button variant="primary" icon="terminal" onClick={connect} disabled={!body || ['issuing', 'connecting'].includes(status)}>{status === 'closed' || status === 'error' ? 'Yeniden bağlan' : 'Terminali aç'}</Button>}</div>}>
    {unavailable && <div className="ws-notice ws-notice-warn"><span>{unavailable}</span></div>}
    <ErrorNotice error={error} />
    <div className="ws-terminal-context" aria-label="Terminal bağlamı"><span>{context?.user ?? (target?.scope === 'server' ? 'root' : 'Site kullanıcısı')}</span><span>{context?.cwd ?? 'Bağlantı açıldığında çalışma dizini doğrulanır'}</span></div>
    <div ref={container} className="ws-terminal-surface" aria-label={title} />
  </Section>;
}

export const terminalPanelInternals = Object.freeze({ issueBody, closeMessage, safeLine });
