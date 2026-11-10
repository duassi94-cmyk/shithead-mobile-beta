// Harness de simulação do Shithead — cole no console de uma aba do jogo (não a que você usa para jogar).
// Roda partidas só entre bots, sem som, sem desenhar e sem gravar log/placar.
// A partida roda por microtarefas (não é freada em aba de fundo).
// Uso:
//   SimHarness.start(matrix, reps)   -> começa em segundo plano
//   SimHarness.status()              -> progresso
//   SimHarness.out / SimHarness.viol -> resultados / violações (cartas perdidas ou duplicadas)
window.SimHarness = (() => {
  Object.keys(SoundEngine).forEach(k => { if (typeof SoundEngine[k] === 'function') SoundEngine[k] = () => {}; });
  ['initNewSession', 'startMatchLog', 'logSwap', 'logTurn', 'logMatchEnd', 'setMatchMode'].forEach(k => { LoggerModule[k] = () => {}; });
  window.renderGame = () => {};
  window.triggerFlightVisual = () => {};
  window.showReaction = () => {};
  let maxTurns = 3000;
  window.setTimeout = (fn, ms, ...a) => {
    if (G && (G.turns || 0) > maxTurns) return 0;
    queueMicrotask(() => fn(...a));
    return 0;
  };
  const yieldMacro = () => new Promise(r => { const mc = new MessageChannel(); mc.port1.onmessage = () => r(); mc.port2.postMessage(0); });
  const out = [];
  const viol = [];
  let cur = '';
  let done = false;
  const countAll = () => G.deck.length + G.discard.length + (G.burnedCount || 0) +
    G.players.reduce((s, p) => s + p.hand.length + p.open.length + p.closed.length, 0);
  const origAdvance = window.advanceTurn;
  window.advanceTurn = (...a) => {
    const ids = [...G.deck, ...G.discard, ...G.players.flatMap(p => [...p.hand, ...p.open, ...p.closed])].map(c => c.id);
    const dup = ids.length - new Set(ids).size;
    const total = countAll();
    if (total !== G.__initialTotal || dup) viol.push({ cfg: cur, total, expected: G.__initialTotal, dup });
    G.turns = (G.turns || 0) + 1;
    return origAdvance(...a);
  };
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

  async function runOne(cfg, rep) {
    cur = cfg.name;
    setUI(cfg.r);
    lobbySlots = Array.from({ length: cfg.n }, (_, i) => {
      const p = PERSONAS[(i + rep) % 3];
      return { id: 'b' + i, name: p + i, type: 'bot', persona: p };
    });
    const t0 = performance.now();
    startNewMatch(false, 'sim');
    G.__initialTotal = countAll();
    turboMode = true;
    // Na aceleração cada vez de bot roda numa tarefa separada (MessageChannel): o limite
    // precisa ser de turnos, não de esperas (com 400 esperas, partidas longas paravam no meio)
    let guard = 0;
    while (G.phase !== 'GAMEOVER' && (G.turns || 0) <= maxTurns && guard++ < maxTurns * 3) await yieldMacro();
    const stuck = G.phase !== 'GAMEOVER';
    const res = {
      ...cfg.tags, cfg: cfg.name, n: cfg.n, rep, turns: G.turns || 0, ms: Math.round(performance.now() - t0), stuck,
      loser: (G.players.find(p => p.name === G.loserName) || {}).persona,
      maxStall: G.stall ? G.stall.maxStreak : 0, jokers: G.rules.jokers, decks: G.rules.decks
    };
    G.phase = 'ABANDONED';
    await yieldMacro();
    return res;
  }

  function start(matrix, reps = 3, turnsLimit = 3000) {
    maxTurns = turnsLimit;
    done = false;
    (async () => {
      for (const cfg of matrix) {
        for (let rep = 0; rep < reps; rep++) {
          if (cfg.before) cfg.before();
          out.push(await runOne(cfg, rep));
        }
      }
      done = true;
    })();
  }

  const status = () => `n=${out.length} done=${done} stuck=${out.filter(x => x.stuck).length} viol=${viol.length} last=${cur}`;
  return { start, status, out, viol, BASE };
})();
