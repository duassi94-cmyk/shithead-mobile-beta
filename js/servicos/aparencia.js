// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

/* ==========================================================================
   APARÊNCIA (só neste aparelho; nada vai pela rede)
   - naipes: 2 cores (♥♦ vermelhos) ou 4 cores (♦ azul, ♣ verde)
   - verso das cartas e cor do feltro da mesa
   - painel lateral (placar, jogadas, regras) fixo ao lado da mesa em telas largas
   - lado da mão: direita (padrão) ou esquerda (canhotos: espelha reações, botões e colunas)
   Aplicada como atributos na raiz da página (data-suits, data-back, data-felt, data-panel, data-hand);
   o style.css troca as cores por variáveis. Valores fora da lista voltam ao padrão.
   ========================================================================== */
import { Store } from './armazenamento.js';

const KEY = 'sh_look';
const OPTIONS = {
  suits: ['2', '4'],
  back: ['red', 'blue', 'green', 'black'],
  felt: ['green', 'blue', 'wine'],
  panel: ['on', 'off'],
  hand: ['right', 'left']
};
const DEFAULTS = { suits: '2', back: 'red', felt: 'green', panel: 'on', hand: 'right' };

// Escolha atual em memória: vale mesmo se o navegador não deixar gravar (modo privado)
let current = null;

function get() {
  if (current) return { ...current };
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
  root.dataset.hand = look.hand;
}

function set(key, value) {
  if (!OPTIONS[key] || !OPTIONS[key].includes(String(value))) return get();
  const look = { ...get(), [key]: String(value) };
  current = look;
  try { Store.set(KEY, JSON.stringify(look)); } catch (e) {}
  apply(look);
  return look;
}

const Aparencia = { OPTIONS, DEFAULTS, get, set, apply };
export { Aparencia };
