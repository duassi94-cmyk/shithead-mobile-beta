// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

import { AppConfig } from '../config.js';
import { AvatarModule } from '../servicos/avatar.js';
import { RulesEngine } from '../nucleo/regras.js';

/* ==========================================================================
   SEGURANÇA: tudo que vem da rede (nomes, fotos, cartas, estado da mesa) é
   limpo antes de ser usado. Nada recebido de outro aparelho vira código na
   página: nomes perdem caracteres de HTML, fotos só são aceitas como imagem
   JPEG/PNG/WebP em base64 e cartas são reconstruídas a partir da lista oficial.
   ========================================================================== */
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"'`]/g, ch => HTML_ESC[ch]);
}

// Caracteres de controle e invisíveis (montado por código: escrever \u2028 direto quebraria a regex)
const INVISIBLE_CHARS_RE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]]
  .map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']', 'g');

function sanitizeName(s, fallback = 'Jogador') {
  const clean = String(s == null ? '' : s)
    .replace(INVISIBLE_CHARS_RE, '') // caracteres de controle / texto invisível
    .replace(/[<>&"'`\\]/g, '')
    .trim()
    .slice(0, 24); // o campo de nome aceita 14; nomes de bot chegam a ~20
  return clean || fallback;
}

const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
function sanitizeAvatar(s, type = 'human', persona = null) {
  if (typeof s === 'string' && s.length < 60000 && AVATAR_RE.test(s)) return s;
  // Os avatares padrão (SVG) são gerados aqui mesmo: nunca aceitos "como vieram"
  return AvatarModule.getDefaultAvatar(type === 'bot' ? 'bot' : 'human', persona);
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
const sanitizeId = (id) => (typeof id === 'string' && SAFE_ID_RE.test(id) ? id : null);
const PERSONAS_OK = ['easy', 'medium', 'hard'];

const RANK_BY_LABEL = {};
AppConfig.RANKS.forEach(r => { RANK_BY_LABEL[r.label] = r; });
// Ids de carta: sorteados ("k" + 7 caracteres). Cartas que o jogador não pode ver chegam
// "viradas" ({ id, hidden: true }): as próprias fechadas com o id real (para escolher
// qual virar), e as dos outros/baralho com um marcador de posição (d12, h2_5, f1_0).
const CARD_ID_RE = /^k[a-z0-9]{7}$/;
const PLACEHOLDER_ID_RE = /^(?:d\d{1,3}|[hf]\d_\d{1,3})$/;
function sanitizeCard(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.hidden) {
    const hid = typeof c.id === 'string' && (CARD_ID_RE.test(c.id) || PLACEHOLDER_ID_RE.test(c.id)) ? c.id : null;
    return hid ? { id: hid, hidden: true } : null;
  }
  const id = typeof c.id === 'string' && CARD_ID_RE.test(c.id) ? c.id : null;
  if (!id) return null;
  if (c.isJoker || c.label === 'JOKER') {
    return { id, label: 'JOKER', val: 16, suit: '★', isRed: false, isJoker: true, public: !!c.public };
  }
  const rank = RANK_BY_LABEL[c.label];
  const suit = AppConfig.SUITS.includes(c.suit) ? c.suit : null;
  if (!rank || !suit) return null;
  return { id, label: rank.label, val: rank.val, suit, isRed: suit === '♥' || suit === '♦', isJoker: false, public: !!c.public };
}
const sanitizeCards = (arr) => (Array.isArray(arr) ? arr.slice(0, 120).map(sanitizeCard).filter(Boolean) : []);

function sanitizeSlot(s) {
  if (!s || typeof s !== 'object') return null;
  const id = sanitizeId(s.id);
  if (!id) return null;
  const type = s.type === 'bot' ? 'bot' : 'human';
  const persona = PERSONAS_OK.includes(s.persona) ? s.persona : null;
  return { id, name: sanitizeName(s.name), type, persona, avatar: sanitizeAvatar(s.avatar, type, persona) };
}

// Histórico de jogadas (js/nucleo/historico.js): só tipos, efeitos e cartas conhecidos,
// jogadores que estão na mesa e números pequenos. O texto é montado aqui, nunca vem da rede.
const HIST_KINDS = ['play', 'pickup', 'blindFail', 'out', 'end'];
const HIST_SRC = ['hand', 'table', 'mixed', 'blind'];
const HIST_FX = ['', 'burn', 'reverse', 'seven', 'two', 'joker'];
function sanitizeCardLabel(l) {
  if (l === 'JOKER★') return l;
  const m = typeof l === 'string' && /^(10|[2-9JQKA])(.)$/u.exec(l);
  return m && RANK_BY_LABEL[m[1]] && AppConfig.SUITS.includes(m[2]) ? l : null;
}
function sanitizeHistory(arr, ids) {
  if (!Array.isArray(arr)) return [];
  const int = (v, max) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));
  return arr.slice(-30).map(e => {
    if (!e || typeof e !== 'object' || !HIST_KINDS.includes(e.k) || !ids.includes(e.p)) return null;
    const out = { t: int(e.t, 99999), k: e.k, p: e.p };
    if (e.k === 'play' || e.k === 'blindFail') {
      out.cards = (Array.isArray(e.cards) ? e.cards.slice(0, 8) : []).map(sanitizeCardLabel).filter(Boolean);
      if (!out.cards.length) return null;
    }
    if (e.k === 'play') {
      out.src = HIST_SRC.includes(e.src) ? e.src : 'hand';
      out.fx = HIST_FX.includes(e.fx) ? e.fx : '';
    }
    if (e.k === 'pickup' || e.k === 'blindFail') out.n = int(e.n, 250);
    if (e.k === 'out') out.n = int(e.n, 6);
    return out;
  }).filter(Boolean);
}

// Estado da mesa recebido do host: reconstruído campo a campo
function sanitizeState(st) {
  if (!st || typeof st !== 'object' || !Array.isArray(st.players)) return null;
  const players = st.players.slice(0, 6).map(p => {
    const id = sanitizeId(p && p.id);
    if (!id) return null;
    return {
      id,
      name: sanitizeName(p.name),
      type: p.type === 'bot' ? 'bot' : 'human',
      persona: PERSONAS_OK.includes(p.persona) ? p.persona : null,
      hand: sanitizeCards(p.hand),
      open: sanitizeCards(p.open),
      closed: sanitizeCards(p.closed),
      readySwap: !!p.readySwap,
      escaped: !!p.escaped,
      disconnected: !!p.disconnected,
      seatNumber: Number(p.seatNumber) || 0,
      avatar: null
    };
  });
  if (players.some(p => !p) || players.length < 2) return null;
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const ids = players.map(p => p.id);
  const pid = (v) => (ids.includes(v) ? v : null);
  return {
    rules: sanitizeRules(st.rules),
    deck: sanitizeCards(st.deck),
    discard: sanitizeCards(st.discard),
    discardPlayGroups: Array.isArray(st.discardPlayGroups)
      ? st.discardPlayGroups.slice(-60).map(g => ({ playerName: sanitizeName(g && g.playerName, ''), cards: sanitizeCards(g && g.cards) }))
      : [],
    burnedCount: num(st.burnedCount),
    players,
    phase: ['SWAP', 'SPEED_TIE', 'PLAY', 'GAMEOVER', 'ABANDONED'].includes(st.phase) ? st.phase : 'PLAY',
    turnIdx: Math.min(players.length - 1, Math.max(0, num(st.turnIdx))),
    direction: st.direction === -1 ? -1 : 1,
    constraint7: !!st.constraint7,
    freePlayAfterJoker: !!st.freePlayAfterJoker,
    freePlayAfter2: !!st.freePlayAfter2,
    bannerText: String(st.bannerText || '').slice(0, 200),
    tieContext: st.tieContext && Array.isArray(st.tieContext.candidates) ? {
      role: st.tieContext.role === 'SECOND' ? 'SECOND' : 'FIRST',
      candidates: st.tieContext.candidates.map(n => num(n, -1)).filter(n => n >= 0 && n < players.length),
      cardVal: num(st.tieContext.cardVal),
      label: (RANK_BY_LABEL[st.tieContext.label] ? st.tieContext.label : 'Coringa'),
      fixedFirstIdx: st.tieContext.fixedFirstIdx == null ? null : num(st.tieContext.fixedFirstIdx)
    } : null,
    loserName: st.loserName ? sanitizeName(st.loserName) : null,
    loserId: pid(st.loserId),
    loserAvatar: null,
    mode: ['normal', 'sim', 'tutorial'].includes(st.mode) ? st.mode : 'normal',
    escapeOrder: Array.isArray(st.escapeOrder) ? st.escapeOrder.map(pid).filter(Boolean) : [],
    sessionLosses: (() => {
      const out = {};
      if (st.sessionLosses && typeof st.sessionLosses === 'object') ids.forEach(id => { out[id] = Math.max(0, num(st.sessionLosses[id])); });
      return out;
    })(),
    version: num(st.version),
    turnCounter: num(st.turnCounter),
    pickupStamp: num(st.pickupStamp),
    lastPickupBy: pid(st.lastPickupBy),
    openingVal: Number.isInteger(st.openingVal) && st.openingVal >= 2 && st.openingVal <= 16 ? st.openingVal : null,
    openingLabel: st.openingVal != null && RANK_BY_LABEL[st.openingLabel] ? st.openingLabel : (st.openingVal === 16 ? 'Coringa' : null),
    lastPickupCount: Math.min(250, Math.max(0, num(st.lastPickupCount))),
    turbo: !!st.turbo,
    history: sanitizeHistory(st.history, ids),
    stall: null
  };
}

function sanitizeRules(r) {
  r = r && typeof r === 'object' ? r : {};
  const b = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    decks: r.decks === 2 ? 2 : 1,
    jokers: Math.min(4, Math.max(0, Number(r.jokers) || 0)),
    p2: b(r.p2, true),
    draw2: r.draw2 === 3 ? 3 : 1,
    p7: b(r.p7, true),
    p10: b(r.p10, true),
    after10: r.after10 === 'again' ? 'again' : 'next',
    pjoker: b(r.pjoker, true),
    multijoker: r.multijoker === 'per_joker' ? 'per_joker' : 'once',
    p48: b(r.p48, true),
    mode48: r.mode48 === 'together' ? 'together' : 'sequence',
    burn48: b(r.burn48, false),
    bigPile: sanitizeBigPile(r.bigPile, r.decks === 2 ? 2 : 1)
  };
}

// Monte grande: a partir de quantas cartas o monte gera tensão e o GOMBRA! vira "organismo vivo"
function defaultBigPile(decks) { return decks === 2 ? 20 : 12; }
function sanitizeBigPile(v, decks) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(99, Math.max(5, n)) : defaultBigPile(decks);
}

// Registros de partida (placar) recebidos do host
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.players)) return null;
  const n = Math.min(6, Math.max(2, Number(r.n) || r.players.length));
  return {
    matchId: String(r.matchId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
    at: String(r.at || '').slice(0, 30),
    room: ROOM_CODE_ANY_RE.test(String(r.room)) ? String(r.room) : null,
    n,
    players: r.players.slice(0, 6).map(p => ({
      id: sanitizeId(p && p.id) || 'desconhecido',
      name: sanitizeName(p && p.name),
      human: !!(p && p.human),
      place: Math.min(n, Math.max(1, Number(p && p.place) || n))
    }))
  };
}

const REACTIONS_OK = ['👍', '😂', '😱', '😡', '🔥', '💩', 'GOMBRA', 'DORMIU'];

/* ---- Código da sala ----------------------------------------------------------
   5 caracteres de um alfabeto sem símbolos que se confundem (sem 0/O, 1/I/L, 2/Z,
   5/S, 8/B, G/6): cerca de 6,4 milhões de combinações. Aceita minúsculas e espaços
   ao digitar. O placar ainda reconhece salas antigas de 4 números. */
const ROOM_ALPHABET = 'ACDEFHJKMNPRTUVWXY34679';
const ROOM_CODE_LEN = 5;
const ROOM_CODE_RE = new RegExp('^[' + ROOM_ALPHABET + ']{' + ROOM_CODE_LEN + '}$');
const ROOM_CODE_ANY_RE = new RegExp('^(?:\\d{4}|[' + ROOM_ALPHABET + ']{' + ROOM_CODE_LEN + '})$');
function newRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_ALPHABET[RulesEngine.randInt(ROOM_ALPHABET.length)];
  return code;
}
function normalizeRoomCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN + 2);
}

export { esc, sanitizeName, sanitizeAvatar, sanitizeId, PERSONAS_OK, RANK_BY_LABEL, CARD_ID_RE, PLACEHOLDER_ID_RE, sanitizeCard, sanitizeCards, sanitizeSlot, sanitizeState, sanitizeHistory, sanitizeRules, defaultBigPile, sanitizeBigPile, sanitizeRecord, REACTIONS_OK, ROOM_ALPHABET, ROOM_CODE_LEN, ROOM_CODE_RE, ROOM_CODE_ANY_RE, newRoomCode, normalizeRoomCode };
