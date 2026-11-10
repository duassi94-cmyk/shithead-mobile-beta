# Testes do Shithead! Mobile

Ferramentas para rodar no navegador, com o jogo servido localmente
(`py -m http.server 8765` na pasta do repositório). Nenhuma delas é carregada
pelo `index.html`: são abertas só durante os testes.

Desde a build 2026-11-10.8 o motor, a IA e os serviços são módulos ES em `js/`
(veja o comentário de `js/ponte.js`). A ponte publica os mesmos nomes de antes em
`window` (`Core`, `AIEngine`, `LoggerModule`, `SoundEngine`...), então as ferramentas
continuam funcionando do mesmo jeito.

| Arquivo | Para que serve |
|---|---|
| `sim-harness.js` | Roda partidas só entre bots, sem tela e sem som, e confere se nenhuma carta some ou duplica. Use numa aba do jogo (não na que você usa para jogar). |
| `layout-test.js` | Confere em vários tamanhos de tela se algo fica cortado, sobreposto ou fora da tela: `await __run()` (mesa, incluindo texto ≥ 11 px e botões ≥ 44 px, com o menu ⋯ aberto; com o celular deitado — a partir de 640 px de largura — confere a coluna da mão ao lado do feltro) e `await __lobby()` (telas de entrada: Início, Convite, Sala, Placar, Ajustes; inclui alvos de toque ≥ 44 px). Desliga a gravação no armazenamento do navegador da aba. |
| `make-icons.py` | Gera os ícones PNG do app (`icons/`) sem bibliotecas externas: `py tests/make-icons.py`. O mesmo desenho está em `icons/icon.svg`. |
| `security-check.js` | Age como um aparelho estranho contra uma sala aberta: versão antiga, mensagem sem entrar, id inválido e excesso de mensagens. |
| `replay.js` | Reproduz uma partida a partir do log (semente + ações) e confere a distribuição, as impressões digitais da mesa, cada jogada e o final. |
| `core-diff.js` | Joga partidas pelo fluxo do jogo e repete cada ação direto no motor de regras (`js/nucleo/motor.js`), comparando a mesa inteira e tudo o que acontece em volta (log, sons, animações, reações, fim). Também grava partidas de referência para conferir trocas futuras do motor. |

## Motor de regras

As regras moram só em `js/nucleo/motor.js` (sem tela, som, rede ou relógio). Cada ação muda a mesa e
devolve uma lista de eventos; o `game.js` transforma os eventos em tela, som, log e rede.

```js
// numa aba de http://localhost:8765/ (não a que você usa para jogar)
const s = document.createElement('script'); s.src = 'tests/core-diff.js'; document.head.appendChild(s);
await CoreDiff.run({ matches: 20 });     // { partidas, acoes, falhas: 0, ... }
CoreDiff.start({ matches: 200 }); CoreDiff.progress   // rodada longa em segundo plano

// Antes de mexer no motor: grave partidas de referência (banco só de teste no navegador)
await CoreDiff.golden({ matches: 40 });
// Depois da mudança, numa aba nova, reproduza todas com o motor novo:
const r = document.createElement('script'); r.src = 'tests/replay.js'; document.head.appendChild(r);
(await Replay.all({ matches: await CoreDiff.loadGolden() })).filter(x => !x.ok)   // [] = nada mudou
await CoreDiff.dropGolden();             // apaga o banco de teste
```

## Replay

O log de cada partida (a partir da build 2026-11-10.3) guarda, só no aparelho do host,
a semente do embaralhamento e a lista de ações aplicadas (de todos: você, convidados e bots).

```js
// numa aba de http://localhost:8765/ (o replay troca o estado da aba; recarregue depois)
const s = document.createElement('script'); s.src = 'tests/replay.js'; document.head.appendChild(s);
await Replay.fromSaved();            // última partida deste navegador
await Replay.run(logExportado);      // JSON do botão "Baixar Log" (última partida)
await Replay.all(logExportado);      // todas as partidas do log
```

`ok: true` = a partida reproduzida bateu em tudo. Partidas interrompidas no meio
aparecem com "o log não tem o final", mas as conferências até ali continuam valendo.

## Onde o log fica

Desde a build 2026-11-10.7 os logs (partidas e conexão) ficam no IndexedDB do navegador
(banco `shithead-logs`): uma chave por partida, gravada em segundo plano. O log antigo do
localStorage é migrado na primeira abertura. Se o navegador recusar o IndexedDB (modo
privado), o jogo volta a gravar no localStorage. Para testar essa reserva:
`localStorage.sh_debug_noidb = '1'` e recarregue (apague a chave depois).

`sim-harness.js` e `core-diff.js` desligam a gravação dos logs na aba (`LogDB.off()`).
`Replay.fromSaved()` espera o log carregar do banco.

## Retomada do host

O host grava a partida em andamento (`sh_host_resume`, 30 min). Para testar à mão:
1. Numa aba, crie a sala e entre com outra aba pelo link; comece a partida.
2. Recarregue a aba do host no meio da partida: o convidado mostra "esperando o host voltar".
3. No host, toque em "Retomar partida": a mesma sala reabre (se o servidor ainda segurar o
   código, o host tenta de novo em 3, 5, 10... s) e o convidado volta para o próprio lugar.
4. No fim, `Replay.fromSaved()` no host deve dar `ok: true` (o log continua na mesma partida).

## Simulação

```js
// numa aba de http://localhost:8765/
const s = document.createElement('script'); s.src = 'tests/sim-harness.js'; document.head.appendChild(s);
// depois:
SimHarness.start([{ name: '4j_2bar', n: 4, r: { decks: 2, jokers: 2 }, tags: {} }], 3, 3000);
SimHarness.status();   // n=… done=… stuck=… viol=…
```

## Segurança

1. Numa aba do jogo, crie uma sala (anote o código).
2. Noutra aba, abra `http://localhost:8765/tests/`, carregue `security-check.js` e rode
   `await SecurityCheck.run('CODIGO')`.
3. Esperado: `UPDATE_REQUIRED` nas versões erradas, nada no envio sem JOIN, `FECHADA`
   no id inválido e, no log do host, contadores `rate_limited_REACTION` e `rate_limited_RESYNC`.

Local e beta usam salas separadas das oficiais (prefixo `shithead-mobile-beta-sala-`).
