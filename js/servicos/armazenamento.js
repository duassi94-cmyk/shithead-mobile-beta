// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

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

/* ==========================================================================
   0b. BANCO DOS LOGS (LogDB): IndexedDB
   Os logs (partidas e conexão) crescem a cada jogada. No IndexedDB a gravação roda
   em segundo plano, sem travar a tela, e o espaço é muito maior que os ~5 MB do
   localStorage (dividido com foto, nome, placar...). Se o navegador recusar o
   IndexedDB (modo privado de alguns navegadores), cada log volta a gravar no
   localStorage, como antes.
   Uma tabela só ("kv"): chave → valor.
   ========================================================================== */
const LogDB = (() => {
  const NAME = 'shithead-logs';
  let dbp = null;
  let off = false; // ferramentas de teste desligam a gravação (LogDB.off())

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        try {
          if (!window.indexedDB) throw new Error('sem IndexedDB');
          // Teste da reserva: localStorage.sh_debug_noidb = '1' faz o jogo agir como num
          // navegador que recusa o IndexedDB
          if (Store.get('sh_debug_noidb') === '1') throw new Error('IndexedDB desligado (teste)');
          const rq = indexedDB.open(NAME, 1);
          rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
          rq.onsuccess = () => {
            const db = rq.result;
            db.onversionchange = () => db.close();
            resolve(db);
          };
          rq.onerror = () => reject(rq.error || new Error('IndexedDB recusado'));
          rq.onblocked = () => reject(new Error('IndexedDB bloqueado'));
        } catch (e) {
          reject(e);
        }
      });
    }
    return dbp;
  }

  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction('kv', mode); } catch (e) { reject(e); return; }
      const out = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error('erro na gravação'));
      t.onabort = () => reject(t.error || new Error('gravação cancelada'));
    }));
  }

  const getMany = (keys) => tx('readonly', st => keys.map(k => st.get(k))).then(rqs => rqs.map(r => r.result));
  // Grava e apaga numa transação só: ou tudo entra, ou nada
  const write = (puts = [], dels = []) => (off ? Promise.resolve() : tx('readwrite', st => {
    puts.forEach(([k, v]) => st.put(v, k));
    dels.forEach(k => st.delete(k));
  }));

  return { getMany, write, off: () => { off = true; } };
})();

export { Store, LogDB };
