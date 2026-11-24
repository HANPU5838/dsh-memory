<div align="center">

# DSH Memory

**Local long-term memory for DeepSeek Harness: 11 tools · 4 recall channels · decays, consolidates, self-audits · data never leaves your machine**

[![version](https://img.shields.io/badge/version-v1.12.2-4B9CD3.svg)](https://github.com/HANPU5838/dsh-memory/releases)
[![ci](https://github.com/HANPU5838/dsh-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/HANPU5838/dsh-memory/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/HANPU5838/dsh-memory?style=flat&color=DAA520)](https://github.com/HANPU5838/dsh-memory/stargazers)
[![license](https://img.shields.io/badge/license-MIT-3DA639.svg)](LICENSE)

**[Install](#install-in-30-seconds) · [Features](#why-it-is-a-real-memory-system) · [Configuration](#configuration) · [Tools](#the-eleven-tools) · [Comparison](docs/comparison.md) · [Changelog](CHANGELOG.md)**

[中文](README.md) · **English** · [Website](https://hanpu5838.github.io/dsh-memory/)

</div>

**Current version: v1.12.2** · [Release](https://github.com/HANPU5838/dsh-memory/releases) · [Changelog](CHANGELOG.md)

> This is the independently maintained edition of DSH Memory — the only source for code, releases,
> issues, installs and updates. The package name `@restregular/dsh-memory` exists only to satisfy the
> DSH loader entry. The original author and the MIT license are preserved in full (see [LICENSE](LICENSE)).

## Install in 30 seconds

```bash
dsh plugin --profile web add "github:HANPU5838/dsh-memory#main"
```

Restart `dsh web` once. It works with **zero configuration**: without a vector backend it falls back to
pure lexical retrieval and makes no network requests. For semantic retrieval, open the panel →
"Service" → "Vector service" and run the one-click installer (on Termux: `pkg install llama-cpp`,
then the bge-m3 model is downloaded automatically).

<img src="https://raw.githubusercontent.com/HANPU5838/dsh-memory/main/preview/memory-records.png" width="880" alt="DSH Memory panel · records">

## What it is

**A memory store for your agent that does not forget, keeps itself organized, and checks its own health —
with all data staying on your machine.**

The agent reads and writes memories through 11 tools. On every turn the plugin retrieves the relevant
ones, compresses them, and injects them into context. Memories have strength, decay, merge and settle
conflicts — it is not an append-only pile of text.

| Fact | Number |
| --- | --- |
| Model tools | **11**: save / search / list / get / forget / scopes / block / hooks / core / insight / maintain |
| Retrieval channels | **4**: BM25 lexical + bge-m3 vectors + PPR graph expansion + PRF query expansion, fused with RRF, optional cross-encoder rerank |
| Memory kinds | **9**: fact / decision / preference / procedure / note / rule / state / profile / reflection |
| Scopes | global / project / session / custom, with per-scope grants and user approval |
| Panel | **7 pages**: Service / Records / Knowledge tree / Relations / Rule code / Settings / Audit |
| Verification | **1413 tests, 0 failures** (1 skipped by design), 16-endpoint panel smoke test, real-store e2e, 11-item doctor |

## Why it is a "real" memory system

Memory is split into four layers that constrain each other:

```
Write    scope / kind / importance / tags / TTL / secret redaction
   ↓
Retrieve BM25 + bge-m3 vectors + PPR graph expansion + PRF → RRF → cross-encoder rerank
   ↓
Context  dynamic token budget → TextRank extractive summary → conflict resolution → injection
   ↓
Lifecycle FSRS strength → semantic merge → conflict arbitration → consolidation → dormancy / soft delete
```

| Problem you have | What it does |
| --- | --- |
| "I know I noted this somewhere" | Lexical + vector channels fused with RRF; paraphrases and casual questions still hit |
| Literally not found but clearly related | PPR graph expansion bridges via shared entities (paths, URLs, versions, tags); results are marked "associated" |
| The pile grows and search gets noisy | FSRS strength ranking + semantic merge (0.92) + 2000 records per scope + periodic consolidation |
| Old and new memories contradict each other | Conflicts flagged from 0.75 similarity, arbitrated by importance / evidence / time; the loser stays stored but never enters context |
| Injected context blows the window | Dynamic token budget (500/turn) + TextRank extractive summaries; it only extracts, never invents |
| No idea why a memory was recalled | Tool output carries provenance markers; the Audit page shows the full decision chain |
| Projects pollute each other | Four scope classes + purpose/alias + out-of-scope approval |
| Memories get junk or secrets written in | Three-phase rule hooks (before-save can reject) + credential detection rejects on match |
| No idea whether the system is healthy | `memory_insight` with seven signal classes + health score; `memory_maintain` for one-shot maintenance |

## The eleven tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Write a memory (content / scope / kind / tags / importance / TTL / triggers) |
| `memory_search` | Retrieve impressions only (8-char id / scope / kind / tags / short summary); use `get` for content |
| `memory_list` | List by scope / kind |
| `memory_get` | Fetch content and metadata (`fields` on demand) |
| `memory_forget` | Delete (soft delete by default; rules and scopes are approval-protected) |
| `memory_scopes` | Scope catalog: `list` / `edit` (purpose, alias) / `request` (out-of-scope grant) |
| `memory_block` | Hide irrelevant memories: `block` / `unblock` / `list`; session or workspace level |
| `memory_hooks` | Rule code hooks: `list` / `get` / `save` / `delete` / `approve` / `revoke-approval` / `run` |
| `memory_core` | Core blocks: `get` / `set` / `history` / `restore` for identity / profile / goal, always in system prompt |
| `memory_insight` | Metacognition: `report` (read-only) / `reflect` (candidate) / `tick` (rhythm) / `associate` (query-free recall) |
| `memory_maintain` | Run maintenance now: expiry, capacity, dormancy, consolidation, empty-scope cleanup, health score |

## Scopes and permissions

| Scope | Key | Visibility |
| --- | --- | --- |
| Global | `global` | Facts and preferences shared across projects |
| Project | `project:<path>` | Shared by every session opened on that workspace path |
| Session | `session:<id>` | This session only; archived and restored with it |
| Custom | bare name, e.g. `handbook` | Your own domain library, with purpose and alias |

Out-of-scope access shows only the scope catalog (name, count, purpose) — never content. The agent cannot
grant itself access; approval always comes from the user.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `storeDir` | `~/.dsh-memory` | Store root (JSONL + vector cache + backups) |
| `retrieval.vector.provider` | `local` | `local` (llama-server) / `openai` / `ollama` / `off` |
| `retrieval.vector.endpoint` | `127.0.0.1:8078/v1/embeddings` | OpenAI-compatible `/v1/embeddings` |
| `retrieval.rerank.enabled` | `false` | cross-encoder rerank (local `llama-server --rerank`, Cohere, Jina) |
| `retrieval.graphExpansion.enabled` | `true` | PPR graph expansion |
| `retrieval.strengthRanking` | `true` | FSRS-style strength ranking |
| `inject.recall.tokenBudget` | `500` | Injection budget per turn |
| `limits.maxRecordsPerScope` | `2000` | Per-scope capacity |
| `secrets.mode` | `refuse` | Refuse to write credentials, or `redact` |

Runtime toggles live in `settings.json` and can be changed from the panel; changes apply immediately.

## Panel

Seven pages: **Service** (vector backend, environment check, one-click install, health), **Records**
(browse/search/edit/delete/import/export), **Knowledge tree** (scope → kind → records with lineage),
**Relations** (potential links, conflicts, clustering, timeline), **Rule code** (review and test hook
scripts), **Settings** (recall / summary / impression / policy / rules / auto-recall / graph / budget),
**Audit** (the full decision chain of every injection).

## Data and privacy

- Memories, vector cache and backups live entirely under `<storeDir>`; without a vector backend the plugin
  makes **zero network requests**;
- Writes that look like credentials (API keys, tokens, passwords, private keys, JWTs, connection strings)
  are refused by default, or redacted if you set `secrets.mode: redact`;
- Out-of-scope access requires user approval; `memory_block` hides rather than deletes; soft-deleted
  records are recoverable for 30 days;
- Updating the plugin replaces code only — it never migrates or rewrites your memories.

## Comparison

There is no shortage of memory frameworks. This project is deliberately **not** a memory platform: it is a
single-process DSH plugin with no runtime dependencies, fully offline, and it ships the lifecycle
(strength, decay, merge, conflict arbitration, consolidation) that most frameworks leave to you.
Read the detailed, sourced comparison — including where this project is weaker — in
[`docs/comparison.md`](docs/comparison.md), and the reproducible retrieval benchmark in
[`docs/benchmark.md`](docs/benchmark.md).

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; for security
reports use [SECURITY.md](SECURITY.md). Translation help for this English README is especially welcome.

## Credits and license

- **Original author**: RestRegular — the original project is
  [RestRegular/dsh-memory](https://github.com/RestRegular/dsh-memory) (MIT). This repository is an
  independently maintained edition; the MIT copyright and attribution are preserved.
- **Maintained by**: [HANPU5838](https://github.com/HANPU5838).
- Local embeddings are served by [llama.cpp](https://github.com/ggml-org/llama.cpp) with bge-m3.

MIT License © RestRegular (original copyright) and HANPU5838 (this repository)
