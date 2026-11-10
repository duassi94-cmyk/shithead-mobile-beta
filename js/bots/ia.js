// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

import { RulesEngine } from '../nucleo/regras.js';
import { Core } from '../nucleo/motor.js';

/* ==========================================================================
   6. MOTOR DE INTELIGÊNCIA ARTIFICIAL (AIEngine)
   ========================================================================== */
const AIEngine = (() => {
  function cardStrategicWeight(card, rules) {
    if (card.isJoker && rules.pjoker) return 100;
    if (card.val === 15 && rules.p2) return 95;
    if (card.val === 10 && rules.p10) return 90;
    return card.val;
  }

  // Troca inicial do bot (só decide e arruma as cartas; o registro no log é do jogo)
  function performInitialSwap(state, playerIdx) {
    const p = state.players[playerIdx];
    if (p.persona === 'easy') return;
    const combined = [...p.hand, ...p.open].sort(
      (a, b) => cardStrategicWeight(b, state.rules) - cardStrategicWeight(a, state.rules)
    );
    p.open = combined.slice(0, 3);
    p.hand = combined.slice(3, 6);
  }

  // Quantos turnos sem progresso (por jogador ativo) até a IA entrar em "modo destravar"
  const STALL_TURNS_PER_PLAYER = 4;

  function totalCards(p) {
    return p.hand.length + p.open.length + p.closed.length;
  }

  function isStalled(state) {
    if (!state.stall || state.deck.length > 0) return false;
    const active = state.players.filter(p => !p.escaped).length;
    return state.stall.sinceProgress >= STALL_TURNS_PER_PLAYER * active;
  }

  function getPrevActivePlayerIndex(state, fromIdx) {
    const n = state.players.length;
    let prev = fromIdx;
    for (let i = 0; i < n; i++) {
      prev = (prev - state.direction + n) % n;
      if (!state.players[prev].escaped) return prev;
    }
    return fromIdx;
  }

  // Cartas do próximo jogador que a IA conhece legitimamente:
  // cartas abertas na mesa + cartas que ele recolheu do monte (marcadas como públicas).
  function knownResponderCards(state, player) {
    if (player.hand.length > 0) {
      const known = player.hand.filter(c => c.public);
      return { cards: known, fullyKnown: known.length === player.hand.length };
    }
    if (player.open.length > 0) return { cards: player.open, fullyKnown: true };
    return { cards: [], fullyKnown: false }; // cartas fechadas: ninguém sabe
  }

  // O próximo jogador consegue responder se colocarmos `card` no topo?
  // Retorna true/false quando dá pra saber, ou null quando é desconhecido.
  function canNextAnswer(state, card, next) {
    const r = state.rules;
    if ((card.val === 10 && r.p10) || (card.val === 15 && r.p2) || (card.isJoker && r.pjoker)) return null;
    const fake = {
      rules: r,
      discard: [card],
      constraint7: card.val === 7 && r.p7,
      freePlayAfter2: false,
      freePlayAfterJoker: false
    };
    const { cards, fullyKnown } = knownResponderCards(state, next);
    if (cards.some(c => RulesEngine.isCardPlayable(fake, c))) return true;
    return fullyKnown ? false : null;
  }

  // Valor do Coringa: a mão gira no sentido do jogo.
  // Eu entrego minha mão (sem o coringa) ao próximo e recebo a do anterior.
  function jokerScore(state, bot, botIdx, jokersInGroup, fromHand) {
    const nextIdx = RulesEngine.getNextActivePlayerIndex(state, botIdx);
    const prevIdx = getPrevActivePlayerIndex(state, botIdx);
    const next = state.players[nextIdx];
    const prev = state.players[prevIdx];
    const give = fromHand ? bot.hand.length - jokersInGroup : bot.hand.length;
    const receive = prevIdx === botIdx ? give : prev.hand.length;

    // Jogada suicida: entregar mão vazia a quem não tem mais nada na mesa = ele escapa
    if (give === 0 && state.deck.length === 0 && next.open.length === 0 && next.closed.length === 0) {
      return 1000;
    }
    const gain = give - receive; // positivo = me livro de mais cartas do que recebo
    if (gain >= 2) return -20 - gain * 3;
    if (gain >= 1 && state.deck.length === 0) return -5;
    return 100; // segura o coringa
  }

  const options = { search: true, searchAfterTurnsPerPlayer: 10 };

  function isDeeplyStalled(state) {
    if (!state.stall || state.deck.length > 0) return false;
    const active = state.players.filter(p => !p.escaped).length;
    return state.stall.sinceProgress >= options.searchAfterTurnsPerPlayer * active;
  }

  function decideTurnAction(state, botIdx) {
    // Travado há muito tempo: a IA "imagina" o resto da partida antes de decidir
    if (options.search && isDeeplyStalled(state)) {
      const searched = searchEndgameAction(state, botIdx);
      if (searched) return searched;
    }
    return heuristicAction(state, botIdx);
  }

  function heuristicAction(state, botIdx) {
    const bot = state.players[botIdx];
    const r = state.rules;
    const stalled = isStalled(state);

    if (bot.hand.length === 0 && bot.open.length === 0) {
      if (bot.closed.length > 0) {
        const randomClosed = bot.closed[Math.floor(Math.random() * bot.closed.length)];
        return { type: 'PLAY_BLIND', cardId: randomClosed.id };
      }
      return null;
    }

    const fromHand = bot.hand.length > 0;
    const pool = fromHand ? bot.hand : bot.open;
    const validCards = pool.filter(c => RulesEngine.isCardPlayable(state, c));

    if (validCards.length === 0) {
      return { type: 'PICKUP_PILE' };
    }

    // Agrupa as jogadas possíveis por valor
    const groups = new Map();
    validCards.forEach(c => {
      const key = c.isJoker ? 'J' : c.val;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    });

    const nextIdx = RulesEngine.getNextActivePlayerIndex(state, botIdx);
    const next = state.players[nextIdx];
    const nextTotal = totalCards(next);
    const deckEmpty = state.deck.length === 0;
    const level = bot.persona === 'easy' ? 1 : bot.persona === 'medium' ? 2 : 3;

    let best = null;
    groups.forEach((cards) => {
      const sample = cards[0];
      const allOfRank = pool.filter(c => (sample.isJoker ? c.isJoker : (!c.isJoker && c.val === sample.val)));
      const isSpecial = (sample.val === 15 && r.p2) || (sample.val === 10 && r.p10) || (sample.isJoker && r.pjoker);
      let score;

      if (level === 1 && !stalled) {
        score = Math.random() * 10; // Fácil: aleatório
      } else {
        score = cardStrategicWeight(sample, r);
        if (deckEmpty) score -= (allOfRank.length - 1) * 2; // livrar-se de várias de uma vez

        const answer = canNextAnswer(state, sample, next);
        if (level === 3 || stalled) {
          if (answer === false) score -= 30; // ele não tem resposta conhecida: obriga a recolher
          if (sample.val === 7 && r.p7 && nextTotal <= 4) score -= 8;
        }

        if (sample.isJoker && r.pjoker) {
          score = level >= 2 || stalled ? jokerScore(state, bot, botIdx, 1, fromHand) : 100;
        }

        // Jogada que termina todas as minhas cartas = ótimo
        if (deckEmpty && allOfRank.length === totalCards(bot)) score -= 200;
      }

      if (stalled && !isSpecial) {
        // Modo destravar: prioriza grupos grandes e quebra ciclos com aleatoriedade.
        // Especiais (2, 10, Coringa) ficam de fora: são cartas de controle e
        // valem mais jogadas uma a uma (cada 2 dá uma jogada extra).
        score -= allOfRank.length * 6;
        if (sample.val === 7 && r.p7) score -= 10;
        // Quanto mais tempo travado, mais imprevisível a escolha (quebra ciclos repetidos)
        const heat = Math.min(state.stall.sinceProgress, 200);
        score += Math.random() * (15 + heat * 0.6);
      }

      if (!best || score < best.score) best = { score, sample, allOfRank, isSpecial };
    });

    const finishing = deckEmpty && best.allOfRank.length === totalCards(bot);
    const playAll = (level > 1 || stalled) && (!best.isSpecial || finishing);
    let groupToPlay = best.sample.isJoker ? [best.sample] : (playAll ? best.allOfRank : [best.sample]);

    // Travado há muito tempo: divide o grupo em tamanho aleatório para os mesmos
    // blocos de cartas não ficarem indo e voltando iguais entre os jogadores.
    if (stalled && !finishing && groupToPlay.length > 1 && state.stall.sinceProgress > STALL_TURNS_PER_PLAYER * 6) {
      const k = 1 + Math.floor(Math.random() * groupToPlay.length);
      groupToPlay = groupToPlay.slice(0, k);
    }

    const handIds = fromHand ? groupToPlay.map(c => c.id) : [];
    let openIds = fromHand ? [] : groupToPlay.map(c => c.id);

    // Última(s) carta(s) da mão: junta as abertas da mesa de mesmo valor.
    // Especiais (2, 10, Coringa) ficam guardados na mesa — valem mais jogados um a um —
    // exceto quando juntar termina todas as cartas do bot.
    if (fromHand && deckEmpty && handIds.length === bot.hand.length && !best.sample.isJoker) {
      const sameOpen = bot.open.filter(c => !c.isJoker && c.val === best.sample.val);
      const endsGame = handIds.length + sameOpen.length === totalCards(bot);
      if (!best.isSpecial || endsGame) openIds = sameOpen.map(c => c.id);
    }

    return { type: 'PLAY_CARDS', handIds, openIds };
  }

  /* ------------------------------------------------------------------------
     BUSCA DE FIM DE JOGO (Monte Carlo)
     Usada só quando a partida está travada. Para cada jogada possível, o bot
     simula várias continuações rápidas da partida e escolhe a que mais vezes
     o deixa com menos cartas / salvo. As cartas que o bot não conhece
     (mãos escondidas dos outros, cartas fechadas, baralho) são embaralhadas
     em cada simulação: a IA não "vê" cartas escondidas.
     ------------------------------------------------------------------------ */
  const ROLLOUTS_PER_MOVE = 6;
  const ROLLOUT_DEPTH = 100;

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[k]] = [arr[k], arr[i]];
    }
    return arr;
  }

  // Cópia da mesa do ponto de vista do bot, com as cartas desconhecidas redistribuídas
  function determinize(state, botIdx) {
    const s = Core.cloneForSim(state);
    const unknown = [...s.deck];
    s.players.forEach((p, i) => {
      unknown.push(...p.closed);
      if (i !== botIdx) unknown.push(...p.hand.filter(c => !c.public));
    });
    shuffleInPlace(unknown);
    let k = 0;
    s.deck = s.deck.map(() => unknown[k++]);
    s.players.forEach((p, i) => {
      p.closed = p.closed.map(() => unknown[k++]);
      if (i !== botIdx) p.hand = p.hand.map(c => (c.public ? c : unknown[k++]));
    });
    return s;
  }

  function candidateActions(state, botIdx) {
    const bot = state.players[botIdx];
    const out = [];
    if (bot.hand.length === 0 && bot.open.length === 0) return out; // fechadas: no escuro, sem escolha real
    const fromHand = bot.hand.length > 0;
    const pool = fromHand ? bot.hand : bot.open;
    const valid = pool.filter(c => RulesEngine.isCardPlayable(state, c));
    const groups = new Map();
    valid.forEach(c => {
      const key = c.isJoker ? 'J' : c.val;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    });
    groups.forEach((cards) => {
      const sizes = new Set([1, cards.length]);
      sizes.forEach(n => {
        const ids = cards.slice(0, n).map(c => c.id);
        let openIds = fromHand ? [] : ids;
        if (fromHand && state.deck.length === 0 && n === bot.hand.length && !cards[0].isJoker) {
          openIds = bot.open.filter(c => !c.isJoker && c.val === cards[0].val).map(c => c.id);
        }
        out.push({ type: 'PLAY_CARDS', handIds: fromHand ? ids : [], openIds });
      });
    });
    return out; // sem jogada válida, a heurística decide (recolher o monte)
  }

  // Política rápida para as simulações: heurística com um pouco de acaso
  function rolloutPolicy(s, idx) {
    const p = s.players[idx];
    if (p.hand.length === 0 && p.open.length === 0) {
      return p.closed.length ? { type: 'PLAY_BLIND', cardId: p.closed[Math.floor(Math.random() * p.closed.length)].id } : null;
    }
    if (Math.random() < 0.15) {
      const opts = candidateActions(s, idx);
      if (opts.length) return opts[Math.floor(Math.random() * opts.length)];
    }
    return heuristicAction(s, idx);
  }

  function evaluate(s, botId) {
    const me = s.players.find(p => p.id === botId);
    const active = s.players.filter(p => !p.escaped);
    if (me.escaped) return 1000 - s.plies;
    if (active.length <= 1) return -1000; // fui o último: Shithead
    const mine = totalCards(me);
    const others = active.filter(p => p.id !== botId);
    const avgOthers = others.reduce((a, p) => a + totalCards(p), 0) / Math.max(1, others.length);
    return (avgOthers - mine) * 4;
  }

  function searchEndgameAction(state, botIdx) {
    const cands = candidateActions(state, botIdx);
    if (cands.length <= 1) return cands[0] || null;
    const botId = state.players[botIdx].id;
    // Quanto mais tempo travado, mais simulações e mais profundas
    const extra = Math.min(4, Math.floor(state.stall.sinceProgress / 150));
    const rollouts = ROLLOUTS_PER_MOVE + extra;
    const depth = ROLLOUT_DEPTH + extra * 10;
    const scored = cands.map(action => {
      let total = 0;
      for (let i = 0; i < rollouts; i++) {
        const s = determinize(state, botIdx);
        s.plies = 0;
        // Mesmas regras da partida real (core.js), numa cópia que não toca a mesa
        if (Core.apply(s, s.players[botIdx].id, action).ok) s.plies++;
        while (s.phase === 'PLAY' && s.plies < depth) {
          const a = rolloutPolicy(s, s.turnIdx);
          if (!a || !Core.apply(s, s.players[s.turnIdx].id, a).ok) break;
          s.plies++;
        }
        total += evaluate(s, botId);
      }
      return { mean: total / rollouts, action };
    });
    const bestMean = Math.max(...scored.map(x => x.mean));
    // Sorteia entre as jogadas praticamente empatadas: evita repetir o mesmo ciclo
    const near = scored.filter(x => x.mean >= bestMean - 3);
    return near[Math.floor(Math.random() * near.length)].action;
  }

  return { performInitialSwap, decideTurnAction, isStalled, options };
})();

export { AIEngine };
