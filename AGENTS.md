# HomeAgent agent guide

This file applies to the whole repository. Keep it focused on durable engineering
contracts; do not copy temporary roadmap or release status into it.

## 开发优先级与修复原则

- 当前以功能开发和端到端可用为主，优先完成用户明确要求的行为。安全加固、权限体系扩展和额外约束不作为普通功能任务的默认目标。
- 修复应针对实际根因，并保留原有可用能力。不得通过缩小功能范围、禁用原有路径或增加用户操作步骤来代替修复。
- 新增限制必须来自明确产品需求、实际接口限制或已复现且与本次任务直接相关的问题；不能仅因假设风险、未来规模或“更安全”而加入白名单、审批、确认、隔离层或新的上限。
- 用户已明确指定目标、范围或保存位置时，按该意图执行并复用已有能力；能由现有工具查询得到的信息应主动查询，不反复要求用户确认或手工提供。只有影响正确实现且无法合理确定的信息才需要澄清。
- 区分查询来源、消息投递位置与数据归属。某一步的限制只作用于该步骤，不能推导成整个流程的禁令；例如入库归属不能覆盖用户指定的查询群。
- 实现优先复用现有接口与简单路径。与当前交付无关的安全增强、通用框架和重构留待明确任务，不附带扩展实施。
- 回归测试须覆盖用户原始操作场景及修复前可用的路径，不能只验证新增约束生效。完成标准是用户目标可实现、已有功能未被意外收窄。

下文的数据正确性、凭据保护和明确授权约定按其原有适用范围执行；不得将这些约定扩张解释为用户未要求的产品限制或额外审批流程。

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
- A Feishu topic Chat Run may use only its explicitly routed Provider-native
  conversation. Bind it by Space, chat, and root message; use Provider fork
  semantics and stage the returned child session only in the same atomic commit
  that records Run success. It becomes eligible as the next parent only after
  `delivery.status=sent` is durably recorded. Never reconstruct topic history in
  prompts, advance a mapping on failure, or export Provider session ids in Space
  archives.
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
- Preserve provider isolation: restricted calls must not inherit ambient user
  rules, hooks, plugins, or unrelated conversation history. The sole conversation
  exception is an explicitly routed Feishu topic Chat turn using its compatible
  Provider-native parent. HomeAgent supplies only the routed Team Space to shared
  topic turns. Codex `isolated` topic calls also require verified filesystem
  isolation. Explicit `local-full-access` Chat/Task calls are permitted only by a
  frozen Agent revision and a valid persisted local execution grant, rechecked
  at each model process launch. They provide no Provider filesystem/network
  isolation; Workdir and prompts are not access controls. Never enable this mode
  by fallback, legacy `full`, archive import, or a group message. Both modes keep
  ambient configuration suppressed and Skills frozen; `write`/`full` Tasks still
  need their own positive per-Run human approval.
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
- Treat AI latency and output length as reliability concerns. Production Provider,
  Chat, Task, Dream, and learning paths use the centralized stability-first limits
  in `packages/shared/src/ai-limits.ts`; do not introduce a shorter AI timeout or
  token ceiling without an explicit product requirement, a documented reason, and
  a regression test. Prefer explicit cancellation, bounded inputs/artifacts,
  concurrency control, and health reporting over short arbitrary deadlines.
- User-facing product copy and operational documentation default to Simplified
  Chinese. Keep identifiers, stable schema fields, and code comments consistent
  with the surrounding file.
- Do not edit generated/runtime content in `data/`, `.homeagent/`, `dist/`,
  `node_modules/`, coverage output, logs, or SQLite projections.

## Working and validation workflow

1. Inspect `git status` and nearby tests before editing. Preserve unrelated user
   changes in a dirty worktree.
2. Apply the development priorities above. Make the smallest change that fixes
   the requested behavior while preserving existing supported user workflows and
   the applicable boundaries and invariants.
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
