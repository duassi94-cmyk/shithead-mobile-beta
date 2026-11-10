// ARQUIVO TEMPORÁRIO DE TESTE — não publicar (apagar antes do commit)
(() => {
  // Nada desta aba grava no armazenamento do navegador (dados do usuário intactos)
  const sp = Storage.prototype;
  if (!sp.__orig) sp.__orig = { set: sp.setItem, rem: sp.removeItem };
  sp.setItem = function (k, v) { if (this === window.sessionStorage) return sp.__orig.set.call(this, k, v); };
  sp.removeItem = function (k) { if (this === window.sessionStorage) return sp.__orig.rem.call(this, k); };
  sp.clear = function () {};
  SoundEngine.init = () => {};
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const R = (e) => e.getBoundingClientRect();
  const inside = (a, b, t = 0.5) => a.left >= b.left - t && a.right <= b.right + t && a.top >= b.top - t && a.bottom <= b.bottom + t;
  const ov = (a, b, t = 4) => { const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return ox > t && oy > t ? Math.round(ox) + 'x' + Math.round(oy) : null; };
  const fits = (e) => !e || !e.offsetWidth || (e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1);

  window.__start = async (n, decks = '1') => {
    if (document.getElementById('screen-game').classList.contains('active')) { document.getElementById('btn-leave').click(); await wait(300); }
    document.getElementById('sel-decks').value = decks; document.getElementById('sel-decks').dispatchEvent(new Event('change'));
    if (decks === '2') { document.getElementById('chk-pjoker').checked = true; document.getElementById('sel-jokers').value = '4'; }
    document.getElementById('chk-sim-bots').checked = false;
    while (lobbySlots.length > n) lobbySlots.pop(); renderLobbySlots();
    for (let i = 0; i < 6 && lobbySlots.length < n; i++) document.getElementById('btn-add-bot')?.click();
    document.getElementById('btn-start-match').click(); await wait(700); document.getElementById('btn-ready-swap').click();
    for (let i = 0; i < 30 && G.phase !== 'PLAY'; i++) { const m = document.getElementById('modal-speed'); if (getComputedStyle(m).display !== 'none') document.getElementById('btn-speed-tap').click(); await wait(120); }
    clearTimeout(aiTimeout);
  };

  // Pior caso de textos + mão grande (e opcionalmente tudo na mão)
  window.__worst = (all = false) => {
    const me = G.players.find(p => p.id === myPlayerId); G.turnIdx = G.players.indexOf(me); G.turnCounter = (G.turnCounter || 0) + 7; G.openingVal = null;
    const bot = G.players.find(p => p.type === 'bot'); G.pickupStamp = Date.now() + 1; G.lastPickupBy = bot.id;
    if (all) { const pool = [...G.deck, ...G.discard]; G.players.forEach(p => { if (p !== me) { pool.push(...p.hand); p.hand = []; } }); G.deck = []; me.hand.push(...pool); }
    else { for (let i = 0; i < 12; i++) me.hand.push({ ...G.deck[i + 1], id: 'hh' + i }); }
    G.discard = [{ ...me.hand[0], id: 'zz', val: 13, label: 'K', isJoker: false }];
    G.discardPlayGroups = [{ playerName: 'Madame Lola (Médio)', cards: G.discard.slice() }];
    G.bannerText = G.players[1].name + ' revelou 10♥ inválido e recolheu tudo!';
    renderGame(); refreshSpecialReactions();
  };

  window.__check = () => {
    const vw = innerWidth, vh = innerHeight, out = [];
    const inV = (e, name) => { const r = R(e); if (!r.width) return; if (r.left < -0.5 || r.right > vw + 0.5 || r.top < -0.5 || r.bottom > vh + 0.5) out.push(name + ' fora da tela'); };
    if (document.documentElement.scrollWidth > vw) out.push('página rola na horizontal');
    // reações: dentro da tela, texto inteiro e não cobertas por nada (nem pela mão ampliada)
    const rb = [...document.querySelectorAll('#reaction-bar .react-btn')];
    rb.forEach((b, i) => {
      inV(b, 'reação ' + i); if (!fits(b)) out.push('reação ' + i + ' não cabe');
      const r = R(b); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || !(top === b || b.contains(top))) out.push('reação ' + i + ' coberta');
    });
    document.querySelectorAll('.top-bar > *, .top-actions > *').forEach((b, i) => inV(b, 'topo ' + i));
    if (!fits(document.getElementById('lbl-Constraint'))) out.push('chip regra não cabe');
    if (!fits(document.getElementById('status-banner'))) out.push('faixa status não cabe');
    const seats = [...document.querySelectorAll('.seat')]; seats.forEach((b, i) => inV(b, 'assento ' + i));
    document.querySelectorAll('.seat-name').forEach((b, i) => { if (!fits(b)) out.push('nome assento ' + i + ' não cabe'); });
    for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) { const o = ov(R(seats[i]), R(seats[j]), 6); if (o) out.push('assentos ' + i + '/' + j + ' sobrepostos ' + o); }
    const piles = ['#draw-pile-visual', '#discard-pile-visual', '#burned-pile-visual'].map(s => R(document.querySelector(s)));
    seats.forEach((st, i) => piles.forEach((p, j) => { const o = ov(R(st), p); if (o) out.push('assento ' + i + ' cobre pilha ' + j + ' ' + o); }));
    const felt = R(document.getElementById('center-drop-zone'));
    piles.forEach((p, j) => { if (!inside(p, felt, 2)) out.push('pilha ' + j + ' fora do feltro'); });
    const labels = [...document.querySelectorAll('.pile-label')].map(R);
    labels.forEach((l, i) => { if (!inside(l, felt, 2)) out.push('rótulo pilha ' + i + ' fora do feltro'); });
    for (let i = 0; i < labels.length - 1; i++) if (labels[i].right > labels[i + 1].left - 1) out.push('rótulos ' + i + '/' + (i + 1) + ' encostam');
    const tg = [...document.querySelectorAll('.discard-play-tag')]; tg.forEach(t => { if (!inside(R(t), felt, 2)) out.push('selo do monte fora do feltro'); });
    const sb = document.getElementById('turn-sequence-bar'); if (sb.scrollWidth > sb.clientWidth + 1) out.push('faixa de ordem rola');
    document.querySelectorAll('.action-bar .btn').forEach(b => { if (b.offsetWidth) { inV(b, b.id); if (!fits(b)) out.push(b.id + ' não cabe'); } });
    inV(document.getElementById('player-zone'), 'zona do jogador');
    const z = document.getElementById('player-zone');
    if (!z.classList.contains('hand-open')) out.push('mão não abriu na vez');
    const L = R(document.getElementById('hand-layer')), S = R(document.getElementById('my-hand-cards'));
    inV(document.getElementById('hand-layer'), 'mão ampliada');
    piles.forEach((p, j) => { if (p.bottom > L.top + 2) out.push('mão ampliada cobre pilha ' + j); });
    if (!fits(document.querySelector('.hand-layer-head'))) out.push('cabeçalho da mão não cabe');
    const cards = [...document.querySelectorAll('#my-hand-cards .playing-card')];
    if (cards.some(c => { const r = R(c); return r.top < S.top - 0.5 || r.bottom > S.bottom + 0.5; })) out.push('cartas passam da altura da mão');
    const lt = document.getElementById('layer-table-slot'); [...lt.querySelectorAll('.playing-card')].forEach(c => { if (!inside(R(c), L)) out.push('carta da mesa cortada na camada'); });
    // mão recolhida
    setHandOpen(false);
    const fan = R(document.getElementById('dock-fan')), dock = R(document.getElementById('hand-dock'));
    document.querySelectorAll('#dock-fan .dock-card').forEach(c => { if (!inside(R(c), fan)) out.push('miniatura transborda'); });
    const lab = document.getElementById('dock-label'); if (!fits(lab) || !inside(R(lab), dock)) out.push('contador da mão não cabe');
    const slot = R(document.getElementById('my-table-cards'));
    piles.forEach((p, j) => { if (ov(slot, p, 2)) out.push('cartas da mesa encostam na pilha ' + j); });
    if (ov(slot, R(document.getElementById('status-banner')), 2)) out.push('cartas da mesa encostam na faixa');
    setHandOpen(true);
    const compact = document.getElementById('opponents-area').classList.contains('seats-compact');
    return vw + 'x' + vh + ' ' + G.players.length + 'j' + (G.rules.decks === 2 ? ' 2bar' : '') + (compact ? ' (compacto)' : '') + ': ' + (out.length ? [...new Set(out)].join('; ') : 'OK');
  };

  window.__run = async () => {
    const res = [];
    for (const [n, d, all] of [[3, '1', false], [4, '1', false], [6, '1', false], [4, '2', true], [6, '2', true]]) {
      await __start(n, d); __worst(all); await wait(250); res.push(__check());
    }
    return res;
  };

  // Mede deslocamentos de layout durante uma partida jogada automaticamente
  window.__shift = async (ms = 30000) => {
    await __start(4);
    const auto = setInterval(() => { if (!G) return; const m = document.getElementById('modal-speed'); if (getComputedStyle(m).display !== 'none') document.getElementById('btn-speed-tap').click(); if (G.phase === 'PLAY' && G.players[G.turnIdx].id === myPlayerId) { const a = AIEngine.decideTurnAction(G, G.turnIdx); if (a) executePlayerAction(myPlayerId, a); } }, 700);
    scheduleBotIfNeeded();
    const sel = ['.top-bar', '#turn-sequence-bar', '#table-area', '.piles-row', '#draw-pile-visual', '#discard-pile-visual', '#burned-pile-visual', '#status-banner', '#reaction-bar', '#player-zone', '.zone-row', '#hand-dock', '.action-bar'];
    const geo = {}, chg = {};
    const lay = e => { let x = 0, y = 0, n = e; while (n) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; } return [x, y, e.offsetWidth, e.offsetHeight].join(','); };
    const samp = setInterval(() => { try { for (const s of sel) { const e = document.querySelector(s); if (!e) continue; const k = lay(e); if (geo[s] && geo[s] !== k) (chg[s] ||= []).push(geo[s] + ' → ' + k + ' @t' + G.turnCounter); geo[s] = k; } document.querySelectorAll('#reaction-bar .react-btn').forEach((b, i) => { const k = b.offsetTop + ':' + b.offsetHeight + ':' + b.offsetWidth; const s = 'reação' + i; if (geo[s] && geo[s] !== k) (chg[s] ||= []).push(geo[s] + '→' + k); geo[s] = k; }); } catch (e) {} }, 40);
    await wait(ms); clearInterval(auto); clearInterval(samp);
    return Object.fromEntries(Object.entries(chg).map(([k, v]) => [k, v.length + ' | ' + v.slice(0, 2).join(' ; ')]));
  };
  window.__testReady = true;
})();
