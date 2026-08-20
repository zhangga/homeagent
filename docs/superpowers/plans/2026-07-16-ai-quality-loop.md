# AI Quality Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build the stage-two AI quality loop: deterministic quality evaluation, durable answer feedback, runtime observability, and an evidence-based FTS-native retrieval improvement recommendation.

**Architecture:** Keep the current FTS + LLM routing, ask, proactive participation, and learning behavior intact. Add a focused core quality store around `KnowledgeEngine.ask()`, expose aggregate-only operational health, collect explicit feedback from the management ask page, and run a deterministic offline evaluation suite that emits an FTS-native improvement recommendation. Do not introduce embedding providers or vector indexes.

**Tech Stack:** TypeScript, Bun test runner, Hono, existing SQLite/markdown knowledge stores, atomic JSON persistence, existing fake LLM test boundary.

---

### Task 1: Add durable answer traces and feedback

**Files:**
- Create: `packages/core/src/quality.ts`
- Create: `packages/core/src/quality.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/shared/src/types.ts`

- [x] Write tests that construct a quality store in a temporary data directory, record successful and failed answer traces, restart the store, and verify the records survive.
- [x] Add tests for feedback validation: supported kinds are `helpful`, `unhelpful`, and `citation_error`; unknown trace IDs and duplicate feedback submissions are rejected.
- [x] Add tests that verify snapshots contain aggregate counts and rates but do not expose question or answer text.
- [x] Implement `AnswerTrace`, `AnswerFeedback`, `AnswerFeedbackKind`, and `QualitySnapshot` types.
- [x] Implement a bounded, atomically persisted `QualityStore` under `<dataDir>/quality/quality.json`.
- [x] Keep at most 1,000 answer traces and 2,000 feedback records to prevent unbounded local growth.
- [x] Add an optional `traceId` to `AskResult` so existing callers remain source compatible.
- [x] Export the quality module from `@homeagent/core`.
- [x] Run `bun test packages/core/src/quality.test.ts`.

### Task 2: Instrument the ask boundary

**Files:**
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/engine.test.ts`

- [x] Write a test proving a successful knowledge answer records source, citations, spaces, latency, and a trace ID.
- [x] Write a test proving a failed ask records a failed trace and still rethrows the original error.
- [x] Write a test proving `recordAnswerFeedback()` only accepts feedback for an existing answer trace in the requested space.
- [x] Construct `QualityStore` with the engine data directory.
- [x] Wrap `askImpl()` with timing and success/failure trace recording without changing retrieval or synthesis behavior.
- [x] Add `recordAnswerFeedback()`, `qualitySnapshot()`, and `answerTrace()` methods to `KnowledgeEngine`.
- [x] Include the aggregate quality snapshot in `KnowledgeEngine.health()` details.
- [x] Run focused engine and ask tests.

### Task 3: Add management-page feedback

**Files:**
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/app.test.ts`

- [x] Extend the ask-page test to assert that a traced answer renders three feedback actions.
- [x] Add POST route tests for helpful, unhelpful, and citation-error feedback.
- [x] Add rejection tests for invalid feedback kinds, unknown traces, and traces from another space.
- [x] Render compact feedback controls only when an answer has a trace ID.
- [x] Add `POST /spaces/:space/ask/feedback` with strict form validation and a redirect flash message.
- [x] Preserve the question in the redirect so the user returns to the answer context.
- [x] Run `bun test packages/web/src/app.test.ts`.

### Task 4: Instrument queue and answer runtime metrics

**Files:**
- Modify: `packages/shared/src/serializer.ts`
- Modify: `packages/shared/src/serializer.test.ts`
- Modify: `packages/orchestrator/src/runtime.ts`
- Modify: `packages/orchestrator/src/runtime.test.ts`

- [x] Add serializer tests for queued/running counts, maximum backlog, completed/failed counts, wait time, and execution duration.
- [x] Implement a read-only serializer snapshot without changing FIFO or error isolation semantics.
- [x] Add orchestrator tests for event totals, answer success/failure, answer latency, proactive participation outcomes, and queue backlog.
- [x] Add a privacy-safe `OrchestratorHealth` snapshot containing counts and timings only; do not include message text, sender IDs, chat IDs, or answer content.
- [x] Instrument the global event queue, the answer path, and proactive participation decisions.
- [x] Export the health type through `@homeagent/orchestrator`.
- [x] Run serializer and orchestrator focused tests.

### Task 5: Surface AI quality and runtime health

**Files:**
- Modify: `packages/app/src/health.ts`
- Modify: `packages/app/src/health.test.ts`
- Modify: `packages/app/src/main.ts`
- Modify: `packages/web/src/views.ts`

- [x] Add health reporter tests for normal runtime metrics, degraded queue backlog, and degraded recent answer failure rate.
- [x] Add a `runtimeHealth` source and turn its snapshot into an `aiRuntime` component.
- [x] Add an `aiQuality` component from the engine quality snapshot.
- [x] Treat AI quality and backlog degradation as visible warnings, not readiness blockers.
- [x] Wire `orchestrator.health()` into the process health reporter.
- [x] Add Chinese labels for the two management health cards.
- [x] Run app health and web view tests.

### Task 6: Build the deterministic quality evaluation suite

**Files:**
- Create: `quality/evaluation-cases.json`
- Create: `scripts/ai-quality-evaluation.ts`
- Create: `scripts/ai-quality-evaluation.test.ts`
- Modify: `package.json`

- [x] Define fixed cases for retrieval/citation, conversation routing, proactive participation, and learning-plan structure.
- [x] Write tests for category scoring, overall scoring, failure reporting, and retrieval recommendations.
- [x] Use the existing fake LLM boundary so the suite is offline, repeatable, and free of provider credentials.
- [x] Score retrieval coverage and citation correctness separately.
- [x] Emit `improve_fts_retrieval` when FTS coverage is the bottleneck, recommend aliases/tags generation and bounded large-catalog routing, keep FTS while fixing grounding when routing/citations fail, and emit `insufficient_data` when the dataset is too small.
- [x] Print a human-readable summary and machine-readable JSON when run from the command line.
- [x] Add `evaluate:quality` to package scripts.
- [x] Run `bun test scripts/ai-quality-evaluation.test.ts` and `bun run evaluate:quality`.

### Task 7: Make quality evaluation a beta gate and document operation

**Files:**
- Modify: `scripts/verify-beta-readiness.ts`
- Modify: `scripts/verify-beta-readiness.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/beta-release-runbook.md`

- [x] Add a beta-readiness check that runs the deterministic quality evaluation and fails only on broken evaluation execution or required category regressions.
- [x] Add the quality evaluation command to CI.
- [x] Document feedback collection, health metrics, evaluation categories, thresholds, and retrieval recommendation meanings.
- [x] Explicitly state that stage two does not add personal-space privacy or hidden-space policies.
- [x] Run beta readiness tests and the beta verification command.

### Task 8: Final verification, review, and commit

**Files:**
- Review all changed files.

- [x] Run `bun run typecheck`.
- [x] Run `bun test`.
- [x] Run `bun run evaluate:quality`.
- [x] Run `bun run verify:beta`.
- [x] Use the code-review skill to review correctness and code quality independently.
- [x] Fix every high-confidence issue found by review and rerun affected checks.
- [x] Commit the completed stage-two implementation on the current branch.
