---
name: papermind-unknowns
description: Thin PaperMind project adapter for the Unknowns Compass workflow. Use when planning, reviewing, rescuing, or implementing a consequential PaperMind product or engineering change; when the user asks what PaperMind may be missing; or when a feature crosses research evidence, AI behavior, frontend/backend contracts, user data, deployment, trial readiness, or product positioning. Requires the general unknowns-compass skill and supplies only PaperMind-specific territory, risk lenses, artifact routing, and verification expectations.
---

# PaperMind Unknowns Adapter

Use `unknowns-compass` as the method. This adapter must stay thin: do not duplicate its four-quadrant model, discovery workflow, or artifact templates here.

## First move

1. Load and follow `unknowns-compass`.
2. Resolve the live PaperMind repository and inspect its current state.
3. Read the smallest set of PaperMind sources needed for the task.
4. Apply the PaperMind lenses below to the core unknowns map.

If `unknowns-compass` is unavailable, report that dependency and perform only a compact blind-spot pass; do not invent a second full method inside this adapter.

## PaperMind territory map

Treat live code, data behavior, tests, and deployment evidence as territory. Documentation is a map and may drift.

| Question | Inspect first |
|---|---|
| Product identity, current capabilities, user path | `README.md` |
| Why a product or technical choice exists | `DECISIONS.md` |
| Shipped change history and version claims | `CHANGELOG.md` plus actual release/deploy evidence |
| Deep-reading behavior and evidence loop | `docs/deep-reading-overview.md`, relevant validation docs, `web/src/pages/PaperRead.jsx`, `web/src/components/PdfViewer.jsx`, backend endpoints |
| Backend contracts and AI orchestration | `papermind/api.py`, `papermind/src/`, `papermind/.env.example` |
| Frontend behavior and identity propagation | `web/src/`, especially `web/src/api.js` and affected pages/components |
| Stored user data and isolation | `papermind/src/database.py`, current schema/migrations, API ownership checks |
| Zotero handoff | `zotero-plugin/` and corresponding backend/frontend entry path |
| Deployment, recovery, and operations | `deploy/`, `scripts/`, backup docs, live runtime evidence when available |
| Regression evidence | `tests/`, frontend build/lint, and an end-to-end user-path check |

Before changing files, inspect `git status` and preserve unrelated user work. This repository may contain active uncommitted changes.

## PaperMind blind-spot lenses

Use only the lenses relevant to the task, but always consider the first four.

### 1. Researcher outcome and reading loop

- Which researcher moment is improved: discovery, triage, understanding, critique, transfer, note capture, or return?
- Does the change close a real loop, or add another surface without a next action?
- Can the user trace an interpretation back to paper text, page, figure, or evidence?
- Does the design support Chinese and English reading behavior intentionally rather than incidentally?
- What would make the feature look intelligent while failing to improve understanding?

### 2. Evidence fidelity

- Which content is source text, metadata, model inference, user interpretation, or system observation?
- Are page anchors, quotations, numbers, and paper identity preserved across storage and display?
- Could a summary or recommendation overstate what the source supports?
- What happens when the PDF, metadata, extraction, or model output is incomplete?

### 3. Identity, privacy, and ownership

- Which user or device owns every created/read/updated/deleted object?
- Can UID, owner privileges, shared links, local storage, or API parameters be confused or forged?
- What content leaves the machine for third-party model APIs, and is that boundary visible to the user?
- Are API keys, PDFs, notes, chats, figures, and database backups protected from source control and accidental exposure?
- How are export, deletion, restore, and device migration handled?

### 4. AI provider, cost, and failure behavior

- Which provider/model actually handles the path, and what fallback chain applies?
- What is the rate-limit and global-cost behavior for owner and trial users?
- Are timeout, malformed output, partial output, retry, duplicate request, and provider outage paths usable?
- Could a model/config change silently alter product behavior or evidence quality?
- Is there observable runtime evidence for the model and provider used?

### 5. Cross-layer contract

- Do frontend payloads, backend validation, database fields, and rendered state agree?
- What happens to existing local data and older clients?
- Are loading, empty, error, retry, stale, mobile, and re-entry states covered?
- Does the Zotero or external handoff preserve identity and avoid duplicate records?

### 6. Productization and operations

- Is “tests/build passed” being mistaken for “ready to trial or ship”?
- Do version labels, documentation, deployed code, and packaged artifacts agree?
- Is backup configured, tested, restorable, and free of secrets?
- What support, privacy, legal, open-source, dependency, or maintenance obligation is introduced?
- Can a single maintainer diagnose and recover the failure with existing observability?

### 7. Learning and measurement

- What assumption is this change testing?
- What observable user behavior or qualitative evidence would support or reject it?
- Is the metric aligned with deeper reading rather than clicks, generated text volume, or feature usage alone?
- What is the smallest reversible slice that teaches us enough before the architecture hardens?

## Artifact routing

- Keep the active unknowns summary in conversation for bounded work.
- For a long or multi-session change, create one task-scoped unknowns file only if it will be reused. Do not create a permanent ledger by default.
- Record accepted, durable product or architecture decisions in `DECISIONS.md` using its existing style.
- Update `CHANGELOG.md`, `README.md`, or focused docs only when the implemented behavior actually changes their claims.
- Keep execution deviations in temporary working notes; fold only durable lessons into project documentation.
- Never create a parallel “master plan” that competes with the current code, `DECISIONS.md`, or an existing task document.

## Execution gate

Before implementation, surface:

1. the top three unknowns most likely to change the user path or architecture;
2. the cheapest discovery move for each;
3. any high-impact assumption being accepted;
4. the end-to-end evidence that will demonstrate success.

Stop only the affected branch when a high-impact, hard-to-reverse unknown lacks evidence or user authority. Continue safe read-only investigation and reversible work.

## Verification expectations

Select checks in proportion to the change:

- backend: `papermind/.venv_new/bin/python -m unittest discover -s tests`;
- frontend behavior: `npm run build`, and `npm run lint` when the touched scope makes lint signal useful;
- API changes: verify the real frontend-backend payload and error contract;
- data changes: verify existing-data compatibility, ownership boundaries, backup, and recovery;
- user-facing flows: walk the actual path, including loading, empty, error, mobile, and re-entry states as applicable;
- AI behavior: verify evidence fidelity and failure/fallback behavior, not only a successful response;
- release claims: distinguish local checks from deployed, packaged, trial-ready, or release-ready evidence.

The final handoff must state what was verified, what remains assumed, and which unknowns were deliberately deferred.
