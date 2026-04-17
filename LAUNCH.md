# Cortex (mem-ria) — Launch Content

## Show HN

**Title:** Show HN: Cortex – Persistent memory for AI coding agents (Claude Code, Cursor, etc.)

**Text:**

Hi HN, I built Cortex (npm package: mem-ria) because I was frustrated that every time I start a new Claude Code session, it forgets everything from previous sessions.

Most "AI memory" tools are just vector stores — save embedding, retrieve top-K. Cortex does more:

- **Importance scoring** — 7 signals score each memory (recency, frequency, entity density, decisions vs. noise)
- **Auto-pruning** — archives low-value memories so your brain stays lean
- **Entity linking** — tracks people, projects, tools with canonical names + aliases
- **Nightly brain cycle** — like sleep consolidation: rescan, score, prune, embed, self-diagnose
- **Self-diagnosis** — 6 health dimensions tell you if your memory is healthy or degrading

It installs as an MCP server for Claude Code in 2 commands:

```
npm install -g mem-ria
mem-ria init
```

After that, Claude Code remembers across sessions — preferences, decisions, people, project context.

There's also a cloud dashboard at cortex.eontech.pro where you can visualize your brain: memory explorer, entity graph, salience distribution, health checks.

Stack: TypeScript, SQLite (better-sqlite3), Hono, zero external API dependencies (brain runs locally).

Free tier: 100 memories. Paid: starts at $9/mo for 10K memories + advanced features.

GitHub: https://github.com/jonathansarraf-stack/mem-ria
npm: https://www.npmjs.com/package/mem-ria
Dashboard: https://cortex.eontech.pro/app/

---

## Reddit r/ClaudeAI

**Title:** I gave Claude Code a brain that actually remembers between sessions

**Text:**

I was tired of re-explaining my project setup, team members, coding conventions, and past decisions every time I start a new Claude Code session. So I built **Cortex** (npm: `mem-ria`).

**What it does:**
- Installs as an MCP server (`npm i -g mem-ria && mem-ria init`)
- Claude Code gets memory tools: save, search, entity lookup, brain diagnostics
- Memories persist in a local SQLite brain.db
- A nightly "brain cycle" scores importance, prunes noise, links entities

**What makes it different from just saving notes:**
- It scores importance (salience) using 7 signals — not all memories are equal
- It auto-prunes noise so your brain doesn't bloat
- It tracks entities (people, projects, tools) and links memories to them
- It self-diagnoses: tells you if ingestion stopped, if salience is stale, etc.

**Cloud dashboard (optional):**
- `mem-ria sync` uploads your brain to cortex.eontech.pro/app/
- Visualize: memory explorer, entity graph, salience distribution, health checks
- Free to try, $9/mo for full features

2 commands to set up. Zero config. Works with Claude Code out of the box.

GitHub: https://github.com/jonathansarraf-stack/mem-ria

Anyone else frustrated by the amnesia problem?

---

## Reddit r/ChatGPTCoding

**Title:** Built an MCP server that gives AI coding assistants persistent memory with importance scoring

**Text:**

Just open-sourced **mem-ria** — a memory layer for AI coding tools (Claude Code, Cursor, any MCP-compatible client).

The problem: AI assistants forget everything between sessions. You keep re-explaining the same context.

My solution is different from just "save to vector DB":

| Feature | Vector stores | mem-ria |
|---|---|---|
| Store + retrieve | yes | yes |
| Importance scoring | no | 7-signal salience |
| Auto-pruning | no | rules + AI |
| Entity tracking | no | canonical names + aliases |
| Self-diagnosis | no | 6 health dimensions |
| Nightly consolidation | no | full pipeline |

Install: `npm i -g mem-ria && mem-ria init`

It runs 100% local (SQLite), no API keys needed for the core brain. Optional cloud dashboard for visualization.

Free tier: 100 memories (enough to try it). Paid starts at $9/mo.

GitHub: https://github.com/jonathansarraf-stack/mem-ria
Site: https://cortex.eontech.pro

---

## Twitter/X Thread

**Tweet 1 (hook):**
Your AI has amnesia. Every session starts from zero.

I built Cortex — persistent memory for AI agents that actually thinks.

Not just a vector store. A brain. 🧠

**Tweet 2 (problem):**
Most "AI memory" solutions:
save(fact) → embed → vector store → top-K retrieval

That's a filing cabinet, not a brain.

Real brains score importance, forget noise, consolidate knowledge overnight, and notice when something is wrong.

**Tweet 3 (solution):**
Cortex does exactly that:

→ 7-signal importance scoring
→ Auto-pruning (archive noise)
→ Entity linking (people, projects, tools)
→ Nightly brain cycle (rescan → score → prune → embed → diagnose)
→ Self-diagnosis (6 health dimensions)

2 commands to install:
npm i -g mem-ria
mem-ria init

**Tweet 4 (demo):**
What it looks like in Claude Code:

[attach demo-cli.svg]

After init, Claude Code remembers:
- Your preferences
- Past decisions
- People and entities
- Project context

Across every session. Forever.

**Tweet 5 (dashboard):**
Optional cloud dashboard at cortex.eontech.pro:

[attach dashboard-preview.png]

→ Memory explorer with filters
→ Entity relationship graph
→ Salience distribution
→ Brain health checks
→ One-click brain cycle

**Tweet 6 (differentiator):**
vs Mem0: they charge per API call, need cloud. Cortex runs 100% local.
vs Zep: chatbot-focused. Cortex is for dev tools.
vs Letta: complex agent framework. Cortex is npm install + done.

Free tier: 100 memories.
Pro: $9/mo → 10K memories + embeddings + cloud.

**Tweet 7 (CTA):**
GitHub: github.com/jonathansarraf-stack/mem-ria
npm: npmjs.com/package/mem-ria
Dashboard: cortex.eontech.pro/app/

Works with Claude Code, Cursor, Windsurf — anything that speaks MCP.

Star it. Try it. Tell me what breaks.

---

## Product Hunt (one-liner)

**Tagline:** A brain for your AI — persistent memory with importance scoring, auto-pruning, and self-diagnosis

**Description:** Cortex gives your AI coding assistant (Claude Code, Cursor) persistent memory that manages itself. It scores importance, prunes noise, links entities, and runs a nightly brain cycle. 2 commands to install, 100% local, zero config.
