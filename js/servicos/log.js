// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

import { AppConfig } from '../config.js';
import { LogDB } from './armazenamento.js';
import { NetLog } from './netlog.js';

/* ==========================================================================
   3. MÓDULO DE LOG DE SESSÃO PARA AJUSTE DE IA (LoggerModule)
   ========================================================================== */
const LoggerModule = (() => {
  // Gravação: IndexedDB (LogDB) com uma chave para o cabeçalho da sessão e uma por
  // partida — a cada jogada só a partida atual é regravada, em segundo plano.
  // Leitura: a sessão fica na memória (sessionData); "Copiar" e "Baixar" leem dela na
  // hora (o Safari só copia se for no próprio toque, sem espera).
  // Reserva: sem IndexedDB, grava a sessão inteira no localStorage, como antes.
  const STORAGE_KEY = 'sh_last_session_log'; // localStorage (reserva e formato antigo)
  const PENDING_KEY = 'sh_log_pending';      // partida em andamento, salva às pressas ao fechar a página
  const HEADER_KEY = 'log:session';
  const MAX_MATCHES = 30;                    // partidas mantidas por sessão (as mais antigas saem)
  const matchKey = (m) => 'log:m' + m.matchNumber;
  let sessionData = null;
  let useIdb = true;
  let storedMatchKeys = [];  // partidas que estão no IndexedDB (para apagar as que saíram)
  let dirtyHeader = false;
  const dirtyMatches = new Set();
  let flushing = false;

  // Regras em texto legível (para quem lê o log sem conhecer os nomes internos)
  function describeRules(r) {
    if (!r) return [];
    return [
      `${r.decks} baralho(s), ${r.pjoker ? r.jokers : 0} coringa(s)`,
      r.p2 ? `2: joga sobre tudo e joga de novo; se zerar a mão compra ${r.draw2}` : '2: sem poder',
      r.p7 ? '7: próximo joga ≤ 7' : '7: sem poder',
      r.p10 ? `10: queima o monte e ${r.after10 === 'again' ? 'joga de novo' : 'passa a vez'}` : '10: sem poder',
      r.pjoker ? `Coringa: gira as mãos ${r.multijoker === 'per_joker' ? '1 vez por coringa' : '1 vez'}` : 'Coringa: fora do baralho',
      r.p48 ? `${r.decks === 1 ? 4 : 8} iguais (${r.mode48 === 'together' ? 'juntas' : 'em sequência'}): invertem${r.burn48 ? ' e queimam o monte' : ''}` : 'Iguais: sem poder',
      `Monte grande a partir de ${r.bigPile || (r.decks === 2 ? 20 : 12)} cartas`,
      r.timer ? `Cronômetro: ${r.timer} s por jogada e na troca; ao acabar, ${{ pickup: 'a pessoa recolhe o monte', warn: 'só um aviso' }[r.timeout] || 'o bot joga pela pessoa'}` : 'Sem cronômetro'
    ];
  }

  function buildInfo() {
    return { appVersion: AppConfig.VERSION, build: AppConfig.BUILD };
  }

  function initNewSession(rules, players) {
    sessionData = {
      ...buildInfo(),
      sessionId: 'sess_' + Date.now(),
      createdAt: new Date().toISOString(),
      rulesSnapshot: { ...rules },
      participants: players.map(p => ({ id: p.id, name: p.name, type: p.type, persona: p.persona })),
      matches: []
    };
    saveToStorage(true);
  }

  // replayInfo: { seed, mode, lobby } — o necessário para reproduzir a partida.
  // A semente fica só neste log (no aparelho do host); nunca vai para a rede.
  function startMatchLog(rules, players, replayInfo = null) {
    if (!sessionData) {
      initNewSession(rules, players);
    }
    const matchEntry = {
      matchNumber: sessionData.matches.length + 1,
      startedAt: new Date().toISOString(),
      // Identificação completa de cada partida: as regras podem mudar entre partidas da mesma sessão
      ...buildInfo(),
      rules: { ...rules },
      rulesText: describeRules(rules),
      playerCount: players.length,
      humans: players.filter(p => p.type === 'human').length,
      initialHands: players.map(p => ({
        name: p.name,
        persona: p.persona || 'human',
        hand: p.hand.map(c => c.label + c.suit),
        open: p.open.map(c => c.label + c.suit),
        closed: p.closed.map(c => c.label + c.suit)
      })),
      swaps: [],
      turns: [],
      loser: null
    };
    // Formato 2 (replay): semente + ordem do lobby + ações aplicadas pelo host, em ordem.
    // Ações: [ms desde o início, id do jogador, tipo, dados]. Checks: [nº de ações, impressão digital].
    if (replayInfo && replayInfo.seed) {
      matchEntry.replay = {
        format: 2,
        seed: replayInfo.seed,
        mode: replayInfo.mode || 'normal',
        lobby: (replayInfo.lobby || []).map(s => ({ id: s.id, name: s.name, type: s.type, persona: s.persona || null })),
        actions: [],
        checks: [],
        final: null
      };
    }
    sessionData.matches.push(matchEntry);
    // Sessão muito longa: as partidas mais antigas saem do log
    while (sessionData.matches.length > MAX_MATCHES) {
      sessionData.matches.shift();
      sessionData.trimmedOldMatches = (sessionData.trimmedOldMatches || 0) + 1;
    }
    saveToStorage(true);
  }

  function logAction(entry) {
    const m = currentMatch();
    if (!m || !m.replay) return;
    m.replay.actions.push(entry);
    saveToStorage();
  }

  function logCheck(count, digest) {
    const m = currentMatch();
    if (!m || !m.replay) return;
    m.replay.checks.push([count, digest]);
  }

  function currentMatch() {
    if (!sessionData || sessionData.matches.length === 0) return null;
    return sessionData.matches[sessionData.matches.length - 1];
  }

  function logSwap(player, openCardsAfter, handCardsAfter) {
    const m = currentMatch();
    if (!m) return;
    m.swaps.push({
      player: player.name,
      persona: player.persona || 'human',
      openAfter: openCardsAfter.map(c => c.label + c.suit),
      handAfter: handCardsAfter.map(c => c.label + c.suit)
    });
    saveToStorage();
  }

  function logTurn(entry) {
    const m = currentMatch();
    if (!m) return;
    m.turns.push({
      turnSeq: m.turns.length + 1,
      at: new Date().toISOString(),
      ...entry
    });
    saveToStorage();
  }

  function setMatchMode(mode, extra = {}) {
    const m = currentMatch();
    if (m) { Object.assign(m, { mode }, extra); saveToStorage(); }
  }

  function logMatchEnd(loserName, final = null) {
    const m = currentMatch();
    if (!m) return;
    m.loser = loserName;
    m.endedAt = new Date().toISOString();
    if (m.replay && final) m.replay.final = final;
    saveToStorage();
  }

  // Marca o que mudou e grava no fim da tarefa atual (várias anotações da mesma jogada
  // viram uma gravação só). header = a lista de partidas ou o cabeçalho mudou.
  function saveToStorage(header = false) {
    if (!sessionData) return;
    if (!useIdb) { saveLocal(); return; }
    if (header) dirtyHeader = true;
    const m = currentMatch();
    if (m) dirtyMatches.add(m.matchNumber);
    if (!flushing) {
      flushing = true;
      Promise.resolve().then(flush);
    }
  }

  function flush() {
    if (!sessionData || (!dirtyHeader && dirtyMatches.size === 0)) { flushing = false; return; }
    const { matches, ...head } = sessionData;
    const keep = matches.map(matchKey);
    const puts = [];
    if (dirtyHeader) puts.push([HEADER_KEY, { ...head, matchKeys: keep }]);
    dirtyMatches.forEach(n => {
      const m = matches.find(x => x.matchNumber === n);
      if (m) puts.push([matchKey(m), m]);
    });
    const dels = dirtyHeader ? storedMatchKeys.filter(k => !keep.includes(k)) : [];
    dirtyHeader = false;
    dirtyMatches.clear();
    // O IndexedDB copia os valores no put: mudanças depois disso entram na próxima gravação
    LogDB.write(puts, dels).then(() => {
      storedMatchKeys = storedMatchKeys.filter(k => !dels.includes(k));
      puts.forEach(([k]) => { if (k !== HEADER_KEY && !storedMatchKeys.includes(k)) storedMatchKeys.push(k); });
      flushing = false;
      if (dirtyHeader || dirtyMatches.size) saveToStorage();
    }, (err) => {
      // IndexedDB recusou (modo privado, cota): passa a usar o localStorage
      useIdb = false;
      flushing = false;
      try { NetLog.log('log_storage_fallback', { err: String(err && (err.name || err.message)) }); } catch (e) {}
      saveLocal();
    });
  }

  // Reserva (sem IndexedDB): sessão inteira no localStorage. Se lotar, descarta as
  // partidas mais antigas da sessão (mantendo a atual) para nunca bloquear o resto
  // do jogo (avatar, nome, placar, regras).
  function saveLocal() {
    if (!sessionData) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionData));
        return;
      } catch (e) {
        if (sessionData.matches.length > 1) {
          sessionData.matches.shift();
          sessionData.trimmedOldMatches = (sessionData.trimmedOldMatches || 0) + 1;
        } else {
          const m = sessionData.matches[0];
          if (m && m.turns.length > 50) {
            m.turns.splice(0, Math.floor(m.turns.length / 2));
            m.turnsTrimmed = true;
          } else {
            return;
          }
        }
      }
    }
  }

  function readLocalJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  const progressOf = (m) => (m ? (m.turns ? m.turns.length : 0) + (m.replay ? m.replay.actions.length : 0) + (m.endedAt ? 1 : 0) : -1);

  // Página fechando com gravação pendente: guarda a partida atual no localStorage
  // (síncrono). Na próxima abertura ela substitui a do IndexedDB se estiver mais completa.
  function stashPending() {
    if (!useIdb || !sessionData || (!flushing && !dirtyHeader && dirtyMatches.size === 0)) return;
    const m = currentMatch();
    if (!m) return;
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ sessionId: sessionData.sessionId, match: m })); } catch (e) {}
  }
  window.addEventListener('pagehide', stashPending);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stashPending(); });

  // Abertura: lê o log do IndexedDB (ou migra o do localStorage, uma vez só)
  const ready = (async () => {
    let loaded = null;
    let fromLegacy = false;
    try {
      const [head] = await LogDB.getMany([HEADER_KEY]);
      if (head && Array.isArray(head.matchKeys)) {
        const ms = await LogDB.getMany(head.matchKeys);
        const { matchKeys, ...h } = head;
        loaded = { ...h, matches: ms.filter(Boolean) };
        storedMatchKeys = matchKeys.slice();
      }
      const legacy = readLocalJson(STORAGE_KEY);
      if (legacy && Array.isArray(legacy.matches) && (!loaded || String(legacy.createdAt) > String(loaded.createdAt))) {
        loaded = legacy;
        fromLegacy = true;
      }
    } catch (e) {
      useIdb = false;
      loaded = readLocalJson(STORAGE_KEY);
    }
    const pend = readLocalJson(PENDING_KEY);
    let fromPending = false;
    if (pend && pend.match && loaded && Array.isArray(loaded.matches) && pend.sessionId === loaded.sessionId) {
      const i = loaded.matches.findIndex(m => m.matchNumber === pend.match.matchNumber);
      if (i !== -1 && progressOf(pend.match) > progressOf(loaded.matches[i])) {
        loaded.matches[i] = pend.match;
        fromPending = true;
      }
    }
    // Se uma partida já começou enquanto o log carregava, ela prevalece
    let wroteOk = true;
    if (!sessionData && loaded && Array.isArray(loaded.matches)) {
      sessionData = loaded;
      if (useIdb && (fromLegacy || fromPending)) {
        const { matches, ...head } = sessionData;
        const keep = matches.map(matchKey);
        try {
          await LogDB.write([[HEADER_KEY, { ...head, matchKeys: keep }], ...matches.map(m => [matchKey(m), m])],
            storedMatchKeys.filter(k => !keep.includes(k)));
          storedMatchKeys = keep;
        } catch (e) {
          wroteOk = false;
        }
      }
    }
    if (useIdb && wroteOk) {
      // Já está no IndexedDB: o localStorage fica livre para o resto do jogo
      try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(PENDING_KEY); } catch (e) {}
    }
    return { idb: useIdb, matches: sessionData ? sessionData.matches.length : 0, migrated: fromLegacy, pending: fromPending };
  })();

  // Qual partida do log está em andamento (a retomada do host confere antes de continuar nela)
  function currentMatchRef() {
    const m = currentMatch();
    return m && sessionData
      ? { sessionId: sessionData.sessionId, matchNumber: m.matchNumber, actions: m.replay ? m.replay.actions.length : 0 }
      : null;
  }

  // Host recarregou a página no meio da partida: volta a gravar na mesma partida do log
  // (chame depois de LoggerModule.ready)
  function resumeSession(ref) {
    const m = currentMatch();
    if (!m || !ref || sessionData.sessionId !== ref.sessionId || m.matchNumber !== ref.matchNumber) return false;
    (m.resumes || (m.resumes = [])).push(new Date().toISOString());
    // A página caiu entre gravar a mesa e gravar o log: o replay não consegue seguir dali
    if (m.replay && Number.isFinite(ref.actions) && m.replay.actions.length !== ref.actions) {
      m.replay.gap = { logActions: m.replay.actions.length, hostActions: ref.actions };
    }
    saveToStorage();
    return true;
  }

  // Sessão atual (na memória; depois de LoggerModule.ready inclui a gravada)
  function getSavedSession() {
    return sessionData;
  }

  // Log completo para exportar: partidas (só no host) + rede (host e convidados)
  function getExport() {
    const games = getSavedSession();
    const net = NetLog.get();
    if (!games && net.events.length === 0) return null;
    return {
      appVersion: AppConfig.VERSION,
      build: AppConfig.BUILD,
      exportedAt: new Date().toISOString(),
      exportedFrom: NetLog.environment(),
      ...(games || {}),
      // a versão de quem exporta prevalece (o log de partidas pode ser de um build anterior)
      currentBuild: AppConfig.BUILD,
      network: net
    };
  }

  function downloadLastSession() {
    const data = getExport();
    if (!data) return false;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${AppConfig.VERSION}-session-log.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  }

  return {
    initNewSession,
    startMatchLog,
    logSwap,
    logTurn,
    logAction,
    logCheck,
    logMatchEnd,
    setMatchMode,
    describeRules,
    currentMatchRef,
    resumeSession,
    ready,
    getSavedSession,
    getExport,
    downloadLastSession
  };
})();

export { LoggerModule };
