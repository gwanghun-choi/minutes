# minutes documentation

Navigation only. Each topic has one canonical location.

| | |
|---|---|
| **[architecture/current.md](architecture/current.md)** | Current system structure — runtime components, module map, data flow, persistence, failure behaviour. |
| **[workflows/development.md](workflows/development.md)** | How to make a change here: understand → trace → verify, with real commands. |
| **[workflows/ai-pipeline.md](workflows/ai-pipeline.md)** | Each AI stage — responsibility, input, output, implementation, failure behaviour. |
| **[decisions/](decisions/README.md)** | Why a significant choice was made, and what qualifies as significant. |
| **[work-log/](work-log/index.md)** | Dated record of meaningful work. |

The frontend lives in [`../frontend/`](../frontend). Its structure is in
[architecture/current.md](architecture/current.md#application-module-map); why it
is React and why it stays in this image is in
[decisions/2026-08-21-react-typescript-spa-in-one-image.md](decisions/2026-08-21-react-typescript-spa-in-one-image.md).

Outside `docs/`:

- **[../README.md](../README.md)** — project purpose, how to run it.
- **[../AGENTS.md](../AGENTS.md)** — repository invariants. Read first.
- **[../CLAUDE.md](../CLAUDE.md)** — agent development workflow.

When source and documentation disagree, the source is correct and the document
is stale. Fix the document.
