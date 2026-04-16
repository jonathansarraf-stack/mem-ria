# mem-ria — Roteiro de Teste Manual

Roteiro pra testar o mem-ria como um usuário real faria, antes de mostrar pra alguém.

## Pré-requisitos

```bash
cd /root/mem-ria
pnpm build
```

## Teste 1 — CLI básico (5 min)

```bash
# Cria um diretório de teste limpo
mkdir -p /tmp/test-memria && cd /tmp/test-memria

# Cria dados fake de memória do Claude
mkdir -p .claude/projects/test/memory
cat > .claude/projects/test/memory/decision.md << 'EOF'
---
name: Auth Decision
type: project
description: Decided to use JWT over sessions
---
We decided to use JWT tokens instead of server-side sessions.
Reason: stateless, works across microservices, team agreed on 2026-04-10.
EOF

# Init
HOME=/tmp/test-memria mem-ria init

# Verifica o que foi ingerido
HOME=/tmp/test-memria mem-ria status

# Busca
HOME=/tmp/test-memria mem-ria search "JWT"
HOME=/tmp/test-memria mem-ria search "decisões de hoje"

# Roda o brain cycle
HOME=/tmp/test-memria mem-ria cycle

# Diagnóstico
HOME=/tmp/test-memria mem-ria doctor
```

**O que verificar:**
- [ ] `init` reporta quantas memórias ingeriu
- [ ] `search "JWT"` encontra a decisão do auth
- [ ] `cycle` roda sem erros e reporta cada stage
- [ ] `status` mostra health e stats
- [ ] `doctor` reporta brain.db e config OK

---

## Teste 2 — HTTP API + multi-agent (5 min)

```bash
# Terminal 1: sobe o server
HOME=/tmp/test-memria mem-ria serve --http --port 3334
# Anota a API key que ele gera

# Terminal 2: testa os endpoints (substitui KEY pela key gerada)
KEY="a-key-gerada"

# Health check (sem auth)
curl http://localhost:3334/healthz

# Salva memória como agent rafael
curl -X POST http://localhost:3334/api/memory \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"source":"test","title":"Cliente quer desconto","body":"Acme pediu 15% off no contrato anual","kind":"fact","scope":"agent:rafael"}'

# Salva memória como agent camila
curl -X POST http://localhost:3334/api/memory \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"source":"test","title":"Launch adiado","body":"Lançamento do produto movido pra Q3","kind":"decision","scope":"agent:camila"}'

# Busca como rafael — deve achar "desconto"
curl "http://localhost:3334/api/memory/search?q=desconto&scope=agent:rafael" \
  -H "Authorization: Bearer $KEY"

# Busca como camila — NÃO deve achar "desconto" (isolamento)
curl "http://localhost:3334/api/memory/search?q=desconto&scope=agent:camila" \
  -H "Authorization: Bearer $KEY"

# Brain health
curl http://localhost:3334/api/brain/health \
  -H "Authorization: Bearer $KEY"

# Brain cycle
curl -X POST http://localhost:3334/api/brain/cycle \
  -H "Authorization: Bearer $KEY"

# Stats
curl "http://localhost:3334/api/memory/search?q=JWT" \
  -H "Authorization: Bearer $KEY"

# Dashboard (abre no browser)
# http://localhost:3334/dashboard
```

**O que verificar:**
- [ ] Server sobe e mostra API key gerada
- [ ] `healthz` responde sem auth
- [ ] POST salva e retorna id
- [ ] Search do rafael acha "desconto"
- [ ] Search da camila NÃO acha "desconto" (scope isolation)
- [ ] `/api/brain/health` retorna report
- [ ] `/api/brain/cycle` roda e retorna steps
- [ ] Request sem Bearer → 401
- [ ] Dashboard abre no browser

---

## Teste 3 — MCP com Claude Code (5 min)

```bash
# Verifica que MCP tá configurado
cat ~/.claude/settings.json | grep mem-ria

# Abre uma conversa no Claude Code e pede:
# "Use memory_search to find what you know about JWT"
# "Save this as a memory: we decided to use Hono for the HTTP server"
# "Check the brain status"
# "Show me the memory stats"
```

**O que verificar:**
- [ ] Claude Code consegue chamar memory_search
- [ ] Claude Code salva via memory_save
- [ ] brain_status retorna health report
- [ ] memory_stats mostra contagem

---

## Teste 4 — Segurança (3 min)

```bash
KEY="a-key-gerada"

# Sem auth → 401
curl http://localhost:3334/api/memory/search?q=test
# Esperado: {"error":"Unauthorized"}

# Body inválido → 400
curl -X POST http://localhost:3334/api/memory \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d 'not json'
# Esperado: {"error":"Invalid JSON body"}

# Scope isolation — agent rafael NÃO consegue ver agent camila
curl "http://localhost:3334/api/memory/search?q=Launch&scope=agent:rafael" \
  -H "Authorization: Bearer $KEY"
# Esperado: 0 resultados (Launch tá em agent:camila)
```

**O que verificar:**
- [ ] Sem auth retorna 401
- [ ] JSON inválido retorna 400
- [ ] Scopes são isolados entre agents

---

## Teste 5 — Dashboard visual (2 min)

Abre `http://localhost:3334/dashboard` no browser.

**O que verificar:**
- [ ] Overview mostra total de memórias
- [ ] Search funciona (digita query, vê resultados)
- [ ] Health mostra indicadores coloridos
- [ ] Auto-refresh funciona (espera 30s)

---

## Critério de "pronto pra mostrar"

Todos os [ ] acima marcados? Então tá pronto.

Se algo falhar:
1. Anota o que falhou
2. Roda `mem-ria doctor` pra diagnóstico
3. Me avisa que corrijo
