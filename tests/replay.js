// Replay de partidas a partir do log (formato 2: semente + ações).
// Abra uma aba do jogo (ex.: http://localhost:8765/), carregue este arquivo e rode:
//
//   await Replay.fromSaved()          -> reproduz a última partida do log deste navegador
//   await Replay.run(logExportado, i) -> reproduz a partida i (padrão: a última) de um log
//                                       exportado (o JSON do botão "Baixar Log")
//   await Replay.all(logExportado)    -> reproduz todas as partidas do log
//
// Durante o replay, tela, som, rede, bots automáticos e gravação no log/placar ficam
// desligados. Depois de usar, recarregue a aba para voltar ao jogo normal.
window.Replay = (() => {
  const label = (c) => (c ? (c.isJoker ? 'JOKER★' : c.label + c.suit) : '?');

  function stubAll() {
    const saved = {};
    const set = (obj, key, fn, name) => { saved[name] = [obj, key, obj[key]]; obj[key] = fn; };
    Object.keys(SoundEngine).forEach(k => { if (typeof SoundEngine[k] === 'function') set(SoundEngine, k, () => {}, 'snd_' + k); });
    ['renderGame', 'triggerFlightVisual', 'showReaction', 'broadcastState', 'maybeBotReact', 'scheduleBotIfNeeded',
      'showInvalidWarning', 'recordMatchResult', 'renderScoreboard', 'keepScreenAwake'].forEach(n => set(window, n, () => {}, n));
    set(window, 'setTimeout', () => 0, 'setTimeout'); // bots do duelo e início automático: o replay comanda
    const turns = [];
    const checks = [];
    const dealt = [];
    set(LoggerModule, 'initNewSession', () => {}, 'log_init');
    // Guarda a distribuição como o log grava: antes da troca de cartas dos bots
    set(LoggerModule, 'startMatchLog', (rules, players) => {
      players.forEach(p => dealt.push({ hand: p.hand.map(label), open: p.open.map(label), closed: p.closed.map(label) }));
    }, 'log_start');
    set(LoggerModule, 'setMatchMode', () => {}, 'log_mode');
    set(LoggerModule, 'logSwap', () => {}, 'log_swap');
    set(LoggerModule, 'logAction', () => {}, 'log_action');
    set(LoggerModule, 'logMatchEnd', () => {}, 'log_end');
    set(LoggerModule, 'logTurn', (e) => turns.push(e), 'log_turn');
    set(LoggerModule, 'logCheck', (n, d) => checks.push([n, d]), 'log_check');
    return {
      turns, checks, dealt,
      restore() { Object.values(saved).forEach(([obj, key, orig]) => { obj[key] = orig; }); }
    };
  }

  function getMatches(data) {
    if (!data) return [];
    if (Array.isArray(data.matches)) return data.matches;
    return [];
  }

  function toAction(type, d) {
    d = d || {};
    switch (type) {
      case 'PLAY_CARDS': return { type, handIds: d.h || [], openIds: d.o || [] };
      case 'SWAP_CARDS': return { type, handId: d.h, openId: d.o };
      case 'PLAY_BLIND': return { type, cardId: d.c };
      default: return { type };
    }
  }

  function replayMatch(m) {
    const r = m.replay;
    const report = { match: m.matchNumber, mode: r && r.mode, ok: false, problems: [] };
    if (!r || r.format !== 2 || !Rng.isSeed(r.seed)) {
      report.problems.push('partida sem dados de replay (log de uma versão anterior)');
      return report;
    }
    const st = stubAll();
    try {
      startNewMatch(false, r.mode, { seed: r.seed, rules: m.rules, slots: r.lobby });

      // 1. Distribuição inicial igual à do log legível (antes das trocas)
      if (Array.isArray(m.initialHands)) {
        m.initialHands.forEach((h, i) => {
          const got = st.dealt[i];
          const same = got && ['hand', 'open', 'closed'].every(z => JSON.stringify(got[z]) === JSON.stringify(h[z]));
          if (!same) report.problems.push(`distribuição inicial diferente para ${h.name}`);
        });
      }
      if (G.players.every(p => p.readySwap) && G.phase === 'SWAP') evaluateStartAndDirection();

      // 2. Aplica as ações na ordem
      let applied = 0;
      for (const [, pid, type, data] of r.actions) {
        if (type === 'SPEED_WIN') handleSpeedTieWin(data.i);
        else if (type === 'READY_AUTO') {
          const p = G.players.find(pl => pl.id === pid);
          if (p) { markReadyByTakeover(p); if (G.phase === 'SWAP' && G.players.every(pl => pl.readySwap)) evaluateStartAndDirection(); }
        } else executePlayerAction(pid, toAction(type, data));
        applied++;
      }
      report.actions = applied;

      // 3. Impressões digitais a cada 20 ações
      const want = new Map((r.checks || []).map(([n, d]) => [n, d]));
      let checked = 0;
      st.checks.forEach(([n, d]) => {
        if (!want.has(n)) return;
        checked++;
        if (want.get(n) !== d) report.problems.push(`mesa diferente depois da ação ${n}`);
      });
      report.checkpoints = `${checked}/${want.size}`;

      // 4. Final
      if (r.final) {
        const f = r.final;
        if (G.phase !== 'GAMEOVER') report.problems.push(`partida não terminou no replay (fase ${G.phase})`);
        if (G.loserId !== f.loserId) report.problems.push(`perdedor diferente (${G.loserName})`);
        if ((G.turnCounter || 0) !== f.turnCounter) report.problems.push(`número de turnos diferente (${G.turnCounter} × ${f.turnCounter})`);
        if (stateDigest(G) !== f.digest) report.problems.push('mesa final diferente');
      } else {
        report.problems.push('o log não tem o final da partida (interrompida ou exportada no meio)');
      }

      // 5. Jogada a jogada contra o log legível (formato 1)
      if (Array.isArray(m.turns) && !m.turnsTrimmed) {
        const n = Math.min(m.turns.length, st.turns.length);
        let firstDiff = -1;
        for (let i = 0; i < n; i++) {
          const a = m.turns[i], b = st.turns[i];
          const sa = `${a.player}|${a.action}|${(a.cardsPlayed || []).join(' ')}|${a.cardFlipped || ''}`;
          const sb = `${b.player}|${b.action}|${(b.cardsPlayed || []).join(' ')}|${b.cardFlipped || ''}`;
          if (sa !== sb) { firstDiff = i; break; }
        }
        if (firstDiff >= 0) report.problems.push(`jogada ${firstDiff + 1} diferente do log legível`);
        if (m.turns.length !== st.turns.length) report.problems.push(`quantidade de jogadas: log ${m.turns.length}, replay ${st.turns.length}`);
        report.turns = `${st.turns.length} jogadas comparadas`;
      }
      report.loser = G.loserName;
      report.ok = report.problems.length === 0;
    } catch (e) {
      report.problems.push('erro no replay: ' + (e && e.message));
    } finally {
      st.restore();
    }
    return report;
  }

  async function run(data, index = -1) {
    const matches = getMatches(data);
    if (!matches.length) return { ok: false, problems: ['nenhuma partida no log'] };
    const m = matches[index < 0 ? matches.length + index : index];
    return replayMatch(m);
  }

  async function all(data) {
    return getMatches(data).map(replayMatch);
  }

  async function fromSaved(index = -1) {
    return run(LoggerModule.getSavedSession(), index);
  }

  return { run, all, fromSaved };
})();
