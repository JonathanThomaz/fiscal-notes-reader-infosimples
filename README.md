# fiscal-notes-reader-infosimples

Leitor de NFC-e de MG via API paga da Infosimples (`sefaz/mg/nfce-resumida`). Consome `reader.infosimples.v1`, consulta a nota pela chave de acesso, normaliza para `canonical-document.v1` e publica em `fiscal.results`. Decisão e custos: ADR 0010 do workspace.

Faz parte do workspace `fiscal-notes-workspace` e é clonado em `workers/reader-infosimples`.

## Uso

```bash
cp .env.example .env    # RABBITMQ_URL do mesmo broker da API e INFOSIMPLES_TOKEN
yarn install
yarn dev                # build + start
```

A fila é declarada pelo `fiscal-notes-api` na primeira publicação; até lá o worker aguarda. O leitor `infosimples` é registrado pela migração 0004 da API (desabilitado: um admin habilita, pois cada consulta é cobrada).

## Custo e latência

- Cada consulta custa cerca de R$ 0,24 (primeiras 500 do mês). Reprocessar uma nota é uma nova cobrança.
- A API leva de 1 a mais de 5 minutos por nota. Use `PREFETCH` baixo e `INFOSIMPLES_TIMEOUT_S` de pelo menos 300.
- Reduza o limite mensal do token no painel da Infosimples.

## Comportamento

- Só NFC-e (modelo 65) de MG; o resto devolve `not_supported` sem chamar a API.
- Códigos da Infosimples → status do `reader-result.v1`:

| Código | Status | Repete |
| --- | --- | --- |
| 200 com dados / sem dados | `success` / `empty` | – |
| 605 | `timeout` | sim |
| 600, 609, 610, falha de rede | `provider_error` | sim |
| 601, 602, 603 | `failed` | não |
| 604, 606, 607, 608 | `invalid_input` | não |
| outros | `provider_error` | não |

- Só os erros não cobrados são repetidos, respeitando `limits` e `deadline`.
- Faltam GTIN, NCM, CFOP, desconto e pagamento; vão para `quality.fields_missing`. Se a soma dos itens diferir do total, entra um aviso em `quality.warnings`.
- `raw` leva a resposta JSON completa, que contém o CPF do destinatário: a API grava criptografado (ADR 0006).
- Logs em JSON, sem token, chave, conteúdo do QR nem payload. A mensagem de erro publicada é o `code_message` fixo da API; `errors` (que pode ecoar parâmetros) não é publicado.

## Desenvolvimento

| Script | O que faz |
| --- | --- |
| `yarn test` | Testes do leitor (fixtures fictícias) e do worker contra RabbitMQ real (Testcontainers) |
| `yarn typecheck` / `yarn lint` / `yarn format` | Verificações |

Os JSON Schemas em `src/contracts/schemas/` são cópias de `docs/contracts/` do workspace (ADR 0008). As fixtures de teste não usam dados reais.

Commits: Conventional Commits em português.
