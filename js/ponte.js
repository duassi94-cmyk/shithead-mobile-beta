// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+.

/* ==========================================================================
   PONTE DE TRANSIÇÃO: módulos ES → game.js
   O jogo está migrando por partes para módulos ES (js/):
     config.js            AppConfig (versão, build, ambiente, cartas, bots)
     servicos/            armazenamento (Store, LogDB), avatar, log de partidas,
                          log de conexão (+ captura de erros), som
     nucleo/              sorteio (semente, impressão digital), regras, motor (Core),
                          histórico público de jogadas (PlayHistory)
     bots/ia.js           IA dos bots
     rede/sanitizar.js    limpeza de tudo que chega da rede, código da sala
   O game.js (tela, rede, fluxo da partida) ainda é um script clássico que usa esses
   nomes como globais. Esta ponte os entrega em window e só então carrega o game.js,
   na ordem certa em qualquer navegador. As ferramentas de teste (tests/) usam os
   mesmos nomes. Cada parte que sair do game.js para um módulo deixa de precisar daqui.
   ========================================================================== */
import { AppConfig } from './config.js';
import { Store, LogDB } from './servicos/armazenamento.js';
import { AvatarModule } from './servicos/avatar.js';
import { NetLog } from './servicos/netlog.js';
import { LoggerModule } from './servicos/log.js';
import { SoundEngine } from './servicos/som.js';
import { Rng, stateDigest } from './nucleo/sorteio.js';
import { RulesEngine } from './nucleo/regras.js';
import { Core } from './nucleo/motor.js';
import { HISTORY_MAX, historyBefore, addHistory, historyText } from './nucleo/historico.js';
import { AIEngine } from './bots/ia.js';
import * as Sanitizar from './rede/sanitizar.js';

Object.assign(window, {
  AppConfig, Store, LogDB, AvatarModule, NetLog, LoggerModule, SoundEngine,
  Rng, stateDigest, RulesEngine, Core, AIEngine,
  PlayHistory: { MAX: HISTORY_MAX, before: historyBefore, add: addHistory, text: historyText }
}, Sanitizar);

// Registro do Service Worker (modo offline e atualização dos arquivos)
if ('serviceWorker' in navigator) {
  const register = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}

// Agora o game.js (async = false: executa assim que chegar, depois desta ponte)
const script = document.createElement('script');
script.src = 'game.js';
script.async = false;
document.body.appendChild(script);
