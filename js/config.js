// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

/* ==========================================================================
   1. CONFIGURAÇÕES E CONSTANTES DO SISTEMA (AppConfig)
   ========================================================================== */
const AppConfig = Object.freeze({
  VERSION: 'shithead-mobile-v5',
  // Build publicado: data + número da publicação do dia. Atualizar a cada publicação
  // no GitHub para os logs dizerem exatamente qual código estava rodando.
  BUILD: '2026-11-10.11',
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

export { AppConfig };
