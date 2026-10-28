# Requisitos do desafio Verzel

Fonte: enunciado PDF de 7 páginas fornecido para este desafio (não incluído no repositório).

## Funcionais obrigatórios

- Autenticação com os papéis Leiloeiro e Licitante, com autorização aplicada no servidor.
- Leiloeiro busca item em API pública, cria lotes persistidos, acompanha apenas os próprios lotes, cancela lote sem lance e consulta o resultado e total recebido.
- Vitrine separa lotes agendados, ao vivo e encerrados; não mostra cancelados.
- Sala do lote apresenta item, lance atual, histórico pseudônimo, contagem regressiva, liderança e formulário; atualiza sem recarregar.
- Licitante consulta carteira total/comprometido/disponível, deposita saldo fictício, acompanha lances e arremates e compartilha comprovante público.
- Auditoria pública mostra lances completos e recalcula integridade a partir das evidências criptográficas; recibos e auditoria não expõem dados privados.
- O deploy de uma aplicação acessível por link público é obrigatório na avaliação.

## Regras de negócio obrigatórias

- Lance aceito apenas quando `startsAt <= horário_do_servidor < endsAt`.
- Primeiro lance >= lance inicial; próximos >= lance atual + incremento.
- O líder não cobre o próprio lance.
- O valor integral do lance do líder fica reservado; ser superado libera a reserva imediatamente.
- Lance exige saldo disponível suficiente e usa centavos inteiros.
- Lance válido nos dois minutos finais prorroga o fim para dois minutos após o lance.
- Encerramento debita o vencedor, credita o leiloeiro, registra um resultado único e disponibiliza recibo; lote sem lances termina sem transferência.
- Encerramento ocorre no servidor, mesmo sem visitantes, e é idempotente.
- Operação de lance é atômica e serializada entre lote e carteiras.
- Rejeições retornam motivo específico e confiável.

## Interface e experiência

- Interface responsiva e consistente, com estados vazios, loading e erro, validação, feedback, datas/valores brasileiros, teclado e confirmação ao cancelar.
- A contagem regressiva é informativa; o relógio do servidor decide a validade do lance.
- Busca/filtros e modo escuro são opcionais.

## Backend, banco e privacidade

- Tecnologias obrigatórias: React; Node.js ou Python; PostgreSQL, MySQL ou NoSQL.
- A aplicação segue útil se a API externa falhar; itens de lotes já existentes são snapshots locais.
- Senhas protegidas por hash; permissões e decisões financeiras conferidas no servidor.
- O histórico deve detectar alteração, remoção ou inserção, inclusive mudanças diretas no banco; explicar o modelo de ameaça e limitações.
- Auditoria e recibo usam identificadores pseudônimos.
- Migrações, índices, restrições, `.env.example` sem segredos e seed idempotente.

## Entrega e demonstração

- Seed: 1 leiloeiro, 2 licitantes, carteiras suficientes e 1 lote ao vivo com lances no mínimo; a demonstração atual cria 4; credenciais documentadas; nunca redefine saldos existentes.
- README em português com instalação, banco, migrações, seed, execução, testes, regras, auditoria e deploy.
- Testes para regras críticas, concorrência, liquidação, API indisponível, adulteração, permissões e recibo público.
- Registro honesto de o que passou, falhou, não pôde ser verificado e de eventual bloqueio do deploy.

## Opcionais

- Busca/filtro de lotes, cancelamento com estorno automático, Docker Compose, testes adicionais e tema escuro.

## Explicitamente dispensados

- Nota fiscal, revenda entre usuários, aplicativo nativo e recuperação de senha.

## Decisões adotadas

- PostgreSQL e `pg` (SQL parametrizado) para controlar bloqueios `FOR UPDATE` e transações de lance/liquidação sem abstrair as garantias concorrentes.
- API de produtos DummyJSON; produto é buscado novamente ao criar o lote e os atributos/imagem são armazenados como snapshot.
- SHA-256 por evento e cabeça HMAC-SHA-256 com sequência + hash final mantida no banco; segredo fica apenas no servidor.
- Recibo público com token aleatório, sem login; participante mostrado por `publicId` aleatório.
- Um processo Node executa liquidação periódica; bloqueio e constraint única tornam reexecuções seguras em múltiplas instâncias.
- Deploy preparado via Docker/Render Blueprint; publicação só pode ser confirmada depois de associar um repositório, configurar credenciais e verificar URL.
