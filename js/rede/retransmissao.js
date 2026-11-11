// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

/* ==========================================================================
   RETRANSMISSÃO (TURN) PARA AS PARTIDAS ONLINE
   A ligação entre aparelhos tenta ser direta. Em redes que não deixam (4G/5G,
   CGNAT, Wi-Fi de empresa), os dados precisam passar por um servidor de
   retransmissão (TURN). Os TURN que vinham embutidos no PeerJS deixaram de
   existir em 2026, então o jogo usa o do Metered (plano grátis).
   - A chave pk_live_ é "publicável": feita para ficar no navegador, só serve
     para pedir credenciais TURN (o Metered as entrega na mensagem "welcome").
   - A busca começa ao abrir as telas de jogo online (prefetch), para a sala
     não esperar. Se o Metered não responder em alguns segundos, segue só com STUN (como
     antes): quem consegue ligação direta continua entrando.
   - As credenciais ficam guardadas por alguns minutos e servem para host e
     convidados (cada um busca as suas).
   ========================================================================== */
const METERED_WS = 'wss://rms.metered.ca/v1?key=';
const METERED_KEY = 'pk_live_80df2173750fb65814afb7b510017879b57b10bb';
const WAIT_MS = 8000; // o Metered costuma responder em 0,5–3,5 s
const KEEP_MS = 10 * 60 * 1000;
const STUN_ONLY = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.relay.metered.ca:80' }];

let cached = null;   // { servers, at }
let pending = null;  // Promise em andamento (pedidos ao mesmo tempo usam a mesma)

// Só aceita o formato esperado: urls stun:/turn:/turns: e usuário/senha em texto
function cleanServers(list) {
  if (!Array.isArray(list)) return [];
  const okUrl = (u) => typeof u === 'string' && u.length < 200 && /^(stun|turns?):[\w.\-:?=&]+$/.test(u);
  const out = [];
  for (const s of list.slice(0, 10)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(okUrl);
    if (!urls.length) continue;
    const entry = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof s.username === 'string' && s.username.length < 300) entry.username = s.username;
    if (typeof s.credential === 'string' && s.credential.length < 300) entry.credential = s.credential;
    if (urls.some(u => u.startsWith('turn')) && !(entry.username && entry.credential)) continue;
    out.push(entry);
  }
  return out;
}

function askMetered() {
  return new Promise((resolve) => {
    let ws = null;
    const t0 = Date.now();
    const done = (servers, why) => {
      clearTimeout(timer);
      try { if (ws) { ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } } catch (e) {}
      resolve({ servers, why, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => done(null, 'timeout'), WAIT_MS);
    try { ws = new WebSocket(METERED_WS + METERED_KEY); } catch (e) { done(null, 'ws_blocked'); return; }
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) {}
      if (!msg || msg.type !== 'welcome') return;
      const servers = cleanServers(msg.metadata && msg.metadata.iceServers);
      done(servers.some(s => String(s.urls).includes('turn')) ? servers : null, servers.length ? 'ok' : 'no_turn');
    };
    ws.onerror = () => done(null, 'ws_error');
    ws.onclose = (ev) => done(null, 'ws_close_' + (ev && ev.code));
  });
}

// Lista de servidores ICE para o PeerJS. info: { source: 'metered'|'cache'|'stun', why, ms }
async function getIceServers() {
  if (cached && Date.now() - cached.at < KEEP_MS) return { servers: cached.servers, source: 'cache' };
  if (!pending) {
    pending = askMetered().finally(() => { pending = null; });
  }
  const r = await pending;
  if (r.servers) {
    cached = { servers: [...r.servers, STUN_ONLY[0]], at: Date.now() };
    return { servers: cached.servers, source: 'metered', ms: r.ms };
  }
  return { servers: STUN_ONLY, source: 'stun', why: r.why, ms: r.ms };
}

// Começa a buscar antes de precisar (ao abrir as telas de jogo online)
function prefetch() {
  if (navigator.onLine === false) return;
  getIceServers().catch(() => {});
}

// Credencial recusada ou vencida: a próxima busca pede outra
function forgetIceServers() { cached = null; }

const Retransmissao = { getIceServers, prefetch, forgetIceServers };
export { Retransmissao };
