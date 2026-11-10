'use strict';
    /* ==========================================================================
       7. CONTROLADOR DE ESTADO E INTERFACE (GameApp)
       ========================================================================== */
    let myPeer = null;
    let isHost = true;
    let hostConn = null;
    let clientConns = [];
    let myPlayerId = 'local_host';
    let roomCode = '';
    let myCustomAvatar = Store.get('sh_player_avatar') || null;

    let lobbySlots = [
      { id: 'local_host', name: 'Você', type: 'human', persona: null, avatar: myCustomAvatar || AvatarModule.getDefaultAvatar('human', null) },
      { id: 'bot_1', name: AppConfig.AI_PERSONAS.easy.name, type: 'bot', persona: 'easy', avatar: AvatarModule.getDefaultAvatar('bot', 'easy') },
      { id: 'bot_2', name: AppConfig.AI_PERSONAS.medium.name, type: 'bot', persona: 'medium', avatar: AvatarModule.getDefaultAvatar('bot', 'medium') },
      { id: 'bot_3', name: AppConfig.AI_PERSONAS.hard.name, type: 'bot', persona: 'hard', avatar: AvatarModule.getDefaultAvatar('bot', 'hard') }
    ];

    let G = null;
    let selectedHandIds = new Set();
    let selectedOpenIds = new Set();
    let swapHandId = null;
    let aiTimeout = null;
    let speedLock = false;
    let toastTimer = null;

    /* A limpeza de tudo que vem da rede (sanitize*, esc) e o código da sala moram em
       js/rede/sanitizar.js; chegam aqui pela ponte (js/ponte.js). */

    // Monte grande da mesa atual (regra da partida ou o padrão do nº de baralhos)
    function bigPileThreshold() {
      return (G && G.rules && G.rules.bigPile) || defaultBigPile(G && G.rules ? G.rules.decks : 1);
    }

    // Vibra só depois de o jogador já ter tocado na página (antes disso o navegador bloqueia e reclama no console)
    function safeVibrate(pattern) {
      if (!navigator.vibrate) return;
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      try { navigator.vibrate(pattern); } catch (e) {}
    }

    function showInvalidWarning(msg, elementToShake = null) {
      SoundEngine.invalidError();
      const toast = document.getElementById('toast-warning');
      toast.textContent = msg;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);

      const target = elementToShake || document.getElementById('discard-pile-visual');
      if (target) {
        target.classList.remove('shake-error');
        void target.offsetWidth;
        target.classList.add('shake-error');
        setTimeout(() => target.classList.remove('shake-error'), 400);
      }
    }

    // Carta simplificada: valor grande no canto (o que aparece com as cartas sobrepostas),
    // naipe grande no centro e um selo pequeno nas cartas especiais (2, 7, 10, Coringa)
    function powerIcon(card) {
      const r = (G && G.rules) || {};
      if (card.isJoker) return r.pjoker === false ? '' : '🔄';
      if (card.val === 15 && r.p2 !== false) return '↺';
      if (card.val === 10 && r.p10 !== false) return '🔥';
      if (card.val === 7 && r.p7 !== false) return '↓';
      return '';
    }

    function createCardDOM(card, isFaceDown = false) {
      const el = document.createElement('div');
      if (isFaceDown || !card || card.hidden) {
        el.className = 'playing-card card-back';
        return el;
      }
      const isFace = !card.isJoker && card.val >= 11 && card.val <= 13;
      el.className = 'playing-card' + (card.isRed ? ' red' : '') + (card.isJoker ? ' joker-card' : '') + (isFace ? ' face-card' : '');
      const icon = powerIcon(card);
      const badge = icon ? `<div class="card-power">${icon}</div>` : '';
      if (card.isJoker) {
        el.innerHTML = `
          <div class="card-corner"><span class="rank">★</span></div>
          <div class="card-center">🃏</div>${badge}`;
        return el;
      }
      const center = isFace ? `<b>${card.label}</b>` : card.suit;
      el.innerHTML = `
        <div class="card-corner"><span class="rank">${card.label}</span><span class="suit">${card.suit}</span></div>
        <div class="card-center">${center}</div>${badge}`;
      return el;
    }

    // Número pseudo-aleatório estável por carta (o monte fica "bagunçado" sem tremer a cada render)
    function cardJitter(card, salt = 0) {
      const s = String(card && card.id || '') + salt;
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return ((h >>> 0) % 1000) / 1000; // 0..1
    }

    function animateCardFlight(fromRect, toRect, card, isFaceDown = false, duration = 340) {
      if (!fromRect || !toRect) return;
      const fxLayer = document.getElementById('fx-layer');
      const flyingCard = createCardDOM(card, isFaceDown);
      flyingCard.classList.add('flying-card');
      flyingCard.style.position = 'fixed';
      flyingCard.style.left = `${fromRect.left}px`;
      flyingCard.style.top = `${fromRect.top}px`;
      flyingCard.style.margin = '0';
      flyingCard.style.zIndex = '999';
      fxLayer.appendChild(flyingCard);

      const dx = toRect.left - fromRect.left;
      const dy = toRect.top - fromRect.top;
      const spin = (Math.random() * 24 - 12).toFixed(1);

      // Remoção garantida mesmo se a animação não rodar (aba em segundo plano etc.)
      const killer = setTimeout(() => flyingCard.remove(), duration + 250);
      try {
        const anim = flyingCard.animate([
          { transform: 'translate(0px, 0px) scale(1) rotate(0deg)', opacity: 1 },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 22}px) scale(1.1) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.5 },
          { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(${spin}deg)`, opacity: 0.95 }
        ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
        anim.onfinish = () => { clearTimeout(killer); flyingCard.remove(); };
      } catch (e) {
        flyingCard.remove();
      }
    }

    function getSeatRect(playerId) {
      if (playerId === myPlayerId) {
        // Mão aberta: a própria mão; recolhida: o leque no canto
        const open = document.getElementById('player-zone')?.classList.contains('hand-open');
        const el = document.getElementById(open ? 'my-hand-cards' : 'hand-dock');
        return el ? el.getBoundingClientRect() : null;
      }
      const seat = document.querySelector(`.seat[data-seat-id="${CSS.escape(playerId || '')}"] .seat-avatar`);
      if (seat) return seat.getBoundingClientRect();
      const area = document.getElementById('opponents-area');
      return area ? area.getBoundingClientRect() : null;
    }

    function triggerFlightVisual(fx) {
      if (!fx) return;
      if (turboMode || (G && G.turbo)) return; // acelerado: sem animações nem sons por jogada
      if (fx.sfxTag) SoundEngine.playByTag(fx.sfxTag);

      const discardEl = document.getElementById('discard-pile-visual');
      const deckEl = document.getElementById('draw-pile-visual');
      const burnedEl = document.getElementById('burned-pile-visual');
      const discardRect = discardEl ? discardEl.getBoundingClientRect() : null;
      const deckRect = deckEl ? deckEl.getBoundingClientRect() : null;
      const actorRect = fx.actorId ? getSeatRect(fx.actorId) : null;
      const handRect = getSeatRect(myPlayerId);

      if (fx.kind === 'PLAY') {
        const startRect = fx.fromRect || (fx.isMe ? handRect : actorRect);
        if (startRect && discardRect) {
          fx.cards.forEach((c, i) => {
            setTimeout(() => animateCardFlight(startRect, discardRect, c, false, 330), i * 55);
          });
        }
        if (fx.burned && burnedEl) {
          setTimeout(() => {
            burnedEl.classList.remove('burn-flash');
            void burnedEl.offsetWidth;
            burnedEl.classList.add('burn-flash');
          }, 300);
        }
      } else if (fx.kind === 'PICKUP') {
        const targetRect = fx.isMe ? handRect : actorRect;
        if (discardRect && targetRect) {
          for (let i = 0; i < Math.min(5, fx.count || 3); i++) {
            setTimeout(() => animateCardFlight(discardRect, targetRect, null, true, 380), i * 60);
          }
        }
      } else if (fx.kind === 'DRAW') {
        const targetRect = fx.isMe ? handRect : (fx.actorId ? getSeatRect(fx.actorId) : null);
        if (deckRect && targetRect) {
          for (let i = 0; i < (fx.count || 1); i++) {
            setTimeout(() => {
              SoundEngine.slide();
              animateCardFlight(deckRect, targetRect, null, true, 320);
            }, i * 70);
          }
        }
      }
    }

    /* ==========================================================================
       REAÇÕES RÁPIDAS (emojis flutuantes + GOMBRA!)
       ========================================================================== */
    let lastReactionAt = 0;

    /* Janelas das interações especiais (medidas no relógio de cada aparelho,
       a partir do momento em que ele viu o evento acontecer):
       - GOMBRA!  : até 10 s depois que OUTRO jogador recolheu o monte
       - DORMIU?? : quando o jogador da vez (humano, outro) passou de 10 s sem jogar */
    const GOMBRA_WINDOW_MS = 10000;
    const SLEEP_AFTER_MS = 10000;
    const DORMIU_COOLDOWN_MS = 6000;
    let seenPickupSeq = 0;
    let pickupSeenAt = 0;
    let turnKey = '';
    let turnStartedAt = 0;
    let lastDormiuAt = 0;

    // Chamado a cada render: detecta compra nova do monte e troca de vez
    function trackInteractionClocks() {
      if (!G) return;
      if ((G.pickupStamp || 0) !== seenPickupSeq) {
        seenPickupSeq = G.pickupStamp || 0;
        pickupSeenAt = seenPickupSeq ? Date.now() : 0;
      }
      const key = `${G.phase}|${G.turnIdx}|${G.turnCounter || 0}`;
      if (key !== turnKey) {
        turnKey = key;
        turnStartedAt = Date.now();
      }
    }

    function gombraRemainingMs() {
      if (!G || !pickupSeenAt || G.lastPickupBy === myPlayerId) return 0;
      return Math.max(0, GOMBRA_WINDOW_MS - (Date.now() - pickupSeenAt));
    }

    function sleepyPlayer() {
      if (!G || G.phase !== 'PLAY') return null;
      const p = G.players[G.turnIdx];
      if (!p || p.id === myPlayerId || p.type !== 'human' || p.escaped) return null;
      return Date.now() - turnStartedAt >= SLEEP_AFTER_MS ? p : null;
    }

    // Atualiza os botões GOMBRA! / DORMIU?? (contagem regressiva e liberação)
    function refreshSpecialReactions() {
      const gBtn = document.querySelector('.gombra-btn');
      const dBtn = document.querySelector('.dormiu-btn');
      if (!gBtn || !dBtn) return;
      const left = gombraRemainingMs();
      gBtn.disabled = left <= 0;
      // A contagem fica num espaço de largura fixa: o botão não muda de tamanho
      const gTxt = left > 0 ? String(Math.ceil(left / 1000)) : '';
      if (gBtn.dataset.count !== gTxt) {
        gBtn.dataset.count = gTxt;
        gBtn.innerHTML = `GOMBRA!<span class="gcount">${gTxt}</span>`;
      }
      gBtn.title = left > 0 ? 'Liberado: alguém acabou de recolher o monte!' : 'Liberado por 10 s quando outro jogador recolhe o monte';
      const sleeper = sleepyPlayer();
      const cooling = Date.now() - lastDormiuAt < DORMIU_COOLDOWN_MS;
      dBtn.disabled = !sleeper || cooling;
      dBtn.title = sleeper ? `Acordar ${sleeper.name}!` : 'Liberado quando o jogador da vez demora mais de 10 s';
      dBtn.classList.toggle('dormiu-ready', !!sleeper && !cooling);
    }
    setInterval(refreshSpecialReactions, 250);

    function showReaction(playerId, emoji, target = null) {
      const layer = document.getElementById('reaction-layer');
      const area = document.getElementById('table-area');
      if (!layer || !area) return;
      const areaRect = area.getBoundingClientRect();
      let x = areaRect.width / 2;
      let y = areaRect.height - 10;
      if (playerId !== myPlayerId) {
        const r = getSeatRect(playerId);
        if (r) {
          x = r.left + r.width / 2 - areaRect.left;
          y = r.top + r.height / 2 - areaRect.top;
        }
      }
      const p = G ? G.players.find(pl => pl.id === playerId) : null;

      if (emoji === 'GOMBRA') {
        const burst = document.createElement('div');
        burst.className = 'gombra-burst';
        // Se a compra que liberou o GOMBRA! foi de um monte grande, ele vira "organismo vivo"
        const alive = G && (G.lastPickupCount || 0) >= bigPileThreshold();
        burst.innerHTML = `GOMBRA!${alive ? '<span class="organismo">🦠 organismo vivo 🦠</span>' : ''}<small>${p ? esc(p.name) : ''}</small>`;
        if (alive) burst.classList.add('gombra-alive');
        layer.appendChild(burst);
        SoundEngine.gombra();
        setTimeout(() => burst.remove(), 1900);
        return;
      }

      if (emoji === 'DORMIU') {
        const t = G ? G.players.find(pl => pl.id === target) : null;
        const isMe = target === myPlayerId;
        // Balão em cima de quem está demorando (ou no centro, se for você)
        let tx = areaRect.width / 2;
        let ty = areaRect.height * 0.45;
        if (!isMe && target) {
          const r = getSeatRect(target);
          if (r) { tx = r.left + r.width / 2 - areaRect.left; ty = r.top - areaRect.top + 10; }
        }
        const burst = document.createElement('div');
        burst.className = 'dormiu-burst' + (isMe ? ' dormiu-me' : '');
        burst.style.left = `${tx}px`;
        burst.style.top = `${ty}px`;
        burst.innerHTML = `💤 DORMIU?? ⏰<small>${p ? esc(p.name) : ''}${t && !isMe ? ' → ' + esc(t.name) : ''}</small>`;
        layer.appendChild(burst);
        setTimeout(() => burst.remove(), isMe ? 2600 : 1800);
        if (isMe) {
          // O despertador toca só para quem está demorando (respeita o botão de mudo; a vibração vale sempre)
          SoundEngine.alarm();
          document.getElementById('player-zone')?.classList.add('wake-shake');
          setTimeout(() => document.getElementById('player-zone')?.classList.remove('wake-shake'), 1200);
          safeVibrate([200, 100, 200, 100, 400]);
        } else {
          SoundEngine.select();
        }
        return;
      }
      for (let i = 0; i < 3; i++) {
        const el = document.createElement('div');
        el.className = 'float-emoji';
        el.textContent = emoji;
        el.style.left = `${x + (i - 1) * 14}px`;
        el.style.top = `${y}px`;
        el.style.setProperty('--drift', `${(Math.random() * 60 - 30).toFixed(0)}px`);
        el.style.animationDelay = `${i * 120}ms`;
        layer.appendChild(el);
        setTimeout(() => el.remove(), 1900 + i * 120);
      }
      SoundEngine.select();
    }

    function sendReaction(emoji) {
      const now = Date.now();
      if (now - lastReactionAt < 700) return; // evita spam
      let target = null;
      if (emoji === 'GOMBRA' && gombraRemainingMs() <= 0) return;
      if (emoji === 'DORMIU') {
        const sleeper = sleepyPlayer();
        if (!sleeper || now - lastDormiuAt < DORMIU_COOLDOWN_MS) return;
        target = sleeper.id;
        lastDormiuAt = now;
      }
      lastReactionAt = now;
      const msg = { type: 'REACTION', playerId: myPlayerId, emoji, target };
      if (isHost) {
        showReaction(myPlayerId, emoji, target);
        joinedConns().forEach(c => netSend(c, msg));
      } else if (hostConn) {
        // O convidado vê na hora; o host repassa para os outros
        showReaction(myPlayerId, emoji, target);
        netSend(hostConn, msg);
      }
      refreshSpecialReactions();
    }

    // Bots também reagem de vez em quando (só o host decide)
    function maybeBotReact(actor, event, count = 0) {
      if (!isHost || !G || turboMode || !event) return;
      const bots = G.players.filter(p => p.type === 'bot' && p.id !== actor.id && !p.escaped);
      if (bots.length === 0) return;
      let pool = null;
      let chance = 0;
      // GOMBRA! só vale logo depois de alguém recolher o monte
      if (event === 'PICKUP') { pool = count >= 6 ? ['GOMBRA', 'GOMBRA', '😂', '💩'] : ['GOMBRA', '😂']; chance = count >= 6 ? 0.55 : 0.2; }
      else if (event === 'BURN') { pool = ['🔥', '😱']; chance = 0.25; }
      else if (event === 'JOKER') { pool = ['😱', '😡', '😂']; chance = 0.5; }
      else if (event === 'REVERSE') { pool = ['😱']; chance = 0.3; }
      if (!pool || Math.random() > chance) return;
      const bot = bots[Math.floor(Math.random() * bots.length)];
      const emoji = pool[Math.floor(Math.random() * pool.length)];
      setTimeout(() => {
        showReaction(bot.id, emoji);
        joinedConns().forEach(c => netSend(c, { type: 'REACTION', playerId: bot.id, emoji }));
      }, 450 + Math.random() * 2500);
    }

    // Bots também cobram quem demora: depois de 12–18 s, às vezes um bot manda DORMIU??
    let botDormiuKey = '';
    setInterval(() => {
      if (!isHost || !G || G.phase !== 'PLAY' || turboMode || coachOpen) return;
      const p = G.players[G.turnIdx];
      if (!p || p.type !== 'human' || p.escaped) return;
      const key = `${G.turnIdx}|${G.turnCounter || 0}`;
      if (key === botDormiuKey || Date.now() - turnStartedAt < 12000) return;
      botDormiuKey = key;
      if (Math.random() > 0.6) return;
      const bots = G.players.filter(b => b.type === 'bot' && !b.escaped);
      if (!bots.length) return;
      const bot = bots[Math.floor(Math.random() * bots.length)];
      setTimeout(() => {
        if (!G || `${G.turnIdx}|${G.turnCounter || 0}` !== key) return; // já jogou
        showReaction(bot.id, 'DORMIU', p.id);
        joinedConns().forEach(c => netSend(c, { type: 'REACTION', playerId: bot.id, emoji: 'DORMIU', target: p.id }));
      }, Math.random() * 6000);
    }, 1000);

    /* ==========================================================================
       LIMPEZA DE ESTADO VISUAL (sanitizeUIState)
       Remove classes e elementos residuais que causam bugs gráficos.
       ========================================================================== */
    function sanitizeUIState() {
      document.querySelectorAll('.dragging-source').forEach(el => el.classList.remove('dragging-source'));
      document.querySelectorAll('.long-pressing').forEach(el => el.classList.remove('long-pressing'));
      document.querySelectorAll('#fx-layer .drag-ghost').forEach(el => el.remove());
      clearDropHighlights();
      if (!G) return;
      const me = G.players.find(p => p.id === myPlayerId);
      if (!me || G.phase !== 'PLAY') {
        selectedHandIds.clear();
        selectedOpenIds.clear();
      } else {
        const handIds = new Set(me.hand.map(c => c.id));
        const openIds = new Set(me.open.map(c => c.id));
        [...selectedHandIds].forEach(id => { if (!handIds.has(id)) selectedHandIds.delete(id); });
        [...selectedOpenIds].forEach(id => { if (!openIds.has(id)) selectedOpenIds.delete(id); });
      }
      if (G.phase !== 'SWAP') swapHandId = null;
    }

    function syncMyAvatarPreview() {
      const src = myCustomAvatar || AvatarModule.getDefaultAvatar('human', null);
      document.getElementById('img-my-avatar').src = src;
      if (isHost) {
        lobbySlots[0].avatar = src;
        renderLobbySlots();
        broadcastLobby();
      } else {
        sendProfileToHost();
      }
    }

    function refreshLogPanelUI() {
      const box = document.getElementById('box-session-log');
      const saved = LoggerModule.getSavedSession();
      const net = NetLog.get();
      const matches = saved && saved.matches ? saved.matches.length : 0;
      // Mostra o log se houver partidas gravadas OU eventos de rede (convidados também)
      if (matches === 0 && net.events.filter(e => e.ev !== 'app_start').length === 0) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'flex';
      const totalTurns = matches ? saved.matches.reduce((acc, m) => acc + (m.turns ? m.turns.length : 0), 0) : 0;
      const problems = net.events.filter(e => /error|lost|timeout|slow|fail|gap/.test(e.ev)).length;
      document.getElementById('lbl-log-summary').textContent =
        `${matches} partida(s), ${totalTurns} jogadas · ${net.events.length} evento(s) de conexão` +
        (problems ? ` (${problems} com problema)` : '') + '. Baixe ou copie para trazer à conversa.';
    }

    function loadSavedSetup() {
      SoundEngine.updateMuteButtons();
      const savedName = Store.get('sh_player_name');
      if (savedName) {
        const clean = sanitizeName(savedName);
        document.getElementById('inp-name').value = clean;
        lobbySlots[0].name = clean;
      }
      syncMyAvatarPreview();

      const savedRules = Store.get('sh_rules');
      if (savedRules) {
        try {
          const r = JSON.parse(savedRules);
          document.getElementById('sel-decks').value = r.decks || '1';
          document.getElementById('sel-jokers').value = r.jokers ?? '1';
          document.getElementById('chk-p2').checked = r.p2 ?? true;
          document.getElementById('sel-draw2').value = r.draw2 || '1';
          document.getElementById('chk-p7').checked = r.p7 ?? true;
          document.getElementById('chk-p10').checked = r.p10 ?? true;
          document.getElementById('sel-after10').value = r.after10 || 'next';
          document.getElementById('chk-pjoker').checked = r.pjoker ?? true;
          document.getElementById('sel-multijoker').value = r.multijoker || 'once';
          document.getElementById('chk-p48').checked = r.p48 ?? true;
          document.getElementById('sel-48mode').value = r.mode48 || 'sequence';
          document.getElementById('chk-48burn').checked = r.burn48 ?? false;
          document.getElementById('inp-bigpile').value = sanitizeBigPile(r.bigPile, r.decks === 2 ? 2 : 1);
        } catch (e) {}
      }
      lastDecksForBigPile = parseInt(document.getElementById('sel-decks').value, 10) === 2 ? 2 : 1;
      renderScoreboard();
      renderLobbySlots();
      refreshLogPanelUI();

      autoJoinFromUrl();
    }

    // Ao trocar a quantidade de baralhos, o padrão acompanha (12 ↔ 20), a menos que o valor tenha sido editado
    let lastDecksForBigPile = 1;
    function syncBigPileInput(decks) {
      const inp = document.getElementById('inp-bigpile');
      let v = sanitizeBigPile(inp.value, decks);
      if (decks !== lastDecksForBigPile && v === defaultBigPile(lastDecksForBigPile)) v = defaultBigPile(decks);
      lastDecksForBigPile = decks;
      if (String(inp.value) !== String(v)) inp.value = v;
      return v;
    }

    function getRulesFromUI() {
      const playerCount = lobbySlots.length;
      let decks = parseInt(document.getElementById('sel-decks').value, 10);
      if (playerCount >= 6) {
        decks = 2;
        document.getElementById('sel-decks').value = '2';
      }
      let maxJokers = decks * 2;
      let jokers = parseInt(document.getElementById('sel-jokers').value, 10);
      if (jokers > maxJokers) {
        jokers = maxJokers;
        document.getElementById('sel-jokers').value = String(maxJokers);
      }

      // Coringa desligado = Coringa fora do baralho
      const pjoker = document.getElementById('chk-pjoker').checked;
      document.getElementById('sel-jokers').disabled = !pjoker;
      if (!pjoker) jokers = 0;

      const rules = {
        decks,
        jokers,
        p2: document.getElementById('chk-p2').checked,
        draw2: parseInt(document.getElementById('sel-draw2').value, 10),
        p7: document.getElementById('chk-p7').checked,
        p10: document.getElementById('chk-p10').checked,
        after10: document.getElementById('sel-after10').value,
        pjoker,
        multijoker: document.getElementById('sel-multijoker').value,
        p48: document.getElementById('chk-p48').checked,
        mode48: document.getElementById('sel-48mode').value,
        burn48: document.getElementById('chk-48burn').checked,
        bigPile: syncBigPileInput(decks)
      };
      Store.set('sh_rules', JSON.stringify(rules));
      return rules;
    }

    /* ==========================================================================
       PLACAR: histórico geral (neste aparelho) + sessão da sala
       - Cada partida vira um registro com a ordem em que os jogadores escaparam.
       - Jogadores são identificados pelo id do aparelho (trocar o nome não perde o histórico).
       - Só pessoas entram no placar; simulação e tutorial não contam.
       - Geral: cada aparelho guarda as partidas de que participou (host e convidados).
       - Sessão: contada pelo host enquanto a sala estiver aberta e enviada a todos.
       ========================================================================== */
    const HISTORY_KEY = 'sh_history_v1';
    const HISTORY_MAX = 500;
    let sessionRecords = [];
    let boardTab = 'session';

    // O host aparece como 'local_host' na mesa; no histórico vale o id do aparelho dele
    function canonicalId(id) {
      return id === 'local_host' ? getDeviceId() : id;
    }

    function loadHistory() {
      try {
        const arr = JSON.parse(Store.get(HISTORY_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch (e) {
        return [];
      }
    }

    function addToHistory(record) {
      const hist = loadHistory();
      if (hist.some(r => r.matchId === record.matchId)) return; // já registrada
      hist.push(record);
      while (hist.length > HISTORY_MAX) hist.shift();
      Store.set(HISTORY_KEY, JSON.stringify(hist));
    }

    function buildMatchRecord() {
      const n = G.players.length;
      const order = G.escapeOrder || [];
      return {
        matchId: `${getDeviceId()}_${Date.now().toString(36)}`,
        at: new Date().toISOString(),
        room: roomCode || null,
        n,
        players: G.players.map(p => {
          const idx = order.indexOf(p.id);
          return {
            id: canonicalId(p.id),
            name: p.name,
            human: p.type === 'human' || !!p.disconnected,
            place: p.id === G.loserId ? n : (idx === -1 ? n - 1 : idx + 1)
          };
        })
      };
    }

    function computeStats(records, wantBots = false) {
      const stats = {};
      records.forEach(rec => {
        rec.players.forEach(p => {
          if (p.human === wantBots) return;
          const s = stats[p.id] || (stats[p.id] = { id: p.id, name: p.name, played: 0, losses: 0, firsts: 0, placeSum: 0, lastAt: '' });
          s.played++;
          if (p.place === rec.n) s.losses++;
          if (p.place === 1) s.firsts++;
          s.placeSum += p.place;
          if (rec.at >= s.lastAt) { s.name = p.name; s.lastAt = rec.at; }
        });
      });
      return Object.values(stats).sort((a, b) =>
        (a.losses / a.played) - (b.losses / b.played) || b.played - a.played || b.firsts - a.firsts);
    }

    function avatarForId(id) {
      const slot = lobbySlots.find(s => canonicalId(s.id) === id || s.id === id);
      return slot ? slot.avatar : AvatarModule.getDefaultAvatar('human', null);
    }

    // withBots: na sessão, os bots aparecem numa seção à parte, sem posição no ranking
    function leaderboardHtml(records, emptyText, withBots = false) {
      const rows = computeStats(records);
      const botRows = withBots ? computeStats(records, true) : [];
      if (rows.length === 0 && botRows.length === 0) return `<div class="board-empty">${emptyText}</div>`;
      let html = rows.length ? statsTableHtml(rows, true) : `<div class="board-empty">${emptyText}</div>`;
      if (botRows.length) html += `<div class="board-section-title">🤖 Bots (fora do ranking)</div>${statsTableHtml(botRows, false)}`;
      return html;
    }

    function botAvatarForId(id) {
      const slot = lobbySlots.find(s => s.id === id);
      const gp = G && G.players.find(p => p.id === id);
      const persona = (slot && slot.persona) || (gp && gp.persona) || 'medium';
      return (slot && slot.avatar) || AvatarModule.getDefaultAvatar('bot', persona);
    }

    function statsTableHtml(rows, ranked) {
      const me = getDeviceId();
      return `<table class="board">
        <thead><tr><th></th><th class="b-name">${ranked ? 'Jogador' : 'Bot'}</th><th title="Partidas">P</th><th title="Vezes que foi o Shithead">💀</th><th title="% de derrotas">%</th><th title="Vezes que saiu em 1º">🥇</th><th title="Posição média de saída (1 = melhor)">Pos</th></tr></thead>
        <tbody>${rows.map((s, i) => {
          const isMe = ranked && s.id === me;
          const av = ranked ? avatarForId(s.id) : botAvatarForId(s.id);
          return `
          <tr class="${isMe ? 'b-me' : (ranked ? '' : 'b-bot')}">
            <td class="b-rank">${ranked ? i + 1 : '–'}</td>
            <td class="b-name"><img class="avatar-sm b-av" src="${esc(av)}" alt="" /><span>${esc(s.name)}${isMe ? ' <em>(você)</em>' : ''}</span></td>
            <td>${s.played}</td>
            <td class="b-loss">${s.losses}</td>
            <td>${Math.round((s.losses / s.played) * 100)}%</td>
            <td>${s.firsts}</td>
            <td>${(s.placeSum / s.played).toFixed(1)}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
    }

    function renderScoreboard() {
      const el = document.getElementById('scoreboard-list');
      if (!el) return;
      if (document.getElementById('board-overlay')?.classList.contains('show')) renderBoardOverlay();
      document.querySelectorAll('[data-board]').forEach(b => b.classList.toggle('active', b.dataset.board === boardTab));
      const note = document.getElementById('lbl-board-note');
      const resetBtn = document.getElementById('btn-reset-scores');
      if (boardTab === 'session') {
        el.innerHTML = leaderboardHtml(sessionRecords, 'Nenhuma partida nesta sessão ainda.', true);
        note.textContent = (joinRoomCode ? `Sala ${joinRoomCode}` : (roomCode ? `Sala ${roomCode}` : 'Partidas locais')) + ` · ${sessionRecords.length} partida(s) · zera ao abrir uma sala nova`;
        resetBtn.style.display = isHost ? 'inline-block' : 'none';
      } else {
        const hist = loadHistory();
        el.innerHTML = leaderboardHtml(hist, 'Nenhuma partida registrada neste aparelho ainda.');
        note.textContent = `${hist.length} partida(s) guardadas neste aparelho`;
        resetBtn.style.display = 'inline-block';
      }
    }

    // Derrotas na sessão por jogador da mesa (para o 💀 ao lado de cada um)
    function sessionLossesForTable() {
      const out = {};
      if (!G) return out;
      G.players.forEach(p => {
        const cid = canonicalId(p.id);
        out[p.id] = sessionRecords.filter(r => r.players.some(x => x.id === cid && x.place === r.n)).length;
      });
      return out;
    }

    // Fim de partida (host): grava, atualiza a sessão e avisa todos os aparelhos
    function recordMatchResult() {
      if (!G || G.mode !== 'normal' || G.resultRecorded) return;
      G.resultRecorded = true;
      const record = buildMatchRecord();
      if (!record.players.some(p => p.human)) return;
      addToHistory(record);
      sessionRecords.push(record);
      G.sessionLosses = sessionLossesForTable();
      joinedConns().forEach(c => netSend(c, { type: 'MATCH_RESULT', record, session: sessionRecords }));
      renderScoreboard();
    }

    function renderLobbySlots() {
      const container = document.getElementById('slots-container');
      document.getElementById('lbl-player-count').textContent = lobbySlots.length;
      if (lobbySlots.length >= 6) {
        document.getElementById('sel-decks').value = '2';
      }
      container.innerHTML = '';

      lobbySlots.forEach((slot, idx) => {
        const div = document.createElement('div');
        div.className = 'slot-item';
        const avatarSrc = slot.avatar || AvatarModule.getDefaultAvatar(slot.type, slot.persona);

        if (slot.type === 'human') {
          div.innerHTML = `
            <div class="slot-left">
              <span class="badge" style="background:#0f172a; color:var(--cyan);">#${idx + 1}</span>
              <img src="${esc(avatarSrc)}" class="avatar-sm" alt="" />
              <strong>${esc(slot.name)}${slot.id === myPlayerId ? ' <span style="color:var(--cyan);font-weight:600;">(você)</span>' : ''}</strong>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
              ${idx === 0 ? '<span class="badge">Host</span>' : (isHost
                ? `<span class="badge ${clientConns.some(c => c.__playerId === slot.id) ? 'badge-online' : 'badge-offline'}">${clientConns.some(c => c.__playerId === slot.id) ? 'online' : 'offline'}</span>
                   <button data-kick="${idx}" class="btn btn-danger" style="padding:3px 7px; font-size:0.72rem;" title="Remover jogador">X</button>`
                : '<span class="badge">Humano</span>')}
            </div>
          `;
        } else {
          // Bot: o seletor já mostra o nome (sem nome repetido sobreposto ao seletor)
          div.innerHTML = isHost ? `
            <div class="slot-left slot-left-bot">
              <span class="badge" style="background:#0f172a; color:var(--cyan);">#${idx + 1}</span>
              <img src="${esc(avatarSrc)}" class="avatar-sm" alt="" />
              <select data-idx="${idx}" class="sel-bot-persona" title="Nível do bot">
                <option value="easy" ${slot.persona === 'easy' ? 'selected' : ''}>Tio Barnabé (Fácil)</option>
                <option value="medium" ${slot.persona === 'medium' ? 'selected' : ''}>Madame Lola (Médio)</option>
                <option value="hard" ${slot.persona === 'hard' ? 'selected' : ''}>Dr. Chaos (Difícil)</option>
                <option value="random">Aleatório</option>
              </select>
            </div>
            ${lobbySlots.length > 3 ? `<button data-remove="${idx}" class="btn btn-danger" style="padding:3px 7px; font-size:0.72rem; flex-shrink:0;" title="Remover bot">X</button>` : ''}
          ` : `
            <div class="slot-left">
              <span class="badge" style="background:#0f172a; color:var(--cyan);">#${idx + 1}</span>
              <img src="${esc(avatarSrc)}" class="avatar-sm" alt="" />
              <strong>${esc(slot.name)}</strong>
            </div>
            <span class="badge" style="flex-shrink:0;">IA</span>
          `;
        }
        container.appendChild(div);
      });

      container.querySelectorAll('.sel-bot-persona').forEach(sel => {
        sel.addEventListener('change', (e) => {
          const i = parseInt(e.target.dataset.idx, 10);
          let val = e.target.value;
          if (val === 'random') {
            const keys = ['easy', 'medium', 'hard'];
            val = keys[Math.floor(Math.random() * keys.length)];
          }
          lobbySlots[i].persona = val;
          lobbySlots[i].name = AppConfig.AI_PERSONAS[val].name;
          lobbySlots[i].avatar = AvatarModule.getDefaultAvatar('bot', val);
          renderLobbySlots();
          broadcastLobby();
        });
      });

      container.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          if (lobbySlots.length <= 3) return;
          const i = parseInt(e.target.dataset.remove, 10);
          lobbySlots.splice(i, 1);
          renderLobbySlots();
          broadcastLobby();
        });
      });

      // Host remove um jogador humano (ex.: duplicado ou que saiu)
      container.querySelectorAll('[data-kick]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const i = parseInt(e.target.dataset.kick, 10);
          const slot = lobbySlots[i];
          if (!slot || i === 0) return;
          kickPlayer(slot.id);
        });
      });
    }

    // Volta a ser o "dono" da própria mesa local (depois de sair/ser removido de uma sala)
    function resetToLocalLobby() {
      isHost = true;
      myPlayerId = 'local_host';
      const myName = document.getElementById('inp-name').value.trim() || 'Você';
      lobbySlots = [
        { id: 'local_host', name: myName, type: 'human', persona: null, avatar: myCustomAvatar || AvatarModule.getDefaultAvatar('human', null) },
        ...['easy', 'medium', 'hard'].map((p, i) => ({ id: 'bot_' + (i + 1), name: AppConfig.AI_PERSONAS[p].name, type: 'bot', persona: p, avatar: AvatarModule.getDefaultAvatar('bot', p) }))
      ];
      G = null;
      renderLobbySlots();
    }

    function kickPlayer(pid) {
      nlog('kick', { pid: shortId(pid) });
      clientConns.filter(c => c.__playerId === pid).forEach(c => {
        c.__kicked = true;
        try { netSend(c, { type: 'KICKED' }); } catch (e) {}
        setTimeout(() => { try { c.close(); } catch (e) {} }, 300);
      });
      for (let i = clientConns.length - 1; i >= 0; i--) {
        if (clientConns[i].__playerId === pid) clientConns.splice(i, 1);
      }
      // Se estiver numa partida em andamento, um bot assume o lugar
      const gp = G && G.phase !== 'GAMEOVER' && G.phase !== 'ABANDONED' ? G.players.find(p => p.id === pid) : null;
      if (gp) {
        gp.type = 'bot';
        gp.persona = 'medium';
        markReadyByTakeover(gp);
        gp.disconnected = true;
        // Na preparação, se todos os outros já estavam prontos, a partida começa
        if (G.phase === 'SWAP' && G.players.every(pl => pl.readySwap)) evaluateStartAndDirection();
        broadcastState();
        scheduleBotIfNeeded();
      }
      lobbySlots = lobbySlots.filter(s => s.id !== pid);
      // Removido deixa de ser "conhecido": com a sala trancada, não volta sozinho
      delete guestSecrets[pid];
      renderLobbySlots();
      broadcastLobby();
    }

    /* ==========================================================================
       8. CONEXÃO MULTIPLAYER P2P (PeerJS / WebRTC)
       - Sinalização: servidor público gratuito do PeerJS (0.peerjs.com). Ele só
         apresenta os aparelhos; depois os dados vão direto de um para o outro.
       - O Host é a "mesa": guarda o estado, roda os bots e valida as jogadas.
       - Link/QR: ...?sala=1234 abre o jogo e entra direto na sala.
       ========================================================================== */
    // Beta e testes locais usam salas separadas das oficiais (convidados de um não entram no outro)
    const PEER_PREFIX = AppConfig.ENV === 'prod' ? 'shithead-mobile-v5-sala-' : 'shithead-mobile-beta-sala-';
    const CONN_OPTS = { reliable: true, serialization: 'json' };
    let wakeLock = null;
    let joinRoomCode = '';
    let reconnectTimer = null;

    /* ---- Envio confiável -------------------------------------------------------
       Mensagens WebRTC acima de ~16 KB podem sumir em silêncio entre navegadores
       diferentes (ex.: Firefox Android ↔ Chrome). Aqui toda mensagem grande é
       dividida em pedaços pequenos e remontada do outro lado. */
    const NET_CHUNK = 12000;
    let netMsgSeq = 0;

    /* ---- Log de conexão ---------------------------------------------------------
       Tudo que acontece na rede vai para o NetLog (baixado junto com o log da sessão).
       Ids aparecem encurtados (6 últimos caracteres); nada de IPs ou conteúdo. */
    const shortId = (id) => (id ? String(id).slice(-6) : null);
    function nlog(ev, details = {}) {
      NetLog.log(ev, { role: isHost ? 'host' : 'guest', room: (isHost ? roomCode : joinRoomCode) || null, ...details });
    }
    function errInfo(err) {
      return err ? { errType: err.type || err.name || null, errMsg: String(err.message || err).slice(0, 160) } : {};
    }

    // Estado ICE da ligação direta e qual rota foi usada (direta, via STUN ou via TURN/relay)
    function watchPeerConnection(conn, who) {
      const pc = conn && conn.peerConnection;
      if (!pc || pc.__watched) return;
      pc.__watched = true;
      const report = () => reportRoute(pc, who);
      pc.addEventListener('iceconnectionstatechange', () => {
        nlog('ice_state', { who, state: pc.iceConnectionState });
        NetLog.count('ice_' + pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') report();
      });
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') report();
    }

    async function reportRoute(pc, who) {
      try {
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach(s => {
          if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId) || pair;
        });
        if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s; });
        if (!pair) return;
        const local = stats.get(pair.localCandidateId) || {};
        const remote = stats.get(pair.remoteCandidateId) || {};
        // host = rede local; srflx = direto pela internet (STUN); relay = passou pelo servidor TURN
        nlog('route', {
          who,
          local: local.candidateType || null,
          remote: remote.candidateType || null,
          protocol: local.protocol || null,
          relayProtocol: local.relayProtocol || null,
          rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null
        });
        NetLog.count('route_' + (local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay' : 'direct'));
      } catch (e) { /* getStats indisponível */ }
    }

    function netSend(conn, msg) {
      if (!conn || !conn.open) {
        NetLog.count('send_skipped_closed');
        return false;
      }
      const text = JSON.stringify(msg);
      try {
        if (text.length <= NET_CHUNK) {
          conn.send(text);
        } else {
          const id = `${Date.now().toString(36)}_${netMsgSeq++}`;
          const n = Math.ceil(text.length / NET_CHUNK);
          for (let i = 0; i < n; i++) {
            conn.send(JSON.stringify({ type: 'CHUNK', id, i, n, part: text.slice(i * NET_CHUNK, (i + 1) * NET_CHUNK) }));
          }
          NetLog.count('chunked_out');
          if (text.length > 30000) nlog('big_message', { type: msg.type, bytes: text.length, parts: n });
        }
        NetLog.count('msg_out');
        NetLog.count('bytes_out', text.length);
        return true;
      } catch (e) {
        NetLog.count('send_fail');
        nlog('send_fail', { type: msg && msg.type, bytes: text.length, ...errInfo(e) });
        return false;
      }
    }

    function netReceive(conn, raw, handler) {
      let msg = raw;
      if (typeof raw === 'string') {
        NetLog.count('bytes_in', raw.length);
        try { msg = JSON.parse(raw); } catch (e) { NetLog.count('parse_fail'); return; }
      }
      if (!msg || typeof msg !== 'object') return;
      NetLog.count('msg_in');
      if (msg.type === 'CHUNK') {
        // Limites: até 100 pedaços por mensagem (~1,2 MB), 8 mensagens em montagem por conexão
        const n = Number(msg.n);
        const i = Number(msg.i);
        if (!Number.isInteger(n) || n < 1 || n > 100 || !Number.isInteger(i) || i < 0 || i >= n ||
            typeof msg.part !== 'string' || msg.part.length > NET_CHUNK || typeof msg.id !== 'string' || msg.id.length > 40) {
          NetLog.count('chunk_rejected');
          return;
        }
        const buf = conn.__chunks || (conn.__chunks = {});
        if (!buf[msg.id] && Object.keys(buf).length >= 8) { NetLog.count('chunk_rejected'); return; }
        const entry = buf[msg.id] || (buf[msg.id] = { parts: new Array(n), got: 0, at: Date.now() });
        if (entry.parts.length !== n) { NetLog.count('chunk_rejected'); return; }
        if (entry.parts[msg.i] === undefined) { entry.parts[msg.i] = msg.part; entry.got++; }
        if (entry.got === msg.n) {
          delete buf[msg.id];
          NetLog.count('chunked_in');
          try { handler(JSON.parse(entry.parts.join(''))); } catch (e) { NetLog.count('chunk_parse_fail'); }
        }
        // descarta pedaços órfãos antigos (mensagem que nunca completou)
        Object.keys(buf).forEach(k => {
          if (Date.now() - buf[k].at > 30000) {
            nlog('chunk_lost', { got: buf[k].got, of: buf[k].parts.length });
            NetLog.count('chunk_lost');
            delete buf[k];
          }
        });
        return;
      }
      handler(msg);
    }

    // Estado da partida sem as fotos (elas já vão no lobby): mensagem bem menor
    /* ---- O que cada aparelho pode ver ------------------------------------------
       O host guarda a mesa inteira, mas manda a cada convidado só a parte dele:
       - a própria mão completa;
       - as próprias cartas fechadas viradas (só o id, para escolher qual virar);
       - das outras pessoas, a mão e as fechadas como cartas viradas sem id real;
       - o baralho como cartas viradas (só a quantidade importa).
       Cartas abertas na mesa e o monte continuam visíveis para todos.
       viewerId que não está na mesa (espectador) não vê nenhuma carta escondida. */
    function hiddenRun(n, tag) {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = { id: tag + i, hidden: true };
      return out;
    }
    function stateForNet(viewerId) {
      if (!G) return G;
      return {
        ...G,
        stall: undefined,
        deck: hiddenRun(G.deck.length, 'd'),
        sessionLosses: sessionLossesForTable(),
        loserAvatar: null,
        players: G.players.map((p, pi) => {
          const mine = !!viewerId && p.id === viewerId;
          return {
            ...p,
            avatar: null,
            hand: mine ? p.hand : hiddenRun(p.hand.length, 'h' + pi + '_'),
            closed: mine ? p.closed.map(c => ({ id: c.id, hidden: true })) : hiddenRun(p.closed.length, 'f' + pi + '_')
          };
        })
      };
    }

    function restoreAvatars(state) {
      const byId = {};
      lobbySlots.forEach(s => { byId[s.id] = s.avatar; });
      state.players.forEach(p => {
        p.avatar = byId[p.id] || AvatarModule.getDefaultAvatar(p.type === 'bot' && p.persona ? 'bot' : 'human', p.persona);
      });
      if (state.loserId) {
        const lp = state.players.find(p => p.id === state.loserId);
        state.loserAvatar = lp ? lp.avatar : null;
      }
    }

    /* ---- Pulso do host -----------------------------------------------------------
       A cada 2,5 s o host avisa se está numa partida e qual a versão do estado.
       Se o convidado perdeu alguma mensagem, ele pede a mesa de novo (RESYNC).
       Se o convidado ficar 30 s sem ouvir o host, reconecta sozinho. */
    let lastHostPingAt = 0;
    let lastResyncAt = 0;

    function hostInGame() {
      return !!(G && G.phase !== 'ABANDONED' && document.getElementById('screen-game').classList.contains('active'));
    }

    // Tempo de ida e volta de cada convidado (PING → PONG): resumo no log a cada ~30 s
    function recordRtt(conn, sentAt) {
      const rtt = Date.now() - sentAt;
      if (!(rtt >= 0 && rtt < 60000)) return;
      const s = conn.__rtt || (conn.__rtt = { n: 0, sum: 0, max: 0 });
      s.n++; s.sum += rtt; s.max = Math.max(s.max, rtt);
      if (s.n >= 12) {
        nlog('rtt', { pid: shortId(conn.__playerId), avgMs: Math.round(s.sum / s.n), maxMs: s.max, n: s.n });
        conn.__rtt = { n: 0, sum: 0, max: 0 };
      }
    }

    setInterval(() => {
      if (isHost && clientConns.length) {
        // over: a partida terminou e o host ainda está na tela de fim de jogo
        const ping = { type: 'PING', inGame: hostInGame(), over: !!(G && G.phase === 'GAMEOVER'), version: G ? (G.version || 0) : 0, protocol: AppConfig.PROTOCOL, t: Date.now() };
        clientConns.forEach(c => { if (c.__playerId) netSend(c, ping); });
      }
      // 30 s de folga: navegadores "freiam" timers de abas em segundo plano no host
      if (!isHost && joinRoomCode && hostConn && hostConn.open && lastHostPingAt && Date.now() - lastHostPingAt > 30000) {
        nlog('ping_timeout', { gapS: Math.round((Date.now() - lastHostPingAt) / 1000) });
        lastHostPingAt = 0;
        handleHostLost('ping_timeout');
      }
    }, 2500);

    function handlePing(ping) {
      const gap = lastHostPingAt ? Date.now() - lastHostPingAt : 0;
      if (gap > 8000) nlog('ping_gap', { gapS: Math.round(gap / 1000), hidden: document.hidden });
      lastHostPingAt = Date.now();
      const inGameHere = document.getElementById('screen-game').classList.contains('active');
      // Partida terminada e eu já saí para a sala: fico na sala (antes o pulso me puxava de
      // volta para a tela de fim de jogo enquanto o host continuava nela).
      // Se eu ainda estou na mesa e perdi o resultado final, peço a mesa de novo.
      const leftAfterEnd = ping.over && !inGameHere;
      const behind = ping.inGame && !leftAfterEnd && (!G || !inGameHere || (G.version || 0) < ping.version);
      if (behind && Date.now() - lastResyncAt > 2000) {
        lastResyncAt = Date.now();
        nlog('resync_sent', { localV: G ? (G.version || 0) : null, hostV: ping.version, inGameHere });
        NetLog.count('resync_sent');
        netSend(hostConn, { type: 'RESYNC' });
      }
      // Host saiu da partida (voltou ao lobby) e eu ainda estou na mesa
      if (!ping.inGame && inGameHere && G && G.phase !== 'GAMEOVER') {
        nlog('host_left_game');
        G = null;
        document.getElementById('screen-game').classList.remove('active');
        document.getElementById('screen-lobby').classList.add('active');
        setNetStatus('join-net-status', 'O host voltou para a sala. Aguardando nova partida...', 'info');
      }
    }

    function getJoinUrl(code) {
      // Endereço oficial no GitHub Pages; em testes locais usa o endereço atual
      const base = window.location.origin + window.location.pathname.replace(/index\.html$/, '');
      return `${base}?sala=${code}`;
    }

    function setNetStatus(elId, text, kind = 'info') {
      const el = document.getElementById(elId);
      if (!el) return;
      el.textContent = text;
      el.className = 'net-status net-' + kind;
      el.style.display = text ? 'block' : 'none';
    }

    // Mantém a tela acesa durante a partida (se o host apagar a tela, a sala cai)
    async function keepScreenAwake(on) {
      try {
        if (on && 'wakeLock' in navigator && !wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
          nlog('wake_lock', { ok: true });
        } else if (on && !('wakeLock' in navigator)) {
          if (!keepScreenAwake.__warned) { keepScreenAwake.__warned = true; nlog('wake_lock', { ok: false, reason: 'sem suporte' }); }
        } else if (!on && wakeLock) {
          await wakeLock.release();
          wakeLock = null;
        }
      } catch (e) {
        nlog('wake_lock', { ok: false, ...errInfo(e) });
      }
    }
    // Tela apagada / app em segundo plano e internet caindo: causas comuns de queda
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (clientConns.length || joinRoomCode) {
        if (document.hidden) {
          hiddenAt = Date.now();
          nlog('page_hidden');
        } else {
          nlog('page_visible', { awayS: hiddenAt ? Math.round((Date.now() - hiddenAt) / 1000) : null, connOpen: isHost ? clientConns.filter(c => c.open).length : !!(hostConn && hostConn.open) });
        }
      }
      if (!document.hidden && G && G.phase !== 'GAMEOVER' && (clientConns.length || hostConn)) keepScreenAwake(true);
    });
    window.addEventListener('online', () => nlog('net_online', { netType: (navigator.connection || {}).effectiveType || null }));
    window.addEventListener('offline', () => nlog('net_offline'));
    if (navigator.connection && navigator.connection.addEventListener) {
      navigator.connection.addEventListener('change', () => {
        if (clientConns.length || joinRoomCode) nlog('net_change', { netType: navigator.connection.effectiveType || null, rttMs: navigator.connection.rtt || null });
      });
    }

    function peerErrorText(err) {
      const t = err && err.type;
      if (t === 'peer-unavailable') return 'Sala não encontrada. Confira o código ou peça um novo link ao host.';
      if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Sem conexão com o servidor de salas. Verifique a internet e tente de novo.';
      if (t === 'browser-incompatible') return 'Este navegador não suporta jogo online (WebRTC).';
      if (t === 'webrtc') return 'Não foi possível ligar os aparelhos diretamente (rede bloqueando). Tente outra rede (ex.: Wi-Fi ↔ 4G).';
      return 'Erro de conexão: ' + (t || 'desconhecido');
    }

    function renderHostInvite() {
      document.getElementById('host-qr-box').style.display = 'flex';
      document.getElementById('join-box').style.display = 'none';
      document.getElementById('lbl-room-code').textContent = roomCode;
      const url = getJoinUrl(roomCode);
      document.getElementById('lbl-invite-url').textContent = url.replace(/^https?:\/\//, '');
      const qrEl = document.getElementById('qr-container');
      qrEl.innerHTML = '';
      new QRCode(qrEl, { text: url, width: 156, height: 156, correctLevel: QRCode.CorrectLevel.M });
    }

    // opts.code + opts.resume: reabre a mesma sala (retomada do host), sem zerar placar,
    // trava da sala nem o log da sessão
    let hostRetryTimer = null;
    const REOPEN_WAITS_S = [3, 5, 10, 15, 20, 30]; // ~80 s: o servidor segura o nome por até ~1 min
    function createHostRoom(attempt = 0, opts = {}) {
      clearTimeout(hostRetryTimer);
      if (myPeer) myPeer.destroy();
      isHost = true;
      // "Você" só faz sentido na própria tela: online, o host precisa de um nome
      if (!document.getElementById('inp-name').value.trim() && lobbySlots[0].name === 'Você') {
        lobbySlots[0].name = 'Anfitrião';
        renderLobbySlots();
      }
      roomCode = opts.code || newRoomCode();
      if (attempt === 0 && !opts.resume) {
        sessionRecords = []; renderScoreboard(); // sala nova = sessão nova
        setRoomLocked(false);
      }
      setNetStatus('host-net-status', opts.resume ? `Reabrindo a sala ${roomCode}...` : 'Criando sala...', 'info');
      const t0 = Date.now();
      nlog('room_create', { attempt, resume: !!opts.resume, env: attempt === 0 ? NetLog.environment() : undefined });
      const peer = new Peer(PEER_PREFIX + roomCode);
      myPeer = peer;

      myPeer.on('open', () => {
        renderHostInvite();
        setNetStatus('host-net-status', opts.resume ? `Sala ${roomCode} reaberta! Os convidados estão voltando...` : 'Sala aberta! Aguardando jogadores...', 'ok');
        nlog('room_open', { ms: Date.now() - t0, resume: !!opts.resume, attempt, server: peer.options && peer.options.host });
        if (opts.resume) {
          if (G) { G.bannerText = `Sala ${roomCode} reaberta — esperando os convidados voltarem.`; renderGame(); }
        } else {
          LoggerModule.initNewSession(getRulesFromUI(), lobbySlots);
        }
      });

      myPeer.on('error', (err) => {
        nlog('peer_error', errInfo(err));
        NetLog.count('peer_error_' + (err && err.type));
        if (err.type === 'unavailable-id') {
          peer.__idTaken = true; // o "desconectado" que vem em seguida não é queda de rede
          // Retomada: o nome da sala ainda está preso no servidor (a conexão antiga não
          // expirou). Insiste no MESMO código — com outro, os convidados não achariam a sala.
          if (opts.code && attempt < REOPEN_WAITS_S.length && peer === myPeer) {
            const wait = REOPEN_WAITS_S[attempt];
            setNetStatus('host-net-status', `A sala ${roomCode} ainda está presa no servidor. Tentando de novo em ${wait} s...`, 'warn');
            if (G && opts.resume) { G.bannerText = `Reabrindo a sala ${roomCode}... (tentando de novo em ${wait} s)`; renderGame(); }
            hostRetryTimer = setTimeout(() => { if (myPeer === peer) createHostRoom(attempt + 1, opts); }, wait * 1000);
            return;
          }
          // Sala nova: código já em uso por outra sala, sorteia outro
          if (!opts.code && attempt < 5) { createHostRoom(attempt + 1); return; }
        }
        setNetStatus('host-net-status', peerErrorText(err), 'error');
      });

      // Queda com o servidor de salas: as conexões já abertas continuam; tenta reabrir a sala
      myPeer.on('disconnected', () => {
        if (peer.__idTaken || peer !== myPeer) return;
        nlog('server_disconnected', { guests: clientConns.length });
        NetLog.count('server_disconnected');
        setNetStatus('host-net-status', 'Reconectando ao servidor de salas...', 'warn');
        setTimeout(() => { if (myPeer && !myPeer.destroyed) myPeer.reconnect(); }, 1500);
      });

      myPeer.on('connection', (conn) => {
        const tc = Date.now();
        nlog('guest_connecting', { peer: shortId(conn.peer) });
        conn.on('open', () => {
          clientConns.push(conn);
          nlog('guest_conn_open', { peer: shortId(conn.peer), ms: Date.now() - tc });
          watchPeerConnection(conn, shortId(conn.peer));
          conn.on('data', (d) => netReceive(conn, d, (m) => handleHostReceive(conn, m)));
        });
        conn.on('close', () => { conn.__closeReason = conn.__closeReason || 'close'; handleClientLeft(conn); });
        conn.on('error', (err) => {
          conn.__closeReason = 'error';
          nlog('guest_conn_error', { pid: shortId(conn.__playerId), ...errInfo(err) });
          handleClientLeft(conn);
        });
      });
    }

    function getDeviceId() {
      let id = Store.get('sh_device_id');
      if (!id) {
        const rnd = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
        id = 'dev_' + rnd;
        Store.set('sh_device_id', id);
      }
      return id;
    }

    // Segredo do aparelho: só vai para o host da sala, nunca é repassado aos outros jogadores
    function getDeviceSecret() {
      let s = Store.get('sh_device_secret');
      if (!s || !/^[A-Za-z0-9]{16,64}$/.test(s)) {
        const bytes = new Uint8Array(16);
        (window.crypto || {}).getRandomValues ? crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.random() * 256; });
        s = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        Store.set('sh_device_secret', s);
      }
      return s;
    }

    function handleClientLeft(conn) {
      const idx = clientConns.indexOf(conn);
      if (idx === -1) return;
      clientConns.splice(idx, 1);
      const pid = conn.__playerId;
      const openedFor = conn.__openedAt ? Math.round((Date.now() - conn.__openedAt) / 1000) : null;
      nlog('guest_conn_closed', {
        pid: shortId(pid), reason: conn.__kicked ? 'kicked' : (conn.__replaced ? 'replaced' : (conn.__closeReason || 'close')),
        connectedS: openedFor, ice: conn.peerConnection ? conn.peerConnection.iceConnectionState : null
      });
      if (!pid || conn.__replaced || conn.__kicked) return;
      // O mesmo aparelho já voltou por outra conexão: não é uma saída
      if (clientConns.some(c => c.__playerId === pid)) return;
      const slot = lobbySlots.find(s => s.id === pid);
      const inGame = G && G.phase !== 'GAMEOVER' && G.phase !== 'ABANDONED' && G.players.some(p => p.id === pid);
      nlog('guest_left', { pid: shortId(pid), name: slot ? slot.name : null, inGame: !!inGame, botTookOver: !!inGame });
      NetLog.count('guest_left');
      if (inGame) {
        // Durante a partida: um bot assume o lugar até a pessoa voltar
        const p = G.players.find(pl => pl.id === pid);
        p.type = 'bot';
        p.persona = 'medium';
        markReadyByTakeover(p);
        p.disconnected = true;
        G.bannerText = `${p.name} caiu — um bot está jogando por ele(a) até voltar.`;
        if (G.phase === 'SWAP' && G.players.every(pl => pl.readySwap)) evaluateStartAndDirection();
        broadcastState();
        renderGame();
        renderLobbySlots();
        scheduleBotIfNeeded();
      } else if (slot) {
        lobbySlots = lobbySlots.filter(s => s.id !== pid);
        renderLobbySlots();
        broadcastLobby();
      }
      setNetStatus('host-net-status', `${slot ? slot.name : 'Um jogador'} saiu da sala.`, 'warn');
    }

    function joinRoom(code) {
      code = normalizeRoomCode(code);
      if (!ROOM_CODE_RE.test(code)) {
        setNetStatus('join-net-status', `Digite o código da sala: ${ROOM_CODE_LEN} letras ou números (ex.: KX7RD).`, 'error');
        return;
      }
      SoundEngine.init();
      joinRoomCode = code;
      isHost = false;
      const resumeBox = document.getElementById('resume-box');
      if (resumeBox) resumeBox.style.display = 'none';
      // Identificador fixo deste aparelho/navegador: recarregar a página, a tela
      // apagar ou o navegador fechar a aba não criam um jogador novo — o host
      // reconhece o aparelho e devolve o mesmo lugar na mesa.
      myPlayerId = getDeviceId();

      // A conexão antiga vira "velha": o fechamento dela não dispara outra reconexão
      if (hostConn) hostConn.__stale = true;
      if (myPeer) myPeer.destroy();
      clearTimeout(reconnectTimer);
      setNetStatus('join-net-status', `Conectando à sala ${code}...`, 'info');
      document.getElementById('join-box').style.display = 'flex';
      document.getElementById('inp-room-code').value = code;
      const t0 = Date.now();
      joinAttempts++;
      nlog('join_start', { attempt: joinAttempts, reason: lastLostReason || 'inicio', device: shortId(myPlayerId), env: joinAttempts === 1 ? NetLog.environment() : undefined });
      const peer = new Peer();
      myPeer = peer;

      peer.on('open', () => {
        if (peer !== myPeer) return;
        nlog('peer_open', { ms: Date.now() - t0, server: peer.options && peer.options.host });
        const conn = peer.connect(PEER_PREFIX + code, CONN_OPTS);
        hostConn = conn;
        const timeout = setTimeout(() => {
          if (!conn.open && conn === hostConn) {
            nlog('conn_slow', { waitedS: 9, ice: conn.peerConnection ? conn.peerConnection.iceConnectionState : null });
            NetLog.count('conn_slow');
            setNetStatus('join-net-status', 'A conexão está demorando... Se não entrar, tente outra rede (Wi-Fi ↔ 4G).', 'warn');
            // Voltando para a sala (ex.: o host recarregou e o nome antigo ainda responde no
            // servidor): tenta de novo em vez de esperar para sempre
            if (waitingHostReturn()) {
              clearTimeout(reconnectTimer);
              reconnectTimer = setTimeout(() => { if (joinRoomCode && !(hostConn && hostConn.open)) joinRoom(joinRoomCode); }, 3000);
            }
          }
        }, 9000);
        // Acompanha o ICE desde o começo (mostra se a rede está bloqueando a ligação direta)
        setTimeout(() => watchPeerConnection(conn, 'host'), 0);
        conn.on('open', () => {
          clearTimeout(timeout);
          conn.__openedAt = Date.now();
          nlog('conn_open', { ms: Date.now() - t0, attempt: joinAttempts, afterHostLostS: hostLostAt ? Math.round((Date.now() - hostLostAt) / 1000) : undefined });
          hostLostAt = 0;
          retryCount = 0;
          watchPeerConnection(conn, 'host');
          const myName = document.getElementById('inp-name').value.trim() || 'Jogador';
          const avatar = myCustomAvatar || AvatarModule.getDefaultAvatar('human', null);
          netSend(conn, { type: 'JOIN', id: myPlayerId, secret: getDeviceSecret(), name: myName, avatar, env: NetLog.environment(), protocol: AppConfig.PROTOCOL, build: AppConfig.BUILD });
          // Conta ao host por que precisou reconectar (fica no log dos dois lados)
          if (joinAttempts > 1) netSend(conn, { type: 'NETLOG', what: 'reconnected', info: { attempt: joinAttempts, lastReason: lastLostReason } });
          lastLostReason = null;
          lastHostPingAt = Date.now();
          setNetStatus('join-net-status', `✔ Na sala ${code}! Aguardando o host iniciar.`, 'ok');
          setGuestLobbyMode(true);
        });
        conn.on('data', (d) => { if (!conn.__stale) netReceive(conn, d, handleClientReceive); });
        conn.on('close', () => { if (!conn.__stale) handleHostLost('conn_close'); });
        conn.on('error', (err) => {
          nlog('conn_error', { ...errInfo(err), stale: !!conn.__stale });
          if (!conn.__stale) handleHostLost('conn_error');
        });
      });

      peer.on('disconnected', () => {
        if (peer === myPeer) nlog('server_disconnected', { connOpen: !!(hostConn && hostConn.open) });
      });

      myPeer.on('error', (err) => {
        nlog('peer_error', errInfo(err));
        NetLog.count('peer_error_' + (err && err.type));
        setNetStatus('join-net-status', peerErrorText(err), 'error');
        if (err.type === 'peer-unavailable') {
          // Eu estava nesta sala e o host sumiu: ele pode estar recarregando a página
          // (retomada). Continua tentando por alguns minutos em vez de desistir.
          if (waitingHostReturn() && peer === myPeer) {
            retryCount = Math.min(retryCount + 1, 6);
            const wait = Math.min(15000, 2500 * retryCount);
            const leftS = Math.max(0, Math.round((HOST_RETURN_WAIT_MS - (Date.now() - hostLostAt)) / 1000));
            setNetStatus('join-net-status', `O host saiu da sala. Esperando ele voltar (até ${Math.ceil(leftS / 60)} min)...`, 'warn');
            if (G && document.getElementById('screen-game').classList.contains('active')) {
              G.bannerText = 'O host saiu — esperando ele voltar para a mesa...';
              renderGame();
            }
            nlog('host_wait', { retry: retryCount, inS: Math.round(wait / 1000), leftS });
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => { if (joinRoomCode && !(hostConn && hostConn.open)) joinRoom(joinRoomCode); }, wait);
            return;
          }
          if (hostLostAt) {
            nlog('host_gave_up', { waitedS: Math.round((Date.now() - hostLostAt) / 1000) });
            setNetStatus('join-net-status', 'O host não voltou para a sala. Peça um link novo para jogar de novo.', 'error');
            showInvalidWarning('O host não voltou para a sala.');
            hostLostAt = 0;
          }
          setGuestLobbyMode(false);
          return;
        }
        // Falha de rede/servidor (comum ao voltar da tela apagada): tenta de novo com
        // intervalos crescentes (3 s, 6 s, 12 s… até 30 s). Com a tela apagada, espera
        // ela voltar — o aviso de "tela visível" reconecta na hora.
        const transient = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err.type);
        if (transient && joinRoomCode && peer === myPeer) {
          retryCount = Math.min(retryCount + 1, 6);
          const wait = Math.min(30000, 3000 * Math.pow(2, retryCount - 1));
          lastLostReason = 'erro_' + err.type;
          if (!document.hidden) {
            clearTimeout(reconnectTimer);
            setNetStatus('join-net-status', `Sem conexão com o servidor. Tentando de novo em ${Math.round(wait / 1000)} s...`, 'warn');
            nlog('retry_scheduled', { inS: Math.round(wait / 1000), retry: retryCount });
            reconnectTimer = setTimeout(() => { if (joinRoomCode && !(hostConn && hostConn.open)) joinRoom(joinRoomCode); }, wait);
          }
        }
      });
    }

    let retryCount = 0;

    // Celular voltou do modo de espera: se a conexão caiu, reconecta na hora
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || isHost || !joinRoomCode) return;
      if (!hostConn || !hostConn.open) {
        clearTimeout(reconnectTimer);
        lastLostReason = lastLostReason || 'voltou_da_espera';
        joinRoom(joinRoomCode);
      }
    });

    let joinAttempts = 0;
    let lastLostReason = null;
    // Quando a conexão com o host caiu (0 = conectado). Enquanto durar a espera, o convidado
    // insiste em voltar, mesmo que o servidor diga que a sala não existe (host recarregando).
    let hostLostAt = 0;
    const HOST_RETURN_WAIT_MS = 3 * 60 * 1000;
    function waitingHostReturn() {
      return !!(hostLostAt && joinRoomCode && Date.now() - hostLostAt < HOST_RETURN_WAIT_MS);
    }

    function handleHostLost(reason = 'desconhecido') {
      if (isHost || !joinRoomCode) return;
      const openedFor = hostConn && hostConn.__openedAt ? Math.round((Date.now() - hostConn.__openedAt) / 1000) : null;
      nlog('host_lost', { reason, connectedS: openedFor, hidden: document.hidden, online: navigator.onLine,
        ice: hostConn && hostConn.peerConnection ? hostConn.peerConnection.iceConnectionState : null });
      NetLog.count('host_lost_' + reason);
      lastLostReason = reason;
      if (!hostLostAt) hostLostAt = Date.now();
      if (hostConn) hostConn.__stale = true;
      showInvalidWarning('Conexão com o host perdida. Tentando voltar...');
      setNetStatus('join-net-status', 'Conexão perdida. Tentando voltar à sala...', 'warn');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => joinRoom(joinRoomCode), 2500);
    }

    // Host e convidado com versões diferentes do formato das mensagens.
    // Convidado desatualizado: recarrega a página uma vez (o service worker busca a versão nova).
    // Host desatualizado: avisa para o host recarregar.
    function handleVersionMismatch(hostProtocol, hostBuild) {
      nlog('version_mismatch', { mine: AppConfig.PROTOCOL, host: hostProtocol, hostBuild });
      NetLog.count('version_mismatch');
      clearTimeout(reconnectTimer);
      if (hostConn) hostConn.__stale = true;
      const code = joinRoomCode;
      joinRoomCode = '';
      if (myPeer) { try { myPeer.destroy(); } catch (e) {} }
      if (document.getElementById('screen-game').classList.contains('active')) {
        G = null;
        document.getElementById('screen-game').classList.remove('active');
        document.getElementById('screen-lobby').classList.add('active');
      }
      setGuestLobbyMode(false);
      if (hostProtocol > AppConfig.PROTOCOL) {
        let lastTry = 0;
        try { lastTry = Number(sessionStorage.getItem('sh_update_reload')) || 0; } catch (e) {}
        if (Date.now() - lastTry > 120000) {
          try { sessionStorage.setItem('sh_update_reload', String(Date.now())); } catch (e) {}
          setNetStatus('join-net-status', 'O host está com uma versão mais nova do jogo. Atualizando esta página...', 'warn');
          const url = code ? getJoinUrl(code) : location.href;
          setTimeout(() => location.replace(url), 900);
          return;
        }
        setNetStatus('join-net-status', 'Este aparelho está com uma versão antiga do jogo. Feche a aba, abra o link de novo e tente outra vez.', 'error');
      } else {
        setNetStatus('join-net-status', 'O host está com uma versão antiga do jogo. Peça para ele recarregar a página e criar a sala de novo.', 'error');
      }
    }

    // Convidado: esconde o que só o host controla
    function setGuestLobbyMode(guest) {
      document.getElementById('box-rules').style.display = guest ? 'none' : 'flex';
      document.getElementById('btn-add-bot').style.display = guest ? 'none' : 'inline-block';
      document.querySelector('.sim-row').style.display = guest ? 'none' : 'flex';
      document.getElementById('btn-tutorial').style.display = guest ? 'none' : 'block';
      document.getElementById('btn-create-host').disabled = guest;
      const startBtn = document.getElementById('btn-start-match');
      startBtn.disabled = guest;
      startBtn.textContent = guest ? 'Aguardando o host iniciar...' : 'Iniciar Partida';
    }

    document.getElementById('btn-create-host').addEventListener('click', () => {
      SoundEngine.init();
      createHostRoom();
    });

    document.getElementById('btn-show-join').addEventListener('click', () => {
      SoundEngine.init();
      document.getElementById('join-box').style.display = 'flex';
      document.getElementById('host-qr-box').style.display = 'none';
      document.getElementById('inp-room-code').focus();
    });

    document.getElementById('btn-connect-peer').addEventListener('click', () => {
      joinRoom(document.getElementById('inp-room-code').value);
    });
    // Código digitado: maiúsculas e sem espaços, enquanto a pessoa digita
    document.getElementById('inp-room-code').addEventListener('input', (e) => {
      const v = normalizeRoomCode(e.target.value).slice(0, ROOM_CODE_LEN);
      if (e.target.value !== v) e.target.value = v;
    });
    document.getElementById('btn-lock-room').addEventListener('click', () => {
      setRoomLocked(!roomLocked);
      nlog('room_lock', { locked: roomLocked });
    });
    document.getElementById('inp-room-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom(e.target.value);
    });

    // Compartilhar convite (WhatsApp etc.) ou copiar o link
    document.getElementById('btn-share-invite').addEventListener('click', async () => {
      const url = getJoinUrl(roomCode);
      const text = `Bora jogar Shithead! Sala ${roomCode}`;
      try {
        if (navigator.share) {
          await navigator.share({ title: 'Shithead!', text, url });
          return;
        }
      } catch (e) { if (e && e.name === 'AbortError') return; }
      try {
        await navigator.clipboard.writeText(url);
        setNetStatus('host-net-status', 'Link copiado! Cole no WhatsApp ou onde quiser.', 'ok');
      } catch (e) {
        setNetStatus('host-net-status', url, 'info');
      }
    });

    // Segredo de cada aparelho (memória do host): impede que alguém use o id de
    // outra pessoa — os ids aparecem na lista do lobby, o segredo nunca é repassado.
    const guestSecrets = {};
    const GUEST_ID_RE = /^(dev|peer)_[A-Za-z0-9]{4,24}$/;

    function sanitizeEnv(e) {
      if (!e || typeof e !== 'object') return null;
      const s = (v, n = 24) => (v == null ? null : String(v).replace(/[^\w .()-]/g, '').slice(0, n));
      const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);
      return { browser: s(e.browser), os: s(e.os), mobile: !!e.mobile, online: !!e.online, netType: s(e.netType, 8),
        downlinkMbps: num(e.downlinkMbps), rttMs: num(e.rttMs), saveData: !!e.saveData, standalone: !!e.standalone, webrtc: !!e.webrtc };
    }

    /* ---- Limite de mensagens por convidado -------------------------------------
       "Balde de fichas" por tipo de mensagem: cada tipo enche a uma taxa por segundo
       até um máximo. O que passar disso é descartado (e contado no log), para um
       aparelho com defeito ou mal-intencionado não sobrecarregar o host. Toque duplo,
       arrastar e o duelo de velocidade ficam bem abaixo destes limites. */
    const RATE_LIMITS = {
      ACTION: [8, 12], REACTION: [3, 5], RESYNC: [0.5, 2], PROFILE: [1, 3],
      NETLOG: [1, 3], TURBO: [1, 2], JOIN: [1, 3], PONG: [2, 4]
    };
    function allowMessage(conn, type) {
      const lim = RATE_LIMITS[type];
      if (!lim) return true;
      const [perSec, burst] = lim;
      const now = Date.now();
      const buckets = conn.__rate || (conn.__rate = {});
      const b = buckets[type] || (buckets[type] = { tokens: burst, at: now });
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec);
      b.at = now;
      if (b.tokens < 1) {
        NetLog.count('rate_limited_' + type);
        return false;
      }
      b.tokens -= 1;
      return true;
    }

    // Trancar a sala: aparelhos novos não entram; quem já esteve na sala pode voltar
    // (a reconexão depois da tela apagar passa pelo mesmo JOIN).
    let roomLocked = false;
    function setRoomLocked(locked) {
      roomLocked = !!locked;
      const btn = document.getElementById('btn-lock-room');
      if (btn) {
        btn.textContent = roomLocked ? '🔒 Sala trancada — toque para destrancar' : '🔓 Sala aberta — toque para trancar';
        btn.setAttribute('aria-pressed', roomLocked ? 'true' : 'false');
        btn.classList.toggle('btn-locked', roomLocked);
      }
      joinedConns().forEach(c => { try { netSend(c, { type: 'LOBBY_LOCK', locked: roomLocked }); } catch (e) {} });
    }

    function handleHostReceive(conn, data) {
      if (!data || typeof data !== 'object') return;
      // Antes do JOIN aceito, a conexão só pode mandar JOIN
      if (!conn.__playerId && data.type !== 'JOIN') return;
      if (!allowMessage(conn, data.type)) return;
      if (data.type === 'PONG') {
        if (Number.isFinite(Number(data.t))) recordRtt(conn, Number(data.t));
        return;
      }
      if (data.type === 'JOIN') {
        // Versão diferente do formato das mensagens: pede para atualizar antes de qualquer coisa
        if (Number(data.protocol) !== AppConfig.PROTOCOL) {
          nlog('join_rejected', { reason: 'versao', guestProtocol: Number(data.protocol) || 0, guestBuild: typeof data.build === 'string' ? data.build.slice(0, 20) : null });
          NetLog.count('join_rejected_version');
          netSend(conn, { type: 'UPDATE_REQUIRED', protocol: AppConfig.PROTOCOL, build: AppConfig.BUILD });
          setTimeout(() => { try { conn.close(); } catch (e) {} }, 1500);
          return;
        }
        const id = typeof data.id === 'string' && GUEST_ID_RE.test(data.id) ? data.id : null;
        const secret = typeof data.secret === 'string' && /^[A-Za-z0-9]{16,64}$/.test(data.secret) ? data.secret : null;
        if (!id || !secret) {
          nlog('join_rejected', { reason: 'id_ou_segredo_invalido' });
          NetLog.count('join_rejected');
          try { conn.close(); } catch (e) {}
          return;
        }
        if (guestSecrets[id] && guestSecrets[id] !== secret) {
          // Alguém tentando entrar com o id de outro aparelho
          nlog('join_rejected', { reason: 'segredo_diferente', pid: shortId(id) });
          NetLog.count('join_rejected');
          try { conn.close(); } catch (e) {}
          return;
        }
        if (roomLocked && !guestSecrets[id]) {
          nlog('join_rejected', { reason: 'sala_trancada', pid: shortId(id) });
          NetLog.count('join_rejected_locked');
          netSend(conn, { type: 'ROOM_LOCKED' });
          setTimeout(() => { try { conn.close(); } catch (e) {} }, 1500);
          return;
        }
        guestSecrets[id] = secret;
        data.id = id;
        conn.__playerId = data.id;
        conn.__openedAt = conn.__openedAt || Date.now();
        const rejoin = lobbySlots.some(s => s.id === data.id) || !!(G && G.players && G.players.some(p => p.id === data.id));
        nlog('guest_join', { pid: shortId(data.id), name: sanitizeName(data.name), rejoin, inGame: hostInGame(), env: sanitizeEnv(data.env) });
        NetLog.count(rejoin ? 'guest_rejoin' : 'guest_join');
        // Mesmo aparelho reconectando: fecha a conexão antiga (sem tratar como saída)
        clientConns.forEach(c => {
          if (c !== conn && c.__playerId === data.id) {
            c.__replaced = true;
            try { c.close(); } catch (e) {}
          }
        });
        for (let i = clientConns.length - 1; i >= 0; i--) {
          if (clientConns[i].__replaced) clientConns.splice(i, 1);
        }
        const name = sanitizeName(data.name);
        const avatar = sanitizeAvatar(data.avatar);

        // Voltando para uma partida em andamento: devolve o lugar
        // (partida já terminada não conta: quem volta fica na sala, sem reabrir a mesa)
        const gp = G && G.phase !== 'ABANDONED' && G.phase !== 'GAMEOVER' ? G.players.find(p => p.id === data.id) : null;
        if (gp) {
          gp.type = 'human';
          gp.persona = null;
          gp.disconnected = false;
          gp.name = name;
          G.bannerText = `${name} voltou para a mesa!`;
          // Um humano voltou com cartas: sai do modo acelerado
          if (!gp.escaped) { turboMode = false; G.turbo = false; }
          clearTimeout(aiTimeout);
          broadcastState();
          renderGame();
          scheduleBotIfNeeded();
        }

        const existing = lobbySlots.find(s => s.id === data.id);
        if (existing) {
          existing.name = name;
          existing.avatar = avatar;
          existing.type = 'human';
        } else {
          const newSlot = { id: data.id, name, type: 'human', persona: null, avatar };
          const botIdx = lobbySlots.findIndex(s => s.type === 'bot');
          if (lobbySlots.length < 6) lobbySlots.push(newSlot);
          else if (botIdx !== -1) lobbySlots[botIdx] = newSlot;
          else {
            netSend(conn, { type: 'ROOM_FULL' });
            return;
          }
        }
        renderLobbySlots();
        broadcastLobby();
        netSend(conn, { type: 'SESSION', session: sessionRecords });
        if (roomLocked) netSend(conn, { type: 'LOBBY_LOCK', locked: true });
        setNetStatus('host-net-status', `${name} entrou na sala!`, 'ok');
        SoundEngine.select();
        // Quem entra durante uma partida recebe a mesa atual (como espectador se não estiver nela).
        // Partida já terminada: não manda (quem reconecta da sala fica na sala; quem ainda estava
        // na mesa e perdeu o fim recebe o resultado pelo pulso, que pede a mesa de novo).
        if (G && G.phase !== 'ABANDONED' && G.phase !== 'GAMEOVER' && document.getElementById('screen-game').classList.contains('active')) {
          netSend(conn, { type: 'STATE_SYNC', state: stateForNet(conn.__playerId), fx: null });
        }
      } else if (data.type === 'PROFILE') {
        const slot = lobbySlots.find(s => s.id === conn.__playerId);
        if (slot) {
          slot.name = sanitizeName(data.name, slot.name);
          if (data.avatar) slot.avatar = sanitizeAvatar(data.avatar);
          renderLobbySlots();
          broadcastLobby();
        }
      } else if (data.type === 'NETLOG') {
        // Convidado avisando de um problema que ele viu (ex.: reconectou).
        // Só campos conhecidos e curtos entram no log do host.
        const info = data.info && typeof data.info === 'object' ? data.info : {};
        nlog('guest_report', {
          pid: shortId(conn.__playerId),
          what: String(data.what || '').replace(/[^\w-]/g, '').slice(0, 30),
          attempt: Math.min(999, Math.max(0, Number(info.attempt) || 0)),
          lastReason: info.lastReason ? String(info.lastReason).replace(/[^\w-]/g, '').slice(0, 30) : null
        });
      } else if (data.type === 'TURBO') {
        // Convidado pediu para acelerar: só vale se não houver mais humanos com cartas
        const p = G && G.players.find(pl => pl.id === conn.__playerId);
        activateTurbo(p ? p.name : 'convidado');
      } else if (data.type === 'RESYNC') {
        nlog('resync_request', { pid: shortId(conn.__playerId) });
        NetLog.count('resync_request');
        // Convidado perdeu alguma mensagem: reenvia a mesa (ou o lobby)
        if (hostInGame()) netSend(conn, { type: 'STATE_SYNC', state: stateForNet(conn.__playerId), fx: null });
        else netSend(conn, { type: 'LOBBY_SYNC', slots: lobbySlots });
      } else if (data.type === 'ACTION') {
        // Só aceita ações do próprio jogador daquela conexão, com formato conhecido
        if (!conn.__playerId || data.playerId !== conn.__playerId) return;
        const a = data.action;
        if (!a || typeof a !== 'object') return;
        const idList = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 12) : []);
        const types = ['PLAY_CARDS', 'PICKUP_PILE', 'PLAY_BLIND', 'SWAP_CARDS', 'READY_SWAP', 'SPEED_TAP'];
        if (!types.includes(a.type)) return;
        executePlayerAction(conn.__playerId, {
          type: a.type,
          handIds: idList(a.handIds),
          openIds: idList(a.openIds),
          cardId: typeof a.cardId === 'string' ? a.cardId : null,
          handId: typeof a.handId === 'string' ? a.handId : null,
          openId: typeof a.openId === 'string' ? a.openId : null
          // fromRect (posição na tela de quem jogou) é descartado: não vale em outro aparelho
        });
      } else if (data.type === 'REACTION') {
        if (data.playerId !== conn.__playerId || !REACTIONS_OK.includes(data.emoji)) return;
        data.target = sanitizeId(data.target);
        // O host confere as janelas (com uma folga de 2 s pela rede)
        if (data.emoji === 'GOMBRA') {
          const fresh = pickupSeenAt && Date.now() - pickupSeenAt < GOMBRA_WINDOW_MS + 2000;
          if (!fresh || (G && G.lastPickupBy === data.playerId)) return;
        }
        if (data.emoji === 'DORMIU') {
          const cur = G && G.phase === 'PLAY' ? G.players[G.turnIdx] : null;
          if (!cur || cur.id !== data.target || Date.now() - turnStartedAt < SLEEP_AFTER_MS - 2000) return;
        }
        showReaction(data.playerId, data.emoji, data.target || null);
        joinedConns().forEach(c => { if (c !== conn) netSend(c, { type: 'REACTION', playerId: data.playerId, emoji: data.emoji, target: data.target || null }); });
      }
    }

    function handleClientReceive(data) {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'LOBBY_SYNC') {
        if (!Array.isArray(data.slots)) return;
        const slots = data.slots.slice(0, 6).map(sanitizeSlot).filter(Boolean);
        if (slots.length) lobbySlots = slots;
        renderLobbySlots();
      } else if (data.type === 'PING') {
        // Host com outra versão do formato das mensagens: não dá para continuar
        if (Number(data.protocol) !== AppConfig.PROTOCOL) { handleVersionMismatch(Number(data.protocol) || 0, null); return; }
        if (hostConn && hostConn.open && Number.isFinite(Number(data.t))) netSend(hostConn, { type: 'PONG', t: Number(data.t) });
        handlePing({ inGame: !!data.inGame, over: !!data.over, version: Number(data.version) || 0 });
      } else if (data.type === 'UPDATE_REQUIRED') {
        handleVersionMismatch(Number(data.protocol) || 0, typeof data.build === 'string' ? data.build.slice(0, 20) : null);
      } else if (data.type === 'ROOM_LOCKED') {
        nlog('room_locked');
        setNetStatus('join-net-status', 'A sala está trancada pelo host. Peça para ele destrancar e tente de novo.', 'error');
        joinRoomCode = '';
        if (hostConn) hostConn.__stale = true;
        setGuestLobbyMode(false);
      } else if (data.type === 'LOBBY_LOCK') {
        const el = document.getElementById('join-net-status');
        if (el && joinRoomCode) setNetStatus('join-net-status', data.locked ? `✔ Na sala ${joinRoomCode} (trancada pelo host). Aguardando o host iniciar.` : `✔ Na sala ${joinRoomCode}! Aguardando o host iniciar.`, 'ok');
      } else if (data.type === 'MATCH_RESULT') {
        // Guarda no histórico deste aparelho as partidas de que participei
        const rec = sanitizeRecord(data.record);
        if (rec && rec.matchId && rec.players.some(p => p.id === getDeviceId())) addToHistory(rec);
        if (Array.isArray(data.session)) sessionRecords = data.session.slice(-500).map(sanitizeRecord).filter(Boolean);
        renderScoreboard();
        if (G) renderGame();
      } else if (data.type === 'SESSION') {
        if (Array.isArray(data.session)) sessionRecords = data.session.slice(-500).map(sanitizeRecord).filter(Boolean);
        renderScoreboard();
      } else if (data.type === 'STATE_SYNC') {
        const state = sanitizeState(data.state);
        if (!state) { NetLog.count('state_rejected'); return; }
        restoreAvatars(state);
        G = state;
        lastHostPingAt = Date.now();
        document.getElementById('screen-lobby').classList.remove('active');
        document.getElementById('screen-game').classList.add('active');
        keepScreenAwake(G.phase !== 'GAMEOVER');
        if (data.fx && typeof data.fx === 'object') {
          const kinds = ['PLAY', 'PICKUP', 'DRAW', 'SLIDE_INIT', 'SWAP'];
          const fx = {
            kind: kinds.includes(data.fx.kind) ? data.fx.kind : null,
            actorId: sanitizeId(data.fx.actorId),
            cards: sanitizeCards(data.fx.cards),
            count: Math.min(60, Math.max(0, Number(data.fx.count) || 0)),
            sfxTag: typeof data.fx.sfxTag === 'string' ? data.fx.sfxTag.slice(0, 12) : null,
            burned: !!data.fx.burned
          };
          if (fx.kind) triggerFlightVisual({ ...fx, isMe: fx.actorId === myPlayerId });
        }
        renderGame();
      } else if (data.type === 'REACTION') {
        if (!REACTIONS_OK.includes(data.emoji)) return;
        showReaction(sanitizeId(data.playerId), data.emoji, sanitizeId(data.target));
      } else if (data.type === 'KICKED') {
        nlog('kicked');
        joinRoomCode = '';
        if (hostConn) hostConn.__stale = true;
        resetToLocalLobby();
        setNetStatus('join-net-status', 'O host removeu você da sala.', 'error');
        setGuestLobbyMode(false);
        document.getElementById('screen-game').classList.remove('active');
        document.getElementById('screen-lobby').classList.add('active');
      } else if (data.type === 'ROOM_FULL') {
        nlog('room_full');
        setNetStatus('join-net-status', 'A sala está cheia (6 jogadores).', 'error');
        joinRoomCode = '';
        setGuestLobbyMode(false);
      }
    }

    // Conexões já aceitas pelo host (JOIN validado). Quem ainda não entrou não recebe nada.
    function joinedConns() {
      return clientConns.filter(c => !!c.__playerId);
    }

    function broadcastLobby() {
      clientConns.forEach(c => { if (!c.__playerId) return; try { netSend(c, { type: 'LOBBY_SYNC', slots: lobbySlots }); } catch (e) {} });
    }

    function broadcastState(fx = null) {
      saveHostResume(); // entrada, saída, bot assumindo: tudo que muda a mesa passa por aqui
      if (!isHost || clientConns.length === 0) return;
      // Uma versão nova por transmissão (antes subia uma vez por convidado)
      G.version = (G.version || 0) + 1;
      // fromRect é coordenada da tela de quem jogou: não serve para os outros aparelhos
      const cleanFx = fx ? { ...fx, fromRect: undefined } : null;
      // Só para conexões já aceitas (JOIN validado): quem ainda não entrou não recebe nada da mesa
      clientConns.forEach(c => { if (!c.__playerId) return; try { netSend(c, { type: 'STATE_SYNC', state: stateForNet(c.__playerId), fx: cleanFx }); } catch (e) {} });
    }

    // Entrada direta pelo link/QR (?sala=1234)
    function autoJoinFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const sala = normalizeRoomCode(params.get('sala'));
      if (!ROOM_CODE_RE.test(sala)) {
        if (params.get('sala')) {
          // Link de uma versão antiga (código de 4 números) ou digitado errado
          document.getElementById('join-box').style.display = 'flex';
          setNetStatus('join-net-status', 'Este link de sala não é válido nesta versão do jogo. Peça um link novo ao host.', 'error');
        }
        return;
      }
      document.getElementById('join-box').style.display = 'flex';
      document.getElementById('inp-room-code').value = sala;
      document.getElementById('join-invite-banner').style.display = 'block';
      document.getElementById('lbl-invite-code').textContent = sala;
      // Entra na hora; se o nome ainda for o padrão, dá para trocar depois (o host é avisado)
      joinRoom(sala);
    }

    function sendProfileToHost() {
      if (isHost || !hostConn || !hostConn.open) return;
      netSend(hostConn, {
        type: 'PROFILE',
        name: document.getElementById('inp-name').value.trim() || 'Jogador',
        avatar: myCustomAvatar || AvatarModule.getDefaultAvatar('human', null)
      });
    }

    /* ==========================================================================
       9. FLUXO DA PARTIDA E EXECUÇÃO DE JOGADAS
       ========================================================================== */
    // Modo da partida: 'normal' | 'sim' (só bots, você assiste) | 'tutorial'
    let currentMode = 'normal';
    let turboMode = false;
    let tutorialSeen = new Set();
    let coachOpen = false;

    function buildSlotsForMode(mode) {
      if (mode === 'tutorial') {
        return [
          { ...lobbySlots[0] },
          { id: 'tut_bot_1', name: 'Tio Barnabé', type: 'bot', persona: 'easy', avatar: AvatarModule.getDefaultAvatar('bot', 'easy') },
          { id: 'tut_bot_2', name: 'Madame Lola', type: 'bot', persona: 'easy', avatar: AvatarModule.getDefaultAvatar('bot', 'medium') }
        ];
      }
      if (mode === 'sim') {
        // O seu lugar vira um bot; você assiste à mesa a partir dele
        return lobbySlots.map(s => s.type === 'human'
          ? { id: 'sim_' + s.id, name: 'Bot Espelho', type: 'bot', persona: 'hard', avatar: AvatarModule.getDefaultAvatar('bot', 'hard') }
          : { ...s });
      }
      return lobbySlots.map(s => ({ ...s }));
    }

    /* ---- Registro para replay -----------------------------------------------------
       Toda ação que o host aplica (dele, dos convidados e dos bots) entra no log com o
       tempo desde o início da partida. A cada 20 ações grava a impressão digital da mesa.
       Ações que não poderiam valer naquele momento (fora da vez, fase errada) não entram. */
    let matchStartedAt = 0;
    let matchActionCount = 0;
    function compactAction(a) {
      switch (a.type) {
        case 'PLAY_CARDS': return { h: a.handIds || [], o: a.openIds || [] };
        case 'SWAP_CARDS': return { h: a.handId, o: a.openId };
        case 'PLAY_BLIND': return { c: a.cardId };
        case 'SPEED_WIN': return { i: a.idx };
        default: return null;
      }
    }
    function recordReplayAction(playerId, action) {
      const entry = [Date.now() - matchStartedAt, playerId, action.type];
      const data = compactAction(action);
      if (data) entry.push(data);
      LoggerModule.logAction(entry);
      matchActionCount++;
    }
    // Um bot assumiu o lugar de alguém (caiu ou foi removido): na preparação isso conta
    // como "pronto" — sem jogada de ninguém — e o replay precisa saber
    function markReadyByTakeover(p) {
      if (!G) return;
      if (G.phase === 'SWAP' && !p.readySwap) recordReplayAction(p.id, { type: 'READY_AUTO' });
      Core.apply(G, p.id, { type: 'READY_AUTO' });
    }

    function recordReplayCheck() {
      if (G && matchActionCount > 0 && matchActionCount % 20 === 0) LoggerModule.logCheck(matchActionCount, stateDigest(G));
    }

    /* ---- Retomada do host --------------------------------------------------------
       O host grava a partida em andamento a cada mudança (mesa, lugares, segredos dos
       convidados, código da sala). Se a página recarregar ou o celular fechar o app,
       ao abrir de novo o jogo oferece retomar: reabre a mesma sala, os convidados voltam
       sozinhos e um bot joga por eles até reconectarem. Vale por 30 minutos.
       A gravação roda no fim da mesma tarefa da jogada (microtarefa): se a página
       morrer, morre entre jogadas, e o log e a mesa gravada ficam sempre de acordo. */
    const RESUME_KEY = 'sh_host_resume';
    const RESUME_MAX_AGE_MS = 30 * 60 * 1000;
    const RESUMABLE = ['SWAP', 'SPEED_TIE', 'PLAY'];
    let resumeSavePending = false;

    function saveHostResume() {
      if (resumeSavePending) return;
      resumeSavePending = true;
      queueMicrotask(() => { resumeSavePending = false; writeHostResume(); });
    }

    function writeHostResume() {
      // Sem mesa (página acabou de abrir, oferta de retomada na tela): não mexe no que está gravado
      if (!isHost || !G) return;
      // Começou outra coisa: a oferta antiga deixa de valer
      const box = document.getElementById('resume-box');
      if (box) box.style.display = 'none';
      if (!RESUMABLE.includes(G.phase) || G.mode === 'tutorial') { Store.remove(RESUME_KEY); return; }
      Store.set(RESUME_KEY, JSON.stringify({
        v: 1, at: Date.now(), build: AppConfig.BUILD, protocol: AppConfig.PROTOCOL, env: AppConfig.ENV,
        roomCode, roomLocked, mode: currentMode, matchStartedAt, matchActionCount,
        log: LoggerModule.currentMatchRef(), lobbySlots, guestSecrets, sessionRecords, G
      }));
    }

    function loadHostResume() {
      let d = null;
      try { d = JSON.parse(Store.get(RESUME_KEY) || 'null'); } catch (e) { d = null; }
      const ok = d && d.v === 1 && d.G && Array.isArray(d.G.players) && RESUMABLE.includes(d.G.phase) &&
        Date.now() - d.at < RESUME_MAX_AGE_MS && d.protocol === AppConfig.PROTOCOL && d.env === AppConfig.ENV;
      if (!ok) { if (d) Store.remove(RESUME_KEY); return null; }
      return d;
    }

    // Ao abrir o jogo: se há partida interrompida deste aparelho como host, oferece retomar
    function offerHostResume() {
      const d = loadHostResume();
      const box = document.getElementById('resume-box');
      if (!d || !box) return;
      const mins = Math.max(1, Math.round((Date.now() - d.at) / 60000));
      const where = d.roomCode ? `na sala ${d.roomCode}` : 'contra os bots';
      document.getElementById('lbl-resume').textContent =
        `Sua partida ${where} (${d.G.players.length} jogadores) foi interrompida há ${mins} min.` +
        (d.roomCode ? ' Os convidados voltam sozinhos quando a sala reabrir.' : '');
      box.style.display = 'flex';
      // O log da partida vem do IndexedDB: espera ele carregar para continuar na mesma partida
      document.getElementById('btn-resume').onclick = () => {
        LoggerModule.ready.then(() => resumeHostMatch(d), () => resumeHostMatch(d));
      };
      document.getElementById('btn-resume-discard').onclick = () => {
        Store.remove(RESUME_KEY);
        box.style.display = 'none';
        nlog('host_resume_discarded', { awayS: Math.round((Date.now() - d.at) / 1000) });
      };
    }

    function resumeHostMatch(d) {
      document.getElementById('resume-box').style.display = 'none';
      SoundEngine.init();
      isHost = true;
      lobbySlots = d.lobbySlots;
      Object.keys(guestSecrets).forEach(k => { delete guestSecrets[k]; });
      Object.assign(guestSecrets, d.guestSecrets || {});
      sessionRecords = Array.isArray(d.sessionRecords) ? d.sessionRecords : [];
      currentMode = d.mode || 'normal';
      matchStartedAt = d.matchStartedAt || Date.now();
      matchActionCount = d.matchActionCount || 0;
      turboMode = false;
      coachOpen = false;
      speedLock = false;
      G = d.G;
      // Os convidados podem ter recebido uma versão um pouco mais nova: a retomada passa à frente
      G.version = (G.version || 0) + 1000;
      G.turbo = false;
      const logOk = LoggerModule.resumeSession(d.log);
      nlog('host_resumed', { phase: G.phase, actions: matchActionCount, online: !!d.roomCode, awayS: Math.round((Date.now() - d.at) / 1000), log: logOk });
      // Os convidados estão fora até reconectarem: um bot joga por eles (como numa queda)
      const away = G.players.filter(p => p.id !== myPlayerId && p.type === 'human');
      away.forEach(p => {
        p.type = 'bot';
        p.persona = 'medium';
        markReadyByTakeover(p);
        p.disconnected = true;
      });
      G.bannerText = away.length
        ? 'Partida retomada! Os convidados estão voltando — um bot joga por eles até reconectarem.'
        : 'Partida retomada!';
      renderScoreboard();
      selectedHandIds.clear();
      selectedOpenIds.clear();
      document.getElementById('modal-gameover').classList.remove('active');
      document.getElementById('screen-lobby').classList.remove('active');
      document.getElementById('screen-game').classList.add('active');
      if (d.roomCode) {
        setRoomLocked(!!d.roomLocked);
        createHostRoom(0, { code: d.roomCode, resume: true });
      }
      renderGame();
      if (G.phase === 'SWAP' && G.players.every(p => p.readySwap)) evaluateStartAndDirection();
      else if (G.phase === 'SPEED_TIE' && G.tieContext) startBotSpeedTaps(G.tieContext.candidates);
      scheduleBotIfNeeded();
      saveHostResume();
    }

    // Página sendo fechada/escondida: grava na hora (não espera a próxima jogada)
    window.addEventListener('pagehide', () => writeHostResume());
    document.addEventListener('visibilitychange', () => { if (document.hidden) writeHostResume(); });

    // opts (usado pelo replay): { seed, rules, slots } — sem eles, sorteia uma semente nova
    // e usa as regras e os lugares do lobby, como sempre.
    function startNewMatch(isRematch = false, mode = null, opts = {}) {
      if (mode) currentMode = mode;
      turboMode = false;
      coachOpen = false;
      document.getElementById('coach-bubble').classList.remove('show');
      SoundEngine.init();
      SoundEngine.slide();
      const rules = opts.rules ? { ...opts.rules } : (currentMode === 'tutorial'
        ? { decks: 1, jokers: 1, p2: true, draw2: 1, p7: true, p10: true, after10: 'next', pjoker: true, multijoker: 'once', p48: true, mode48: 'sequence', burn48: false, bigPile: 12 }
        : getRulesFromUI());
      // O motor embaralha, sorteia os lugares e distribui. A semente é secreta: fica só no
      // host e no log dele (nunca entra em G, que vai pela rede).
      const dealt = Core.deal({
        rules,
        slots: opts.slots || buildSlotsForMode(currentMode),
        seed: Rng.isSeed(opts.seed) ? opts.seed : Rng.newSeed(),
        mode: currentMode
      });
      matchStartedAt = Date.now();
      matchActionCount = 0;
      const players = dealt.state.players;
      players.forEach(p => { if (!p.avatar) p.avatar = AvatarModule.getDefaultAvatar(p.type, p.persona); });

      if (!isRematch) {
        LoggerModule.initNewSession(rules, players);
      }
      LoggerModule.startMatchLog(rules, players, { seed: dealt.seed, mode: currentMode, lobby: dealt.lobby });
      LoggerModule.setMatchMode(currentMode, { online: clientConns.length > 0, guestsConnected: clientConns.length });

      G = dealt.state;

      G.players.forEach((p, idx) => {
        if (p.type !== 'bot') return;
        AIEngine.performInitialSwap(G, idx);
        LoggerModule.logSwap(p, p.open, p.hand);
      });

      selectedHandIds.clear();
      selectedOpenIds.clear();
      swapHandId = null;

      document.getElementById('screen-lobby').classList.remove('active');
      document.getElementById('screen-game').classList.add('active');
      document.getElementById('modal-gameover').classList.remove('active');
      document.getElementById('modal-speed').classList.remove('active');

      broadcastState({ kind: 'SLIDE_INIT', sfxTag: 'SLIDE' });
      renderGame();
      saveHostResume();

      // Todos são bots (simulação): começa sozinho após a preparação
      if (G.players.every(p => p.readySwap)) {
        setTimeout(() => { if (G && G.phase === 'SWAP') evaluateStartAndDirection(); }, 900);
      }
    }

    // Todos prontos: o motor decide quem começa (ou abre o duelo de velocidade)
    function evaluateStartAndDirection() {
      if (!G) return;
      runCoreEvents(Core.startIfReady(G));
      saveHostResume();
    }

    // Duelo de velocidade: cada bot empatado "toca" depois de um tempo sorteado
    function startBotSpeedTaps(candidates) {
      candidates.forEach(cIdx => {
        const p = G.players[cIdx];
        if (p.type === 'bot') {
          const delay = 750 + Math.random() * 1350;
          setTimeout(() => {
            if (G && G.phase === 'SPEED_TIE' && !speedLock) {
              handleSpeedTieWin(cIdx);
            }
          }, delay);
        }
      });
    }

    function handleSpeedTieWin(winnerIdx) {
      if (!G || G.phase !== 'SPEED_TIE' || speedLock) return;
      if (!G.tieContext.candidates.includes(winnerIdx)) return;
      speedLock = true;
      // O duelo depende de quem tocou primeiro: o replay usa o vencedor gravado
      recordReplayAction(G.players[winnerIdx].id, { type: 'SPEED_WIN', idx: winnerIdx });

      runCoreEvents(Core.speedWin(G, winnerIdx).events);
      saveHostResume();
    }

    function attemptLocalPlay(handIds, openIds, fromRect = null) {
      if (!G || G.phase !== 'PLAY') return false;
      const me = G.players.find(p => p.id === myPlayerId) || G.players[0];
      const myIdx = G.players.indexOf(me);

      if (G.turnIdx !== myIdx) {
        showInvalidWarning('Aguarde a sua vez de jogar!');
        return false;
      }

      const handChosen = me.hand.filter(c => handIds.includes(c.id));
      const openChosen = me.open.filter(c => openIds.includes(c.id));
      const allChosen = [...handChosen, ...openChosen];

      if (allChosen.length === 0) {
        showInvalidWarning('Selecione pelo menos uma carta para jogar!');
        return false;
      }

      const firstVal = allChosen[0].val;
      if (!allChosen.every(c => c.val === firstVal)) {
        showInvalidWarning('As cartas jogadas juntas devem ter o mesmo valor!');
        return false;
      }

      if (handChosen.length === 0 && me.hand.length > 0) {
        showInvalidWarning('Você precisa acabar com as cartas da mão antes de jogar as da mesa!');
        return false;
      }

      if (openChosen.length > 0 && G.deck.length > 0) {
        showInvalidWarning('Ainda há cartas no baralho: as cartas da mesa só valem depois que ele acabar!');
        return false;
      }

      if (handChosen.length > 0 && openChosen.length > 0) {
        if (G.deck.length > 0 || handChosen.length !== me.hand.length) {
          showInvalidWarning('Só é possível combinar cartas da mesa com a última jogada da mão quando o baralho zerar!');
          return false;
        }
      }

      if (!RulesEngine.isCardPlayable(G, allChosen[0])) {
        showInvalidWarning(RulesEngine.getInvalidMoveReason(G, allChosen[0]));
        return false;
      }

      sendOrExecuteAction({ type: 'PLAY_CARDS', handIds, openIds, fromRect });
      return true;
    }

    function sendOrExecuteAction(action) {
      if (isHost) {
        executePlayerAction(myPlayerId, action);
      } else if (hostConn) {
        netSend(hostConn, { type: 'ACTION', playerId: myPlayerId, action });
      }
    }

    // Porta de entrada de todas as ações (você, convidados e bots): grava para o replay
    // e aplica. Só grava o que poderia valer naquele momento (fase e vez certas).
    function executePlayerAction(playerId, action) {
      if (!G || !action) return;
      const pIdx = G.players.findIndex(p => p.id === playerId);
      if (pIdx === -1) return;
      const t = action.type;
      const plausible = (G.phase === 'SWAP' && (t === 'SWAP_CARDS' || t === 'READY_SWAP')) ||
        (G.phase === 'PLAY' && pIdx === G.turnIdx && (t === 'PLAY_CARDS' || t === 'PICKUP_PILE' || t === 'PLAY_BLIND'));
      if (plausible) recordReplayAction(playerId, action);
      applyPlayerAction(playerId, action);
      if (plausible) recordReplayCheck();
      saveHostResume();
    }

    function applyPlayerAction(playerId, action) {
      const pIdx = G.players.findIndex(p => p.id === playerId);
      if (pIdx === -1) return;
      // Duelo de velocidade: quem tocou primeiro é decidido aqui (relógio do host)
      if (action.type === 'SPEED_TAP') {
        if (G.phase === 'SPEED_TIE') handleSpeedTieWin(pIdx);
        return;
      }
      runCoreEvents(Core.apply(G, playerId, action).events, action.fromRect || null);
    }

    /* Tudo o que acontece em volta de uma jogada (tela, som, animação, log, rede, bots)
       sai dos eventos que o motor devolve, na ordem em que aconteceram.
       fromRect: de onde a carta saiu na tela (só para a animação de quem jogou aqui). */
    function runCoreEvents(events, fromRect = null) {
      const byId = (id) => G.players.find(p => p.id === id);
      const fly = (fx, withRect) => triggerFlightVisual({ ...fx, isMe: fx.actorId === myPlayerId, ...(withRect ? { fromRect } : {}) });
      for (const ev of events) {
        switch (ev.type) {
          case 'turnLog':
            LoggerModule.logTurn(ev.entry);
            break;
          case 'swapped':
            if (ev.ok) SoundEngine.slide();
            broadcastState({ kind: 'SWAP', sfxTag: 'SLIDE' });
            renderGame();
            break;
          case 'ready': {
            const p = byId(ev.playerId);
            LoggerModule.logSwap(p, p.open, p.hand);
            SoundEngine.select();
            break;
          }
          case 'changed':
            broadcastState();
            renderGame();
            break;
          case 'seated':
            nlog('seating', { order: ev.order.map(shortId) });
            SoundEngine.power2();
            broadcastState();
            renderGame();
            scheduleBotIfNeeded();
            break;
          case 'speedTie':
            speedLock = false;
            SoundEngine.power7();
            broadcastState();
            renderGame();
            startBotSpeedTaps(ev.candidates);
            break;
          case 'pickup':
            G.pickupStamp = Date.now() + Math.random(); // libera o GOMBRA! por 10 s
            break;
          case 'blindFail':
            if (ev.playerId === myPlayerId) {
              showInvalidWarning(`Carta fechada (${ev.card.label}${ev.card.suit}) menor que o monte! Você recolheu tudo.`);
            }
            break;
          case 'flight':
            fly(ev.fx, ev.useFromRect);
            break;
          case 'botReact':
            maybeBotReact(byId(ev.playerId), ev.kind, ev.count);
            break;
          case 'gameOver': {
            const loser = byId(ev.loserId);
            G.loserAvatar = loser.avatar || AvatarModule.getDefaultAvatar(loser.type, loser.persona);
            turboMode = false;
            recordMatchResult(); // simulação e tutorial não contam
            LoggerModule.logMatchEnd(loser.name, {
              actions: matchActionCount + 0, turnCounter: G.turnCounter || 0, loserId: loser.id,
              escapeOrder: (G.escapeOrder || []).slice(), burned: G.burnedCount || 0, digest: stateDigest(G)
            });
            fly(ev.fx, true);
            broadcastState(ev.fx);
            renderGame();
            break;
          }
          case 'turnAdvanced':
            selectedHandIds.clear();
            selectedOpenIds.clear();
            if (turboShouldPaint()) {
              broadcastState(ev.fx);
              renderGame();
            }
            scheduleBotIfNeeded();
            break;
          default:
            break;
        }
      }
    }

    const BOT_DELAY_MS = 950;
    const TURBO_DELAY_MS = 45;

    function scheduleBotIfNeeded() {
      if (!isHost || !G || G.phase !== 'PLAY') return;
      clearTimeout(aiTimeout);
      if (coachOpen) return; // tutorial pausado enquanto o balão está aberto
      const current = G.players[G.turnIdx];
      if (!current || current.type !== 'bot') return;

      const run = () => {
        if (!G || G.phase !== 'PLAY' || coachOpen) return;
        const decision = AIEngine.decideTurnAction(G, G.turnIdx);
        if (decision) executePlayerAction(current.id, decision);
      };
      if (turboMode) {
        // Acelerado: próxima jogada imediatamente (MessageChannel não sofre o atraso mínimo de 4 ms dos timers)
        const mc = new MessageChannel();
        mc.port1.onmessage = run;
        mc.port2.postMessage(0);
        return;
      }
      aiTimeout = setTimeout(run, BOT_DELAY_MS);
    }

    // No modo acelerado, redesenhar/enviar a mesa a cada jogada é o que mais pesa:
    // limita a ~8 atualizações por segundo (o fim da partida sempre é enviado)
    let lastTurboPaint = 0;
    function turboShouldPaint() {
      if (!turboMode || !G || G.phase !== 'PLAY') return true;
      const now = Date.now();
      if (now - lastTurboPaint < 120) return false;
      lastTurboPaint = now;
      return true;
    }

    /* ==========================================================================
       10. INTERAÇÃO DE PONTEIRO UNIFICADA (MOUSE + TOUCH)
       - Toque: seleciona | toque duplo: joga | arrastar até a mesa: joga
       - Segurar 2 s numa carta da mão: seleciona todas do mesmo valor
       - Na mão, deslizar na horizontal rola as cartas (touch-action: pan-x)
       ========================================================================== */
    const LONG_PRESS_MS = 2000;
    let lastTapInfo = { id: null, t: 0 };

    function attachCardInteraction(domEl, card, sourceType, me, isMyTurn) {
      let startX = 0;
      let startY = 0;
      let isDragging = false;
      let ghostEl = null;
      let longPressTimer = null;
      let holdVisualTimer = null;
      let longPressFired = false;

      domEl.addEventListener('contextmenu', (e) => e.preventDefault());

      domEl.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        SoundEngine.init();
        startX = e.clientX;
        startY = e.clientY;
        isDragging = false;
        longPressFired = false;
        try { domEl.setPointerCapture(e.pointerId); } catch (err) {}

        // Segurar para selecionar todas as cartas iguais da mão
        if (sourceType === 'hand' && G && G.phase === 'PLAY' && isMyTurn) {
          domEl.style.setProperty('--lp-ms', `${LONG_PRESS_MS - 250}ms`);
          holdVisualTimer = setTimeout(() => domEl.classList.add('long-pressing'), 250);
          longPressTimer = setTimeout(() => {
            longPressFired = true;
            domEl.classList.remove('long-pressing');
            selectAllSameValue(me, card);
          }, LONG_PRESS_MS);
        }

        const cancelLongPress = () => {
          clearTimeout(holdVisualTimer);
          clearTimeout(longPressTimer);
          holdVisualTimer = null;
          longPressTimer = null;
          domEl.classList.remove('long-pressing');
        };

        const cleanup = (ev) => {
          cancelLongPress();
          try { domEl.releasePointerCapture(ev.pointerId); } catch (err) {}
          domEl.removeEventListener('pointermove', onPointerMove);
          domEl.removeEventListener('pointerup', onPointerUp);
          domEl.removeEventListener('pointercancel', onPointerCancel);
          domEl.classList.remove('dragging-source');
          clearDropHighlights();
          if (ghostEl) { ghostEl.remove(); ghostEl = null; }
        };

        const onPointerMove = (moveEv) => {
          const dx = moveEv.clientX - startX;
          const dy = moveEv.clientY - startY;
          if (Math.hypot(dx, dy) > 8) cancelLongPress();

          // Na mão, gesto horizontal é rolagem (o navegador assume e dispara pointercancel)
          if (!isDragging && Math.hypot(dx, dy) > 8) {
            if (sourceType === 'hand' && e.pointerType !== 'mouse' && Math.abs(dx) > Math.abs(dy)) return;
            isDragging = true;
            SoundEngine.select();
            domEl.classList.add('dragging-source');
            ghostEl = createCardDOM(card, sourceType === 'closed');
            ghostEl.classList.add('drag-ghost');

            let dragCount = 1;
            if (G.phase === 'PLAY') {
              const inSel = (sourceType === 'hand' && selectedHandIds.has(card.id)) ||
                (sourceType === 'open' && selectedOpenIds.has(card.id));
              if (inSel) dragCount = selectedHandIds.size + selectedOpenIds.size;
            }
            if (dragCount > 1) {
              const badge = document.createElement('div');
              badge.className = 'drag-count-badge';
              badge.textContent = `x${dragCount}`;
              ghostEl.appendChild(badge);
            }
            document.getElementById('fx-layer').appendChild(ghostEl);
          }

          if (isDragging && ghostEl) {
            ghostEl.style.left = `${moveEv.clientX}px`;
            ghostEl.style.top = `${moveEv.clientY}px`;
            highlightDropTargets(moveEv.clientX, moveEv.clientY, sourceType);
          }
        };

        // Cancelado pelo navegador (ex.: rolagem da mão): só limpa, nunca conta como toque
        const onPointerCancel = (cancelEv) => cleanup(cancelEv);

        const onPointerUp = (upEv) => {
          const wasDragging = isDragging;
          const dropRect = ghostEl ? ghostEl.getBoundingClientRect() : domEl.getBoundingClientRect();
          cleanup(upEv);

          if (longPressFired) return;
          if (wasDragging) {
            handleCardDrop(upEv.clientX, upEv.clientY, card, sourceType, me, isMyTurn, dropRect, domEl);
            return;
          }
          // O 1º toque redesenha a mão (novo elemento), então o toque anterior fica guardado por carta
          const now = Date.now();
          const lastTapTime = lastTapInfo.id === card.id ? lastTapInfo.t : 0;
          lastTapInfo = { id: card.id, t: now };
          if (G.phase === 'PLAY' && now - lastTapTime < 380 && sourceType !== 'closed') {
            lastTapInfo = { id: null, t: 0 };
            const ids = sourceType === 'hand'
              ? (selectedHandIds.has(card.id) ? [Array.from(selectedHandIds), Array.from(selectedOpenIds)] : [[card.id], []])
              : (selectedOpenIds.has(card.id) ? [Array.from(selectedHandIds), Array.from(selectedOpenIds)] : [[], [card.id]]);
            attemptLocalPlay(ids[0], ids[1], domEl.getBoundingClientRect());
            return;
          }
          handleCardTap(card, sourceType, me, isMyTurn, domEl);
        };

        domEl.addEventListener('pointermove', onPointerMove);
        domEl.addEventListener('pointerup', onPointerUp);
        domEl.addEventListener('pointercancel', onPointerCancel);
      });
    }

    function selectAllSameValue(me, card) {
      if (!G || G.phase !== 'PLAY') return;
      const same = me.hand.filter(c => !c.isJoker && !card.isJoker ? c.val === card.val : c.isJoker && card.isJoker);
      selectedHandIds.clear();
      selectedOpenIds.clear();
      same.forEach(c => selectedHandIds.add(c.id));
      safeVibrate(30);
      SoundEngine.select();
      renderGame();
    }

    function highlightDropTargets(x, y, sourceType) {
      clearDropHighlights();
      if (!G) return;

      if (G.phase === 'SWAP') {
        if (sourceType === 'hand') {
          document.querySelectorAll('.open-over').forEach(el => {
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
              el.classList.add('drop-target-glow');
            }
          });
        } else if (sourceType === 'open') {
          document.querySelectorAll('#my-hand-cards .playing-card').forEach(el => {
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
              el.classList.add('drop-target-glow');
            }
          });
        }
      } else if (G.phase === 'PLAY') {
        const felt = document.getElementById('center-drop-zone');
        const discard = document.getElementById('discard-pile-visual');
        const r = felt.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          felt.classList.add('drop-ready');
          discard.classList.add('highlight-drop');
        }
      }
    }

    function clearDropHighlights() {
      document.querySelectorAll('.drop-target-glow').forEach(el => el.classList.remove('drop-target-glow'));
      document.getElementById('center-drop-zone')?.classList.remove('drop-ready');
      document.getElementById('discard-pile-visual')?.classList.remove('highlight-drop');
    }

    function handleCardDrop(x, y, card, sourceType, me, isMyTurn, dropRect, domEl) {
      if (!G) return;

      if (G.phase === 'SWAP' && !me.readySwap) {
        if (sourceType === 'hand') {
          for (const el of document.querySelectorAll('.open-over')) {
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && el.dataset.cardId) {
              sendOrExecuteAction({ type: 'SWAP_CARDS', handId: card.id, openId: el.dataset.cardId });
              swapHandId = null;
              return;
            }
          }
        } else if (sourceType === 'open') {
          for (const el of document.querySelectorAll('#my-hand-cards .playing-card')) {
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && el.dataset.cardId) {
              sendOrExecuteAction({ type: 'SWAP_CARDS', handId: el.dataset.cardId, openId: card.id });
              swapHandId = null;
              return;
            }
          }
        }
        return;
      }

      if (G.phase === 'PLAY') {
        const felt = document.getElementById('center-drop-zone').getBoundingClientRect();
        if (x >= felt.left && x <= felt.right && y >= felt.top && y <= felt.bottom) {
          if (!isMyTurn) {
            showInvalidWarning('Aguarde a sua vez de jogar!', domEl);
            return;
          }
          if (sourceType === 'closed') {
            if (me.hand.length > 0 || me.open.length > 0) {
              showInvalidWarning('Jogue todas as cartas da mão e as abertas antes de virar as fechadas!', domEl);
              return;
            }
            sendOrExecuteAction({ type: 'PLAY_BLIND', cardId: card.id, fromRect: dropRect });
            return;
          }

          let hIds = [];
          let oIds = [];
          if (sourceType === 'hand') {
            if (selectedHandIds.has(card.id)) {
              hIds = Array.from(selectedHandIds);
              oIds = Array.from(selectedOpenIds);
            } else {
              hIds = [card.id];
            }
          } else if (sourceType === 'open') {
            if (selectedOpenIds.has(card.id)) {
              hIds = Array.from(selectedHandIds);
              oIds = Array.from(selectedOpenIds);
            } else {
              oIds = [card.id];
            }
          }

          const ok = attemptLocalPlay(hIds, oIds, dropRect);
          if (!ok) {
            domEl.classList.add('shake-error');
            setTimeout(() => domEl.classList.remove('shake-error'), 400);
          }
        }
      }
    }

    function handleCardTap(card, sourceType, me, isMyTurn, domEl) {
      if (!G) return;

      if (G.phase === 'SWAP' && !me.readySwap) {
        if (sourceType === 'hand') {
          SoundEngine.select();
          swapHandId = swapHandId === card.id ? null : card.id;
          renderGame();
        } else if (sourceType === 'open') {
          if (swapHandId) {
            sendOrExecuteAction({ type: 'SWAP_CARDS', handId: swapHandId, openId: card.id });
            swapHandId = null;
          } else {
            showInvalidWarning('Toque primeiro em uma carta da mão (ou arraste-a) para trocar com a mesa!');
          }
        }
        return;
      }

      if (G.phase === 'PLAY') {
        if (!isMyTurn) {
          showInvalidWarning('Aguarde a sua vez de jogar!', domEl);
          return;
        }
        if (sourceType === 'closed') {
          if (me.hand.length > 0 || me.open.length > 0) {
            showInvalidWarning('Você só pode virar as cartas fechadas quando acabar com a mão e as abertas!', domEl);
            return;
          }
          sendOrExecuteAction({ type: 'PLAY_BLIND', cardId: card.id, fromRect: domEl.getBoundingClientRect() });
          return;
        }
        if (sourceType === 'hand') {
          toggleSelectHandCard(me, card);
        } else if (sourceType === 'open') {
          toggleSelectOpenCard(me, card, domEl);
        }
      }
    }

    /* ==========================================================================
       11. RENDERIZAÇÃO: MESA REDONDA, PILHAS 3D, PLACAR E FIM DE JOGO
       ========================================================================== */
    // 💀 -X ao lado de cada jogador: derrotas nesta sessão da sala
    function scoreFor(player) {
      if (!player) return '';
      const map = isHost ? sessionLossesForTable() : ((G && G.sessionLosses) || {});
      const v = map[player.id] || 0;
      return v > 0 ? `💀 -${v}` : '';
    }

    function renderTurnSequenceBar(meIdx) {
      const seqBar = document.getElementById('turn-sequence-bar');
      seqBar.innerHTML = '';
      if (!G) return;

      const nextIdx = G.phase === 'PLAY' ? RulesEngine.getNextActivePlayerIndex(G, G.turnIdx) : -1;
      const n = G.players.length;
      // Mostra na ordem real de jogada, começando por quem está jogando
      const startIdx = G.phase === 'PLAY' ? G.turnIdx : 0;
      const order = [];
      for (let k = 0; k < n; k++) order.push(((startIdx + k * G.direction) % n + n) % n);

      order.forEach((idx, k) => {
        const p = G.players[idx];
        const node = document.createElement('div');
        const isCurrent = G.phase === 'PLAY' && idx === G.turnIdx;
        const isNext = G.phase === 'PLAY' && idx === nextIdx && idx !== G.turnIdx;
        // Só quem está jogando mostra o nome; os demais aparecem pelo avatar (cabe em qualquer celular)
        const compact = G.phase === 'PLAY' ? !isCurrent : n > 3;
        node.className = 'seq-node' + (isCurrent ? ' seq-active' : '') + (isNext ? ' seq-next' : '') + (p.escaped ? ' seq-escaped' : '') + (compact ? ' seq-compact' : '');
        node.title = p.name + (isCurrent ? ' — vez' : (isNext ? ' — próximo' : ''));
        const avatarSrc = p.avatar || AvatarModule.getDefaultAvatar(p.type, p.persona);
        const tag = isCurrent ? ' · VEZ' : '';
        node.innerHTML = `<img src="${esc(avatarSrc)}" alt="" /><span>${idx === meIdx && G.mode !== 'sim' ? 'Você' : esc(p.name.split(' ')[0])}${tag}</span>`;
        seqBar.appendChild(node);
        if (k < n - 1) {
          const arrow = document.createElement('span');
          arrow.className = 'seq-arrow';
          arrow.textContent = '›';
          seqBar.appendChild(arrow);
        }
      });
    }

    // Posições dos adversários num arco elíptico (o jogador local fica na base)
    // compact: mesa apertada → arco mais achatado (assentos laterais mais altos, longe das pilhas)
    function seatPositions(count, compact = false) {
      const out = [];
      const drop = compact ? 14 : 36;
      // Mesa apertada com 4+ adversários: espaçamento horizontal uniforme (ninguém encosta no vizinho)
      const even = compact && count >= 4;
      for (let i = 0; i < count; i++) {
        const theta = Math.PI + (i + 1) * (Math.PI / (count + 1)); // de 180° (esquerda) a 360° (direita) pelo topo
        out.push({
          left: even ? ((i + 0.5) * 100) / count : 50 + 41 * Math.cos(theta),
          top: 1 + drop * (1 + Math.sin(theta)) // âncora no topo do assento
        });
      }
      return out;
    }

    function renderSeats(myIdx, nextIdx) {
      const oppArea = document.getElementById('opponents-area');
      oppArea.innerHTML = '';
      const total = G.players.length;
      // Mesa apertada (celular pequeno ou muitos jogadores): assentos compactos
      const opp = total - 1;
      const aw = oppArea.clientWidth, ah = oppArea.clientHeight;
      const compact = ah < 380 || (opp >= 4 && aw < 520) || (opp >= 3 && aw < 380 && ah < 460);
      oppArea.classList.toggle('seats-compact', compact);
      // Largura de cada assento compacto: cabe exatamente no espaço de cada um
      const seatW = Math.max(48, Math.min(76, Math.floor(oppArea.clientWidth / opp) - 4));
      oppArea.style.setProperty('--seat-w', compact ? `${seatW}px` : '');
      oppArea.classList.toggle('seats-tight', compact && seatW < 58); // muitos jogadores em tela estreita
      const positions = seatPositions(opp, compact);
      for (let offset = 1; offset < total; offset++) {
        // Sentido horário na tela: a partir de você (base) → esquerda → topo → direita
        const idx = (myIdx + offset) % total;
        const p = G.players[idx];
        const pos = positions[offset - 1];
        const isTurn = G.turnIdx === idx && G.phase === 'PLAY';
        const isNext = nextIdx === idx && G.phase === 'PLAY' && idx !== G.turnIdx;

        const seat = document.createElement('div');
        seat.className = 'seat' + (isTurn ? ' turn-active' : '') + (isNext ? ' next-active' : '') + (p.escaped ? ' safe-out' : '');
        seat.dataset.seatId = p.id;
        seat.style.left = `${pos.left}%`;
        seat.style.top = `${pos.top}%`;

        const miniTable = [0, 1, 2].map(i => {
          const o = p.open[i];
          const c = p.closed[i];
          if (o) return `<div class="mini-slot open-card ${o.isRed ? 'red' : ''}">${o.isJoker ? '★' : o.label}</div>`;
          if (c) return `<div class="mini-slot"></div>`;
          return `<div class="mini-slot empty"></div>`;
        }).join('');

        const status = p.escaped ? '✔ Salvo!' : (isTurn ? 'jogando…' : (isNext ? 'próximo' : ''));
        const avatarSrc = p.avatar || AvatarModule.getDefaultAvatar(p.type, p.persona);
        seat.innerHTML = `
          <div class="seat-avatar-wrap">
            <img class="seat-avatar" src="${esc(avatarSrc)}" alt="" />
            <span class="skull-badge">${scoreFor(p)}</span>
            <span class="seat-hand-pill" title="Cartas na mão">${p.hand.length}</span>
          </div>
          <div class="seat-name" title="${esc(p.name)}">${esc(p.type === 'bot' ? p.name.replace(/\s*\((Fácil|Médio|Difícil)\)\s*$/, '') : p.name)}</div>
          <div class="opp-mini-table">${miniTable}</div>
          <div class="seat-status">${status}</div>`;
        oppArea.appendChild(seat);
      }
    }

    function renderDrawPile() {
      const stack = document.getElementById('draw-pile-visual');
      const top = stack.querySelector('.deck-top');
      const n = G.deck.length;
      document.getElementById('lbl-deck-count').textContent = n;
      document.getElementById('lbl-deck-badge').textContent = n;
      stack.classList.toggle('empty', n === 0);
      // Espessura 3D: uma "lâmina" de borda para cada ~4 cartas (máx. 10)
      const layers = Math.min(10, Math.ceil(n / 4));
      const shadows = [];
      for (let i = 1; i <= layers; i++) {
        shadows.push(`${i * 0.6}px ${i * 1.1}px 0 ${i % 2 ? '#e2e8f0' : '#94a3b8'}`);
      }
      shadows.push(`${layers * 0.6 + 2}px ${layers * 1.1 + 4}px 8px rgba(0,0,0,0.55)`);
      top.style.boxShadow = shadows.join(', ');
      top.style.transform = `translate(${-layers * 0.6}px, ${-layers * 1.1}px)`;
    }

    function renderBurnedPile() {
      const el = document.getElementById('burned-pile-visual');
      const n = G.burnedCount || 0;
      document.getElementById('lbl-burned-badge').textContent = n;
      const layers = Math.min(6, Math.ceil(n / 4));
      if (el.childElementCount === layers) return; // evita recriar sem necessidade
      el.innerHTML = '';
      for (let i = 0; i < layers; i++) {
        const c = createCardDOM(null, true);
        const j = cardJitter({ id: 'burn' + i });
        c.style.transform = `translate(${(j * 6 - 3).toFixed(1)}px, ${-i * 1.5}px) rotate(${(j * 30 - 15).toFixed(1)}deg)`;
        el.appendChild(c);
      }
    }

    let wasPileTense = false;
    function renderDiscardPileMessy() {
      const discardEl = document.getElementById('discard-pile-visual');
      discardEl.innerHTML = '';
      const totalCards = G.discard.length;
      const badge = document.getElementById('lbl-discard-badge');
      badge.textContent = `Monte ${totalCards}`;
      // Tensão: a partir do limite, o feltro pulsa em vermelho e acelera conforme o monte cresce
      const limit = bigPileThreshold();
      const tense = totalCards >= limit && G.phase === 'PLAY';
      const tension = tense ? Math.min(1, (totalCards - limit) / limit) : 0;
      const felt = document.getElementById('center-drop-zone');
      felt.classList.toggle('pile-tension', tense);
      felt.style.setProperty('--tension', tension.toFixed(2));
      discardEl.classList.toggle('pile-tension', tense);
      discardEl.style.setProperty('--tension', tension.toFixed(2));
      badge.classList.toggle('pile-hot', tense);
      if (tense) badge.textContent = `🔥 Monte ${totalCards} 🔥`;
      if (tense && !wasPileTense && !turboMode) SoundEngine.heartbeat();
      wasPileTense = tense;
      if (totalCards === 0) return;

      const groups = G.discardPlayGroups && G.discardPlayGroups.length > 0
        ? G.discardPlayGroups
        : [{ playerName: '', cards: G.discard.slice(-2) }];
      const lastGroup = groups[groups.length - 1];
      const penultimateGroup = groups.length >= 2 ? groups[groups.length - 2] : null;
      const visibleCount = lastGroup.cards.length + (penultimateGroup ? penultimateGroup.cards.length : 0);
      const olderCards = G.discard.slice(0, Math.max(0, totalCards - visibleCount));

      // Base volumosa: as cartas soterradas formam um bolo bagunçado (estável entre renders)
      const step = Math.max(1, Math.ceil(olderCards.length / 9));
      let layer = 0;
      for (let i = 0; i < olderCards.length; i += step) {
        const c = olderCards[i];
        const dom = createCardDOM(c, false);
        dom.classList.add('pile-body');
        const jx = cardJitter(c, 'x') * 16 - 8;
        const jr = cardJitter(c, 'r') * 50 - 25;
        dom.style.transform = `translate(${jx.toFixed(1)}px, ${(4 - layer * 0.8).toFixed(1)}px) rotate(${jr.toFixed(1)}deg) scale(0.96)`;
        discardEl.appendChild(dom);
        layer++;
      }

      // Penúltima jogada (à esquerda, levemente escurecida)
      if (penultimateGroup) {
        penultimateGroup.cards.forEach((c, idx) => {
          const dom = createCardDOM(c, false);
          const angle = -16 + idx * 7 + cardJitter(c, 'p') * 6;
          dom.style.transform = `translate(${-20 + idx * 9}px, ${-6 + idx * 2}px) rotate(${angle.toFixed(1)}deg) scale(0.95)`;
          dom.style.filter = 'brightness(0.82)';
          discardEl.appendChild(dom);
        });
      }

      // Última jogada (topo, espalhada e nítida)
      lastGroup.cards.forEach((c, idx) => {
        const dom = createCardDOM(c, false);
        const baseX = penultimateGroup ? 14 : 0;
        const baseY = penultimateGroup ? 5 : 0;
        const angle = (cardJitter(c, 'l') * 26 - 13);
        dom.style.transform = `translate(${baseX + idx * 11}px, ${baseY + (idx % 2 ? -3 : 2)}px) rotate(${angle.toFixed(1)}deg)`;
        dom.style.boxShadow = '0 6px 14px rgba(0,0,0,0.55)';
        discardEl.appendChild(dom);
      });

      // Selos "quem jogou": fora das cartas (que são giradas) para nunca ficarem escondidos
      // atrás da carta de cima — penúltima jogada à esquerda, última à direita
      if (penultimateGroup) {
        const tag = document.createElement('div');
        tag.className = 'discard-play-tag tag-prev';
        tag.textContent = `${penultimateGroup.playerName.split(' ')[0]} ${penultimateGroup.cards.length}x`;
        discardEl.appendChild(tag);
      }
      const lastTag = document.createElement('div');
      lastTag.className = 'discard-play-tag tag-latest';
      lastTag.textContent = `${(lastGroup.playerName || 'Topo').split(' ')[0]} ${lastGroup.cards.length}x`;
      discardEl.appendChild(lastTag);
    }

    // Mão recolhida/aberta (a camada ampliada fica sobre a mesa e não empurra o layout)
    let handOpen = false;
    let lastHandKey = '';
    function setHandOpen(open) {
      handOpen = !!open;
      document.getElementById('player-zone').classList.toggle('hand-open', handOpen);
      placeTableCards();
    }

    // Cartas da mesa: no feltro com a mão recolhida; dentro da camada com a mão ampliada
    function placeTableCards() {
      const el = document.getElementById('my-table-cards');
      const target = document.getElementById(handOpen ? 'layer-table-slot' : 'my-table-slot');
      if (el && target && el.parentElement !== target) target.appendChild(el);
    }

    function renderHandDock(me, sortedHand, hideHand, isMyTurn) {
      const fan = document.getElementById('dock-fan');
      const label = document.getElementById('dock-label');
      const dock = document.getElementById('hand-dock');
      const n = sortedHand.length;
      // Miniatura: cada valor aparece uma vez só (repetidas viram "×2", "×3"...)
      const groups = [];
      sortedHand.forEach(c => {
        const key = c.isJoker ? 'J' : c.val;
        const g = groups.find(x => x.key === key);
        if (g) g.n++;
        else groups.push({ key, label: c.isJoker ? '★' : c.label, joker: !!c.isJoker, red: !c.isJoker && c.isRed, n: 1 });
      });
      const cardHtml = g => `<span class="dock-card${g.joker ? ' joker' : ''}">${esc(g.label)}${g.n > 1 ? `<i>×${g.n}</i>` : ''}</span>`;
      const items = hideHand ? (n ? ['<span class="dock-card back"></span>'] : []) : groups.map(cardHtml);
      // Espaçamento: as miniaturas se sobrepõem só o necessário para caber na largura (fixa) do leque;
      // se não couber legível numa linha, usa duas
      const cardW = 24;
      const avail = fan.clientWidth;
      const fitStep = (k) => (k > 1 ? (avail - cardW) / (k - 1) : cardW);
      const twoRows = items.length > 1 && fitStep(items.length) < 13;
      const perRow = twoRows ? Math.ceil(items.length / 2) : items.length;
      const step = Math.max(10, Math.min(cardW + 3, fitStep(perRow)));
      fan.style.setProperty('--dock-step', `${step.toFixed(1)}px`);
      fan.classList.toggle('two-rows', twoRows);
      fan.innerHTML = twoRows
        ? `<span class="dock-row">${items.slice(0, perRow).join('')}</span><span class="dock-row">${items.slice(perRow).join('')}</span>`
        : `<span class="dock-row">${items.join('')}</span>`;
      label.innerHTML = me.escaped ? '✔ Escapou'
        : `${isMyTurn ? '<span class="dock-turn">⚡<span class="dock-turn-txt"> Vez</span></span>' : ''}<span class="dock-n">${n}</span><span class="dock-sub">na mão</span>`;
      dock.title = handOpen ? 'Recolher a mão' : 'Ampliar a mão';
      dock.disabled = n === 0 || hideHand;
      dock.style.visibility = me.escaped && n === 0 ? 'hidden' : 'visible';
    }

    function renderGame() {
      if (!G) return;
      sanitizeUIState();
      trackInteractionClocks();

      // Espectador: simulação local, ou convidado que entrou com a partida já em andamento
      const outsider = !G.players.some(p => p.id === myPlayerId);
      const spectator = G.mode === 'sim' || outsider;
      const hideHand = outsider && G.mode !== 'sim'; // não mostra a mão de outra pessoa
      const me = G.players.find(p => p.id === myPlayerId) || G.players[0];
      const myIdx = G.players.indexOf(me);
      const isMyTurn = !spectator && G.turnIdx === myIdx && G.phase === 'PLAY';
      const nextIdx = G.phase === 'PLAY' ? RulesEngine.getNextActivePlayerIndex(G, G.turnIdx) : -1;

      const dirEl = document.getElementById('lbl-direction');
      dirEl.innerHTML = G.direction === 1 ? '↻<span class="dir-text"> Horário</span>' : '↺<span class="dir-text"> Anti-horário</span>';
      dirEl.title = G.direction === 1 ? 'Sentido horário' : 'Sentido anti-horário';

      let constraintTxt = 'Monte livre';
      let hot = false;
      if (G.constraint7 && G.rules.p7) { constraintTxt = '7 no topo: jogue ≤ 7'; hot = true; }
      else if (G.freePlayAfter2) { constraintTxt = '2: jogue qualquer carta'; }
      else if (RulesEngine.hasJokerInDiscard(G)) { constraintTxt = '🃏 Coringa no monte'; hot = true; }
      else if (G.discard.length > 0) {
        const top = G.discard[G.discard.length - 1];
        constraintTxt = top.val === 15 && G.rules.p2 ? '2: jogue qualquer carta' : `Topo: ${top.label}${top.isJoker ? '' : top.suit} — jogue igual ou maior`;
      }
      const chip = document.getElementById('lbl-Constraint');
      chip.textContent = constraintTxt;
      chip.classList.toggle('rule-hot', hot);
      document.getElementById('status-banner').textContent = G.bannerText;

      renderTurnSequenceBar(myIdx);
      renderSeats(myIdx, nextIdx);
      renderDrawPile();
      renderBurnedPile();
      renderDiscardPileMessy();

      // Botão ⏩: aparece quando você já escapou (ou na simulação)
      const turboBtn = document.getElementById('btn-turbo');
      // ⏩ liberado na simulação ou quando todos que ainda têm cartas são bots (host ou convidado)
      const turboOn = turboMode || !!G.turbo;
      const canTurbo = G.phase === 'PLAY' && !turboOn && ((G.mode === 'sim' && isHost) || onlyBotsLeft());
      turboBtn.style.display = canTurbo ? 'inline-block' : 'none';
      const bigTurbo = document.getElementById('btn-turbo-big');
      const showBig = canTurbo && G.mode !== 'sim';
      bigTurbo.style.display = showBig ? 'block' : 'none';

      // Zona do jogador local
      const zone = document.getElementById('player-zone');
      zone.classList.toggle('my-turn', isMyTurn);
      document.getElementById('img-game-my-avatar').src = me.avatar || AvatarModule.getDefaultAvatar('human', null);
      document.getElementById('lbl-my-name-game').textContent = hideHand
        ? '👁 Você está assistindo — entra na próxima rodada'
        : (spectator ? `👁 Assistindo: ${me.name}` : me.name);
      document.getElementById('lbl-my-score').textContent = spectator ? '' : scoreFor(me);
      document.getElementById('lbl-my-hand-count').textContent =
        me.escaped ? '✔ Você escapou!' : (isMyTurn ? `⚡ Sua vez · ${me.hand.length} na mão` : `🃏 ${me.hand.length} na mão`);

      // Cartas da mesa (fechadas + abertas por cima)
      const myTableEl = document.getElementById('my-table-cards');
      myTableEl.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const stack = document.createElement('div');
        stack.className = 'table-stack';
        const closedCard = me.closed[i];
        const openCard = me.open[i];
        if (!closedCard && !openCard) stack.classList.add('empty-slot');
        if (closedCard) {
          const cDom = createCardDOM(closedCard, true);
          cDom.classList.add('closed-under');
          cDom.dataset.cardId = closedCard.id;
          if (!spectator) attachCardInteraction(cDom, closedCard, 'closed', me, isMyTurn);
          stack.appendChild(cDom);
        }
        if (openCard) {
          const oDom = createCardDOM(openCard, false);
          oDom.classList.add('open-over');
          oDom.dataset.cardId = openCard.id;
          if (selectedOpenIds.has(openCard.id)) oDom.classList.add('selected');
          if (isMyTurn && me.hand.length === 0 && G.deck.length === 0 && RulesEngine.isCardPlayable(G, openCard)) oDom.classList.add('playable');
          if (!spectator) attachCardInteraction(oDom, openCard, 'open', me, isMyTurn);
          stack.appendChild(oDom);
        }
        myTableEl.appendChild(stack);
      }

      // Mão (preserva a posição de rolagem entre renders)
      const myHandEl = document.getElementById('my-hand-cards');
      const prevScroll = myHandEl.scrollLeft;
      myHandEl.innerHTML = '';
      const sortedHand = [...me.hand].sort((a, b) => a.val - b.val);
      myHandEl.appendChild(Object.assign(document.createElement('div'), { className: 'hand-spacer' }));
      sortedHand.forEach(card => {
        const hDom = createCardDOM(card, hideHand);
        hDom.dataset.cardId = card.id;
        if (G.phase === 'SWAP' && swapHandId === card.id) hDom.classList.add('selected');
        if (G.phase === 'PLAY' && selectedHandIds.has(card.id)) hDom.classList.add('selected');
        if (isMyTurn && RulesEngine.isCardPlayable(G, card)) hDom.classList.add('playable');
        if (!spectator) attachCardInteraction(hDom, card, 'hand', me, isMyTurn);
        myHandEl.appendChild(hDom);
      });
      myHandEl.appendChild(Object.assign(document.createElement('div'), { className: 'hand-spacer' }));
      // Sobrepõe as cartas quando não cabem todas lado a lado
      const cw = parseFloat(getComputedStyle(myHandEl).getPropertyValue('--card-w')) || 58;
      myHandEl.classList.toggle('hand-dense', sortedHand.length * (cw + 6) > myHandEl.clientWidth - 16);
      myHandEl.scrollLeft = prevScroll;

      // Mão recolhida no canto (leque pequeno) + abertura automática na sua vez
      renderHandDock(me, sortedHand, hideHand, isMyTurn);
      const wantOpen = !spectator && me.hand.length > 0 &&
        ((G.phase === 'PLAY' && isMyTurn) || (G.phase === 'SWAP' && !me.readySwap));
      // Muda só quando começa/termina a SUA vez (ou a fase): fora da vez, se você abrir a mão ela fica aberta
      const handKey = `${G.phase}|${wantOpen ? 'on' + (G.turnCounter || 0) : 'off'}`;
      if (handKey !== lastHandKey) { lastHandKey = handKey; handOpen = wantOpen; }
      if (me.hand.length === 0 || hideHand) handOpen = false;
      zone.classList.toggle('hand-open', handOpen);
      zone.classList.toggle('spectating', spectator);
      placeTableCards();
      document.getElementById('my-table-slot').classList.toggle('no-cards', me.open.length + me.closed.length === 0);
      // Jogando pelas cartas da mesa (mão vazia): destaque no feltro
      document.getElementById('table-area').classList.toggle('player-zone-turn-table', isMyTurn && me.hand.length === 0 && !me.escaped);
      document.getElementById('lbl-hand-layer').textContent = G.phase === 'SWAP'
        ? 'Troca: toque na mão e depois numa aberta'
        : (isMyTurn ? `Sua vez · ${me.hand.length} na mão` : `Sua mão · ${me.hand.length}`);

      // Botões de ação
      const btnReady = document.getElementById('btn-ready-swap');
      const btnPlay = document.getElementById('btn-play-selected');
      const btnPickup = document.getElementById('btn-pickup-pile');
      const actionBar = btnReady.parentElement;
      actionBar.style.display = (spectator && !showBig) ? 'none' : 'flex';
      document.getElementById('reaction-bar').style.display = (spectator || G.mode === 'tutorial') ? 'none' : 'flex';

      if (G.phase === 'SWAP') {
        btnReady.style.display = 'block';
        btnReady.disabled = me.readySwap;
        btnReady.textContent = me.readySwap ? 'Aguardando outros...' : 'Pronto! Iniciar Jogo';
        btnPlay.style.display = 'none';
        btnPickup.style.display = 'none';
      } else {
        btnReady.style.display = 'none';
        btnPlay.style.display = me.escaped ? 'none' : 'block';
        btnPickup.style.display = me.escaped ? 'none' : 'block';

        const totalSel = selectedHandIds.size + selectedOpenIds.size;
        btnPlay.disabled = !isMyTurn;
        btnPlay.textContent = totalSel > 0 ? `Jogar (${totalSel})` : 'Jogar Carta';

        const pickupStatus = RulesEngine.canPlayerPickupPile(G, me);
        btnPickup.disabled = !isMyTurn || G.discard.length === 0;
        if (isMyTurn && !RulesEngine.hasAnyPlayableMove(G, me) && G.discard.length > 0) {
          btnPickup.textContent = '😬 Recolher Monte'; // curto: não pode quebrar em 2 linhas no celular
          btnPickup.title = 'Sem jogada válida: recolha o monte';
          btnPickup.classList.add('pulse-btn');
        } else {
          btnPickup.textContent = (pickupStatus.allowed || G.discard.length === 0) ? 'Pegar Monte' : '🔒 Monte bloqueado';
          btnPickup.classList.remove('pulse-btn');
        }
      }

      // Modal de empate de velocidade
      const speedModal = document.getElementById('modal-speed');
      if (G.phase === 'SPEED_TIE' && G.tieContext) {
        const amInTie = !spectator && G.tieContext.candidates.includes(myIdx);
        speedModal.classList.add('active');
        document.getElementById('speed-title').textContent =
          G.tieContext.role === 'FIRST'
            ? `Empate na carta mais baixa (${G.tieContext.label})!`
            : `Empate para o 2º a jogar (${G.tieContext.label})!`;
        document.getElementById('speed-desc').textContent = amInTie
          ? 'Você está no empate! Toque primeiro para assumir!'
          : 'Aguardando os jogadores empatados reagirem...';
        document.getElementById('btn-speed-tap').style.display = amInTie ? 'block' : 'none';
      } else {
        speedModal.classList.remove('active');
      }

      // Tela de derrota com destaque para o perdedor
      const overModal = document.getElementById('modal-gameover');
      if (G.phase === 'GAMEOVER') {
        const wasActive = overModal.classList.contains('active');
        overModal.classList.add('active');
        document.getElementById('gameover-avatar').src = G.loserAvatar || AvatarModule.getDefaultAvatar('human', null);
        const loserIsMe = G.loserId === myPlayerId;
        document.getElementById('gameover-name').textContent = loserIsMe ? `${G.loserName} (você!)` : G.loserName;
        document.getElementById('gameover-text').textContent =
          G.mode === 'normal'
            ? (G.players.some(p => p.id === G.loserId && p.type === 'human') ? 'Sobrou com cartas por último e leva 💀 no placar.' : 'Sobrou com cartas por último! (bots não entram no placar)')
            : (G.mode === 'tutorial' ? 'Tutorial concluído! Agora você já sabe jogar. 🎉' : 'Simulação encerrada (não conta no placar).');
        // Ordem de saída desta partida + placar da sessão
        const medals = ['🥇', '🥈', '🥉'];
        const order = [...(G.escapeOrder || [])];
        G.players.forEach(p => { if (!order.includes(p.id) && p.id !== G.loserId) order.push(p.id); });
        if (G.loserId) order.push(G.loserId);
        const podium = order.map((id, i) => {
          const p = G.players.find(pl => pl.id === id);
          if (!p) return '';
          const icon = id === G.loserId ? '💩' : (medals[i] || `${i + 1}º`);
          const av = p.avatar || AvatarModule.getDefaultAvatar(p.type, p.persona);
          return `<div class="podium-item${id === G.loserId ? ' podium-loser' : ''}"><span class="podium-icon">${icon}</span><img class="avatar-sm" src="${esc(av)}" alt="" /><span class="podium-name">${esc(p.name)}</span></div>`;
        }).join('');
        document.getElementById('gameover-scores').innerHTML =
          `<div class="podium">${podium}</div>` +
          (G.mode === 'normal' ? `<div class="board-title">Placar da sessão</div>${leaderboardHtml(sessionRecords, 'O placar aparece após a primeira partida.', true)}` : '');
        document.getElementById('btn-rematch').style.display = isHost ? 'block' : 'none';
        if (!wasActive && loserIsMe) safeVibrate([80, 60, 160]);
      } else {
        overModal.classList.remove('active');
      }

      if (G.mode === 'tutorial') runTutorialCoach(me, isMyTurn);
    }

    function toggleSelectHandCard(me, card) {
      SoundEngine.select();
      if (selectedHandIds.has(card.id)) {
        selectedHandIds.delete(card.id);
        selectedOpenIds.clear();
      } else {
        const existing = me.hand.find(c => selectedHandIds.has(c.id));
        if (existing && existing.val !== card.val) {
          selectedHandIds.clear();
          selectedOpenIds.clear();
        }
        selectedHandIds.add(card.id);
      }
      renderGame();
    }

    function toggleSelectOpenCard(me, card, domEl) {
      if (G.deck.length > 0) {
        showInvalidWarning('Ainda há cartas no baralho: as cartas da mesa só valem depois que ele acabar!', domEl);
        return;
      }
      if (me.hand.length > 0) {
        if (G.deck.length > 0 || selectedHandIds.size !== me.hand.length) {
          showInvalidWarning('Jogue todas as cartas da mão antes de selecionar as cartas da mesa!', domEl);
          return;
        }
        const handSample = me.hand[0];
        if (handSample.val !== card.val) {
          showInvalidWarning('A carta da mesa só pode ser combinada com a última da mão se tiver o mesmo valor!', domEl);
          return;
        }
      } else {
        const existing = me.open.find(c => selectedOpenIds.has(c.id));
        if (existing && existing.val !== card.val) {
          selectedOpenIds.clear();
        }
      }

      SoundEngine.select();
      if (selectedOpenIds.has(card.id)) {
        selectedOpenIds.delete(card.id);
      } else {
        selectedOpenIds.add(card.id);
      }
      renderGame();
    }

    /* ==========================================================================
       TUTORIAL GUIADO: dicas que aparecem na hora certa durante a partida
       ========================================================================== */
    let lastTipTurn = -1;
    function coachSay(key, text) {
      if (tutorialSeen.has(key) || coachOpen) return false;
      // Uma dica por turno (na preparação, todas em sequência)
      const turnMark = G.phase === 'SWAP' ? -2 : (G.turnCounter || 0);
      if (turnMark >= 0 && turnMark === lastTipTurn) return false;
      lastTipTurn = turnMark;
      tutorialSeen.add(key);
      coachOpen = true;
      clearTimeout(aiTimeout);
      document.getElementById('coach-text').innerHTML = text;
      document.getElementById('coach-bubble').classList.add('show');
      return true;
    }

    function closeCoach() {
      coachOpen = false;
      document.getElementById('coach-bubble').classList.remove('show');
      if (G) { renderGame(); scheduleBotIfNeeded(); }
    }

    function runTutorialCoach(me, isMyTurn) {
      if (coachOpen || !G) return;
      const top = G.discard[G.discard.length - 1];
      const hasVal = (v) => me.hand.some(c => c.val === v);
      const counts = {};
      me.hand.forEach(c => { counts[c.val] = (counts[c.val] || 0) + 1; });

      if (G.phase === 'SWAP') {
        coachSay('welcome', '<b>Bem-vindo ao Shithead!</b> O objetivo é <b>não ser o último</b> com cartas. Você tem 3 cartas fechadas, 3 abertas na mesa e 3 na mão.') ||
        coachSay('ranks', '<b>Ordem das cartas</b>, da menor para a maior:<br><b>3 · 4 · 5 · 6 · 7 · 8 · 9 · J · Q · K · A</b><br>Você joga uma carta <b>igual ou maior</b> que a do topo. Os <b>especiais</b> fogem dessa regra: o <b>2</b> e o <b>10</b> entram sobre qualquer carta, o <b>7</b> obriga o próximo a jogar ≤ 7 e o <b>Coringa</b> 🃏 gira as mãos.') ||
        coachSay('swap', 'Antes de começar, você pode <b>trocar</b> cartas da mão com as abertas. Dica: deixe cartas fortes (<b>2, 10, A</b>) na mesa para o final. Toque numa carta da mão e depois numa aberta. Quando terminar, toque em <b>Pronto</b>.');
        return;
      }
      if (G.phase === 'GAMEOVER') return;
      if (me.escaped) {
        coachSay('escaped', 'Você <b>escapou</b>! 🎉 O jogo continua até sobrar só um: esse é o <b>Shithead</b>. Use o botão <b>⏩</b> no topo para acelerar até o fim.');
        return;
      }
      if (G.players.some(p => p.escaped && p.id !== me.id)) {
        if (coachSay('other-escaped', 'Um jogador zerou todas as cartas e está <b>salvo</b>. Quem sobrar por último perde e leva <b>-1</b> no placar 💀.')) return;
      }
      if (RulesEngine.hasJokerInDiscard(G)) {
        if (coachSay('joker', 'Saiu um <b>Coringa</b> 🃏! Todos passaram a mão para o próximo jogador no sentido do jogo. Enquanto houver Coringa no monte, você só pode recolhê-lo se <b>não tiver jogada válida</b>.')) return;
      }
      if (G.burnedCount > 0) {
        if (coachSay('burned', 'O monte foi <b>queimado</b> 🔥 e as cartas saíram do jogo (pilha "Fora", à direita).')) return;
      }
      // Início da partida: como foi decidida a ordem de jogada
      if (G.openingVal != null) {
        const first = G.players[0];
        const second = G.players[1];
        const iStart = first && first.id === me.id;
        if (coachSay('start-order',
          '<b>Quem começa?</b> Quem tem a <b>menor carta</b> na mão abre a partida, e quem tem a <b>segunda menor</b> joga logo depois — por isso a mesa foi reorganizada, com os dois lado a lado. Em caso de empate, vence quem tocar primeiro no duelo de velocidade.<br>' +
          (iStart
            ? `Você tem a menor carta, então <b>você começa</b>! O primeiro lance é <b>obrigatoriamente</b> com ela (<b>${esc(G.openingLabel || '')}</b>); se tiver mais de uma igual, pode jogar todas juntas.`
            : `Quem abre é <b>${esc(first ? first.name : '')}</b>, obrigatoriamente com a menor carta (<b>${esc(G.openingLabel || '')}</b>), e em seguida <b>${esc(second ? second.name : '')}</b>.`))) return;
      }
      // Depois do lance de abertura: como as cartas de cada jogador vão acabando
      if ((G.turnCounter || 0) >= 1 && coachSay('progression',
        '<b>Como as suas cartas vão acabando:</b><br>' +
        '1️⃣ <b>Mão + baralho:</b> enquanto houver baralho de compra, depois de jogar você compra até ficar com <b>3 na mão</b>.<br>' +
        '2️⃣ <b>Baralho acabou:</b> você para de comprar e a mão vai diminuindo.<br>' +
        '3️⃣ <b>Mão vazia:</b> jogue as <b>3 abertas</b> da mesa (dá para juntar a última da mão com abertas do mesmo valor).<br>' +
        '4️⃣ <b>Por último, as 3 fechadas</b>, no escuro: se a carta virada não servir, você recolhe o monte e volta a jogar pela mão.<br>' +
        'Zerou tudo? Você <b>escapou</b>! O último que sobrar com cartas é o <b>Shithead</b> 💩.')) return;
      // A mão recolhida (miniatura embaixo) e a mão ampliada
      if (!isMyTurn && !handOpen && me.hand.length > 0 && (G.turnCounter || 0) >= 2 && coachSay('dock',
        'Fora da sua vez a mão fica <b>recolhida</b> embaixo: a miniatura mostra cada valor que você tem (×2 = repetida). ' +
        '<b>Toque nela para ampliar</b>. Na sua vez ela abre sozinha, com as suas cartas da mesa em cima.')) return;
      if (!isMyTurn) return;

      if (coachSay('first-turn', 'É a <b>sua vez</b>! Jogue uma carta <b>igual ou maior</b> que a do topo (as que podem ser jogadas brilham em verde). Toque para selecionar e depois em <b>Jogar</b>, ou toque duas vezes, ou arraste até a mesa.')) return;
      if (G.constraint7 && G.rules.p7) {
        if (coachSay('seven', 'Tem um <b>7</b> no topo: agora vale o contrário! Você precisa jogar uma carta <b>menor ou igual a 7</b> (ou um especial: 2, 10, Coringa).')) return;
      }
      if (hasVal(15) && coachSay('two', 'O <b>2</b> é a carta mais forte: pode ser jogado sobre qualquer carta e você <b>joga de novo</b> logo em seguida.')) return;
      if (hasVal(10) && coachSay('ten', 'O <b>10</b> pode ser jogado a qualquer momento e <b>queima</b> o monte inteiro.')) return;
      if (Object.values(counts).some(n => n >= 2) && coachSay('longpress', 'Você tem cartas repetidas! Jogue todas juntas: <b>segure uma delas por 2 segundos</b> para selecionar todas do mesmo valor.')) return;
      if (G.discard.length > 0 && !RulesEngine.hasAnyPlayableMove(G, me)) {
        if (coachSay('pickup', 'Sem jogada válida? Então você precisa <b>recolher o monte</b> (botão vermelho). Faz parte do jogo! 😅')) return;
      }
      if (G.deck.length === 0 && coachSay('deck-empty', 'O <b>baralho de compra acabou</b>. Quando sua mão zerar, jogue as cartas <b>abertas</b> da mesa e por último as <b>fechadas</b>, no escuro: se a carta virada não servir, você recolhe o monte.')) return;
      if (top && !top.isJoker && top.val >= 11 && top.val <= 14 && !G.freePlayAfter2 && coachSay('high-top', `O topo está alto (${top.label}). Se não tiver carta maior, use um <b>2</b> ou <b>10</b>, ou recolha o monte.`)) return;
    }

    /* ==========================================================================
       12. EVENTOS DE INTERFACE E UPLOAD DE FOTO
       ========================================================================== */
    document.getElementById('btn-mute-lobby').addEventListener('click', () => SoundEngine.toggleMute());
    document.getElementById('btn-mute-game').addEventListener('click', () => SoundEngine.toggleMute());
    // 🏆 na mesa: placar da sessão (bots aparecem à parte, fora do ranking)
    function renderBoardOverlay() {
      const list = document.getElementById('board-overlay-list');
      list.innerHTML = leaderboardHtml(sessionRecords, 'Nenhuma partida terminada nesta sessão ainda.', true);
      const room = joinRoomCode || roomCode;
      document.getElementById('lbl-board-overlay-note').textContent =
        (room ? `Sala ${room}` : 'Partidas locais') + ` · ${sessionRecords.length} partida(s) · simulação e tutorial não contam`;
    }
    document.getElementById('btn-board-game').addEventListener('click', () => {
      renderBoardOverlay();
      document.getElementById('board-overlay').classList.add('show');
    });
    const closeBoardOverlay = () => document.getElementById('board-overlay').classList.remove('show');
    document.getElementById('btn-board-close').addEventListener('click', closeBoardOverlay);
    document.getElementById('board-overlay').addEventListener('click', (e) => { if (e.target.id === 'board-overlay') closeBoardOverlay(); });

    /* Câmera dentro do navegador: abrir o app de câmera do celular faz alguns
       navegadores (ex.: Firefox no Android) descartarem a página por falta de
       memória — ela recarrega e a foto se perde. Aqui a foto é tirada na própria página. */
    let cameraStream = null;
    let cameraFacing = 'user';

    function stopCamera() {
      if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
      document.getElementById('camera-video').srcObject = null;
    }

    async function startCamera() {
      stopCamera();
      const video = document.getElementById('camera-video');
      const msg = document.getElementById('camera-msg');
      msg.textContent = 'Abrindo a câmera...';
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: cameraFacing, width: { ideal: 640 }, height: { ideal: 640 } },
          audio: false
        });
        video.srcObject = cameraStream;
        video.classList.toggle('mirror', cameraFacing === 'user');
        await video.play().catch(() => {});
        msg.textContent = 'Centralize o rosto no círculo';
      } catch (e) {
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        msg.textContent = denied
          ? 'Permissão da câmera negada. Libere nas configurações do navegador ou use 📁 Arquivo.'
          : 'Não foi possível abrir a câmera. Use 📁 Arquivo.';
      }
    }

    function closeCameraModal() {
      stopCamera();
      document.getElementById('modal-camera').classList.remove('active');
    }

    document.getElementById('btn-camera-photo').addEventListener('click', () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
        document.getElementById('inp-file-camera').click(); // navegador sem suporte: app de câmera
        return;
      }
      document.getElementById('modal-camera').classList.add('active');
      startCamera();
    });

    document.getElementById('btn-camera-flip').addEventListener('click', () => {
      cameraFacing = cameraFacing === 'user' ? 'environment' : 'user';
      startCamera();
    });

    document.getElementById('btn-camera-cancel').addEventListener('click', closeCameraModal);

    document.getElementById('btn-camera-shot').addEventListener('click', () => {
      const video = document.getElementById('camera-video');
      if (!cameraStream || !video.videoWidth) return;
      const dataUrl = AvatarModule.drawableToAvatar(video, video.videoWidth, video.videoHeight, cameraFacing === 'user');
      myCustomAvatar = dataUrl;
      Store.set('sh_player_avatar', dataUrl);
      syncMyAvatarPreview();
      SoundEngine.select();
      closeCameraModal();
    });
    document.getElementById('btn-gallery-photo').addEventListener('click', () => {
      document.getElementById('inp-file-gallery').click();
    });
    document.getElementById('btn-reset-photo').addEventListener('click', () => {
      myCustomAvatar = null;
      Store.remove('sh_player_avatar');
      syncMyAvatarPreview();
    });

    function handleAvatarInput(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      AvatarModule.processImageFile(
        file,
        (dataUrl) => {
          myCustomAvatar = dataUrl;
          Store.set('sh_player_avatar', dataUrl);
          syncMyAvatarPreview();
        },
        (errMsg) => showInvalidWarning(errMsg)
      );
      e.target.value = '';
    }

    const syncJokerSelect = () => {
      document.getElementById('sel-jokers').disabled = !document.getElementById('chk-pjoker').checked;
    };
    document.getElementById('chk-pjoker').addEventListener('change', syncJokerSelect);
    setTimeout(syncJokerSelect, 0);

    // Aviso: sem nenhuma forma de queimar o monte, as cartas nunca saem do jogo
    const syncBurnWarning = () => {
      const p10 = document.getElementById('chk-p10').checked;
      const burn48 = document.getElementById('chk-p48').checked && document.getElementById('chk-48burn').checked;
      document.getElementById('warn-no-burn').style.display = (!p10 && !burn48) ? 'block' : 'none';
    };
    ['chk-p10', 'chk-p48', 'chk-48burn'].forEach(id => document.getElementById(id).addEventListener('change', syncBurnWarning));
    setTimeout(syncBurnWarning, 0);
    document.getElementById('sel-decks').addEventListener('change', (e) => syncBigPileInput(e.target.value === '2' ? 2 : 1));
    document.getElementById('inp-bigpile').addEventListener('change', () => getRulesFromUI());

    document.getElementById('inp-file-camera').addEventListener('change', handleAvatarInput);
    document.getElementById('inp-file-gallery').addEventListener('change', handleAvatarInput);

    document.getElementById('inp-name').addEventListener('input', (e) => {
      const val = sanitizeName(e.target.value);
      Store.set('sh_player_name', val);
      if (isHost) {
        lobbySlots[0].name = val;
        renderLobbySlots();
        clearTimeout(window.__nameTimer);
        window.__nameTimer = setTimeout(broadcastLobby, 400);
      } else {
        clearTimeout(window.__nameTimer);
        window.__nameTimer = setTimeout(sendProfileToHost, 400);
      }
    });

    document.getElementById('btn-add-bot').addEventListener('click', () => {
      if (lobbySlots.length >= 6) return;
      SoundEngine.select();
      const keys = ['easy', 'medium', 'hard'];
      const pKey = keys[lobbySlots.length % 3];
      lobbySlots.push({
        id: 'bot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        name: AppConfig.AI_PERSONAS[pKey].name,
        type: 'bot',
        persona: pKey,
        avatar: AvatarModule.getDefaultAvatar('bot', pKey)
      });
      renderLobbySlots();
    });

    document.querySelectorAll('[data-board]').forEach(btn => btn.addEventListener('click', () => {
      boardTab = btn.dataset.board;
      renderScoreboard();
    }));

    document.getElementById('btn-reset-scores').addEventListener('click', () => {
      SoundEngine.select();
      if (boardTab === 'session') {
        if (!isHost) return;
        sessionRecords = [];
        joinedConns().forEach(c => netSend(c, { type: 'SESSION', session: sessionRecords }));
      } else {
        if (!window.confirm('Apagar todo o histórico de partidas guardado neste aparelho?')) return;
        Store.remove(HISTORY_KEY);
      }
      renderScoreboard();
    });

    document.getElementById('btn-download-log').addEventListener('click', () => {
      SoundEngine.select();
      LoggerModule.downloadLastSession();
    });

    /* Copiar texto no toque. O Safari (iPhone) só aceita a cópia dentro do próprio toque:
       o texto é montado na hora, da memória (sem esperar o IndexedDB), e a cópia é pedida
       sem nenhuma espera antes. Se a área de transferência moderna recusar, tenta o
       método antigo (seleção + copiar); se nada der certo, quem chamou baixa o arquivo. */
    function copyTextInGesture(text) {
      const legacyCopy = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed; top:0; left:0; width:1px; height:1px; opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { ta.setSelectionRange(0, text.length); } catch (e) {}
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        ta.remove();
        return ok;
      };
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => 'clipboard', () => (legacyCopy() ? 'legacy' : false));
      }
      return Promise.resolve(legacyCopy() ? 'legacy' : false);
    }

    document.getElementById('btn-copy-log').addEventListener('click', () => {
      const saved = LoggerModule.getExport();
      if (!saved) return;
      const btn = document.getElementById('btn-copy-log');
      copyTextInGesture(JSON.stringify(saved)).then((how) => {
        nlog('log_copied', { how: how || 'download' });
        if (!how) {
          LoggerModule.downloadLastSession();
          return;
        }
        const old = btn.textContent;
        btn.textContent = '✅ Log Copiado!';
        setTimeout(() => { btn.textContent = old; }, 2000);
      });
    });

    document.getElementById('btn-start-match').addEventListener('click', () => {
      if (!isHost) return;
      const sim = document.getElementById('chk-sim-bots').checked;
      if (sim && clientConns.length > 0) {
        showInvalidWarning('Há jogadores conectados: desmarque "Simular só bots" para jogar com eles.');
        return;
      }
      if (lobbySlots.length < 3) {
        showInvalidWarning('São precisos pelo menos 3 jogadores: adicione um bot.');
        return;
      }
      if (clientConns.length > 0) keepScreenAwake(true);
      startNewMatch(false, sim ? 'sim' : 'normal');
    });

    document.getElementById('btn-tutorial').addEventListener('click', () => {
      if (!isHost) return;
      if (clientConns.length > 0) {
        showInvalidWarning('O tutorial é só para você: feche a sala online antes.');
        return;
      }
      tutorialSeen = new Set();
      lastTipTurn = -1;
      startNewMatch(false, 'tutorial');
    });

    document.getElementById('btn-rematch').addEventListener('click', () => {
      if (!isHost) return;
      // Depois do tutorial, a "Nova Rodada" já é uma partida normal
      startNewMatch(true, currentMode === 'tutorial' ? 'normal' : currentMode);
    });

    document.getElementById('btn-coach-ok').addEventListener('click', closeCoach);

    // Só bots ainda têm cartas (humanos escaparam ou caíram e um bot assumiu)
    function onlyBotsLeft() {
      if (!G || G.phase !== 'PLAY') return false;
      const active = G.players.filter(p => !p.escaped);
      return active.length > 1 && active.every(p => p.type === 'bot');
    }

    function activateTurbo(byName) {
      if (!G || G.phase !== 'PLAY' || turboMode) return;
      if (G.mode !== 'sim' && !onlyBotsLeft()) return;
      turboMode = true;
      G.turbo = true;
      G.bannerText = `⏩ Acelerando até o fim${byName ? ' (pedido de ' + byName + ')' : ''}...`;
      nlog('turbo', { by: byName || 'host' });
      broadcastState();
      renderGame();
      scheduleBotIfNeeded();
    }

    function requestTurbo() {
      if (!G || G.phase !== 'PLAY') return;
      if (isHost) activateTurbo(null);
      else if (hostConn) netSend(hostConn, { type: 'TURBO' });
    }

    document.getElementById('btn-turbo').addEventListener('click', requestTurbo);
    document.getElementById('btn-turbo-big').addEventListener('click', requestTurbo);

    document.querySelectorAll('.react-btn').forEach(btn => {
      btn.addEventListener('click', () => sendReaction(btn.dataset.emoji));
    });

    // Mouse: a roda rola a mão na horizontal (desktop)
    document.getElementById('hand-dock').addEventListener('click', () => setHandOpen(!handOpen));
    document.getElementById('btn-hand-close').addEventListener('click', () => setHandOpen(false));
    document.getElementById('my-hand-cards').addEventListener('wheel', (e) => {
      const el = e.currentTarget;
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });

    // Ao voltar para a aba/app, limpa resíduos visuais de gestos interrompidos
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && G) { sanitizeUIState(); renderGame(); }
    });
    window.addEventListener('blur', () => sanitizeUIState());

    document.getElementById('btn-ready-swap').addEventListener('click', () => {
      sendOrExecuteAction({ type: 'READY_SWAP' });
    });

    document.getElementById('btn-play-selected').addEventListener('click', () => {
      attemptLocalPlay(Array.from(selectedHandIds), Array.from(selectedOpenIds));
    });

    document.getElementById('btn-pickup-pile').addEventListener('click', () => {
      if (!G || G.phase !== 'PLAY') return;
      const me = G.players.find(p => p.id === myPlayerId) || G.players[0];
      const check = RulesEngine.canPlayerPickupPile(G, me);
      if (!check.allowed) {
        showInvalidWarning(check.reason);
        return;
      }
      sendOrExecuteAction({ type: 'PICKUP_PILE' });
    });

    document.getElementById('btn-speed-tap').addEventListener('click', () => {
      sendOrExecuteAction({ type: 'SPEED_TAP' });
    });

    function returnToLobbyScreen() {
      clearTimeout(aiTimeout);
      turboMode = false;
      coachOpen = false;
      document.getElementById('coach-bubble').classList.remove('show');
      if (G && G.phase !== 'GAMEOVER') G.phase = 'ABANDONED'; // para os bots
      saveHostResume(); // partida abandonada: não há o que retomar
      document.getElementById('modal-gameover').classList.remove('active');
      document.getElementById('screen-game').classList.remove('active');
      document.getElementById('screen-lobby').classList.add('active');
      refreshLogPanelUI();
    }

    document.getElementById('btn-leave').addEventListener('click', returnToLobbyScreen);
    document.getElementById('btn-play-again').addEventListener('click', returnToLobbyScreen);

    NetLog.log('app_start', { version: AppConfig.VERSION, build: AppConfig.BUILD, device: getDeviceId().slice(-6), viaInvite: /[?&]sala=/.test(location.search), env: AppConfig.ENV, protocol: AppConfig.PROTOCOL });
    // Mostra a versão/build no topo do lobby (ajuda a saber qual versão o celular está rodando)
    (() => {
      const p = document.querySelector('.brand-title-wrap p');
      if (p) p.textContent = `build ${AppConfig.BUILD} · P2P Mobile & Desktop`;
      // Selo BETA / LOCAL: deixa claro que não é a versão oficial (salas separadas)
      const badge = document.getElementById('lbl-env-badge');
      if (badge && AppConfig.ENV !== 'prod') {
        badge.textContent = AppConfig.ENV === 'beta' ? 'BETA' : 'LOCAL';
        badge.hidden = false;
      }
    })();
    // Mantém o resumo do log atualizado enquanto o lobby está aberto
    setInterval(() => {
      if (document.getElementById('screen-lobby').classList.contains('active')) refreshLogPanelUI();
    }, 5000);

    // Libera o áudio no primeiro gesto em qualquer lugar da página (ex.: convidado que
    // entrou pelo link e só rolou a tela). Chrome/Firefox/Safari só aceitam o desbloqueio
    // em pointerup/touchend/click/keydown — o pointerdown de um toque não conta.
    const AUDIO_UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'];
    const unlockAudio = () => {
      SoundEngine.init();
      if (SoundEngine.isReady()) AUDIO_UNLOCK_EVENTS.forEach(ev => document.removeEventListener(ev, unlockAudio, true));
    };
    AUDIO_UNLOCK_EVENTS.forEach(ev => document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));

    loadSavedSetup();
    if (!/[?&]sala=/.test(location.search)) offerHostResume();
    // Logs carregados do IndexedDB: atualiza o resumo do log no lobby
    Promise.all([LoggerModule.ready, NetLog.ready]).then((r) => {
      nlog('log_storage', { idb: r[0].idb && r[1].idb, matches: r[0].matches, migrated: r[0].migrated || undefined, pending: r[0].pending || undefined });
      refreshLogPanelUI();
    }, () => {});
