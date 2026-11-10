// Comparação fluxo do jogo (game.js) × motor puro (core.js).
// Escrito para validar a troca do motor antigo (regras dentro do game.js) pelo core.js;
// hoje confere que a camada do jogo aplica cada ação e reage a cada evento como esperado.
// Numa aba do jogo (http://localhost:8765/, não a que você usa para jogar):
//
//   const s = document.createElement('script'); s.src = 'tests/core-diff.js'; document.head.appendChild(s);
//   await CoreDiff.run({ matches: 40 })     -> joga partidas e compara a cada ação
//   CoreDiff.last                           -> relatório da última rodada
//
// Cada partida é jogada pelo fluxo atual (startNewMatch / executePlayerAction / duelo de
// velocidade / bot assumindo o lugar). A mesma distribuição é refeita no motor novo
// (mesma semente) e cada ação é repetida nele. Depois de cada ação, compara a mesa inteira
// (onde está cada carta, quem pode jogar, regras ativas, textos, contadores) e o que cada
// motor produziu: linhas do log, animações, sons, reações dos bots e fim de partida.
//
// As ações vêm da IA dos bots, de jogadas sorteadas entre as válidas e de jogadas
// propositalmente erradas (fora da vez, cartas misturadas, mesa com baralho, etc.).
// Durante o teste: sem som, sem desenhar, sem rede e sem gravar no armazenamento da aba.
window.CoreDiff = (() => {
  if (typeof Core === 'undefined') throw new Error('core.js não carregado');

  // ---- Isolamento da aba de teste ------------------------------------------------
  const noStore = function () {};
  let goldenRaw = null;
  const captureStore = function (k, v) { if (k === 'sh_last_session_log') goldenRaw = v; };
  try {
    Storage.prototype.setItem = noStore;
    Storage.prototype.removeItem = noStore;
  } catch (e) {}
  const cap = { turns: [], flights: [], reacts: [], sounds: [], swaps: [], over: [], seating: [], warnings: [] };
  const reset = () => Object.keys(cap).forEach(k => { cap[k] = []; });
  Object.keys(SoundEngine).forEach(k => {
    if (typeof SoundEngine[k] === 'function') SoundEngine[k] = () => { cap.sounds.push(k); };
  });
  // Log de verdade (modo "referência") × log substituído (modo comparação)
  const realLogger = { ...LoggerModule };
  let startInfo = null;
  const stubLogger = {
    initNewSession() {}, setMatchMode() {}, logAction() {}, logCheck() {},
    startMatchLog(rules, players, info) { startInfo = { rules, info, dealt: players.map(p => cardsOf(p)) }; },
    logSwap(p) { cap.swaps.push(p.id); },
    logTurn(e) { const c = { ...e }; delete c.at; cap.turns.push(c); },
    logMatchEnd(name) { cap.over.push(name); }
  };
  Object.assign(LoggerModule, stubLogger);
  window.recordMatchResult = () => { cap.over.push('result'); };
  window.triggerFlightVisual = (fx) => { cap.flights.push(normFx(fx)); };
  window.maybeBotReact = (actor, kind, count = 0) => { cap.reacts.push([actor.id, kind || null, count || 0]); };
  window.showInvalidWarning = (msg) => { cap.warnings.push(msg); };
  window.nlog = (ev) => { if (ev === 'seating') cap.seating.push(G.players.map(p => p.id).join(',')); };
  ['renderGame', 'broadcastState', 'scheduleBotIfNeeded', 'showReaction', 'renderScoreboard', 'keepScreenAwake', 'renderLobbySlots', 'saveHostResume'].forEach(n => { window[n] = () => {}; });
  window.setTimeout = () => 0; // início automático e toques dos bots no duelo: o teste comanda

  // ---- Fotografia da mesa ------------------------------------------------------------
  const U = '∅'; // marca "indefinido" (diferente de null)
  const val = (v) => (v === undefined ? U : v);
  const cid = (c) => c.id + (c.public ? '*' : '');
  const ids = (a) => (a || []).map(cid).join(',');
  function cardsOf(p) { return { hand: p.hand.map(c => c.id), open: p.open.map(c => c.id), closed: p.closed.map(c => c.id) }; }
  const STATE_KEYS = ['phase', 'turnIdx', 'direction', 'burnedCount', 'constraint7', 'freePlayAfterJoker', 'freePlayAfter2',
    'openingVal', 'openingLabel', 'bannerText', 'tieContext', 'loserName', 'loserId', 'escapeOrder', 'turnCounter',
    'stall', 'lastPickupBy', 'lastPickupCount', 'mode', 'sessionLosses', 'rules'];
  // Campos que só a camada do jogo cuida (relógio, tela, rede)
  const LAYER_KEYS = new Set(['pickupStamp', 'loserAvatar', 'version', 'turns', 'turbo']);
  const PLAYER_KEYS = ['id', 'seatNumber', 'name', 'type', 'persona', 'readySwap', 'escaped', 'disconnected'];
  function snap(S) {
    const o = {};
    STATE_KEYS.forEach(k => { o[k] = JSON.stringify(val(S[k])); });
    o.deck = ids(S.deck);
    o.discard = ids(S.discard);
    o.groups = JSON.stringify(S.discardPlayGroups);
    o.players = S.players.map(p => PLAYER_KEYS.map(k => JSON.stringify(val(p[k]))).join('|') + `|${ids(p.hand)}|${ids(p.open)}|${ids(p.closed)}`);
    o.keys = Object.keys(S).filter(k => !LAYER_KEYS.has(k)).sort().join(',');
    o.pkeys = S.players.map(p => Object.keys(p).filter(k => k !== 'avatar').sort().join(','));
    return o;
  }
  function diff(a, b) {
    const out = [];
    Object.keys(a).forEach(k => {
      const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
      if (x !== y) out.push({ campo: k, atual: a[k], novo: b[k] });
    });
    return out;
  }
  function normFx(fx) {
    if (!fx) return null;
    return JSON.stringify({
      kind: fx.kind, actorId: fx.actorId || null, count: fx.count == null ? null : fx.count,
      sfxTag: fx.sfxTag || null, burned: !!fx.burned, cards: (fx.cards || []).map(c => c.id)
    });
  }
  // O que a camada do jogo vai fazer com cada evento do motor novo
  function expectedFrom(events, S) {
    const e = { turns: [], flights: [], reacts: [], sounds: [], swaps: [], over: [], seating: [], warnings: [] };
    events.forEach(ev => {
      switch (ev.type) {
        case 'turnLog': e.turns.push(ev.entry); break;
        case 'swapped': if (ev.ok) e.sounds.push('slide'); break;
        case 'ready': e.swaps.push(ev.playerId); e.sounds.push('select'); break;
        case 'seated': e.seating.push(ev.order.join(',')); e.sounds.push('power2'); break;
        case 'speedTie': e.sounds.push('power7'); break;
        case 'flight': e.flights.push(normFx(ev.fx)); break;
        case 'botReact': e.reacts.push([ev.playerId, ev.kind || null, ev.count || 0]); break;
        case 'blindFail': if (ev.playerId === myPlayerId) e.warnings.push('blind'); break;
        case 'gameOver': {
          const loser = S.players.find(p => p.id === ev.loserId);
          e.over.push('result', loser.name);
          e.flights.push(normFx(ev.fx));
          break;
        }
        default: break;
      }
    });
    return e;
  }

  // ---- Sorteios ----------------------------------------------------------------------
  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rnd(a.length)];
  const shuffled = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const k = rnd(i + 1); [b[i], b[k]] = [b[k], b[i]]; } return b; };

  function randomMove(S, idx) {
    const p = S.players[idx];
    if (p.hand.length === 0 && p.open.length === 0) {
      if (p.closed.length && Math.random() < 0.9) return { type: 'PLAY_BLIND', cardId: pick(p.closed).id };
      return { type: 'PICKUP_PILE' };
    }
    if (Math.random() < 0.12) return { type: 'PICKUP_PILE' };
    const fromHand = p.hand.length > 0;
    const pool = fromHand ? p.hand : p.open;
    const valid = pool.filter(c => RulesEngine.isCardPlayable(S, c));
    if (!valid.length) return { type: 'PICKUP_PILE' };
    const s = pick(valid);
    const same = shuffled(pool.filter(c => c.val === s.val));
    const chosen = same.slice(0, 1 + rnd(same.length));
    let handIds = fromHand ? chosen.map(c => c.id) : [];
    let openIds = fromHand ? [] : chosen.map(c => c.id);
    if (fromHand && S.deck.length === 0 && chosen.length === p.hand.length && Math.random() < 0.7) {
      const so = shuffled(p.open.filter(c => c.val === s.val));
      if (so.length) openIds = so.slice(0, 1 + rnd(so.length)).map(c => c.id);
    }
    return { type: 'PLAY_CARDS', handIds, openIds };
  }

  function junkMove(S, idx) {
    const p = S.players[idx];
    const all = [...S.deck, ...S.discard, ...S.players.flatMap(q => [...q.hand, ...q.open, ...q.closed])];
    switch (rnd(9)) {
      case 0: return { type: 'PLAY_CARDS', handIds: shuffled(p.hand).slice(0, 2).map(c => c.id), openIds: [] };
      case 1: return { type: 'PLAY_CARDS', handIds: p.hand.map(c => c.id), openIds: p.open.map(c => c.id) };
      case 2: return { type: 'PLAY_CARDS', handIds: [], openIds: p.open.slice(0, 1).map(c => c.id) };
      case 3: return { type: 'PLAY_BLIND', cardId: p.closed.length ? pick(p.closed).id : 'k0000000' };
      case 4: return { type: 'PLAY_CARDS', handIds: [], openIds: [] };
      case 5: return { type: 'PLAY_CARDS', handIds: all.length ? [pick(all).id] : [], openIds: [] };
      case 6: return { type: 'SWAP_CARDS', handId: p.hand[0] && p.hand[0].id, openId: p.open[0] && p.open[0].id };
      case 7: return { type: 'READY_SWAP' };
      default: return { type: 'PICKUP_PILE' };
    }
  }

  // ---- Uma partida ---------------------------------------------------------------------
  const BASE = { decks: 1, jokers: 1, p2: true, draw2: 1, p7: true, p10: true, after10: 'next', pjoker: true, multijoker: 'once', p48: true, mode48: 'sequence', burn48: false };
  const setUI = (r) => {
    const b = { ...BASE, ...r };
    document.getElementById('sel-decks').value = String(b.decks);
    document.getElementById('sel-jokers').value = String(b.jokers);
    document.getElementById('chk-p2').checked = b.p2;
    document.getElementById('sel-draw2').value = String(b.draw2);
    document.getElementById('chk-p7').checked = b.p7;
    document.getElementById('chk-p10').checked = b.p10;
    document.getElementById('sel-after10').value = b.after10;
    document.getElementById('chk-pjoker').checked = b.pjoker;
    document.getElementById('sel-multijoker').value = b.multijoker;
    document.getElementById('chk-p48').checked = b.p48;
    document.getElementById('sel-48mode').value = b.mode48;
    document.getElementById('chk-48burn').checked = b.burn48;
  };
  const PERSONAS = ['easy', 'medium', 'hard'];

  function randomConfig(k) {
    const r = {
      decks: Math.random() < 0.6 ? 1 : 2,
      jokers: rnd(5),
      p2: Math.random() < 0.85, draw2: Math.random() < 0.5 ? 1 : 3,
      p7: Math.random() < 0.85, p10: Math.random() < 0.85,
      after10: Math.random() < 0.5 ? 'next' : 'again',
      pjoker: Math.random() < 0.85, multijoker: Math.random() < 0.5 ? 'once' : 'per_joker',
      p48: Math.random() < 0.85, mode48: Math.random() < 0.5 ? 'sequence' : 'together', burn48: Math.random() < 0.4
    };
    const n = 2 + rnd(5);
    const mode = k % 10 === 9 ? 'tutorial' : (k % 4 === 3 ? 'sim' : 'normal');
    const humans = mode === 'sim' ? 0 : (mode === 'tutorial' ? 1 : 1 + rnd(Math.min(3, n)));
    return { r, n: mode === 'tutorial' ? 1 : n, mode, humans };
  }

  // golden = true: joga com o log de verdade e sem comparar (gera partidas de referência)
  function play(cfg, maxOps, golden = false) {
    reset();
    setUI(cfg.r);
    lobbySlots = Array.from({ length: cfg.n }, (_, i) => {
      if (i < cfg.humans) return { id: 'h' + i, name: 'Humano ' + i, type: 'human', persona: null };
      const p = PERSONAS[rnd(3)];
      return { id: 'b' + i, name: p + ' ' + i, type: 'bot', persona: p };
    });
    myPlayerId = cfg.humans > 0 ? 'h0' : null;
    startInfo = null;
    goldenRaw = null;
    if (golden) { Object.assign(LoggerModule, realLogger); Storage.prototype.setItem = captureStore; }
    try {
      startNewMatch(false, cfg.mode);
      turboMode = true; // sem animações; o teste não depende do tempo
      return golden ? playLoop(cfg, maxOps, null, { cfg, ops: 0, problems: [], log: [], cover: {} }, true) : compareMatch(cfg, maxOps);
    } finally {
      if (golden) { Object.assign(LoggerModule, stubLogger); Storage.prototype.setItem = noStore; }
    }
  }

  function compareMatch(cfg, maxOps) {
    // Mesma distribuição no motor novo
    const { info, rules } = startInfo;
    const dealt = Core.deal({ rules: { ...rules }, slots: info.lobby, seed: info.seed, mode: info.mode });
    const C = dealt.state;
    const report = { cfg, seed: info.seed, ops: 0, problems: [], log: [], cover: {} };
    const fail = (what, extra) => { report.problems.push({ ação: report.ops, what, ...extra, ultimas: report.log.slice(-6) }); };

    // Distribuição (antes da troca de cartas dos bots) e cartas idênticas
    const coreDealt = C.players.map(p => cardsOf(p));
    if (JSON.stringify(coreDealt) !== JSON.stringify(startInfo.dealt)) fail('distribuição diferente');
    const byId = new Map();
    [...C.deck, ...C.players.flatMap(p => [...p.hand, ...p.open, ...p.closed])].forEach(c => byId.set(c.id, c));
    [...G.deck, ...G.players.flatMap(p => [...p.hand, ...p.open, ...p.closed])].forEach(c => {
      const o = byId.get(c.id);
      if (!o || JSON.stringify(o) !== JSON.stringify(c)) fail('carta diferente: ' + c.id);
    });
    C.players.forEach((p, idx) => { if (p.type === 'bot') AIEngine.performInitialSwap(C, idx); });
    G.players.forEach((p, i) => { C.players[i].avatar = p.avatar; });
    const d0 = diff(snap(G), snap(C));
    if (d0.length) fail('mesa inicial diferente', { d: d0 });
    return playLoop(cfg, maxOps, C, report, false);
  }

  function playLoop(cfg, maxOps, C, report, golden) {
    const fail = (what, extra) => { report.problems.push({ ação: report.ops, what, ...extra, ultimas: report.log.slice(-6) }); };
    const step = (label, oldFn, coreFn) => {
      reset();
      report.ops++;
      report.log.push(label);
      if (report.log.length > 40) report.log.shift();
      const events = [];
      try { oldFn(); } catch (e) { fail('erro no motor atual: ' + e.message); return false; }
      if (golden) return true;
      try { const ev = coreFn(); if (ev) events.push(...ev); } catch (e) { fail('erro no motor novo: ' + e.message); return false; }
      const d = diff(snap(G), snap(C));
      if (d.length) { fail('mesa diferente depois de ' + label, { d }); return false; }
      const exp = expectedFrom(events, C);
      for (const k of Object.keys(cap)) {
        const got = cap[k].map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
        const want = exp[k].map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
        if (k === 'warnings') { if (got.length !== want.length) { fail(`avisos diferentes em ${label}`, { got, want }); return false; } continue; }
        if (JSON.stringify(got) !== JSON.stringify(want)) { fail(`${k} diferente em ${label}`, { got, want }); return false; }
      }
      events.forEach(ev => {
        const t = ev.type === 'turnLog' ? ev.entry.action : (ev.type === 'flight' ? 'fx_' + (ev.fx.sfxTag || ev.fx.kind) : ev.type);
        report.cover[t] = (report.cover[t] || 0) + 1;
      });
      return true;
    };

    const exec = (pid, action, tag) => {
      const label = `${tag}:${pid}:${action.type}`;
      if (action.type === 'SPEED_TAP') {
        return step(label, () => executePlayerAction(pid, action), () => {
          const idx = C.players.findIndex(p => p.id === pid);
          return C.phase === 'SPEED_TIE' ? Core.speedWin(C, idx).events : [];
        });
      }
      return step(label, () => executePlayerAction(pid, action), () => Core.apply(C, pid, action).events);
    };

    while (report.ops < maxOps && G.phase !== 'GAMEOVER' && !report.problems.length) {
      let ok = true;
      if (G.phase === 'SWAP') {
        const pending = G.players.filter(p => !p.readySwap);
        if (!pending.length) {
          ok = step('início', () => evaluateStartAndDirection(), () => Core.startIfReady(C));
        } else {
          const p = pick(pending);
          const x = Math.random();
          if (x < 0.55) {
            const other = pick(G.players);
            const h = Math.random() < 0.9 ? pick(p.hand) : pick(other.hand);
            const o = Math.random() < 0.9 ? pick(p.open) : pick(other.open);
            ok = exec(p.id, { type: 'SWAP_CARDS', handId: h && h.id, openId: o && o.id }, 'troca');
          } else if (x < 0.88) {
            ok = exec(p.id, { type: 'READY_SWAP' }, 'pronto');
          } else if (x < 0.95) {
            // Um bot assume o lugar (queda/remoção), como em kickPlayer / guest_left
            ok = step(`assume:${p.id}`, () => {
              markReadyByTakeover(p);
              if (G.phase === 'SWAP' && G.players.every(pl => pl.readySwap)) evaluateStartAndDirection();
            }, () => {
              const ev = Core.apply(C, p.id, { type: 'READY_AUTO' }).events;
              return ev.concat(Core.startIfReady(C));
            });
          } else {
            ok = exec(p.id, junkMove(G, G.players.indexOf(p)), 'errada');
          }
        }
      } else if (G.phase === 'SPEED_TIE') {
        const cands = G.tieContext.candidates;
        const winner = pick(cands);
        const x = Math.random();
        if (x < 0.4) {
          ok = step(`duelo:${winner}`, () => handleSpeedTieWin(winner), () => Core.speedWin(C, winner).events);
        } else if (x < 0.8) {
          ok = exec(G.players[winner].id, { type: 'SPEED_TAP' }, 'toque');
        } else {
          const outsiders = G.players.filter((p, i) => !cands.includes(i));
          ok = exec((outsiders.length ? pick(outsiders) : G.players[winner]).id, { type: 'SPEED_TAP' }, 'toque');
        }
      } else if (G.phase === 'PLAY') {
        const idx = G.turnIdx;
        const cur = G.players[idx];
        const x = Math.random();
        if (x < 0.62) {
          const decision = AIEngine.decideTurnAction(G, idx);
          if (decision) ok = exec(cur.id, decision, 'ia');
        } else if (x < 0.9) {
          ok = exec(cur.id, randomMove(G, idx), 'sorteada');
        } else if (x < 0.96) {
          ok = exec(cur.id, junkMove(G, idx), 'errada');
        } else {
          const others = G.players.filter((p, i) => i !== idx);
          const o = pick(others);
          ok = exec(o.id, randomMove(G, G.players.indexOf(o)), 'fora_da_vez');
        }
      } else break;
      if (!ok) break;
    }
    report.phase = G.phase;
    report.ok = report.problems.length === 0;
    G.phase = 'ABANDONED';
    return report;
  }

  const yieldMacro = () => new Promise(r => { const mc = new MessageChannel(); mc.port1.onmessage = () => r(); mc.port2.postMessage(0); });
  const api = { last: null, progress: '' };

  /* ---- Partidas de referência ------------------------------------------------------
     Antes de trocar o motor: CoreDiff.golden({ matches }) joga partidas com o log de
     verdade e guarda os logs num banco só de teste (IndexedDB "shithead-test-golden").
     Depois da troca, numa aba nova: Replay.all({ matches: await CoreDiff.loadGolden() }). */
  const DB = 'shithead-test-golden';
  const idb = (mode, fn) => new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('logs');
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => {
      const tx = rq.result.transaction('logs', mode);
      const r = fn(tx.objectStore('logs'));
      tx.oncomplete = () => { rq.result.close(); res(r && r.result); };
      tx.onerror = () => rej(tx.error);
    };
  });
  api.saveGolden = (list) => idb('readwrite', s => s.put(list, 'matches'));
  api.loadGolden = () => idb('readonly', s => s.get('matches'));
  api.dropGolden = () => new Promise(res => { const rq = indexedDB.deleteDatabase(DB); rq.onsuccess = rq.onerror = () => res(true); });
  api.golden = async ({ matches = 30, maxOps = 2500 } = {}) => {
    const list = [];
    for (let k = 0; k < matches; k++) {
      const rep = play(randomConfig(k), maxOps, true);
      const sess = goldenRaw ? JSON.parse(goldenRaw) : null;
      const m = sess && sess.matches && sess.matches[sess.matches.length - 1];
      if (m) list.push(m);
      api.progress = `referência: ${k + 1}/${matches} (${rep.ops} ações na última)`;
      await yieldMacro();
    }
    await api.saveGolden(list);
    return { guardadas: list.length, terminadas: list.filter(m => m.replay && m.replay.final).length, acoes: list.reduce((a, m) => a + m.replay.actions.length, 0) };
  };

  // Para rodadas longas: CoreDiff.start({...}) volta na hora; acompanhe com CoreDiff.progress
  api.start = (opts) => { api.run(opts); return 'rodando'; };
  api.run = async ({ matches = 40, maxOps = 2500, configs = null } = {}) => {
    const reports = [];
    for (let k = 0; k < matches; k++) {
      const cfg = configs ? configs[k % configs.length] : randomConfig(k);
      reports.push(play(cfg, maxOps));
      const bad = reports.filter(r => !r.ok).length;
      api.progress = `${k + 1}/${matches} partidas, ${reports.reduce((a, r) => a + r.ops, 0)} ações, ${bad} falhas`;
      await yieldMacro();
    }
    const cover = {};
    reports.forEach(r => Object.entries(r.cover || {}).forEach(([k, v]) => { cover[k] = (cover[k] || 0) + v; }));
    const bad = reports.filter(r => !r.ok);
    api.last = {
      partidas: reports.length,
      acoes: reports.reduce((a, r) => a + r.ops, 0),
      terminadas: reports.filter(r => r.phase === 'GAMEOVER').length,
      falhas: bad.length,
      primeiraFalha: bad[0] ? { cfg: bad[0].cfg, seed: bad[0].seed, problems: bad[0].problems } : null,
      cobertura: cover,
      reports
    };
    return { partidas: api.last.partidas, acoes: api.last.acoes, falhas: api.last.falhas, primeiraFalha: api.last.primeiraFalha };
  };
  return api;
})();
