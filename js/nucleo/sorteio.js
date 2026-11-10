// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

/* ---- Semente e gerador determinístico (Rng) ---------------------------------
   Cada partida nasce de uma semente secreta (128 bits sorteados com crypto) que
   fica só no host e no log dele — nunca vai para a rede. A partir dela, um gerador
   determinístico (sfc32) embaralha o baralho, sorteia os ids das cartas e os
   lugares. Com a semente e a lista de ações gravadas no log, qualquer partida
   pode ser reproduzida jogada a jogada (ferramenta tests/replay.js). */
const Rng = (() => {
  function newSeed() {
    const a = new Uint32Array(4);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < 4; i++) a[i] = Math.floor(Math.random() * 0x100000000);
    return Array.from(a, x => x.toString(16).padStart(8, '0')).join('');
  }
  function isSeed(s) { return typeof s === 'string' && /^[0-9a-f]{32}$/.test(s); }
  function create(seed) {
    if (!isSeed(seed)) seed = newSeed();
    let a = parseInt(seed.slice(0, 8), 16) >>> 0;
    let b = parseInt(seed.slice(8, 16), 16) >>> 0;
    let c = parseInt(seed.slice(16, 24), 16) >>> 0;
    let d = parseInt(seed.slice(24, 32), 16) >>> 0;
    function next() {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    }
    for (let i = 0; i < 15; i++) next(); // aquece o gerador
    return { seed, next, int: (n) => Math.floor(next() * n) };
  }
  return { newSeed, isSeed, create };
})();

// "Impressão digital" da mesa: resume onde está cada carta, de quem é a vez, o sentido
// e a fase. Gravada no log a cada 20 ações e no fim; o replay recalcula e compara.
function stateDigest(state) {
  if (!state) return null;
  const ids = (arr) => (arr || []).map(c => c.id).join(',');
  const parts = [
    state.phase, state.turnIdx, state.direction, state.burnedCount || 0,
    ids(state.deck), ids(state.discard),
    ...state.players.map(p => `${p.id}|${p.escaped ? 1 : 0}|${ids(p.hand)}|${ids(p.open)}|${ids(p.closed)}`)
  ].join('#');
  let h = 0x811c9dc5; // FNV-1a 32 bits
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export { Rng, stateDigest };
