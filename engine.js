'use strict';

    /* ==========================================================================
       0. ARMAZENAMENTO SEGURO (Store)
       Envolve o localStorage: nunca quebra o jogo (modo privado, Safari, cota cheia).
       Se a cota lotar ao salvar avatar/nome/placar, encolhe o log da sessão e tenta de novo.
       ========================================================================== */
    const Store = (() => {
      const LOG_KEY = 'sh_last_session_log';

      function get(key, fallback = null) {
        try {
          const v = localStorage.getItem(key);
          return v === null ? fallback : v;
        } catch (e) {
          return fallback;
        }
      }

      function shrinkLog() {
        try {
          const raw = localStorage.getItem(LOG_KEY);
          if (!raw) return false;
          const data = JSON.parse(raw);
          if (data.matches && data.matches.length > 1) {
            data.matches.splice(0, Math.ceil(data.matches.length / 2));
          } else if (data.matches && data.matches[0] && data.matches[0].turns.length > 20) {
            data.matches[0].turns.splice(0, Math.floor(data.matches[0].turns.length / 2));
          } else {
            localStorage.removeItem(LOG_KEY);
            return true;
          }
          localStorage.setItem(LOG_KEY, JSON.stringify(data));
          return true;
        } catch (e) {
          try { localStorage.removeItem(LOG_KEY); } catch (e2) {}
          return true;
        }
      }

      function set(key, value) {
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            localStorage.setItem(key, value);
            return true;
          } catch (e) {
            if (key === LOG_KEY || !shrinkLog()) return false;
          }
        }
        return false;
      }

      function remove(key) {
        try { localStorage.removeItem(key); } catch (e) {}
      }

      return { get, set, remove };
    })();
    // Registro do Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }

    /* ==========================================================================
       1. CONFIGURAÇÕES E CONSTANTES DO SISTEMA (AppConfig)
       ========================================================================== */
    const AppConfig = Object.freeze({
      VERSION: 'shithead-mobile-v5',
      // Build publicado: data + número da publicação do dia. Atualizar a cada publicação
      // no GitHub para os logs dizerem exatamente qual código estava rodando.
      BUILD: '2026-11-10.1',
      // Versão do formato das mensagens entre aparelhos. Mudou o formato? Some 1:
      // o host pede para quem estiver com a versão antiga atualizar a página.
      PROTOCOL: 2,
      // Onde o jogo está rodando: 'prod' (GitHub Pages oficial), 'beta' (repositório
      // de testes, endereço termina em -beta) ou 'local' (computador de desenvolvimento).
      // Beta e local usam salas separadas das oficiais.
      ENV: (() => {
        const h = location.hostname;
        if (/-beta(\/|$)/.test(location.pathname)) return 'beta';
        if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')) return 'local';
        return 'prod';
      })(),
      MAX_IMAGE_BYTES: 25 * 1024 * 1024, // 25 MB na entrada (fotos de celular passam de 5 MB); vira 96x96
      AVATAR_SIZE: 96,
      ALLOWED_MIMES: ['image/jpeg', 'image/png', 'image/webp'],
      SUITS: ['♠', '♥', '♦', '♣'],
      RANKS: [
        { label: '3', val: 3 },
        { label: '4', val: 4 },
        { label: '5', val: 5 },
        { label: '6', val: 6 },
        { label: '7', val: 7 },
        { label: '8', val: 8 },
        { label: '9', val: 9 },
        { label: '10', val: 10 },
        { label: 'J', val: 11 },
        { label: 'Q', val: 12 },
        { label: 'K', val: 13 },
        { label: 'A', val: 14 },
        { label: '2', val: 15 }
      ],
      AI_PERSONAS: {
        easy:   { id: 'easy',   name: 'Tio Barnabé (Fácil)',   level: 1 },
        medium: { id: 'medium', name: 'Madame Lola (Médio)',   level: 2 },
        hard:   { id: 'hard',   name: 'Dr. Chaos (Difícil)',   level: 3 }
      }
    });

    /* ==========================================================================
       2. MÓDULO DE AVATARES E PROCESSAMENTO DE IMAGEM (AvatarModule)
       ========================================================================== */
    const AvatarModule = (() => {
      const svgToDataUrl = (svgStr) => 'data:image/svg+xml;utf8,' + encodeURIComponent(svgStr.trim());

      const DEFAULT_AVATARS = {
        human: svgToDataUrl(`
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="50" fill="#0f766e"/>
            <circle cx="50" cy="36" r="18" fill="#f8fafc"/>
            <path d="M18 88 C18 62, 82 62, 82 88 Z" fill="#f8fafc"/>
          </svg>`),
        easy: svgToDataUrl(`
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="50" fill="#b45309"/>
            <ellipse cx="50" cy="24" rx="36" ry="10" fill="#fde047"/>
            <rect x="30" y="10" width="40" height="14" rx="6" fill="#eab308"/>
            <circle cx="50" cy="54" r="24" fill="#fed7aa"/>
            <circle cx="41" cy="50" r="3.5" fill="#1e293b"/>
            <circle cx="59" cy="50" r="3.5" fill="#1e293b"/>
            <path d="M38 66 Q50 76 62 66" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>
          </svg>`),
        medium: svgToDataUrl(`
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="50" fill="#6d28d9"/>
            <path d="M20 55 C20 20, 80 20, 80 55 L85 85 L15 85 Z" fill="#4c1d95"/>
            <circle cx="50" cy="52" r="23" fill="#fbcfe8"/>
            <rect x="28" y="41" width="19" height="11" rx="5" fill="#0f172a" stroke="#f59e0b" stroke-width="2"/>
            <rect x="53" y="41" width="19" height="11" rx="5" fill="#0f172a" stroke="#f59e0b" stroke-width="2"/>
            <line x1="47" y1="46" x2="53" y2="46" stroke="#f59e0b" stroke-width="2"/>
            <path d="M43 64 Q50 69 57 64" stroke="#be123c" stroke-width="3.5" fill="none" stroke-linecap="round"/>
          </svg>`),
        hard: svgToDataUrl(`
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="50" fill="#111827"/>
            <circle cx="50" cy="50" r="32" fill="#374151" stroke="#ef4444" stroke-width="3"/>
            <rect x="26" y="38" width="48" height="13" rx="6" fill="#ef4444"/>
            <circle cx="40" cy="44.5" r="3" fill="#fef08a"/>
            <circle cx="60" cy="44.5" r="3" fill="#fef08a"/>
            <path d="M36 66 L44 62 L50 67 L56 62 L64 66" stroke="#9ca3af" stroke-width="3" fill="none"/>
          </svg>`)
      };

      function getDefaultAvatar(type, persona) {
        if (type === 'bot' && persona && DEFAULT_AVATARS[persona]) {
          return DEFAULT_AVATARS[persona];
        }
        return DEFAULT_AVATARS.human;
      }

      // Recorta o centro em quadrado e reduz para 96x96 (JPEG leve, ~3-5 KB)
      function drawableToAvatar(source, srcW, srcH, mirror = false) {
        const size = AppConfig.AVATAR_SIZE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const minDim = Math.min(srcW, srcH);
        const sx = (srcW - minDim) / 2;
        const sy = (srcH - minDim) / 2;
        if (mirror) {
          ctx.translate(size, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(source, sx, sy, minDim, minDim, 0, 0, size, size);
        return canvas.toDataURL('image/jpeg', 0.75);
      }

      // Lê a imagem por URL temporária (bem mais leve na memória do que ler
      // o arquivo inteiro como texto: evita o navegador do celular travar/recarregar)
      function processImageFile(file, onSuccess, onError) {
        if (!file) return;
        const typeOk = !file.type || file.type.startsWith('image/');
        if (!typeOk) {
          onError('Formato inválido! Escolha uma foto (JPG, PNG ou WebP).');
          return;
        }
        if (file.size > AppConfig.MAX_IMAGE_BYTES) {
          onError('Arquivo muito grande! O limite é de 25 MB.');
          return;
        }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          try {
            onSuccess(drawableToAvatar(img, img.naturalWidth, img.naturalHeight));
          } catch (e) {
            onError('Não foi possível processar a imagem.');
          }
          URL.revokeObjectURL(url);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          onError('Não foi possível ler a imagem (formato HEIC não é suportado; use JPG).');
        };
        img.src = url;
      }

      return { getDefaultAvatar, processImageFile, drawableToAvatar };
    })();

    /* ==========================================================================
       3. MÓDULO DE LOG DE SESSÃO PARA AJUSTE DE IA (LoggerModule)
       ========================================================================== */
    const LoggerModule = (() => {
      const STORAGE_KEY = 'sh_last_session_log';
      let sessionData = null;

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
          `Monte grande a partir de ${r.bigPile || (r.decks === 2 ? 20 : 12)} cartas`
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
        saveToStorage();
      }

      function startMatchLog(rules, players) {
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
        sessionData.matches.push(matchEntry);
        saveToStorage();
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

      function logMatchEnd(loserName) {
        const m = currentMatch();
        if (!m) return;
        m.loser = loserName;
        m.endedAt = new Date().toISOString();
        saveToStorage();
      }

      // Salva o log a cada jogada. Se o armazenamento do navegador lotar, descarta as
      // partidas mais antigas da sessão (mantendo a atual) para nunca bloquear
      // o resto do jogo (avatar, nome, placar, regras).
      function saveToStorage() {
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

      function getSavedSession() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch (e) {
          return null;
        }
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
        logMatchEnd,
        setMatchMode,
        getSavedSession,
        getExport,
        downloadLastSession
      };
    })();

    /* ==========================================================================
       3b. LOG DE CONEXÃO (NetLog)
       Guarda eventos de rede (sala, conexões, quedas, reconexões, erros, rotas
       WebRTC) em host E convidados, para diagnosticar problemas de conexão.
       - Não grava endereços IP nem conteúdo de mensagens.
       - Fila circular: mantém os últimos 600 eventos.
       ========================================================================== */
    const NetLog = (() => {
      const KEY = 'sh_net_log_v1';
      const MAX_EVENTS = 600;
      let data = null;
      let saveTimer = null;
      const pageStart = Date.now();

      function load() {
        try {
          const raw = Store.get(KEY);
          data = raw ? JSON.parse(raw) : null;
        } catch (e) {
          data = null;
        }
        if (!data || !Array.isArray(data.events)) data = { events: [], counters: {} };
        if (!data.counters) data.counters = {};
      }

      function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          try { Store.set(KEY, JSON.stringify(data)); } catch (e) {}
        }, 400);
      }

      /* Filtro de privacidade/segurança aplicado a TUDO que entra no log:
         - remove endereços IP (v4 e v6), URLs, e-mails e sequências longas tipo token/SDP
         - código de sala aparece mascarado (só os 2 últimos dígitos) para o log
           compartilhado não servir de convite para uma sala ainda aberta
         - textos cortados em 120 caracteres, objetos com no máximo 2 níveis */
      const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
      const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi; // 3+ ":" (não confunde com horário 17:05:53)
      const URL_RE = /\b(?:https?|wss?|turns?|stuns?):[^\s"']*/gi;
      const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/gi;
      const LONG_TOKEN = /[A-Za-z0-9+/=_-]{28,}/g;
      function scrubString(s) {
        return String(s)
          .replace(URL_RE, '[url]')
          .replace(EMAIL, '[email]')
          .replace(IPV4, '[ip]')
          .replace(IPV6, '[ip]')
          .replace(LONG_TOKEN, '[token]')
          .slice(0, 120);
      }
      function scrub(v, depth = 0) {
        if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
        if (typeof v === 'string') return scrubString(v);
        if (depth >= 2 || typeof v !== 'object') return '[obj]';
        if (Array.isArray(v)) return v.slice(0, 10).map(x => scrub(x, depth + 1));
        const out = {};
        Object.keys(v).slice(0, 16).forEach(k => {
          if (/secret|token|password|senha|sdp|candidate|address|ip$/i.test(k)) return; // nunca grava
          out[k] = scrub(v[k], depth + 1);
        });
        return out;
      }
      function maskRoom(r) {
        return r ? '**' + String(r).slice(-2) : r;
      }

      function log(ev, details = {}) {
        if (!data) load();
        const clean = scrub(details);
        if (clean && clean.room) clean.room = maskRoom(clean.room);
        data.events.push({ t: new Date().toISOString(), s: Math.round((Date.now() - pageStart) / 1000), ev: String(ev).slice(0, 40), ...clean });
        if (data.events.length > MAX_EVENTS) data.events.splice(0, data.events.length - MAX_EVENTS);
        save();
      }

      function count(name, n = 1) {
        if (!data) load();
        data.counters[name] = (data.counters[name] || 0) + n;
        save();
      }

      function get() {
        if (!data) load();
        return data;
      }

      function clear() {
        data = { events: [], counters: {} };
        Store.remove(KEY);
      }

      // Informações do aparelho/rede (sem dados pessoais)
      function environment() {
        const c = navigator.connection || {};
        const ua = navigator.userAgent || '';
        const first = (pairs) => {
          for (const [re, label] of pairs) {
            const m = re.exec(ua);
            if (m) return label + (m[1] ? ' ' + m[1] : '');
          }
          return 'outro';
        };
        const browser = first([[/Firefox\/(\d+)/, 'Firefox'], [/Edg\/(\d+)/, 'Edge'], [/SamsungBrowser\/(\d+)/, 'Samsung'], [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+).*Safari/, 'Safari']]);
        const os = first([[/Android ([\d.]+)/, 'Android'], [/(?:iPhone|iPad).*?OS (\d+)/, 'iOS'], [/(Windows)/, ''], [/(Mac OS X)/, ''], [/(Linux)/, '']]).trim();
        return {
          browser,
          os,
          mobile: /Mobi|Android/i.test(ua),
          online: navigator.onLine,
          netType: c.effectiveType || null,
          downlinkMbps: c.downlink || null,
          rttMs: c.rtt || null,
          saveData: !!c.saveData,
          standalone: window.matchMedia ? window.matchMedia('(display-mode: standalone)').matches : false,
          webrtc: !!window.RTCPeerConnection
        };
      }

      return { log, count, get, clear, environment };
    })();

    // Erros inesperados do JavaScript vão para o log de conexão (antes só apareciam no console).
    // Passam pelo mesmo filtro de privacidade; no máximo 20 por abertura, para um erro em laço
    // não encher o log.
    (() => {
      let errCount = 0;
      const screen = () => {
        const s = document.querySelector('.screen.active');
        return s ? s.id : null;
      };
      const record = (kind, msg, file, line, col) => {
        if (++errCount > 20) return;
        try {
          NetLog.log(kind, {
            msg: String(msg || '').slice(0, 120),
            file: String(file || '').split(/[\\/]/).pop().split('?')[0].slice(0, 40) || null,
            line: Number(line) || null,
            col: Number(col) || null,
            screen: screen(),
            build: AppConfig.BUILD
          });
          NetLog.count(kind);
        } catch (e) { /* o registro de erro nunca pode causar outro erro */ }
      };
      window.addEventListener('error', (e) => {
        if (e && e.target && e.target !== window && e.target.tagName) {
          // Falha ao carregar um arquivo (script, imagem)
          record('load_error', e.target.tagName.toLowerCase(), e.target.src || e.target.href, null, null);
          return;
        }
        record('js_error', e && e.message, e && e.filename, e && e.lineno, e && e.colno);
      }, true);
      window.addEventListener('unhandledrejection', (e) => {
        const r = e && e.reason;
        record('js_rejection', r && (r.message || r.type || String(r)), r && r.fileName, r && r.lineNumber, null);
      });
    })();

    /* ==========================================================================
       4. MOTOR DE EFEITOS SONOROS WEB AUDIO (SoundEngine)
       ========================================================================== */
    const SoundEngine = (() => {
      let ctx = null;
      let muted = Store.get('sh_muted') === 'true';

      function init() {
        if (!ctx) {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) ctx = new AudioCtx();
        }
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
      }

      function toggleMute() {
        muted = !muted;
        Store.set('sh_muted', String(muted));
        updateMuteButtons();
        if (!muted) {
          init();
          select();
        }
      }

      function updateMuteButtons() {
        const lobbyBtn = document.getElementById('btn-mute-lobby');
        const gameBtn = document.getElementById('btn-mute-game');
        if (lobbyBtn) lobbyBtn.textContent = muted ? '🔇 Mudo' : '🔊 Som';
        if (gameBtn) gameBtn.textContent = muted ? '🔇' : '🔊';
      }

      function createNoiseBuffer(durationSec) {
        if (!ctx) return null;
        const sampleRate = ctx.sampleRate;
        const frameCount = Math.floor(sampleRate * durationSec);
        const buffer = ctx.createBuffer(1, frameCount, sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < frameCount; i++) {
          data[i] = Math.random() * 2 - 1;
        }
        return buffer;
      }

      function select() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.045);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.05);
      }

      function slide() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        const noise = ctx.createBufferSource();
        noise.buffer = createNoiseBuffer(0.14);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(900, now);
        filter.frequency.exponentialRampToValueAtTime(2400, now + 0.13);
        filter.Q.value = 1.8;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        noise.start(now);
      }

      function playCard() {
        if (muted) return;
        init();
        if (!ctx) return;
        slide();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(190, now + 0.04);
        osc.frequency.exponentialRampToValueAtTime(75, now + 0.13);
        gain.gain.setValueAtTime(0.22, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + 0.04);
        osc.stop(now + 0.15);
      }

      function power2() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, now + idx * 0.055);
          gain.gain.setValueAtTime(0.15, now + idx * 0.055);
          gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.055 + 0.22);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + idx * 0.055);
          osc.stop(now + idx * 0.055 + 0.23);
        });
      }

      function power7() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        [330, 277.18].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 950;
          osc.frequency.setValueAtTime(freq, now + idx * 0.11);
          gain.gain.setValueAtTime(0.14, now + idx * 0.11);
          gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.18);
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + idx * 0.11);
          osc.stop(now + idx * 0.11 + 0.19);
        });
      }

      function burn10() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        const noise = ctx.createBufferSource();
        noise.buffer = createNoiseBuffer(0.45);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, now);
        filter.frequency.exponentialRampToValueAtTime(140, now + 0.44);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.32, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.44);
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        noise.start(now);
      }

      function jokerSwap() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        [392, 523.25, 440, 587.33, 493.88, 659.25, 783.99].forEach((f, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, now + i * 0.045);
          gain.gain.setValueAtTime(0.15, now + i * 0.045);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.045 + 0.14);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + i * 0.045);
          osc.stop(now + i * 0.045 + 0.15);
        });
      }

      function reverseOrder() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(740, now);
        osc.frequency.exponentialRampToValueAtTime(260, now + 0.14);
        osc.frequency.exponentialRampToValueAtTime(660, now + 0.28);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.31);
      }

      function pickupPile() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        [311.13, 277.18, 233.08].forEach((f, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(f, now + i * 0.08);
          gain.gain.setValueAtTime(0.16, now + i * 0.08);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.16);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + i * 0.08);
          osc.stop(now + i * 0.08 + 0.17);
        });
      }

      function invalidError() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        [155, 130].forEach((f, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(f, now + i * 0.09);
          gain.gain.setValueAtTime(0.14, now + i * 0.09);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.08);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + i * 0.09);
          osc.stop(now + i * 0.09 + 0.09);
        });
      }

      function gameOver() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        [
          { f: 392.0, t: 0.0, d: 0.22 },
          { f: 369.99, t: 0.24, d: 0.22 },
          { f: 349.23, t: 0.48, d: 0.22 },
          { f: 329.63, t: 0.72, d: 0.55 }
        ].forEach(n => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(n.f, now + n.t);
          gain.gain.setValueAtTime(0.16, now + n.t);
          gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + n.t);
          osc.stop(now + n.t + n.d + 0.02);
        });
      }

      // Fanfarra "trombone" exagerada para o botão GOMBRA!
      function gombra() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        [
          { f: 196, t: 0.0, d: 0.16 },
          { f: 196, t: 0.18, d: 0.12 },
          { f: 261.63, t: 0.32, d: 0.16 },
          { f: 392, t: 0.5, d: 0.5 }
        ].forEach(n => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 1400;
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(n.f, now + n.t);
          osc.frequency.linearRampToValueAtTime(n.f * 1.03, now + n.t + n.d);
          gain.gain.setValueAtTime(0.0001, now + n.t);
          gain.gain.exponentialRampToValueAtTime(0.2, now + n.t + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + n.t);
          osc.stop(now + n.t + n.d + 0.02);
        });
      }

      // Despertador "trrrim-trrrim" para o DORMIU?? (toca só no aparelho de quem demora)
      function alarm() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        for (let burst = 0; burst < 3; burst++) {
          const start = now + burst * 0.42;
          for (let k = 0; k < 10; k++) {
            const t = start + k * 0.03;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(k % 2 ? 1568 : 1318.5, t);
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t);
            osc.stop(t + 0.03);
          }
        }
      }

      // "Tum-tum" grave de coração quando o monte fica grande
      function heartbeat() {
        if (muted) return;
        init();
        if (!ctx) return;
        const now = ctx.currentTime;
        [0, 0.22, 0.9, 1.12].forEach((t, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(i % 2 ? 50 : 62, now + t);
          osc.frequency.exponentialRampToValueAtTime(35, now + t + 0.18);
          gain.gain.setValueAtTime(0.0001, now + t);
          gain.gain.exponentialRampToValueAtTime(i % 2 ? 0.35 : 0.5, now + t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.2);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + t);
          osc.stop(now + t + 0.22);
        });
      }

      function playByTag(tag) {
        switch (tag) {
          case 'BURN10': burn10(); break;
          case 'JOKER': jokerSwap(); break;
          case 'POWER2': power2(); break;
          case 'POWER7': power7(); break;
          case 'REVERSE': reverseOrder(); break;
          case 'PICKUP': pickupPile(); break;
          case 'GAMEOVER': gameOver(); break;
          case 'SLIDE': slide(); break;
          default: playCard(); break;
        }
      }

      return { init, toggleMute, updateMuteButtons, select, slide, power2, power7, invalidError, gombra, alarm, heartbeat, playByTag, isReady: () => !!ctx && ctx.state === 'running' };
    })();

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
      function randomCardId(used) {
        let id;
        do {
          id = 'k';
          for (let i = 0; i < 7; i++) id += ID_CHARS[randInt(ID_CHARS.length)];
        } while (used.has(id));
        used.add(id);
        return id;
      }

      function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const k = randInt(i + 1);
          [arr[i], arr[k]] = [arr[k], arr[i]];
        }
        return arr;
      }

      function buildDeck(rules) {
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
        shuffle(deck);
        // Os ids são dados depois de embaralhar e são sorteados
        const used = new Set();
        deck.forEach(c => { c.id = randomCardId(used); });
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

      function performInitialSwap(state, playerIdx) {
        const p = state.players[playerIdx];
        if (p.persona === 'easy') {
          LoggerModule.logSwap(p, p.open, p.hand);
          return;
        }
        const combined = [...p.hand, ...p.open].sort(
          (a, b) => cardStrategicWeight(b, state.rules) - cardStrategicWeight(a, state.rules)
        );
        p.open = combined.slice(0, 3);
        p.hand = combined.slice(3, 6);
        LoggerModule.logSwap(p, p.open, p.hand);
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
        const s = SimEngine.clone(state);
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
            SimEngine.apply(s, botIdx, action);
            while (!s.over && s.plies < depth) {
              const a = rolloutPolicy(s, s.turnIdx);
              if (!a) break;
              SimEngine.apply(s, s.turnIdx, a);
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

    /* ==========================================================================
       6b. SIMULADOR PURO DE REGRAS (SimEngine)
       Mesmas regras de game.js, mas sem tela, som, rede ou log.
       Usado pela IA para "imaginar" jogadas futuras.
       ========================================================================== */
    const SimEngine = (() => {
      function clone(state) {
        return {
          rules: state.rules,
          deck: [...state.deck],
          discard: [...state.discard],
          burnedCount: state.burnedCount || 0,
          players: state.players.map(p => ({
            id: p.id, type: p.type, persona: p.persona, escaped: p.escaped,
            hand: [...p.hand], open: [...p.open], closed: [...p.closed]
          })),
          turnIdx: state.turnIdx,
          direction: state.direction,
          constraint7: state.constraint7,
          freePlayAfterJoker: state.freePlayAfterJoker,
          freePlayAfter2: state.freePlayAfter2,
          stall: null,
          over: false,
          plies: 0
        };
      }

      function resetPileFlags(s) {
        s.constraint7 = false;
        s.freePlayAfterJoker = false;
        s.freePlayAfter2 = false;
      }

      function nextTurn(s, again) {
        s.plies++;
        const active = s.players.filter(p => !p.escaped);
        if (active.length <= 1) { s.over = true; return; }
        const sameAgain = again && !s.players[s.turnIdx].escaped;
        if (!sameAgain) {
          s.turnIdx = RulesEngine.getNextActivePlayerIndex(s, s.turnIdx);
        }
        // Mesma regra do jogo: com baralho, a vez começa com a mão completa
        const p = s.players[s.turnIdx];
        if (s.deck.length > 0 && p && !p.escaped) {
          const target = sameAgain ? (p.hand.length === 0 ? Math.min(3, s.rules.draw2 || 1) : 0) : 3;
          const need = Math.min(target - p.hand.length, s.deck.length);
          if (need > 0) p.hand.push(...s.deck.splice(0, need));
        }
      }

      function pickup(s, p, extra = []) {
        p.hand.push(...s.discard, ...extra);
        s.discard = [];
        resetPileFlags(s);
      }

      function rotateHands(s, steps) {
        const active = s.players.filter(p => !p.escaped);
        if (active.length < 2) return;
        const total = steps % active.length;
        for (let k = 0; k < total; k++) {
          const snap = active.map(p => p.hand);
          active.forEach((p, i) => { active[(i + s.direction + active.length) % active.length].hand = snap[i]; });
        }
      }

      function play(s, p, cards) {
        const r = s.rules;
        const sample = cards[0];
        s.discard.push(...cards);
        resetPileFlags(s);
        let again = false;
        let burned = false;

        const target = r.decks === 1 ? 4 : 8;
        if (r.p48 && !sample.isJoker) {
          let reversed = false;
          if (r.mode48 === 'together') {
            reversed = cards.length >= target;
          } else {
            let seq = 0;
            for (let i = s.discard.length - 1; i >= 0; i--) {
              if (!s.discard[i].isJoker && s.discard[i].val === sample.val) seq++; else break;
            }
            reversed = seq >= target;
          }
          if (reversed) {
            s.direction *= -1;
            if (r.burn48) burned = true;
          }
        }
        if (sample.val === 10 && r.p10) {
          burned = true;
          if (r.after10 === 'again') again = true;
        }
        if (sample.val === 7 && r.p7 && !burned) s.constraint7 = true;
        if (sample.val === 15 && r.p2) {
          again = true;
          s.freePlayAfter2 = true;
          if (p.hand.length === 0 && s.deck.length > 0) p.hand.push(...s.deck.splice(0, Math.min(r.draw2, s.deck.length)));
        }
        if (sample.isJoker && r.pjoker) {
          s.freePlayAfterJoker = true;
          rotateHands(s, r.multijoker === 'per_joker' ? cards.length : 1);
        }
        if (burned) {
          s.burnedCount += s.discard.length;
          s.discard = [];
          resetPileFlags(s);
        }
        if (!again && s.deck.length > 0 && p.hand.length < 3) {
          p.hand.push(...s.deck.splice(0, Math.min(3 - p.hand.length, s.deck.length)));
        }
        s.players.forEach(pl => {
          if (!pl.escaped && pl.hand.length === 0 && pl.open.length === 0 && pl.closed.length === 0 && s.deck.length === 0) pl.escaped = true;
        });
        nextTurn(s, again);
      }

      function apply(s, idx, action) {
        const p = s.players[idx];
        if (!action) { nextTurn(s, false); return; }
        if (action.type === 'PICKUP_PILE') {
          pickup(s, p);
          nextTurn(s, false);
        } else if (action.type === 'PLAY_BLIND') {
          const i = p.closed.findIndex(c => c.id === action.cardId);
          const card = i === -1 ? p.closed[0] : p.closed[i];
          p.closed.splice(p.closed.indexOf(card), 1);
          if (RulesEngine.isCardPlayable(s, card)) play(s, p, [card]);
          else { pickup(s, p, [card]); nextTurn(s, false); }
        } else {
          const hs = new Set(action.handIds || []);
          const os = new Set(action.openIds || []);
          const cards = [...p.hand.filter(c => hs.has(c.id)), ...p.open.filter(c => os.has(c.id))];
          if (cards.length === 0) { pickup(s, p); nextTurn(s, false); return; }
          p.hand = p.hand.filter(c => !hs.has(c.id));
          p.open = p.open.filter(c => !os.has(c.id));
          play(s, p, cards);
        }
      }

      return { clone, apply };
    })();

