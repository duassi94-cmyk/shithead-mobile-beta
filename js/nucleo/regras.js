// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

import { AppConfig } from '../config.js';
import { Rng } from './sorteio.js';

/* ==========================================================================
   5. MOTOR DE REGRAS E BARALHO (RulesEngine)
   ========================================================================== */
const RulesEngine = (() => {
  // Número aleatório criptográfico em [0, n): sem previsibilidade no embaralhamento
  function randInt(n) {
    if (window.crypto && crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      const limit = Math.floor(0x100000000 / n) * n; // descarta a sobra para não viciar
      do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  // Identificador sorteado ("k" + 7 caracteres): não revela o valor da carta.
  // Antes os ids eram c_1, c_2... na ordem do baralho, o que entregava cada carta.
  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function randomCardId(used, rng) {
    let id;
    do {
      id = 'k';
      for (let i = 0; i < 7; i++) id += ID_CHARS[rng.int(ID_CHARS.length)];
    } while (used.has(id));
    used.add(id);
    return id;
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const k = rng.int(i + 1);
      [arr[i], arr[k]] = [arr[k], arr[i]];
    }
    return arr;
  }

  // rng: gerador da partida (Rng.create(semente)). Sem ele, usa uma semente nova.
  function buildDeck(rules, rng = Rng.create()) {
    const deck = [];
    for (let d = 0; d < rules.decks; d++) {
      for (const suit of AppConfig.SUITS) {
        for (const r of AppConfig.RANKS) {
          deck.push({
            label: r.label,
            val: r.val,
            suit,
            isRed: suit === '♥' || suit === '♦',
            isJoker: false
          });
        }
      }
    }
    for (let j = 0; j < rules.jokers; j++) {
      deck.push({
        label: 'JOKER',
        val: 16,
        suit: '★',
        isRed: false,
        isJoker: true
      });
    }
    shuffle(deck, rng);
    // Os ids são dados depois de embaralhar e são sorteados
    const used = new Set();
    deck.forEach(c => { c.id = randomCardId(used, rng); });
    return deck;
  }

  function isCardPlayable(state, card) {
    const r = state.rules;
    // 1º lance da partida: quem ganhou a saída abre obrigatoriamente com a sua menor carta
    if (state.openingVal != null) return card.val === state.openingVal;
    if (card.isJoker && r.pjoker) return true;
    if (card.val === 10 && r.p10) return true;
    if (card.val === 15 && r.p2) return true;

    if (state.discard.length === 0 || state.freePlayAfterJoker || state.freePlayAfter2) return true;

    const topCard = state.discard[state.discard.length - 1];
    if (topCard.isJoker && r.pjoker) return true;
    if (topCard.val === 15 && r.p2) return true;

    if (state.constraint7 && r.p7) {
      return card.val <= 7;
    }
    return card.val >= topCard.val;
  }

  function hasJokerInDiscard(state) {
    if (!state.rules.pjoker) return false;
    return state.discard.some(c => c.isJoker);
  }

  function hasAnyPlayableMove(state, player) {
    if (player.hand.length > 0) {
      return player.hand.some(c => isCardPlayable(state, c));
    }
    if (player.open.length > 0) {
      return player.open.some(c => isCardPlayable(state, c));
    }
    // Na fase de cartas fechadas, o jogador sempre pode tentar virar uma carta fechada
    return player.closed.length > 0;
  }

  // Regra atualizada do Coringa: só proíbe comprar o monte quando há Coringa E o jogador tem jogada possível
  function canPlayerPickupPile(state, player) {
    if (state.discard.length === 0) return { allowed: false, reason: 'O monte já está vazio!' };
    if (hasJokerInDiscard(state)) {
      const hasMove = hasAnyPlayableMove(state, player);
      if (hasMove) {
        return {
          allowed: false,
          reason: 'Há um Coringa no monte! Como você tem jogada válida disponível, não pode recolher o monte.'
        };
      }
      return { allowed: true, forcedByNoMove: true };
    }
    return { allowed: true, forcedByNoMove: false };
  }

  function getInvalidMoveReason(state, card) {
    const r = state.rules;
    if (state.openingVal != null && card.val !== state.openingVal) {
      return `Primeiro lance: abra com a sua menor carta (${state.openingLabel || state.openingVal}).`;
    }
    if (state.constraint7 && r.p7 && card.val > 7) {
      return 'Regra do 7 ativa! Jogue uma carta menor ou igual a 7 (ou especial).';
    }
    if (state.discard.length > 0) {
      const topCard = state.discard[state.discard.length - 1];
      return `Jogada inválida! ${card.label}${card.suit} é menor que ${topCard.label}${topCard.isJoker ? '' : topCard.suit}.`;
    }
    return 'Essa carta não pode ser jogada agora!';
  }

  function getNextActivePlayerIndex(state, fromIdx) {
    const n = state.players.length;
    let next = fromIdx;
    for (let i = 0; i < n; i++) {
      next = (next + state.direction + n) % n;
      if (!state.players[next].escaped) return next;
    }
    return fromIdx;
  }

  return {
    buildDeck,
    randInt,
    isCardPlayable,
    hasJokerInDiscard,
    hasAnyPlayableMove,
    canPlayerPickupPile,
    getInvalidMoveReason,
    getNextActivePlayerIndex
  };
})();

export { RulesEngine };
