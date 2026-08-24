# HomeAgent agent guide

This file applies to the whole repository. Keep it focused on durable engineering
contracts; do not copy temporary roadmap or release status into it.

## Sources of truth

- Read `README.md` for supported product behavior, setup, and operator workflows.
- Read `CONTEXT.md` before changing domain or persistence code. Use its terms
  (`Space`, `Raw`, `Raw journal`, `Knowledge page`, `SQLite projection`, and
  `Dream cycle`) consistently.
- Read `docs/beta-release-runbook.md` for release gates. Passing local tests does
  not imply that signing, notarization, real Feishu, migration, or soak gates passed.
- Treat `progress.md`, `task_list.json`, and dated files under
  `docs/superpowers/` as historical task artifacts unless the current task
  explicitly makes one of them authoritative.

## Repository boundaries

HomeAgent is a Bun workspace monorepo with a composition root in `packages/app`.
Preserve these dependency directions:

- `packages/shared`: common types, configuration, logging, serialization, and
  `SpaceId` helpers; it must not depend on another HomeAgent package.
- `packages/llm`: provider processes, usage, pricing, and budget control; depends
  only on `shared`.
- `packages/core`: knowledge, durable state, governance, Agents, Tasks, Chat Runs,
  and learning; depends on `llm` and `shared`.
- `packages/connectors`: CLI and Feishu transport boundaries; depends on `shared`.
- `packages/orchestrator`: message interpretation and application workflows;
  coordinates `core`, `llm`, and `connectors`.
- `packages/web`: Hono presentation and management routes; call public seams from
  `core`/`llm` instead of reaching into transport or runtime internals.
- `packages/app`: process entrypoints, service lifecycle, schedulers, migration,
  and dependency assembly. Keep production wiring here.

Avoid reverse dependencies and avoid importing another package's private source
files. Add or extend a public export when a cross-package seam is genuinely needed.

## Non-negotiable domain invariants

- A record belongs to exactly one `Space`. Never broaden personal/team visibility
  or join data across spaces without an explicit, tested authorization rule.
- `raw/records/**/*.jsonl` plus `raw/retractions.jsonl` are authoritative for Raw
  state. `wiki/**/*.md` is authoritative for knowledge pages. SQLite is a
  rebuildable query/FTS projection, not the sole owner of user data.
- Persist durable state with validation, bounded fields, same-directory temporary
  files, fsync, and atomic replacement where the surrounding store uses that
  pattern. Do not weaken recovery behavior to make a test pass.
- A `WorkAction` result remains `held` until accepted. Accepted evidence may enter
  the Dream queue; rejected, cancelled, or failed evidence stays `excluded`.
  Knowledge pages must never cite held or excluded evidence.
- Chat and Task Runs freeze the Agent revision, instruction, provider, model,
  permission, Workdir, execution limits, and Skill evidence used for that run.
  Retry or restart must not silently substitute current configuration.
- `write` and `full` Task execution requires a persisted positive human approval
  granting that execution before provider invocation. Immediately before execution,
  the frozen Workdir must still be an existing directory and canonicalize to the
  same location captured in the run. Fail closed when approval, ownership,
  provenance, or execution evidence is missing or ambiguous.
- Recovery may resume queued work from its durable plan; it must not replay a
  process that was already running when the application stopped.
- Keep retrieval on the documented FTS plus bounded LLM-routing path. Do not add
  embeddings, vector indexes, or a new knowledge-data egress channel.

## Security and privacy

- Never place App Secrets, tokens, authorization codes, message bodies, or raw
  provider diagnostics in URLs, argv, logs, health output, or public errors.
  Sensitive `lark-cli` input goes through stdin and its managed credential store.
- Keep public errors fixed and bounded. Preserve detailed diagnostics only in an
  explicitly private, bounded audit surface when the existing contract allows it.
- Validate and canonicalize filesystem paths before reads, writes, migrations, or
  process execution. Reject symlinks/junctions and path escapes at trust boundaries.
- Do not edit a live HomeAgent data directory manually. Tests must use isolated
  temporary directories and fake providers/transports unless they are explicitly
  marked live.
- Data migration must stage and verify before switching, must fail before partial
  mutation on invalid input, and must not delete the old data directory.
- Preserve provider isolation: ordinary restricted calls must not inherit ambient
  user rules, hooks, plugins, or conversation history. Tool and Skill access comes
  only from the frozen HomeAgent execution contract.
- Do not perform real Feishu mutations, live provider calls, downloads, signing,
  notarization, or release publication unless the task explicitly requests them
  and the required environment is available.

## Code and test conventions

- Use the Bun toolchain, TypeScript ESM, explicit `.ts` relative imports, and the
  strict settings in `tsconfig.base.json`. Follow the surrounding choice of Bun or
  Node-compatible standard APIs. Do not weaken compiler options or use broad casts
  to bypass a domain validation problem.
- Keep tests beside their implementation as `*.test.ts`. Prefer deterministic fake
  clocks, providers, process runners, and transports over timing or network access.
- Add a regression test with every behavior fix. For durable-state changes, cover
  validation, persistence failure, reopen/recovery, and legacy migration as relevant.
- Bound every persisted or externally supplied collection/string and test the
  boundary. Deep-clone mutable input/output at store seams.
- Preserve safe idempotency for message delivery, notifications, retries, and
  external actions. A persistence failure after delivery must not duplicate effects.
- User-facing product copy and operational documentation default to Simplified
  Chinese. Keep identifiers, stable schema fields, and code comments consistent
  with the surrounding file.
- Do not edit generated/runtime content in `data/`, `.homeagent/`, `dist/`,
  `node_modules/`, coverage output, logs, or SQLite projections.

## Working and validation workflow

1. Inspect `git status` and nearby tests before editing. Preserve unrelated user
   changes in a dirty worktree.
2. Make the smallest change that preserves the boundaries and invariants above.
3. Run the narrowest relevant test files while iterating, for example:

   ```bash
   bun test packages/core/src/engine.test.ts
   bun test packages/llm/src/providers.test.ts
   ```

4. Before handing off a code change, run the relevant focused tests and:

   ```bash
   bun run typecheck
   ```

   Run `bun test` on an Ubuntu/macOS development host, and for changes that cross
   package seams or affect shared runtime behavior. A documentation-only change
   needs formatting/content validation, not an unrelated full code suite.

5. Add gates according to the changed contract:

   ```bash
   bun test                         # supported-host full regression
   bun run evaluate:quality          # retrieval, routing, citations, learning quality
   bun run verify:crash-recovery     # durable state/recovery; Linux or macOS
   bun run verify:brand              # canonical brand or packaged visual assets
   bun run verify:beta -- --allow-dirty  # development-only candidate preflight
   ```

The supported CI matrix is Ubuntu and macOS. Windows is useful for focused
cross-platform checks, but some SIGKILL, LaunchAgent, Swift helper, hard-link, and
POSIX path tests cannot establish release readiness there. Report platform failures
honestly; do not relabel a failing full suite as passing. Live tests require an
explicit `HOMEAGENT_LIVE=1` invocation and are never part of an ordinary local run.

## Documentation and completion

- Update `README.md` when supported behavior, configuration, UI, or operator steps
  change.
- Update `CONTEXT.md` when domain vocabulary or authoritative storage ownership
  changes.
- Update `docs/beta-release-runbook.md` and the release workflow when a release
  gate, artifact, platform requirement, or external acceptance step changes.
- Keep schema/archive compatibility statements synchronized with the parser,
  migration code, and tests.
- A code change is complete only when the requested behavior is implemented,
  relevant focused tests and type checking pass, and any unrun
  platform/live/release gates are called out explicitly. A documentation-only
  change is complete after its references, commands, formatting, and internal
  consistency are checked.
