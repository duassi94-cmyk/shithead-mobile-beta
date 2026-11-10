# Testes do Shithead! Mobile

Ferramentas para rodar no navegador, com o jogo servido localmente
(`py -m http.server 8765` na pasta do repositório). Nenhuma delas é carregada
pelo `index.html`: são abertas só durante os testes.

| Arquivo | Para que serve |
|---|---|
| `sim-harness.js` | Roda partidas só entre bots, sem tela e sem som, e confere se nenhuma carta some ou duplica. Use numa aba do jogo (não na que você usa para jogar). |
| `layout-test.js` | Confere em vários tamanhos de tela se algo fica cortado, sobreposto ou fora da tela. Desliga a gravação no armazenamento do navegador da aba. |
| `security-check.js` | Age como um aparelho estranho contra uma sala aberta: versão antiga, mensagem sem entrar, id inválido e excesso de mensagens. |

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
