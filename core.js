'use strict';

    /* ==========================================================================
       MOTOR DE REGRAS PURO (Core)
       Toda a regra da partida mora aqui: distribuir, trocar cartas, decidir quem
       começa, jogar, recolher, virar carta fechada, girar mãos com o Coringa,
       queimar o monte, inverter o sentido, comprar, escapar e terminar.

       Nada aqui toca em tela, som, rede, relógio ou log. Cada ação altera o estado
       da mesa e devolve uma lista de EVENTOS na ordem em que aconteceram; a camada
       do jogo (game.js) decide o que fazer com eles (animar, tocar som, gravar no
       log, enviar aos convidados, agendar o bot).

       Eventos:
         turnLog {entry}            linha do log legível (formato 1)
         swapped {playerId, ok}     troca de carta na preparação
         ready {playerId}           jogador confirmou a preparação
         changed                    mesa mudou sem jogada (redesenhar/enviar)
         speedTie {role, candidates} empate na menor carta: duelo de velocidade
         seated {order}             ordem definida, a partida começou
         pickup {playerId, count}   alguém recolheu o monte
         blindFail {playerId, card} carta fechada virada não servia
         flight {fx, fromRect}      animação (jogou, comprou, recolheu)
         botReact {playerId, kind, count}
         gameOver {loserId, fx}     fim da partida
         turnAdvanced {fx}          a vez passou (ou o mesmo jogador joga de novo)
       ========================================================================== */
    const Core = (() => {

      // Tutorial: baralho combinado para as cartas especiais aparecerem logo
      function rigTutorialDeck(deck) {
        const take = (pred) => {
          const i = deck.findIndex(pred);
          return i === -1 ? null : deck.splice(i, 1)[0];
        };
        const pick = (val) => take(c => !c.isJoker && c.val === val);
        // Jogador humano (assento 1): fechadas, abertas, mão
        const humanClosed = [pick(9), pick(5), pick(13)];
        const humanOpen = [pick(10), pick(14), pick(12)];
        const humanHand = [pick(3), pick(7), pick(15)];
        const human = [...humanClosed, ...humanOpen, ...humanHand];
        // Bots com cartas medianas (sem 3 para o humano começar)
        const botCards = [];
        for (let b = 0; b < 2; b++) {
          botCards.push([pick(4), pick(6), pick(8), pick(11), pick(9), pick(13), pick(5), pick(8), pick(6)]);
        }
        const joker = take(c => c.isJoker);
        const rest = deck.splice(0);
        // Coringa e um 10 perto do topo do monte de compra
        const top = [pick.call(null, 4), joker, rest.find(c => c.val === 10) ? rest.splice(rest.findIndex(c => c.val === 10), 1)[0] : null]
          .filter(Boolean);
        const ordered = [...human, ...botCards[0], ...botCards[1], ...top, ...rest].filter(Boolean);
        deck.push(...ordered);
        return deck;
      }

      /* ---- Distribuição ------------------------------------------------------
         Mesma semente + mesmas regras + mesmos lugares = mesma partida.
         A troca inicial dos bots (estratégia) fica fora: é decisão da IA. */
      function deal({ rules, slots, seed, mode }) {
        const rng = Rng.create(seed);
        let deck = RulesEngine.buildDeck(rules, rng);
        const seats = slots.map(s => ({ ...s }));
        const lobby = seats.map(s => ({ id: s.id, name: s.name, type: s.type, persona: s.persona }));
        if (mode === 'tutorial') {
          deck = rigTutorialDeck(deck); // o tutorial conta com você no 1º lugar
        } else {
          // Toda partida nova sorteia os lugares na mesa (com o gerador da partida)
          for (let i = seats.length - 1; i > 0; i--) {
            const k = rng.int(i + 1);
            [seats[i], seats[k]] = [seats[k], seats[i]];
          }
        }
        const players = seats.map((slot, idx) => {
          const closed = deck.splice(0, 3);
          const open = deck.splice(0, 3);
          const hand = deck.splice(0, 3);
          return {
            id: slot.id,
            seatNumber: idx + 1,
            name: slot.name,
            type: slot.type,
            persona: slot.persona,
            avatar: slot.avatar || null,
            closed,
            open,
            hand,
            readySwap: slot.type === 'bot',
            escaped: false
          };
        });
        const state = {
          rules,
          deck,
          discard: [],
          discardPlayGroups: [], // grupos das jogadas feitas no monte atual
          burnedCount: 0,        // cartas eliminadas (queimadas)
          players,
          phase: 'SWAP',
          turnIdx: 0,
          direction: 1,
          constraint7: false,
          freePlayAfterJoker: false,
          freePlayAfter2: false,
          bannerText: mode === 'sim'
            ? 'Simulação: os bots estão se preparando...'
            : 'Preparação: toque numa carta da mão e depois numa aberta da mesa para trocar',
          tieContext: null,
          loserName: null,
          mode,
          escapeOrder: [],
          sessionLosses: {}
        };
        return { state, seed: rng.seed, lobby };
      }

      /* ---- Quem começa ---------------------------------------------------------
         Começa quem tem a menor carta na mão; o 2º é quem tem a próxima menor e
         senta logo depois (a mesa é reorganizada). Empate = duelo de velocidade. */
      function startIfReady(S, E = []) {
        if (S.phase !== 'SWAP' || !S.players.every(p => p.readySwap)) return E;
        const lowestPerPlayer = S.players.map((p, idx) => ({ idx, minVal: Math.min(...p.hand.map(c => c.val)) }));
        const globalMin = Math.min(...lowestPerPlayer.map(x => x.minVal));
        const tiedFirst = lowestPerPlayer.filter(x => x.minVal === globalMin).map(x => x.idx);
        if (tiedFirst.length > 1) speedTie(S, E, 'FIRST', tiedFirst, globalMin, null);
        else resolveSecond(S, E, tiedFirst[0]);
        return E;
      }

      function resolveSecond(S, E, firstIdx) {
        const others = S.players
          .map((p, idx) => ({ idx, minVal: Math.min(...p.hand.map(c => c.val)) }))
          .filter(x => x.idx !== firstIdx);
        const secondMin = Math.min(...others.map(x => x.minVal));
        const tiedSecond = others.filter(x => x.minVal === secondMin).map(x => x.idx);
        if (tiedSecond.length > 1) speedTie(S, E, 'SECOND', tiedSecond, secondMin, firstIdx);
        else finalizeStart(S, E, firstIdx, tiedSecond[0]);
      }

      // Reorganiza a mesa: quem começa e o 2º sentam lado a lado; os demais mantêm a
      // ordem em que estavam depois do 1º.
      function finalizeStart(S, E, firstIdx, secondIdx) {
        const n = S.players.length;
        const first = S.players[firstIdx];
        const second = S.players[secondIdx];
        const rest = [];
        for (let k = 1; k < n; k++) {
          const p = S.players[(firstIdx + k) % n];
          if (p !== second) rest.push(p);
        }
        S.players = [first, second, ...rest];
        S.players.forEach((p, i) => { p.seatNumber = i + 1; });
        S.direction = 1;
        S.turnIdx = 0;
        S.phase = 'PLAY';
        S.tieContext = null;
        // 1º lance obrigatório com a menor carta (a que deu a saída)
        const openCard = first.hand.reduce((a, c) => (c.val < a.val ? c : a), first.hand[0]);
        S.openingVal = openCard ? openCard.val : null;
        S.openingLabel = openCard ? (openCard.isJoker ? 'Coringa' : openCard.label) : null;
        S.bannerText = `${first.name} abre com ${S.openingLabel}; ${second.name} joga em seguida!`;
        E.push({ type: 'seated', order: S.players.map(p => p.id) });
      }

      function speedTie(S, E, role, candidates, cardVal, fixedFirstIdx) {
        S.phase = 'SPEED_TIE';
        const rankObj = AppConfig.RANKS.find(r => r.val === cardVal);
        const label = rankObj ? rankObj.label : 'Coringa';
        S.tieContext = { role, candidates, cardVal, label, fixedFirstIdx };
        E.push({ type: 'speedTie', role, candidates: candidates.slice() });
      }

      // Vencedor do duelo de velocidade (quem tocou primeiro — decidido fora do motor)
      function speedWin(S, winnerIdx, E = []) {
        if (S.phase !== 'SPEED_TIE' || !S.tieContext || !S.tieContext.candidates.includes(winnerIdx)) return { ok: false, events: E };
        if (S.tieContext.role === 'FIRST') resolveSecond(S, E, winnerIdx);
        else finalizeStart(S, E, S.tieContext.fixedFirstIdx, winnerIdx);
        return { ok: true, events: E };
      }

      const label = (c) => c.label + c.suit;
      const topLabel = (S) => (S.discard.length > 0 ? label(S.discard[S.discard.length - 1]) : 'Vazio');

      /* ---- Ações do jogador ------------------------------------------------------
         action: SWAP_CARDS {handId, openId} · READY_SWAP · READY_AUTO (bot assumiu)
                 PICKUP_PILE · PLAY_BLIND {cardId} · PLAY_CARDS {handIds, openIds}
         Devolve { ok, events }. Ação inválida para o momento: ok=false, mesa intacta. */
      function apply(S, playerId, action) {
        const E = [];
        const pIdx = S.players.findIndex(p => p.id === playerId);
        if (pIdx === -1 || !action) return { ok: false, events: E };
        const player = S.players[pIdx];
        const t = action.type;

        if (t === 'SWAP_CARDS' && S.phase === 'SWAP') {
          const hIdx = player.hand.findIndex(c => c.id === action.handId);
          const oIdx = player.open.findIndex(c => c.id === action.openId);
          const ok = hIdx !== -1 && oIdx !== -1;
          if (ok) {
            const temp = player.hand[hIdx];
            player.hand[hIdx] = player.open[oIdx];
            player.open[oIdx] = temp;
          }
          E.push({ type: 'swapped', playerId, ok });
          return { ok, events: E };
        }

        if (t === 'READY_SWAP' && S.phase === 'SWAP') {
          player.readySwap = true;
          E.push({ type: 'ready', playerId });
          if (S.players.every(p => p.readySwap)) startIfReady(S, E);
          else E.push({ type: 'changed' });
          return { ok: true, events: E };
        }

        if (t === 'READY_AUTO') {
          // Um bot assumiu o lugar (queda ou remoção): conta como pronto na preparação.
          // Quem chama decide quando conferir o início (startIfReady), depois de ajustar a mesa.
          player.readySwap = true;
          return { ok: true, events: E };
        }

        if (S.phase !== 'PLAY' || pIdx !== S.turnIdx) return { ok: false, events: E };

        if (t === 'PICKUP_PILE') {
          const check = RulesEngine.canPlayerPickupPile(S, player);
          if (!check.allowed) return { ok: false, events: E };
          const count = S.discard.length;
          E.push({ type: 'turnLog', entry: {
            player: player.name,
            persona: player.persona || 'human',
            action: check.forcedByNoMove ? 'PICKUP_NO_MOVE_WITH_JOKER' : 'PICKUP_PILE',
            handBefore: player.hand.map(label),
            openBefore: player.open.map(label),
            discardTopBefore: topLabel(S),
            discardCountBefore: count
          } });
          collectPile(S, player, count);
          S.bannerText = `${player.name} recolheu o monte (${count} cartas)!`;
          E.push({ type: 'pickup', playerId, count });
          const fx = { kind: 'PICKUP', actorId: player.id, count, sfxTag: 'PICKUP' };
          E.push({ type: 'flight', fx });
          E.push({ type: 'botReact', playerId, kind: 'PICKUP', count });
          advance(S, E, false, fx);
          return { ok: true, events: E };
        }

        if (t === 'PLAY_BLIND') {
          if (player.hand.length > 0 || player.open.length > 0) return { ok: false, events: E };
          const cIdx = player.closed.findIndex(c => c.id === action.cardId);
          if (cIdx === -1) return { ok: false, events: E };
          const chosen = player.closed.splice(cIdx, 1)[0];
          if (RulesEngine.isCardPlayable(S, chosen)) {
            playCards(S, E, player, [chosen], 'BLIND_SUCCESS', [], []);
          } else {
            const topBefore = topLabel(S);
            S.discard.push(chosen);
            const count = S.discard.length;
            E.push({ type: 'turnLog', entry: {
              player: player.name,
              persona: player.persona || 'human',
              action: 'BLIND_FAIL_PICKUP',
              cardFlipped: label(chosen),
              discardTopBefore: topBefore,
              discardCountCollected: count
            } });
            collectPile(S, player, count);
            S.bannerText = `${player.name} revelou ${chosen.label}${chosen.suit} inválido e recolheu tudo!`;
            E.push({ type: 'blindFail', playerId, card: chosen });
            E.push({ type: 'pickup', playerId, count });
            const fx = { kind: 'PICKUP', actorId: player.id, count, sfxTag: 'PICKUP' };
            E.push({ type: 'flight', fx });
            E.push({ type: 'botReact', playerId, kind: 'PICKUP', count });
            advance(S, E, false, fx);
          }
          return { ok: true, events: E };
        }

        if (t === 'PLAY_CARDS') {
          const handIds = Array.isArray(action.handIds) ? action.handIds : [];
          const openIds = Array.isArray(action.openIds) ? action.openIds : [];
          const handChosen = player.hand.filter(c => handIds.includes(c.id));
          const openChosen = player.open.filter(c => openIds.includes(c.id));
          const allChosen = [...handChosen, ...openChosen];
          if (allChosen.length === 0) return { ok: false, events: E };
          const firstVal = allChosen[0].val;
          if (!allChosen.every(c => c.val === firstVal)) return { ok: false, events: E };
          if (!RulesEngine.isCardPlayable(S, allChosen[0])) return { ok: false, events: E };
          if (handChosen.length > 0 && openChosen.length > 0) {
            if (S.deck.length > 0 || handChosen.length !== player.hand.length) return { ok: false, events: E };
          }
          if (handChosen.length === 0 && player.hand.length > 0) return { ok: false, events: E };
          if (openChosen.length > 0 && S.deck.length > 0) return { ok: false, events: E }; // mesa só depois do baralho acabar
          const handBefore = player.hand.map(label);
          const openBefore = player.open.map(label);
          player.hand = player.hand.filter(c => !handIds.includes(c.id));
          player.open = player.open.filter(c => !openIds.includes(c.id));
          playCards(S, E, player, allChosen, 'PLAY_CARDS', handBefore, openBefore);
          return { ok: true, events: E };
        }

        return { ok: false, events: E };
      }

      // Recolher o monte inteiro para a mão (todos viram as cartas recolhidas)
      function collectPile(S, player, count) {
        S.discard.forEach(c => { c.public = true; });
        S.lastPickupBy = player.id;
        S.lastPickupCount = count; // monte grande → "organismo vivo" no GOMBRA!
        player.hand.push(...S.discard);
        S.discard = [];
        S.discardPlayGroups = [];
        S.constraint7 = false;
        S.freePlayAfterJoker = false;
        S.freePlayAfter2 = false;
      }

      function playCards(S, E, player, cardsPlayed, sourceAction, handBefore, openBefore) {
        const r = S.rules;
        S.openingVal = null; // o lance de abertura já foi feito
        S.openingLabel = null;
        const sample = cardsPlayed[0];
        const countPlayed = cardsPlayed.length;

        E.push({ type: 'turnLog', entry: {
          player: player.name,
          persona: player.persona || 'human',
          action: sourceAction,
          cardsPlayed: cardsPlayed.map(label),
          handBefore,
          openBefore,
          discardTopBefore: topLabel(S),
          discardCountBefore: S.discard.length,
          constraint7Before: S.constraint7,
          freeAfter2Before: S.freePlayAfter2,
          deckCount: S.deck.length,
          turnsWithoutProgress: S.stall ? S.stall.sinceProgress : 0
        } });

        S.discard.push(...cardsPlayed);
        S.discardPlayGroups.push({ playerName: player.name, cards: cardsPlayed.map(c => ({ ...c })) });
        S.constraint7 = false;
        S.freePlayAfterJoker = false;
        S.freePlayAfter2 = false;

        let playAgain = false;
        let burned = false;
        let reversed = false;
        let sfxTag = 'PLAY';

        // 4 iguais (1 baralho) / 8 iguais (2 baralhos): invertem o sentido
        const targetSame = r.decks === 1 ? 4 : 8;
        if (r.p48 && !sample.isJoker) {
          if (r.mode48 === 'together') {
            if (countPlayed >= targetSame) reversed = true;
          } else {
            let seqCount = 0;
            for (let i = S.discard.length - 1; i >= 0; i--) {
              if (S.discard[i].val === sample.val && !S.discard[i].isJoker) seqCount++;
              else break;
            }
            if (seqCount >= targetSame) reversed = true;
          }
        }
        if (reversed) {
          S.direction *= -1;
          sfxTag = 'REVERSE';
          if (r.burn48) burned = true;
        }

        if (sample.val === 10 && r.p10) {
          burned = true;
          sfxTag = 'BURN10';
          if (r.after10 === 'again') playAgain = true;
        }

        if (sample.val === 7 && r.p7 && !burned) {
          S.constraint7 = true;
          sfxTag = 'POWER7';
        }

        if (sample.val === 15 && r.p2) {
          playAgain = true;
          S.freePlayAfter2 = true;
          sfxTag = 'POWER2';
          if (player.hand.length === 0 && S.deck.length > 0) {
            const drawCount = Math.min(r.draw2, S.deck.length);
            player.hand.push(...S.deck.splice(0, drawCount));
            E.push({ type: 'flight', fx: { kind: 'DRAW', actorId: player.id, count: drawCount } });
          }
        }

        if (sample.isJoker && r.pjoker) {
          S.freePlayAfterJoker = true;
          sfxTag = 'JOKER';
          const steps = r.multijoker === 'per_joker' ? countPlayed : 1;
          rotateHands(S, steps);
        }

        if (burned) {
          S.burnedCount = (S.burnedCount || 0) + S.discard.length;
          S.discard = [];
          S.discardPlayGroups = [];
          S.constraint7 = false;
          S.freePlayAfterJoker = false;
          S.freePlayAfter2 = false;
          sfxTag = 'BURN10';
        }

        if (!playAgain && S.deck.length > 0 && player.hand.length < 3) {
          const needed = Math.min(3 - player.hand.length, S.deck.length);
          player.hand.push(...S.deck.splice(0, needed));
          E.push({ type: 'flight', fx: { kind: 'DRAW', actorId: player.id, count: needed } });
        }

        S.players.forEach(p => {
          if (!p.escaped && p.hand.length === 0 && p.open.length === 0 && p.closed.length === 0 && S.deck.length === 0) {
            p.escaped = true;
            (S.escapeOrder || (S.escapeOrder = [])).push(p.id); // ordem de saída (1º, 2º, ...)
          }
        });

        const desc = `${player.name} jogou ${countPlayed}x ${sample.label}${sample.isJoker ? '' : sample.suit}`;
        if (sample.val === 15 && r.p2 && !player.escaped) S.bannerText = `${desc} — ${player.name} continua jogando (qualquer carta)!`;
        else if (burned) S.bannerText = `${desc} (Monte Queimado!)`;
        else if (reversed) S.bannerText = `${desc} (Ordem Invertida!)`;
        else S.bannerText = desc;

        const activeRemaining = S.players.filter(p => !p.escaped);
        if (activeRemaining.length <= 1) {
          const loser = activeRemaining[0] || player;
          S.phase = 'GAMEOVER';
          S.loserName = loser.name;
          S.loserId = loser.id;
          E.push({ type: 'gameOver', loserId: loser.id, fx: { kind: 'PLAY', actorId: player.id, cards: cardsPlayed, sfxTag: 'GAMEOVER' } });
          return;
        }

        const fx = { kind: 'PLAY', actorId: player.id, cards: cardsPlayed, sfxTag, burned };
        E.push({ type: 'flight', fx, useFromRect: true });
        E.push({ type: 'botReact', playerId: player.id, kind: burned ? 'BURN' : (reversed ? 'REVERSE' : (sample.isJoker ? 'JOKER' : null)) });
        if (player.escaped) playAgain = false;
        advance(S, E, playAgain, fx);
      }

      function rotateHands(S, steps) {
        const activePlayers = S.players.filter(p => !p.escaped);
        if (activePlayers.length < 2) return;
        const totalSteps = steps % activePlayers.length;
        if (totalSteps === 0) return;
        for (let s = 0; s < totalSteps; s++) {
          const snapshot = activePlayers.map(p => [...p.hand]);
          const n = activePlayers.length;
          for (let i = 0; i < n; i++) {
            const targetIdx = (i + S.direction + n) % n;
            activePlayers[targetIdx].hand = snapshot[i];
          }
        }
      }

      /* Enquanto houver baralho, a mesa (abertas/fechadas) não pode ser jogada. Se a vez
         começar com a mão abaixo de 3 cartas, o jogador compra antes de jogar:
         - vez normal: completa até 3 cartas;
         - jogada extra com a mão vazia: compra a quantidade da regra "se zerar a mão". */
      function refillAtTurnStart(S, E, samePlayerAgain) {
        if (S.phase !== 'PLAY' || S.deck.length === 0) return;
        const p = S.players[S.turnIdx];
        if (!p || p.escaped) return;
        const target = samePlayerAgain ? (p.hand.length === 0 ? Math.min(3, S.rules.draw2 || 1) : 0) : 3;
        const need = Math.min(target - p.hand.length, S.deck.length);
        if (need <= 0) return;
        p.hand.push(...S.deck.splice(0, need));
        E.push({ type: 'turnLog', entry: { player: p.name, persona: p.persona || 'human', action: 'DRAW_AT_TURN_START', count: need, deckCount: S.deck.length, samePlayerAgain } });
        E.push({ type: 'flight', fx: { kind: 'DRAW', actorId: p.id, count: need } });
      }

      // Detector de estagnação: turnos sem ninguém atingir seu menor nº de cartas e sem o
      // baralho diminuir. A IA usa isso para mudar de estratégia.
      function updateStall(S) {
        if (!S.stall) S.stall = { best: {}, lastDeck: S.deck.length, sinceProgress: 0, maxStreak: 0 };
        let progressed = S.deck.length < S.stall.lastDeck;
        S.stall.lastDeck = S.deck.length;
        S.players.forEach(p => {
          if (p.escaped) return;
          const total = p.hand.length + p.open.length + p.closed.length;
          const best = S.stall.best[p.id];
          if (best === undefined || total < best) {
            S.stall.best[p.id] = total;
            progressed = true;
          }
        });
        S.stall.sinceProgress = progressed ? 0 : S.stall.sinceProgress + 1;
        S.turnCounter = (S.turnCounter || 0) + 1;
        S.stall.maxStreak = Math.max(S.stall.maxStreak, S.stall.sinceProgress);
      }

      function advance(S, E, samePlayerAgain, fx) {
        if (!samePlayerAgain) S.turnIdx = RulesEngine.getNextActivePlayerIndex(S, S.turnIdx);
        refillAtTurnStart(S, E, samePlayerAgain);
        updateStall(S);
        E.push({ type: 'turnAdvanced', fx });
      }

      /* ---- Cópia para simulação ---------------------------------------------------
         A IA "imagina" continuações da partida aplicando jogadas numa cópia da mesa.
         A cópia não compartilha nada mutável com a mesa real (nem as cartas: recolher
         o monte marca cartas como públicas). Sem histórico de estagnação: a simulação
         começa a contar do zero. */
      function cloneForSim(S) {
        const cards = (arr) => arr.map(c => ({ ...c }));
        return {
          rules: S.rules,
          deck: cards(S.deck),
          discard: cards(S.discard),
          discardPlayGroups: [],
          burnedCount: S.burnedCount || 0,
          players: S.players.map(p => ({
            id: p.id, name: p.name, type: p.type, persona: p.persona, seatNumber: p.seatNumber,
            readySwap: true, escaped: p.escaped,
            hand: cards(p.hand), open: cards(p.open), closed: cards(p.closed)
          })),
          phase: S.phase,
          turnIdx: S.turnIdx,
          direction: S.direction,
          constraint7: S.constraint7,
          freePlayAfterJoker: S.freePlayAfterJoker,
          freePlayAfter2: S.freePlayAfter2,
          openingVal: S.openingVal == null ? null : S.openingVal,
          openingLabel: S.openingLabel || null,
          escapeOrder: (S.escapeOrder || []).slice(),
          turnCounter: 0,
          stall: null,
          mode: 'sim'
        };
      }

      return { deal, rigTutorialDeck, startIfReady, speedWin, apply, cloneForSim };
    })();
