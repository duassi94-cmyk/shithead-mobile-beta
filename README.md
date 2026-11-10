# Shithead!

Jogo de cartas **Shithead** para celular e computador: jogue contra bots ou com amigos, cada um no seu aparelho, sem cadastro e sem instalar nada da loja.

| Versão | Endereço | Para quê |
|---|---|---|
| **Oficial** | https://duassi94-cmyk.github.io/shithead-mobile/ | versão estável, para jogar |
| **Beta** | https://duassi94-cmyk.github.io/shithead-mobile-beta/ | novidades em teste antes de irem para a oficial |

As duas versões usam salas separadas: quem está no beta só joga com quem também está no beta. A versão oficial pode estar algumas atualizações atrás do beta.

## Como jogar

O objetivo é **não ser o último com cartas**. Quem sobra com cartas perde a rodada e leva 💀 no placar.

1. **Preparação:** cada jogador recebe 3 cartas fechadas na mesa, 3 abertas por cima delas e 3 na mão. Antes de começar, dá para trocar cartas da mão com as abertas.
2. **Jogada:** jogue uma ou mais cartas de **mesmo valor**, iguais ou maiores que a do topo do monte. Enquanto houver baralho, a mão é completada até 3 cartas.
3. **Sem jogada:** recolha o monte inteiro para a mão.
4. **Fim da mão:** com o baralho vazio e a mão vazia, jogue as cartas abertas da mesa e, por último, as fechadas, às cegas. Se a carta virada não servir, você recolhe o monte.

**Cartas especiais** (cada uma pode ser ligada ou desligada nas regras da sala):

| Carta | Efeito |
|---|---|
| **2** | Joga sobre qualquer carta e você joga de novo |
| **7** | O próximo só pode jogar 7 ou menos |
| **10** | Queima o monte (as cartas saem do jogo) |
| **Coringa** | As mãos giram entre os jogadores |
| **4 iguais** (8 com 2 baralhos) | Invertem o sentido do jogo |

Há estilos prontos (**Da casa**, **Clássico**, **Caótico**), com 1 ou 2 baralhos, e até 2 regras próprias salvas no aparelho. Para aprender, use o **Tutorial** na tela inicial.

## Recursos

- **Contra bots:** três níveis (Tio Barnabé, Madame Lola e Dr. Chaos), partida na hora.
- **Com amigos:** crie uma sala e mande o link ou o QR Code. A sala pode ser trancada, e quem cai da conexão volta para o mesmo lugar (um bot joga por ele enquanto isso).
- **Cronômetro opcional:** 15, 30 ou 60 s por jogada; no fim do tempo, o bot joga pela pessoa, ela recolhe o monte ou é só um aviso.
- **Na mesa:** histórico das jogadas, regras da mesa, placar da sessão, reações (GOMBRA!, DORMIU??) e "+ iguais" para selecionar cartas de mesmo valor.
- **Do seu jeito:** 4 cores nos naipes, verso das cartas, cor da mesa e mão à esquerda (para canhotos).
- **Em qualquer tela:** celular em pé ou deitado, tablet e computador (com painel lateral).
- **Acessível:** botões de pelo menos 44 px, textos de pelo menos 11 px, leitores de tela e teclado (Tab, Espaço, Enter).
- **Funciona sem internet** contra bots, depois de aberto uma vez.

*Alguns destes recursos podem existir só no beta enquanto estão em teste.*

## Instalar no celular

- **Android (Chrome):** menu **⋮** → *Instalar app* (ou use o botão em Ajustes).
- **iPhone e iPad (Safari):** **Compartilhar** → *Adicionar à Tela de Início*.

O jogo abre em tela cheia, com ícone próprio, como um app.

## Privacidade

- Não há cadastro. Nome, foto, regras e preferências ficam só no seu aparelho.
- Nas partidas online, os aparelhos conversam **diretamente** entre si. O servidor gratuito do [PeerJS](https://peerjs.com/) só serve para apresentar os aparelhos no começo.
- Cada aparelho recebe só o que pode ver: as cartas escondidas dos outros nunca chegam até ele.
- O log de partidas fica no aparelho e só sai dele se você baixá-lo ou copiá-lo (Ajustes → Ajuda e diagnóstico), por exemplo para relatar um problema.

## Para quem desenvolve

O código mais recente fica no [repositório do beta](https://github.com/duassi94-cmyk/shithead-mobile-beta) (ramo `dev` do projeto); a versão oficial é publicada a partir dele depois de testada. A estrutura abaixo é a desse código.

Site estático, **sem etapa de build**: os arquivos do repositório são os que o navegador carrega. Funciona no iOS 15.4+ e em navegadores atuais.

```
index.html, style.css, game.js   tela e fluxo da partida
js/nucleo/                        regras, motor da partida, sorteio com semente, histórico
js/bots/                          inteligência dos bots
js/rede/                          limpeza de tudo que chega pela rede
js/mesa/                          desenho da mesa em componentes (Preact + htm)
js/servicos/                      armazenamento, log, som, avatar, aparência
vendor/                           bibliotecas copiadas (PeerJS, QRCode, Preact + htm) e licenças
tests/                            ferramentas de teste no navegador (veja tests/README.md)
sw.js, manifest.json, icons/      modo offline e instalação
```

**Rodar localmente:**

```bash
python3 -m http.server 8765
```

Depois abra http://localhost:8765/. Uma cópia rodando no computador usa salas separadas das oficiais e das do beta.

**Testes:** ficam em [`tests/`](https://github.com/duassi94-cmyk/shithead-mobile-beta/blob/main/tests/README.md) e rodam numa aba do navegador. Cobrem o layout em vários tamanhos de tela, o motor de regras comparado com partidas de referência, o replay de partidas pelo log, simulações e a segurança da sala.

**Publicação:** o desenvolvimento acontece no ramo `dev`. Cada versão vai primeiro para o **beta** e, depois de testada, para a **oficial**. A cada publicação, o número de build em `js/config.js` e o nome do cache em `sw.js` mudam, para os aparelhos receberem a versão nova.

## Licenças

As bibliotecas de terceiros e suas licenças estão em [`vendor/LICENSES.md`](https://github.com/duassi94-cmyk/shithead-mobile-beta/blob/main/vendor/LICENSES.md): PeerJS, QRCode.js e Preact (MIT) e htm (Apache 2.0).
