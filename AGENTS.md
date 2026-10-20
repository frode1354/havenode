# Crew Studio — Agent notes

Local CrewAI Studio: chat → plan → approve/modify canvas → editor → sandbox → deploy to CrewAI AMP (or ZIP export).
Coding: add canvas individual **Cline** (`role_template_id=cline`) for coding tasks — not a coding Agent Team, not “open in editor” as the primary UX.
Stack: Vite React+TS frontend, FastAPI backend, DeepSeek (and multi-API) LLM.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/` (no Git remote yet). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/` + product requirements in `docs/REQUIREMENTS.md`. See `docs/agents/domain.md`.

### Installed skills (mattpocock/skills)

Project copies live in `.agents/skills/`. Useful entry points:

| Command / skill | When |
| --- | --- |
| `/ask-matt` | Not sure which flow to use |
| `/grill-with-docs` | Align on a change; grow glossary + ADRs |
| `/grill-me` | Align without docs side-effects |
| `/to-spec` → `/to-tickets` → `/implement` | Spec → tickets → build |
| `/tdd` | Red-green-refactor for features/fixes |
| `/diagnosing-bugs` | Hard bugs / regressions |
| `/prototype` | Throwaway UI or logic probes |
| `/improve-codebase-architecture` | Periodic deepening survey |
| `/code-review` | Review since a commit/branch |
| `/handoff` | Compact session for another agent |
| `/retro` | Improve agent env after a session |
| `/setup-ts-deep-modules` | TS deep-module boundaries (optional) |
| `/setup-pre-commit` | Husky + lint-staged (optional) |

Re-run `/setup-matt-pocock-skills` only if switching issue tracker or resetting this config.

## Layout hints

- Frontend: `frontend/src/` (canvas, settings, chat, sandbox modals)
- Backend: `backend/app/` (`main.py`, `studio_llm.py`, `sandbox.py`, `codegen.py`)
- Runtime outputs: `backend/tmp/<project-title>/`
- Studio user settings: `backend/data/settings.json` + browser `localStorage`
