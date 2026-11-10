// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

import { AppConfig } from '../config.js';
import { Store, LogDB } from './armazenamento.js';

/* ==========================================================================
   3b. LOG DE CONEXÃO (NetLog)
   Guarda eventos de rede (sala, conexões, quedas, reconexões, erros, rotas
   WebRTC) em host E convidados, para diagnosticar problemas de conexão.
   - Não grava endereços IP nem conteúdo de mensagens.
   - Fila circular: mantém os últimos 600 eventos.
   ========================================================================== */
const NetLog = (() => {
  const KEY = 'sh_net_log_v1'; // localStorage (reserva e formato antigo)
  const DB_KEY = 'net';        // IndexedDB (LogDB)
  const MAX_EVENTS = 600;
  // Eventos desta abertura entram na hora; o histórico gravado é juntado quando o
  // IndexedDB termina de carregar (ready). Até lá nada é gravado, para não apagar o histórico.
  let data = { events: [], counters: {} };
  let loaded = false;
  let useIdb = true;
  let saveTimer = null;
  const pageStart = Date.now();

  const valid = (d) => (d && Array.isArray(d.events) ? { events: d.events, counters: d.counters || {} } : null);
  function readLocal() {
    try {
      const raw = Store.get(KEY);
      return valid(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return null;
    }
  }

  const ready = (async () => {
    let stored = null;
    let legacy = readLocal();
    try {
      [stored] = await LogDB.getMany([DB_KEY]);
      stored = valid(stored);
    } catch (e) {
      useIdb = false;
    }
    let base = (useIdb ? stored || legacy : legacy) || { events: [], counters: {} };
    if (useIdb && stored && legacy) {
      // Houve um período sem IndexedDB (eventos no localStorage): junta os dois, em ordem
      base = { events: stored.events.concat(legacy.events).sort((a, b) => String(a.t).localeCompare(String(b.t))), counters: { ...stored.counters } };
      Object.entries(legacy.counters).forEach(([k, v]) => { base.counters[k] = (base.counters[k] || 0) + v; });
    }
    const since = data;
    data = { events: base.events.concat(since.events), counters: { ...base.counters } };
    Object.entries(since.counters).forEach(([k, v]) => { data.counters[k] = (data.counters[k] || 0) + v; });
    if (data.events.length > MAX_EVENTS) data.events.splice(0, data.events.length - MAX_EVENTS);
    loaded = true;
    if (useIdb && legacy) {
      // Migração única: depois de gravar no IndexedDB, libera o localStorage
      try { await LogDB.write([[DB_KEY, data]]); Store.remove(KEY); } catch (e) { useIdb = false; }
      legacy = null;
    }
    save();
    return { idb: useIdb, events: data.events.length };
  })();

  function writeNow() {
    if (!loaded) return;
    if (useIdb) {
      LogDB.write([[DB_KEY, data]]).catch(() => { useIdb = false; writeNow(); });
    } else {
      try { Store.set(KEY, JSON.stringify(data)); } catch (e) {}
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, 400);
  }
  // Fechando a página: grava o que estiver esperando
  window.addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeNow(); } });

  /* Filtro de privacidade/segurança aplicado a TUDO que entra no log:
     - remove endereços IP (v4 e v6), URLs, e-mails e sequências longas tipo token/SDP
     - código de sala aparece mascarado (só os 2 últimos dígitos) para o log
       compartilhado não servir de convite para uma sala ainda aberta
     - textos cortados em 120 caracteres, objetos com no máximo 2 níveis */
  const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi; // 3+ ":" (não confunde com horário 17:05:53)
  const URL_RE = /\b(?:https?|wss?|turns?|stuns?):[^\s"']*/gi;
  const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/gi;
  const LONG_TOKEN = /[A-Za-z0-9+/=_-]{28,}/g;
  function scrubString(s) {
    return String(s)
      .replace(URL_RE, '[url]')
      .replace(EMAIL, '[email]')
      .replace(IPV4, '[ip]')
      .replace(IPV6, '[ip]')
      .replace(LONG_TOKEN, '[token]')
      .slice(0, 120);
  }
  function scrub(v, depth = 0) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return scrubString(v);
    if (depth >= 2 || typeof v !== 'object') return '[obj]';
    if (Array.isArray(v)) return v.slice(0, 10).map(x => scrub(x, depth + 1));
    const out = {};
    Object.keys(v).slice(0, 16).forEach(k => {
      if (/secret|token|password|senha|sdp|candidate|address|ip$/i.test(k)) return; // nunca grava
      out[k] = scrub(v[k], depth + 1);
    });
    return out;
  }
  function maskRoom(r) {
    return r ? '**' + String(r).slice(-2) : r;
  }

  function log(ev, details = {}) {
    const clean = scrub(details);
    if (clean && clean.room) clean.room = maskRoom(clean.room);
    data.events.push({ t: new Date().toISOString(), s: Math.round((Date.now() - pageStart) / 1000), ev: String(ev).slice(0, 40), ...clean });
    if (data.events.length > MAX_EVENTS) data.events.splice(0, data.events.length - MAX_EVENTS);
    save();
  }

  function count(name, n = 1) {
    data.counters[name] = (data.counters[name] || 0) + n;
    save();
  }

  function get() {
    return data;
  }

  function clear() {
    data = { events: [], counters: {} };
    Store.remove(KEY);
    LogDB.write([], [DB_KEY]).catch(() => {});
  }

  // Informações do aparelho/rede (sem dados pessoais)
  function environment() {
    const c = navigator.connection || {};
    const ua = navigator.userAgent || '';
    const first = (pairs) => {
      for (const [re, label] of pairs) {
        const m = re.exec(ua);
        if (m) return label + (m[1] ? ' ' + m[1] : '');
      }
      return 'outro';
    };
    const browser = first([[/Firefox\/(\d+)/, 'Firefox'], [/Edg\/(\d+)/, 'Edge'], [/SamsungBrowser\/(\d+)/, 'Samsung'], [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+).*Safari/, 'Safari']]);
    const os = first([[/Android ([\d.]+)/, 'Android'], [/(?:iPhone|iPad).*?OS (\d+)/, 'iOS'], [/(Windows)/, ''], [/(Mac OS X)/, ''], [/(Linux)/, '']]).trim();
    return {
      browser,
      os,
      mobile: /Mobi|Android/i.test(ua),
      online: navigator.onLine,
      netType: c.effectiveType || null,
      downlinkMbps: c.downlink || null,
      rttMs: c.rtt || null,
      saveData: !!c.saveData,
      standalone: window.matchMedia ? window.matchMedia('(display-mode: standalone)').matches : false,
      webrtc: !!window.RTCPeerConnection
    };
  }

  return { log, count, get, clear, environment, ready };
})();

// Erros inesperados do JavaScript vão para o log de conexão (antes só apareciam no console).
// Passam pelo mesmo filtro de privacidade; no máximo 20 por abertura, para um erro em laço
// não encher o log.
(() => {
  let errCount = 0;
  const screen = () => {
    const s = document.querySelector('.screen.active');
    return s ? s.id : null;
  };
  const record = (kind, msg, file, line, col) => {
    if (++errCount > 20) return;
    try {
      NetLog.log(kind, {
        msg: String(msg || '').slice(0, 120),
        file: String(file || '').split(/[\\/]/).pop().split('?')[0].slice(0, 40) || null,
        line: Number(line) || null,
        col: Number(col) || null,
        screen: screen(),
        build: AppConfig.BUILD
      });
      NetLog.count(kind);
    } catch (e) { /* o registro de erro nunca pode causar outro erro */ }
  };
  window.addEventListener('error', (e) => {
    if (e && e.target && e.target !== window && e.target.tagName) {
      // Falha ao carregar um arquivo (script, imagem)
      record('load_error', e.target.tagName.toLowerCase(), e.target.src || e.target.href, null, null);
      return;
    }
    record('js_error', e && e.message, e && e.filename, e && e.lineno, e && e.colno);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    record('js_rejection', r && (r.message || r.type || String(r)), r && r.fileName, r && r.lineNumber, null);
  });
})();

export { NetLog };
