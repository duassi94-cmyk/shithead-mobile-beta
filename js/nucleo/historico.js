// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

/* ==========================================================================
   HISTÓRICO DE JOGADAS (público)
   O host monta, a partir dos eventos do motor, uma lista curta do que todos
   já viram na mesa: quem jogou quais cartas (e se da mão, da mesa ou às
   cegas), quem recolheu o monte, quem saiu e quem perdeu. Nunca entra nada
   escondido (mão de ninguém, compras, cartas fechadas não reveladas).
   Fica em S.history (últimas HISTORY_MAX) e viaja com a mesa para os convidados.
   ========================================================================== */
const HISTORY_MAX = 30;
// efeito da jogada, pelo som que o motor escolheu (o monte queimado vence os outros)
const FX_BY_SFX = { REVERSE: 'reverse', POWER7: 'seven', POWER2: 'two', JOKER: 'joker' };

// Fotografia mínima antes da ação (para saber de onde as cartas saíram e quem saiu agora)
function historyBefore(S, playerId) {
  const p = S.players.find(x => x.id === playerId);
  return { pid: playerId, open: p ? p.open.length : 0, out: (S.escapeOrder || []).length, t: (S.turnCounter || 0) + 1 };
}

// Acrescenta em S.history o que esta ação mostrou a todos. events = o que Core.apply devolveu.
function addHistory(S, events, before) {
  if (!S || !Array.isArray(events) || !before) return;
  const list = Array.isArray(S.history) ? S.history : (S.history = []);
  const add = (e) => list.push({ t: before.t, ...e });
  const player = S.players.find(x => x.id === before.pid);
  const playFx = events.find(ev => (ev.type === 'flight' && ev.fx && ev.fx.kind === 'PLAY') || ev.type === 'gameOver');
  for (const ev of events) {
    if (ev.type !== 'turnLog' || !ev.entry) continue;
    const e = ev.entry;
    if (e.action === 'PLAY_CARDS' || e.action === 'BLIND_SUCCESS') {
      const fx = playFx && playFx.fx ? (playFx.fx.burned ? 'burn' : (FX_BY_SFX[playFx.fx.sfxTag] || '')) : '';
      const cards = (e.cardsPlayed || []).slice(0, 8);
      const fromTable = player ? before.open - player.open.length : 0;
      const src = e.action === 'BLIND_SUCCESS' ? 'blind' : (fromTable <= 0 ? 'hand' : (fromTable >= cards.length ? 'table' : 'mixed'));
      add({ k: 'play', p: before.pid, cards, src, fx });
    } else if (e.action === 'PICKUP_PILE' || e.action === 'PICKUP_NO_MOVE_WITH_JOKER') {
      add({ k: 'pickup', p: before.pid, n: e.discardCountBefore || 0 });
    } else if (e.action === 'BLIND_FAIL_PICKUP') {
      add({ k: 'blindFail', p: before.pid, cards: [e.cardFlipped], n: e.discardCountCollected || 0 });
    }
  }
  (S.escapeOrder || []).slice(before.out).forEach((id, i) => add({ k: 'out', p: id, n: before.out + i + 1 }));
  const over = events.find(ev => ev.type === 'gameOver');
  if (over) add({ k: 'end', p: over.loserId });
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
}

// "JOKER★" → "Coringa"; "10♥" fica igual
const cardText = (l) => (String(l).startsWith('JOKER') ? 'Coringa' : String(l));
function cardsText(cards) {
  if (!cards || !cards.length) return '';
  if (cards.length === 1) return cardText(cards[0]);
  return cards.map(cardText).join(' ');
}
const FX_TEXT = { burn: 'queimou o monte', reverse: 'inverteu o sentido', seven: 'próximo joga 7 ou menos', two: 'joga de novo', joker: 'as mãos giraram' };

// Texto simples de uma entrada (quem mostra na tela escapa o HTML). nameOf(id) → nome.
function historyText(e, nameOf) {
  const who = nameOf(e.p) || 'Alguém';
  switch (e.k) {
    case 'play': {
      const from = { table: ' da mesa', mixed: ' da mão e da mesa', blind: ' às cegas' }[e.src] || '';
      return `${who} jogou ${cardsText(e.cards)}${from}` + (FX_TEXT[e.fx] ? ` — ${FX_TEXT[e.fx]}` : '');
    }
    case 'pickup': return `${who} recolheu o monte (${e.n} ${e.n === 1 ? 'carta' : 'cartas'})`;
    case 'blindFail': return `${who} virou ${cardsText(e.cards)} às cegas, não serviu: recolheu ${e.n} ${e.n === 1 ? 'carta' : 'cartas'}`;
    case 'out': return `${who} saiu da partida (${e.n}º)`;
    case 'end': return `${who} perdeu a partida`;
    default: return '';
  }
}

export { HISTORY_MAX, historyBefore, addHistory, historyText };
