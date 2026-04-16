# Hard-Work: Cortex Cloud — Dashboard + Login pra assinantes

**Contexto:** Cortex (mem-ria) v0.2.0 está publicado no npm com license gate. LP live em cortex.eontech.pro com Stripe. Agora precisa de: login, dashboard hosted onde o assinante vê seu brain visualmente, e sync do brain.db local → cloud.

**Base existente que pode reaproveitar:**
- Eon Work Auth (`/root/eon-work/auth/`) — já tem signup, login OTP, JWT, WebAuthn, orgs
- Horizon (`/opt/clawdio-horizon/`) — já tem dashboard com agents, costs, memory facts
- Dashboard local do mem-ria (`/root/mem-ria/apps/dashboard/index.html`) — 4 tabs já prontas
- Stripe configurado — products e payment links criados, keys em `/root/.secrets/cortex-stripe.env`
- License gate — keys HMAC no `@mem-ria/core`

**Destino:** `cortex.eontech.pro/app/` — dashboard do assinante

---

## Arquitetura

```
cortex.eontech.pro/           → LP (static, já existe)
cortex.eontech.pro/app/       → Dashboard (autenticado)
cortex.eontech.pro/api/       → API backend

Backend: Node.js + Hono (já usado no @mem-ria/server)
Auth: JWT (pode reaproveitar lógica do eon-work-auth)
DB: SQLite (users, subscriptions) ou Postgres (se quiser escalar)
Storage: brain.db por usuário em /data/cortex/brains/{userId}/brain.db
Stripe: webhook pra ativar subscription + gerar license key automaticamente
```

---

## Phases

### Phase 1 — Auth backend (signup, login, JWT)

Criar `/root/mem-ria/cloud/` com:

- `server.ts` — Hono server na porta 3335
- `auth.ts` — rotas:
  - `POST /api/auth/signup` — email + password → cria user → envia OTP por email
  - `POST /api/auth/login` — email + password → envia OTP
  - `POST /api/auth/verify` — email + OTP → JWT (access 15min + refresh 7d)
  - `GET /api/auth/me` — retorna user info + subscription status
- `db.ts` — SQLite com tabelas: users (id, email, password_hash, created), sessions, subscriptions (user_id, plan, stripe_customer_id, stripe_subscription_id, status, license_key)
- JWT com secret em `/root/.secrets/cortex-jwt.env`

**Referência:** `/root/eon-work/auth/server.js` já tem tudo isso. Portar as partes relevantes.

**Gate:** signup → login → me retorna user. JWT válido.

### Phase 2 — Stripe webhook (pagamento → license key automática)

- `POST /api/stripe/webhook` — recebe evento `checkout.session.completed`
  - Extrai email do customer
  - Cria/atualiza subscription no DB
  - Gera license key via `generateKey(plan, 365)` do `@mem-ria/core`
  - Salva key no DB
  - Envia email com a key (via Resend API — já usado no Eon Work)
- Configurar webhook no Stripe dashboard apontando pra `https://cortex.eontech.pro/api/stripe/webhook`

**Gate:** fazer um pagamento teste → receber key por email → `mem-ria activate` funciona.

### Phase 3 — Brain sync (local → cloud)

O assinante roda `mem-ria` localmente. O brain.db dele precisa sincronizar com o cloud pra aparecer no dashboard.

Opções:
1. **Upload do brain.db inteiro** — simples, `mem-ria sync` faz upload do brain.db pra `/api/brain/upload`
2. **Sync incremental** — mais complexo, envia só entries novas/modificadas
3. **Cloud-first** — brain.db vive no cloud, CLI lê/escreve via API

**Recomendação pra v1: opção 1 (upload).** Simples, funciona, dá pra melhorar depois.

- CLI: `mem-ria sync` — comprime brain.db, faz upload pra `/api/brain/upload` com Bearer JWT
- Backend: salva em `/data/cortex/brains/{userId}/brain.db`
- Schedule: `mem-ria serve` faz sync a cada 1h automaticamente

**Gate:** `mem-ria sync` → brain aparece no dashboard cloud.

### Phase 4 — Dashboard visual (a parte bonita)

Página em `cortex.eontech.pro/app/` (autenticada). Design system Eontech.

**Telas:**

1. **Login/Signup** — email + password, OTP verify. Clean, dark, centered.

2. **Overview (home)** — 
   - Número grande: total de memórias
   - Brain health: 6 dimensões como círculos coloridos (tipo o insular)
   - Gráfico de memórias por dia (últimos 30 dias) — linha simples
   - Top 5 entidades — cards com mention count
   - Salience distribution — barras coloridas (low → very_high)
   - Último brain cycle — timestamp + steps

3. **Memory Explorer** —
   - Lista de todas as memórias com filtros: kind, source, scope, salience range
   - Cada memória expande pra mostrar body completo + metadata
   - Busca com FTS (usa a API de search do mem-ria)
   - Sort: by salience, by date, by source
   - Kind badges coloridas (decision=roxo, fact=azul, person=verde, project=laranja)

4. **Brain Graph** —
   - Visualização de grafo: entidades como nós, memórias como edges
   - Clica na entidade → mostra todas as memórias sobre ela
   - Cores por tipo de entidade
   - Usa canvas ou SVG simples (sem lib pesada)
   - Inspiração: vault-graph.js que já existe no Horizon

5. **Brain Health** —
   - 6 dimensões do insular como cards grandes
   - Cada card: ícone, status (green/yellow/red), mensagem, trend (últimos 7 dias)
   - Timeline do brain cycle: últimos 10 runs com duração e steps

6. **Settings** —
   - Plano atual + link pro Stripe billing portal
   - License key (copiável)
   - Sync status (último sync, brain.db size)
   - Botão: "Download brain.db" (backup local)

**Visual:** Mesmo design system da LP — Space Grotesk, JetBrains Mono, verde lima, fundo escuro, gradientes, noise overlay.

**Gate:** Login → vê overview com dados reais do brain sincronizado.

### Phase 5 — API endpoints pra dashboard

O dashboard precisa de API. Reaproveita o `@mem-ria/server` existente, mas autenticado com JWT do user:

```
GET  /api/brain/stats         → stats do brain do user
GET  /api/brain/search?q=     → search no brain do user
GET  /api/brain/health        → insular report
GET  /api/brain/salience      → salience distribution
GET  /api/brain/entities      → lista de entidades
GET  /api/brain/entity/:name  → detalhe da entidade
POST /api/brain/cycle         → trigger brain cycle
GET  /api/brain/memories      → lista paginada de memórias
GET  /api/brain/timeline      → memórias por dia (últimos 30d)
POST /api/brain/upload        → upload do brain.db
GET  /api/brain/download      → download do brain.db
```

Cada request carrega o brain.db do user em `/data/cortex/brains/{userId}/brain.db`, instancia um `MemRia` temporário, executa, e fecha.

### Phase 6 — Deploy

- Nginx: adicionar location `/app/` e `/api/` no config de cortex.eontech.pro
- PM2: process `cortex-cloud` na porta 3335
- Cloudflare: já configurado (cortex.eontech.pro)
- Cron: brain cycle noturno pra cada user ativo

**Gate:** tudo rodando em produção, acessível em cortex.eontech.pro/app/.

---

## Estimativas

| Phase | Tempo | Complexidade |
|---|---|---|
| 1. Auth | 2-3h | Médio (pode portar do eon-work) |
| 2. Stripe webhook | 1-2h | Baixo |
| 3. Brain sync | 2h | Médio |
| 4. Dashboard visual | 4-5h | Alto (6 telas, visual rico) |
| 5. API endpoints | 2h | Baixo (reusa @mem-ria/server) |
| 6. Deploy | 1h | Baixo |
| **Total** | **12-15h** | |

---

## Dados necessários

- JWT secret: gerar e salvar em `/root/.secrets/cortex-jwt.env`
- Resend API key: pra enviar emails (OTP + license key). Já tem?
- Stripe webhook secret: configurar no Stripe dashboard
- Diretório de brains: `/data/cortex/brains/`

## Referências no código existente

| O que | Onde |
|---|---|
| Auth (signup, login, JWT, OTP) | `/root/eon-work/auth/server.js` |
| Dashboard UI | `/root/mem-ria/apps/dashboard/index.html` |
| Vault graph | `/opt/clawdio-horizon/public/horizon/vault-graph.js` |
| Brain modules API | `/root/mem-ria/packages/server/src/index.ts` |
| License key generation | `/root/mem-ria/packages/core/src/license.ts` |
| Design system | `/var/www/cortex-eontech/index.html` (LP) |
| Stripe keys | `/root/.secrets/cortex-stripe.env` |

## Como iniciar na próxima sessão

Copie isso:

> Quero implementar o Cortex Cloud. O HARDWORK está em `/root/mem-ria/HARDWORK-cloud.md`. Ele tem 6 phases: auth, stripe webhook, brain sync, dashboard visual, API, deploy. O produto Cortex (mem-ria) já está publicado no npm v0.2.0 com license gate. LP em cortex.eontech.pro com Stripe. O goal é: assinante faz login em cortex.eontech.pro/app/ e vê seu brain visualmente — memórias, entidades, saúde, grafo. Começa pela Phase 1 (auth).
