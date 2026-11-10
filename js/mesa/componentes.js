// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

/* ==========================================================================
   MESA EM COMPONENTES (Preact + htm, vendor/preact-htm.module.js)
   O game.js calcula o que mostrar (dados simples) e estes componentes só
   desenham. O Preact compara com o desenho anterior e mexe apenas no que
   mudou: imagens e nós que continuam iguais não são recriados a cada jogada.
   Textos e atributos passam pelo Preact, que nunca interpreta HTML vindo
   dos dados (nomes de jogadores aparecem sempre como texto).
   As classes de CSS são as mesmas do desenho antigo (style.css e testes).
   ========================================================================== */
import { html, render } from '../../vendor/preact-htm.module.js';

/* ---- Faixa de ordem de jogada ----------------------------------------------
   nodes: [{ id, avatar, label, title, current, next, escaped, compact }] */
function SeqBar({ nodes }) {
  const out = [];
  nodes.forEach((n, k) => {
    const cls = 'seq-node' + (n.current ? ' seq-active' : '') + (n.next ? ' seq-next' : '') +
      (n.escaped ? ' seq-escaped' : '') + (n.compact ? ' seq-compact' : '');
    out.push(html`<div key=${n.id} class=${cls} title=${n.title}>
      <img src=${n.avatar} alt="" /><span>${n.label}${n.current ? html`<span class="seq-tag"> · VEZ</span>` : null}</span>
    </div>`);
    if (k < nodes.length - 1) out.push(html`<span key=${'a' + k} class="seq-arrow" aria-hidden="true">›</span>`);
  });
  return out;
}

/* ---- Assentos dos adversários ----------------------------------------------
   seats: [{ id, left, top, turn, next, escaped, avatar, score, handCount,
             name, fullName, status, slots: [{ kind: 'open'|'closed'|'empty', red, label }] }] */
function MiniSlot({ s }) {
  if (s.kind === 'open') return html`<div class=${'mini-slot open-card' + (s.red ? ' red' : '')}>${s.label}</div>`;
  return html`<div class=${s.kind === 'closed' ? 'mini-slot' : 'mini-slot empty'}></div>`;
}
function Seat({ s }) {
  const cls = 'seat' + (s.turn ? ' turn-active' : '') + (s.next ? ' next-active' : '') + (s.escaped ? ' safe-out' : '');
  // Para leitores de tela o assento é lido de uma vez (nome, cartas, mesa, situação)
  const opens = s.slots.filter(x => x.kind === 'open').map(x => x.spoken).join(', ');
  const closed = s.slots.filter(x => x.kind !== 'empty').length;
  const label = `${s.fullName}: ${s.handCount} na mão` + (opens ? `; mesa: ${opens}` : '') +
    `; ${closed} ${closed === 1 ? 'carta' : 'cartas'} na mesa` + (s.status ? `; ${s.status}` : '') + (s.score ? `; ${s.score}` : '');
  return html`<div class=${cls} data-seat-id=${s.id} style=${{ left: s.left + '%', top: s.top + '%' }} role="group" aria-label=${label}>
    <div class="seat-avatar-wrap" aria-hidden="true">
      <img class="seat-avatar" src=${s.avatar} alt="" />
      <span class="skull-badge">${s.score || null}</span>
      <span class="seat-hand-pill" title="Cartas na mão">${s.handCount}</span>
    </div>
    <div class="seat-name" title=${s.fullName} aria-hidden="true">${s.name}</div>
    <div class="opp-mini-table" aria-hidden="true">${s.slots.map((slot, i) => html`<${MiniSlot} key=${i} s=${slot} />`)}</div>
    <div class="seat-status" aria-hidden="true">${s.status}</div>
  </div>`;
}
function Seats({ seats }) {
  return seats.map(s => html`<${Seat} key=${s.id} s=${s} />`);
}

/* ---- Nome falado de uma carta (leitores de tela) ---------------------------- */
const RANK_NAME = { A: 'Ás', J: 'Valete', Q: 'Dama', K: 'Rei' };
const SUIT_NAME = { '♠': 'espadas', '♥': 'copas', '♦': 'ouros', '♣': 'paus' };
function cardSpoken(card) {
  if (!card || card.hidden) return 'carta virada';
  if (card.isJoker) return 'Coringa';
  return `${RANK_NAME[card.label] || card.label} de ${SUIT_NAME[card.suit] || card.suit}`;
}

/* ---- Carta (mesmo desenho do createCardDOM do game.js) ----------------------
   card: { label, suit, val, isRed, isJoker } ou null/hidden = verso.
   power: ícone do poder da carta ('' = sem). cls: classes extras. style: objeto de estilo. */
function Card({ card, power = '', cls = '', style = null, back = false, id = null, bind = null, a11y = null }) {
  // a11y: { label, pressed } → carta que se toca: botão com nome, focável pelo teclado
  const ax = a11y ? { role: 'button', tabindex: 0, 'aria-label': a11y.label, 'aria-pressed': a11y.pressed == null ? null : String(a11y.pressed) } : { 'aria-hidden': 'true' };
  // bind(el): chamado a cada desenho com o elemento (eventos de toque ligados pelo game.js)
  const ref = bind ? (el) => { if (el) bind(el); } : null;
  if (back || !card || card.hidden) return html`<div class=${'playing-card card-back' + (cls ? ' ' + cls : '')} style=${style} data-card-id=${id} ref=${ref} ...${ax}></div>`;
  const face = !card.isJoker && card.val >= 11 && card.val <= 13;
  const c = 'playing-card' + (card.isRed ? ' red' : '') + (card.isJoker ? ' joker-card' : '') + (face ? ' face-card' : '') + (cls ? ' ' + cls : '');
  const badge = power ? html`<div class="card-power">${power}</div>` : null;
  if (card.isJoker) {
    return html`<div class=${c} style=${style} data-card-id=${id} ref=${ref} ...${ax}><div class="card-corner"><span class="rank">★</span></div><div class="card-center">🃏</div>${badge}</div>`;
  }
  return html`<div class=${c} style=${style} data-card-id=${id} ref=${ref} ...${ax}>
    <div class="card-corner"><span class="rank">${card.label}</span><span class="suit">${card.suit}</span></div>
    <div class="card-center">${face ? html`<b>${card.label}</b>` : card.suit}</div>${badge}
  </div>`;
}

/* ---- Monte (descarte) e queimadas -------------------------------------------
   items: [{ key, card, power, cls, style }]; tags: [{ cls, text }] (selos "quem jogou") */
function Pile({ items, tags = [] }) {
  return [
    ...items.map(it => html`<${Card} key=${it.key} card=${it.card} power=${it.power} cls=${it.cls} style=${it.style} />`),
    ...tags.map(t => html`<div key=${'tag-' + t.cls} class=${'discard-play-tag ' + t.cls}>${t.text}</div>`)
  ];
}

/* ---- Sua mão e suas cartas da mesa -------------------------------------------
   hand: [{ card, back, cls, power, bind }] (já ordenada) — entre dois espaçadores
   table: 3 pilhas [{ closed: item|null, open: item|null }] (item = como na mão) */
const cardOf = (it, extra) => html`<${Card} key=${it.card.id} id=${it.card.id} card=${it.card} back=${it.back}
  power=${it.power} cls=${(extra || '') + (it.cls ? ' ' + it.cls : '')} bind=${it.bind} a11y=${it.a11y} />`;
function Hand({ hand }) {
  return [html`<div key="s1" class="hand-spacer"></div>`, ...hand.map(it => cardOf(it, '')), html`<div key="s2" class="hand-spacer"></div>`];
}
function TableStacks({ table }) {
  return table.map((st, i) => html`<div key=${i} class=${'table-stack' + (!st.closed && !st.open ? ' empty-slot' : '')}>
    ${st.closed ? cardOf({ ...st.closed, back: true }, 'closed-under') : null}
    ${st.open ? cardOf(st.open, 'open-over') : null}
  </div>`);
}

/* ---- Miniatura da mão (leque recolhido) ---------------------------------------
   rows: [[{ key, label, joker, n, back }]] — uma ou duas linhas */
function DockFan({ rows }) {
  return rows.map((row, r) => html`<span key=${r} class="dock-row">${row.map(g => g.back
    ? html`<span key="back" class="dock-card back"></span>`
    : html`<span key=${g.key} class=${'dock-card' + (g.joker ? ' joker' : '')}>${g.label}${g.n > 1 ? html`<i>×${g.n}</i>` : null}</span>`)}</span>`);
}

// Na primeira vez, o container pode ter sobras do desenho antigo: limpa uma vez só
function mount(el, vnode) {
  if (!el.__preact) { el.textContent = ''; el.__preact = true; }
  render(vnode, el);
}

const Mesa = {
  cardSpoken,
  seqBar: (el, nodes) => mount(el, html`<${SeqBar} nodes=${nodes} />`),
  seats: (el, seats) => mount(el, html`<${Seats} seats=${seats} />`),
  pile: (el, items, tags) => mount(el, html`<${Pile} items=${items} tags=${tags} />`),
  hand: (el, hand) => mount(el, html`<${Hand} hand=${hand} />`),
  table: (el, table) => mount(el, html`<${TableStacks} table=${table} />`),
  dock: (el, rows) => mount(el, html`<${DockFan} rows=${rows} />`)
};

export { Mesa, cardSpoken };
