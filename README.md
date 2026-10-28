# Verzel Leilões

Casa de leilões online para o desafio Elite Dev da Verzel. Leiloeiros publicam itens pesquisados em uma API pública; licitantes disputam lotes ao vivo com carteira fictícia, registro de auditoria público e comprovante compartilhável.

## Estado desta entrega

- Aplicação full-stack criada neste diretório; o catálogo, as salas, a carteira, o painel, os resultados, os comprovantes e a auditoria usam PostgreSQL pela API Node.
- Migração e seed foram executados em um PostgreSQL 16 de teste isolado. `pnpm test` com integração, `pnpm lint`, `pnpm typecheck` e `pnpm build` passaram; 18 testes passaram, incluindo cadastro sem elevação de papel, login, depósito, lances concorrentes, atualização Socket.IO, liberação de saldo, adulterações, liquidação e comprovante público.
- Código publicado no [GitHub](https://github.com/mateusm1403/verzel-leiloes), branch `main`; aplicação disponível em [verzel-leiloes.onrender.com](https://verzel-leiloes.onrender.com/). Em 28/10/2026, a página, os assets e `/api/health` responderam HTTP 200; o seed disponibilizou quatro lotes ao vivo e as quatro auditorias públicas estavam íntegras.

## Funcionalidades

- Dois papéis, Leiloeiro e Licitante, com senha protegida por bcrypt e sessão em cookie `HttpOnly`.
- Pesquisa de produtos DummyJSON, criação de lote com cópia local dos metadados, datas, lance inicial e incremento.
- Vitrine com filtros por estado e busca por título; lotes cancelados ficam fora da vitrine.
- Sala do lote com histórico pseudônimo, contador, feedback do servidor e eventos Socket.IO em tempo real.
- Carteira com saldo total, compromissos em outros lotes, saldo disponível, depósitos fictícios e extrato persistido.
- Painel do leiloeiro com seus lotes, resultados, valor em arremates e cancelamento de lote sem lances.
- Meus lances, estado de liderança e comprovante público compartilhável.
- Auditoria pública baseada em SHA-256 e assinatura HMAC-SHA-256.
- Processo do servidor liquida lotes vencidos a cada cinco segundos, mesmo sem uma pessoa na sala.
- Seed idempotente com um leiloeiro, dois licitantes, saldo inicial e quatro lotes ao vivo, cada um com dois lances de demonstração.

## Arquitetura

- **Front-end:** React 19, TypeScript, Vite e React Router.
- **Back-end:** Node.js 24, TypeScript e Express 5.
- **Banco:** PostgreSQL 17 com SQL parametrizado pelo `pg`. As operações de lance e liquidação usam transações e bloqueios de linha explícitos (`FOR UPDATE`).
- **Tempo real:** Socket.IO 4; a sala é pública para leitura e as mutações de lance só passam pela API autenticada.
- **Validação e segurança:** Zod, bcrypt, JWT em cookie `HttpOnly`, Helmet, limitação de requisições, validação de origem e centavos inteiros.
- **API externa:** DummyJSON Products. A busca usa `/products/search`; ao criar lote, o item é carregado novamente e seus dados são copiados para `item_snapshot`. Reviews e e-mails da resposta externa não são armazenados nem retornados. A API documenta título, preço, descrição, categoria, imagem e busca por texto: [DummyJSON Products](https://dummyjson.com/docs/products).

### Estrutura

```text
apps/
  api/
    migrations/       Migrações SQL versionadas
    src/              Rotas, autenticação, regras e serviços do leilão
  web/
    src/              Páginas React e estilos responsivos
docs/
  requirements.md     Requisitos extraídos do PDF e decisões adotadas
scripts/
  migrate.ts          Aplicador de migrações
  seed.ts             Dados de demonstração idempotentes
tests/                Testes unitários, de auditoria e integração PostgreSQL
```

## Pré-requisitos

- Node.js 24 ou mais recente.
- pnpm 11.25.0 (pelo Corepack).
- PostgreSQL 16 ou mais recente, ou Docker Desktop com Docker Compose (o Compose usa PostgreSQL 17).

## Configuração local

No PowerShell, a partir da pasta do projeto:

```powershell
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
Copy-Item .env.example .env
```

Gere dois segredos independentes e coloque os valores nas linhas `JWT_SECRET=` e `AUDIT_SECRET=` de `.env`:

```powershell
node -p "require('node:crypto').randomBytes(48).toString('base64')"
node -p "require('node:crypto').randomBytes(48).toString('base64')"
```

O segredo de auditoria deve permanecer igual durante toda a vida do banco. Trocar o valor fará os históricos assinados existentes aparecerem como comprometidos; perder o valor torna a verificação inconclusiva.

### Banco PostgreSQL com Docker Compose

O Compose disponibiliza PostgreSQL local na porta `5432` com o usuário e a senha de desenvolvimento já mostrados em `docker-compose.yml`:

```powershell
docker compose up -d database
```

O `DATABASE_URL` de `.env.example` corresponde a esse banco. Para usar um PostgreSQL instalado fora do Compose, altere a URL em `.env`.

### Migrações, seed e aplicação

```powershell
pnpm migrate
pnpm seed
pnpm dev
```

O Vite abre em `http://localhost:5173` e encaminha `/api` e Socket.IO ao servidor Node em `http://localhost:4000`. O back-end entrega a build do React no mesmo host em produção. A API externa só é necessária para pesquisar/criar novos lotes; os lotes existentes usam os snapshots no banco.

Para iniciar tudo em contêineres, depois de configurar `.env`:

```powershell
docker compose up --build
```

Abra `http://localhost:4000`. O comando padrão da imagem aplica migrações e executa o seed de forma idempotente antes de iniciar o servidor. A imagem inclui os módulos usados pelo seed.

## Contas e roteiro de demonstração

No ambiente local, `pnpm seed` cria estas contas **somente se ainda não existirem**:

| Papel | E-mail | Senha inicial |
|---|---|---|
| Leiloeiro | `leiloeiro@verzel.demo` | `DemoAuction#2026` |
| Licitante 1 | `ana@verzel.demo` | `DemoAuction#2026` |
| Licitante 2 | `bruno@verzel.demo` | `DemoAuction#2026` |

Em desenvolvimento, a senha padrão facilita o roteiro local. `DEMO_PASSWORD` pode substituí-la para contas criadas pela primeira vez. Em produção, essa variável é obrigatória e não há fallback implícito. O Blueprint fornecido configura a mesma senha de demonstração para que o avaliador consiga entrar no ambiente publicado. O seed não imprime senhas nos logs e não troca a senha de uma conta existente.

Estas são contas públicas de demonstração, com saldo fictício, usadas tanto localmente quanto na implantação de avaliação criada com o Blueprint. Elas existem para permitir que o avaliador percorra os dois papéis sem provisionamento manual. Não reutilize essa senha em contas ou sistemas reais; para outra implantação, substitua `DEMO_PASSWORD` antes de publicar. O valor não aparece na tela de login nem nos logs.

Fluxo sugerido: entre como Ana, confira a carteira e dê um lance em um lote ao vivo; saia e entre como Bruno para cobrir a oferta. A sala da Ana deve indicar que ela foi superada, enquanto o saldo reservado é liberado. No painel do leiloeiro, confira os quatro lotes, pesquise no DummyJSON e publique outro. Para demonstrar a compra, finalize um lote de teste, confirme o débito do vencedor, o crédito ao leiloeiro e abra o recibo público sem login.

## Regras de lance e consistência financeira

- O servidor consulta o próprio relógio do PostgreSQL e aceita somente `starts_at <= agora < ends_at`.
- O primeiro lance precisa atingir o lance inicial. Depois disso, o mínimo é o lance atual mais o incremento.
- O licitante que lidera não pode cobrir a si mesmo; leiloeiro não pode dar lances.
- Os valores são enviados e persistidos como centavos inteiros. O saldo disponível é o total da carteira menos a soma das reservas ativas.
- A transação trava o lote e as carteiras relevantes; valida os limites, libera a reserva anterior, cria a nova reserva, grava o evento do lance, avança a cabeça assinada e atualiza o horário final. Em falha, a transação inteira volta.
- Uma reserva existe por lote. Quando o líder é superado, a reserva anterior é removida na mesma transação e volta imediatamente ao saldo disponível. Uma carteira pode ter reservas em diversos lotes.
- Um lance aceito a até dois minutos do fim define o fim como exatamente dois minutos após o horário do lance, mesmo se já houver uma prorrogação anterior.
- O worker consulta lotes vencidos a cada cinco segundos. A linha do lote é bloqueada, o resultado tem uma chave única por lote e o compromisso é removido na mesma transação do débito do vencedor e crédito do leiloeiro. Sem lances, não há transferência. Se o processo reiniciar, o próximo ciclo continua o trabalho.
- O sucesso só é retornado depois do commit. O evento Socket.IO é emitido depois da transação. Se uma conexão cair, a reconexão volta a pedir o estado completo da sala.

## Auditoria e privacidade

Cada evento armazena sequência, lote, participante interno, centavos, horário, hash anterior e hash SHA-256 do evento. O hash inclui esses campos. A tabela `audit_heads` guarda sequência esperada, hash final e HMAC-SHA-256 calculado com `AUDIT_SECRET`; a cabeça é atualizada na mesma transação do lance.

A página pública recalcula a sequência e os hashes, compara a contagem e a cabeça e valida o HMAC. Isso detecta alteração de valor/participante/horário, remoção no meio ou no fim, inserção, troca da sequência ou encadeamento e mudança na própria cabeça. Quando falta a cabeça, a tela diz que não foi possível verificar; não declara integridade por padrão. O modelo de ameaça e seus limites operacionais estão em [docs/security-model.md](docs/security-model.md).

Lances e participantes públicos são pseudônimos; e-mail, hash da senha e token da sessão nunca entram na auditoria nem nos recibos.

O recibo usa UUID aleatório e exibe lote, total final, encerramento e pseudônimo do vencedor. A rota do recibo não exige sessão.

## API principal

| Método e caminho | Acesso | Ação |
|---|---|---|
| `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | Público / sessão | Cadastro, login, saída e sessão atual |
| `GET /api/lots`, `GET /api/lots/:id` | Público | Vitrine e sala do lote |
| `POST /api/lots/:id/bids` | Licitante | Envio de lance |
| `GET /api/lots/:id/audit`, `GET /api/receipts/:token` | Público | Auditoria e comprovante |
| `GET /api/wallet`, `POST /api/wallet/deposits`, `GET /api/me/activity` | Licitante | Carteira, depósito e atividade |
| `GET /api/seller/products?q=...`, `GET /api/seller/lots`, `POST /api/seller/lots`, `DELETE /api/seller/lots/:id`, `GET /api/seller/summary` | Leiloeiro | Catálogo, gestão de lotes e resultados |
| `GET /api/health` | Público | Verificação do serviço e banco |

Origem HTTP e WebSocket é limitada a `APP_ORIGIN`. Localmente o padrão é `http://localhost:5173`; no Render o servidor usa `RENDER_EXTERNAL_URL` quando não há override. A interface e a API são servidas no mesmo domínio publicado.

## Testes, lint e build

```powershell
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Os testes unitários cobrem mínimo e incremento, papel, líder, lote agendado/ao vivo/encerrado/cancelado, saldo disponível, extensão antissniping, API indisponível e manipulações de histórico. Os testes PostgreSQL percorrem cadastro sem elevação de papel, login, depósito, lances concorrentes, evento Socket.IO, liberação da reserva, recusa de cancelamento, adulteração real de registros, encerramento simultâneo, prevenção de liquidação duplicada, papéis/ownership e acesso público ao recibo; também verificam encerramento sem vencedor. Eles ficam desabilitados por padrão para nunca escrever em um banco normal. Foram executados nesta entrega em um cluster temporário PostgreSQL 16 isolado.

Para executá-lo, crie um PostgreSQL **descartável e isolado**, configure a URL abaixo e aplique a migração nesse banco:

```powershell
$env:DATABASE_TEST_URL = 'postgresql://auction:senha@localhost:5432/verzel_auction_test'
$env:DATABASE_URL = $env:DATABASE_TEST_URL
pnpm migrate
$env:RUN_DATABASE_TESTS = 'true'
pnpm test
```

## Deploy

O repositório inclui `Dockerfile`, `docker-compose.yml` e `render.yaml`. O Blueprint declara um serviço web Docker e PostgreSQL no plano `free` e gera `JWT_SECRET` e `AUDIT_SECRET`; a senha das contas de avaliação é fixa e está documentada acima para que o avaliador possa entrar. Para compatibilidade com o plano gratuito, a imagem aplica migrações e executa o seed no comando de inicialização; o Render reserva o comando de pre-deploy para serviços pagos ([documentação](https://render.com/docs/deploys)). O health check valida `/api/health`. O runtime do Render fornece `RENDER_EXTERNAL_URL`, usada para validar origem e WebSocket. O deploy Docker e o blueprint são suportados conforme a [documentação Docker](https://render.com/docs/docker) e [Blueprints](https://render.com/docs/blueprint-spec).

O código está publicado em [mateusm1403/verzel-leiloes](https://github.com/mateusm1403/verzel-leiloes) e a aplicação em [https://verzel-leiloes.onrender.com](https://verzel-leiloes.onrender.com/). A verificação externa de 28/10/2026 confirmou a página, os assets e `/api/health`; o catálogo retornou quatro lotes ao vivo e as quatro auditorias dos lotes semeados estavam íntegras. Antes da avaliação, percorra também o login dos dois papéis, o lance em navegador separado, o saldo comprometido, o painel do leiloeiro e a auditoria pública. O recibo e a liquidação estão cobertos pelos testes de integração PostgreSQL.

O serviço está configurado no plano gratuito e não cria recurso pago no arquivo. Planos e limites do provedor podem mudar; confirme-os no painel antes de criar o Blueprint.

## Limitações conhecidas

- A suíte padrão deixa a integração PostgreSQL desabilitada; os testes de integração desta entrega foram executados com sucesso em um banco temporário descartável. Para repeti-los, configure `DATABASE_TEST_URL` e use os comandos acima.
- O seed é idempotente: não reabre lotes encerrados nem restaura lances em um banco já utilizado. Para uma demonstração limpa, configure um banco de teste descartável novo e execute migração e seed.
- O seed publica lotes de demonstração por até 30 dias; não há reposição automática de ofertas depois que esses lotes encerram. O acesso ao perfil de leiloeiro também é provisionado pelo operador, não pelo cadastro público.
- A verificação externa confirmou saúde, catálogo e auditoria em 28/10/2026. O fluxo interativo de login e Socket.IO ainda precisa ser conferido no host publicado.
- O plano gratuito do Render dorme após inatividade e seu PostgreSQL expira após 30 dias;
- A sala Socket.IO transmite eventos entre clientes conectados à mesma instância. O banco serializa lances e encerramentos entre instâncias, mas escalar horizontalmente o serviço exige adicionar um adapter compartilhado (por exemplo Redis) para propagar eventos entre processos.
- DummyJSON é um catálogo de demonstração; a aplicação guarda uma cópia do item para que lotes publicados continuem funcionando quando a API externa não responder.
- Recuperação de senha, nota fiscal, revenda e aplicativo nativo estão fora do desafio.

## Uso de IA

Usei o Codex integrado ao repositório como copiloto durante o desenvolvimento. Comecei fornecendo o enunciado completo e pedi que os requisitos fossem organizados em uma lista verificável. A partir dela, usei a IA para apoiar a implementação, a documentação e os testes, especialmente nos fluxos de lances, saldo comprometido, encerramento dos lotes e auditoria do histórico.

Também usei o Codex para revisar a experiência como se fosse um avaliador: identificar mensagens pouco claras, pontos confusos na interface e requisitos que poderiam passar despercebidos. Durante a publicação, compartilhei os logs do Render para investigar a falha de inicialização do Docker e confirmar a correção. Depois, conferi a aplicação publicada e os endpoints de saúde e auditoria.

Procurei trabalhar em ciclos curtos: dava contexto e critérios concretos, analisava as sugestões, pedia ajustes quando necessário e verificava o resultado no código, nos testes e na aplicação. A IA acelerou a análise e a execução, mas usei meu julgamento para decidir o que entraria no projeto e conferir se a solução atendia ao enunciado.
