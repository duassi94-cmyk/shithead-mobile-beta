// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

/* ==========================================================================
   APARÊNCIA (só neste aparelho; nada vai pela rede)
   - naipes: 2 cores (♥♦ vermelhos) ou 4 cores (♦ azul, ♣ verde)
   - verso das cartas e cor do feltro da mesa
   - painel lateral (placar, jogadas, regras) fixo ao lado da mesa em telas largas
   Aplicada como atributos na raiz da página (data-suits, data-back, data-felt, data-panel);
   o style.css troca as cores por variáveis. Valores fora da lista voltam ao padrão.
   ========================================================================== */
import { Store } from './armazenamento.js';

const KEY = 'sh_look';
const OPTIONS = {
  suits: ['2', '4'],
  back: ['red', 'blue', 'green', 'black'],
  felt: ['green', 'blue', 'wine'],
  panel: ['on', 'off']
};
const DEFAULTS = { suits: '2', back: 'red', felt: 'green', panel: 'on' };

function get() {
  let saved = {};
  try { saved = JSON.parse(Store.get(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = OPTIONS[k].includes(String(saved[k])) ? String(saved[k]) : DEFAULTS[k];
  return out;
}

function apply(look = get()) {
  const root = document.documentElement;
  root.dataset.suits = look.suits;
  root.dataset.back = look.back;
  root.dataset.felt = look.felt;
  root.dataset.panel = look.panel;
}

function set(key, value) {
  if (!OPTIONS[key] || !OPTIONS[key].includes(String(value))) return get();
  const look = { ...get(), [key]: String(value) };
  Store.set(KEY, JSON.stringify(look));
  apply(look);
  return look;
}

const Aparencia = { OPTIONS, DEFAULTS, get, set, apply };
export { Aparencia };
