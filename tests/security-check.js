// Teste de segurança da sala — abra http://localhost:8765/tests/ numa aba separada,
// cole este arquivo no console (ou carregue com <script>) e chame as funções abaixo.
// Ele age como um "aparelho estranho": conecta direto no host pelo PeerJS, sem o jogo.
//
//   await SecurityCheck.run('ABCDE')   -> roda todos os casos contra a sala ABCDE
//
// A sala precisa estar aberta por um host em outra aba (ambiente local ou beta).
window.SecurityCheck = (() => {
  const PREFIX = 'shithead-mobile-beta-sala-';
  const PROTOCOL = 2;

  function loadPeer() {
    if (window.Peer) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/vendor/peerjs.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  // Conecta, manda as mensagens e devolve os tipos de mensagem recebidos
  function intruder(code, msgs, waitMs = 3500) {
    return new Promise(resolve => {
      const got = [];
      const p = new Peer();
      p.on('error', e => got.push('ERRO ' + e.type));
      p.on('open', () => {
        const c = p.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        c.on('open', () => (Array.isArray(msgs) ? msgs : [msgs]).forEach(m => c.send(JSON.stringify(m))));
        c.on('data', d => { try { got.push(JSON.parse(d).type); } catch (e) { got.push(String(d).slice(0, 40)); } });
        c.on('close', () => got.push('FECHADA'));
      });
      setTimeout(() => { try { p.destroy(); } catch (e) {} resolve(got); }, waitMs);
    });
  }

  const join = (id, extra = {}) => ({ type: 'JOIN', id, secret: 'abcdefabcdef1234abcd', name: 'Teste ' + id.slice(-4), protocol: PROTOCOL, ...extra });
  const count = (arr) => arr.reduce((a, t) => { a[t] = (a[t] || 0) + 1; return a; }, {});

  async function run(code) {
    await loadPeer();
    const r = {};
    // 1. Versão antiga ou sem versão: host pede para atualizar e fecha
    r.versaoAntiga = await intruder(code, join('dev_teste000001', { protocol: 1 }));
    r.semVersao = await intruder(code, join('dev_teste000002', { protocol: undefined }));
    // 2. Mensagem antes do JOIN: ignorada (nada volta)
    r.semJoin = await intruder(code, { type: 'RESYNC' });
    // 3. Id inválido / segredo inválido: recusado
    r.idInvalido = await intruder(code, join('x<script>'));
    // 4. Excesso de mensagens: o host descarta (veja os contadores rate_limited_* no log do host)
    const spam = [join('dev_teste000003')];
    for (let i = 0; i < 40; i++) spam.push({ type: 'REACTION', playerId: 'dev_teste000003', emoji: '💩' });
    for (let i = 0; i < 30; i++) spam.push({ type: 'RESYNC' });
    r.excesso = count(await intruder(code, spam, 4000));
    return r;
  }

  return { run, intruder, join };
})();
