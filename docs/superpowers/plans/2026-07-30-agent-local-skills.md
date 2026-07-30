# Agent Local Skills Implementation Plan

> **Design spec:** `docs/superpowers/specs/2026-07-30-agent-local-skills-design.md`

**Goal:** Replace the Agent's unchecked Skill-name string with a bounded local
Skill catalog, exact source bindings, provider-aware resolution, truthful
warnings, and durable task-run evidence while preserving the existing Feishu
group → space → Agent relationship.

**Architecture:** Add a read-only `SkillCatalog` in core, keep provider-specific
root and invocation behavior behind typed adapters, migrate Agent Skill strings
to discriminated source bindings, resolve Skills once for each Agent-backed
operation, and pass only compatible invocation names to the existing local CLI
boundary. Ordinary calls use a forced read-only execution policy; research tasks
retain Agent Permission and Workdir. Web remains server-rendered and embeds a
bounded catalog for an inline selector.

**Tech stack:** Bun, TypeScript, Hono server-rendered HTML, plain DOM/CSS, local
JSON stores, local Agent CLIs, Bun test.

## Delivery Rules

- Work test-first within each task: add focused failing tests, observe RED,
  implement the smallest behavior, and rerun the focused suite.
- Treat every discovered `SKILL.md` as untrusted local content. Escape metadata
  in HTML and warnings, never execute Skill scripts during discovery, and never
  log Skill bodies.
- Do not follow directory symlinks. Bound file size, depth, visited entries,
  Skill count, total bytes, diagnostics, and user-visible warnings.
- Do not expose absolute local paths in Feishu messages or task notifications.
  Use `~/` abbreviations only in authenticated local administration views.
- Do not add Git/URL/package import, auto-update, a standalone Skills page,
  filesystem watchers, daemon/runtime sharing, Devices, Issues, Chats, or other
  Mew platform resources.
- Preserve the graceful-degradation decision: unavailable Skills are skipped,
  the base Agent still runs, and a bounded warning is shown.
- Preserve operation permissions: ordinary calls are read-only; only research
  tasks may use Agent `write` or `full` and Workdir.
- Do not claim a Skill is "confirmed loaded." Use "resolved and requested,"
  "skipped," and provider-process outcome language.
- Keep old `agents.json`, task-run files, and space archives readable.
- Preserve unrelated working-tree changes. Do not stage `.superpowers/`,
  runtime data, or unrelated untracked files.

## Task 1: Build the Bounded Local Skill Catalog

**Files:**

- Create: `packages/core/src/skill-catalog.ts`
- Create: `packages/core/src/skill-catalog.test.ts`
- Modify: `packages/core/src/index.ts`

### Step 1: Add failing catalog parsing tests

Cover:

1. A valid `SKILL.md` exposes `name`, `description`, `skillFileHash`, root kind,
   relative directory, provider compatibility, and a stable `sourceKey`.
2. Missing, empty, or invalid frontmatter names produce an invalid visible
   source instead of throwing.
3. Metadata is treated as text and retains no executable behavior.
4. `skillFileHash` is SHA-256 over the raw `SKILL.md` bytes.
5. Changing file contents changes the hash but keeps the same `sourceKey`.
6. `sourceKey` contains a known root identifier and normalized relative path,
   never an absolute home path.

### Step 2: Run the focused catalog test and verify RED

```powershell
bun test packages/core/src/skill-catalog.test.ts
```

Expected: fail because the catalog types and parser do not exist.

### Step 3: Implement narrow catalog types and parser

Add:

```ts
type SkillRootKind =
  | "shared-agents"
  | "codex-user"
  | "codex-plugin"
  | "codex-vendor"
  | "claude-user"
  | "claude-plugin"
  | "claude-marketplace"
  | "trae-user";

interface SkillSource {
  sourceKey: string;
  rootKind: SkillRootKind;
  relativeDir: string;
  name: string;
  description: string;
  providerIds: ProviderId[];
  skillFile: string;
  skillFileHash: string;
  status: "available" | "invalid";
  diagnostics: SkillDiagnostic[];
}
```

Implement a small frontmatter reader for the required scalar fields only. Do
not introduce a general YAML execution or object-deserialization surface.

### Step 4: Add failing scan-boundary tests

Use temporary directory trees to cover:

1. All configured root kinds.
2. A directory without `SKILL.md`.
3. A regular-file `SKILL.md`.
4. Directory and file symlinks.
5. Duplicate roots resolving to the same real path.
6. Unreadable entries.
7. Maximum file size.
8. Maximum recursion depth.
9. Maximum visited entries.
10. Maximum discovered Skills.
11. Maximum total bytes.
12. A single bad root not preventing results from good roots.

### Step 5: Implement bounded scanning

- Inject roots, limits, and filesystem/home dependencies for deterministic
  tests.
- Reject symlinked entries without following them.
- Realpath and deduplicate root directories before traversal.
- Sort roots and relative paths so catalog output and tests are deterministic.
- Return bounded diagnostics instead of throwing for local file failures.
- Export the service through `packages/core/src/index.ts`.

### Step 6: Add failing grouping tests

Cover:

1. Same normalized name and same `SKILL.md` hash group into one display entry
   while retaining every source.
2. Same normalized name and different hash remain separate variants.
3. Names are compared using one documented normalization rule.
4. Supporting files do not affect `skillFileHash` or falsely claim full
   directory equality.

### Step 7: Implement the display projection

Keep actual `SkillSource` records independent. Add a separate catalog-view
projection for grouping so Agent bindings always retain a real `sourceKey`.

### Step 8: Run focused tests and type checking

```powershell
bun test packages/core/src/skill-catalog.test.ts
bun run typecheck
```

## Task 2: Add Provider-Aware Roots, Precedence, and Invocation Contracts

**Files:**

- Modify: `packages/llm/src/providers.ts`
- Modify: `packages/llm/src/providers.test.ts`
- Modify: `packages/core/src/skill-catalog.ts`
- Modify: `packages/core/src/skill-catalog.test.ts`

### Step 1: Add failing provider Skill contract tests

Cover:

1. Codex maps resolved names to `$name`.
2. Claude maps resolved names to `/name`.
3. TRAE uses its supported plain invocation form.
4. Invocation names pass the existing bounded identifier validation.
5. Unknown or malformed names are not interpolated into prompts.
6. Every provider exposes an ordered list of known default Skill roots.
7. `~/.agents/skills` is compatible with all supported providers.
8. No adapter mutates provider homes, authentication paths, or global process
   configuration.

### Step 2: Run the provider test and verify RED

```powershell
bun test packages/llm/src/providers.test.ts
```

### Step 3: Extract provider Skill helpers

Add typed helpers such as:

```ts
interface ProviderSkillReference {
  provider: ProviderId;
  invocationName: string;
  reference: string;
}

function providerSkillReference(
  provider: ProviderId,
  invocationName: string,
): ProviderSkillReference | undefined;
```

Refactor `injectExecutionSkills` to consume only resolved invocation names. It
must no longer be the first layer that validates arbitrary Agent form text.

### Step 4: Add failing precedence and shadow tests

Cover:

1. Each provider has deterministic root precedence.
2. Two compatible same-name sources identify the provider-effective source.
3. A lower-precedence different-hash source is visible but marked shadowed.
4. A source that cannot be invoked exactly is not reported as resolved.
5. Identical grouped sources choose and display the provider-effective
   `sourceKey`.
6. An administrator-selected alternative remains skipped if the provider cannot
   address it exactly.

### Step 5: Implement provider resolution

Add a resolver that partitions bindings into:

```ts
interface ResolvedAgentSkills {
  requested: SkillRequestSnapshot[];
  resolved: ResolvedSkillSnapshot[];
  skipped: SkippedSkillSnapshot[];
  warnings: SkillWarning[];
}
```

Use stable reason codes including:

- `missing_source`
- `invalid_skill`
- `provider_incompatible`
- `ambiguous_legacy_name`
- `shadowed_source`
- `invalid_invocation_name`

Keep detailed paths inside administrator diagnostics. User warnings use only
Skill name and reason category.

### Step 6: Add the short-lived cache and direct recheck

Tests must prove:

1. Catalog page reads reuse a fresh cache.
2. Explicit refresh invalidates it.
3. A stale cache triggers one bounded rescan.
4. Execution rechecks bound source files directly without scanning all roots.
5. Removing or changing a bound file is observed by the next execution.

### Step 7: Run focused suites

```powershell
bun test packages/llm/src/providers.test.ts packages/core/src/skill-catalog.test.ts
bun run typecheck
```

## Task 3: Migrate Agent Persistence to Source Bindings

**Files:**

- Modify: `packages/core/src/agents.ts`
- Modify: `packages/core/src/agents.test.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/engine.test.ts`
- Modify: `packages/core/src/governance.ts`
- Modify: `packages/core/src/governance.test.ts`
- Modify: `packages/core/src/index.ts`

### Step 1: Add failing Agent schema tests

Define and cover:

```ts
interface SourceSkillBinding {
  kind: "source";
  sourceKey: string;
  name: string;
}

interface LegacySkillBinding {
  kind: "legacy-name";
  name: string;
}

type AgentSkillBinding = SourceSkillBinding | LegacySkillBinding;
```

Tests:

1. A new Agent persists exact source bindings.
2. Updates deduplicate bindings by `sourceKey` while preserving order.
3. Invalid binding objects and unbounded names are rejected.
4. Clone-returning methods do not expose mutable binding arrays or objects.
5. Unrelated Agent edits preserve missing source bindings.
6. Delete/restore behavior preserves exact binding records.

### Step 2: Run the Agent store test and verify RED

```powershell
bun test packages/core/src/agents.test.ts
```

### Step 3: Version and implement `agents.json`

- Add an explicit persisted schema version.
- Keep the public in-memory `Agent` type fully normalized.
- Replace identifier normalization with binding validation.
- Keep a separate conversion from resolved source bindings to
  `ProviderExecution.skills`.
- Update copy/clone sites to deep-copy bindings.

### Step 4: Add failing legacy migration tests

Create old versionless fixtures with `skills: string[]` and cover:

1. One compatible catalog match migrates to `kind: "source"`.
2. No match becomes `kind: "legacy-name"`.
3. Multiple different-`SKILL.md` matches remain legacy.
4. Duplicate old names are stable-deduplicated.
5. An unavailable catalog does not destroy the old values.
6. Migration is durably rewritten once.
7. Reloading the migrated file is idempotent.

### Step 5: Inject catalog-assisted migration

Allow `AgentStore` to receive a narrow Skill lookup dependency. Application
construction supplies the real catalog; tests supply deterministic fixtures.
Migration may resolve only an exact unique provider-compatible match.

### Step 6: Update space archive governance

Add the next archive version and tests for:

1. Exporting source and legacy bindings.
2. Restoring the new version.
3. Reading older archives whose Agent has string Skills.
4. Ambiguous old archive Skills staying legacy.
5. Conflict checks comparing normalized Agent records.
6. Rollback preserving Agents and bindings after a failed restore.

### Step 7: Update engine copy and validation boundaries

Update Agent snapshots, `agentForSpace`, export/restore, update, and delete paths
to deep-copy bindings. The engine must reject submitted source keys that are not
known catalog entries while preserving already-stored missing bindings during
unrelated updates.

### Step 8: Run focused persistence suites

```powershell
bun test packages/core/src/agents.test.ts packages/core/src/governance.test.ts packages/core/src/engine.test.ts
bun run typecheck
```

## Task 4: Introduce One Skill-Aware Agent Call Context

**Files:**

- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/engine.test.ts`
- Modify: `packages/core/src/llm.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/core/src/ask.test.ts`
- Modify: `packages/core/src/dream.test.ts`
- Modify: `packages/core/src/learning.test.ts`
- Modify: `packages/core/src/learning-engine.test.ts`

### Step 1: Add failing context-resolution tests

Introduce one internal boundary such as:

```ts
interface SpaceAgentCallContext {
  agent?: Agent;
  client: LlmClient;
  skills: ResolvedAgentSkills;
  execution: ProviderExecution;
}
```

Cover:

1. A bound Agent resolves its Skills once for the call.
2. A space without an Agent has no Skill requests.
3. Ordinary calls always use `permission: "read-only"`.
4. Ordinary calls never inherit Agent Workdir.
5. Research-task context uses Agent Permission and canonical Workdir.
6. The context passes only resolved invocation names to the provider.
7. Catalog failures degrade to skipped warnings rather than blocking the base
   Agent.

### Step 2: Run the focused engine test and verify RED

```powershell
bun test packages/core/src/engine.test.ts
```

### Step 3: Replace boolean task execution selection

Replace the `taskExecution` boolean in `llmClientForSpace` with a typed operation
kind:

```ts
type AgentOperation =
  | "chat"
  | "ask"
  | "dream"
  | "learning"
  | "learning-research"
  | "research-task";
```

Resolve Agent, Skills, permission, model, and reasoning effort together. Do not
let callers separately select an Agent and later rebuild execution fields.

### Step 4: Add failing Ask and Dream evidence tests

Cover:

1. Ask uses the primary write space's Agent and Skills.
2. Ask results contain bounded Skill warning data when one or all bindings skip.
3. Grounding, citations, trace IDs, and cold-start behavior remain unchanged.
4. Dream uses Skills with read-only execution.
5. Dream reports carry Skill warnings without adding them to knowledge-page
   content or treating them as distillation errors.
6. Fake injected LLM clients continue to bypass local catalog requirements in
   unit tests.

### Step 5: Extend public result types narrowly

Add one shared, presentation-safe warning type:

```ts
interface SkillWarningView {
  name: string;
  code: SkillWarningCode;
  message: string;
}
```

Add optional `skillWarnings` to `AskResult` and `DreamReport`. Do not include
paths, hashes, or raw parser diagnostics in shared user-facing types.

### Step 6: Add failing learning-flow tests

Cover every LLM-backed learning operation:

1. Topic-route creation.
2. Assessment completion.
3. Online-resource research.
4. Lesson preparation.
5. Learning-answer feedback.

Each must use the plan space's Agent Skills with read-only permission. Add a
small typed wrapper or operation result that carries `skillWarnings` back to the
orchestrator without persisting them into the learner profile, route, lesson
content, or raw knowledge source.

### Step 7: Implement learning result propagation

Prefer an explicit generic result:

```ts
interface AgentOperationResult<T> {
  value: T;
  skillWarnings: SkillWarningView[];
}
```

Use it only at LLM-backed engine boundaries. Keep purely local learning
mutations returning their current domain types. Update schedulers and
orchestrator callers atomically so no warning is silently discarded.

### Step 8: Run focused core suites

```powershell
bun test packages/core/src/engine.test.ts packages/core/src/ask.test.ts packages/core/src/dream.test.ts packages/core/src/learning.test.ts packages/core/src/learning-engine.test.ts
bun run typecheck
```

## Task 5: Persist Research-Task Skill Evidence

**Files:**

- Modify: `packages/core/src/task-runs.ts`
- Modify: `packages/core/src/task-runs.test.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/engine.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/app/src/task-scheduler.ts`
- Modify: `packages/app/src/task-scheduler.test.ts`

### Step 1: Add failing task-run schema tests

Add optional snapshots:

```ts
interface TaskRunSkillEvidence {
  requested: SkillRequestSnapshot[];
  resolved: ResolvedSkillSnapshot[];
  skipped: SkippedSkillSnapshot[];
}
```

Cover:

1. New runs persist an empty or populated evidence object at start.
2. Resolved entries include `sourceKey`, safe name, invocation name, and
   `skillFileHash`.
3. Skipped entries include a safe reason code and bounded message, never an
   absolute path.
4. Returned records deep-clone all evidence arrays and objects.
5. Older task-run versions still load.
6. The next version validates evidence bounds.
7. Recovery of interrupted runs preserves start-time evidence.

### Step 2: Run the task-run test and verify RED

```powershell
bun test packages/core/src/task-runs.test.ts
```

### Step 3: Version and implement task-run persistence

- Accept existing versions 2 and 3.
- Write the next version with optional Skill evidence.
- Capture resolution before `TaskRunStore.start`.
- Use the same resolved snapshot for the provider process.
- Do not re-resolve the Agent or Skills after the durable run record exists.

### Step 4: Add failing execution outcome tests

Cover:

1. Partial skips plus provider success produce a succeeded run.
2. Total skips plus provider success produce a succeeded run.
3. Provider failure retains start-time Skill evidence.
4. Cancel and timeout retain evidence.
5. Immediate post-task dream uses the same Agent Skills under read-only
   permission, not task write/full.
6. Retry captures current Agent and Skill configuration in the new run.
7. Rebinding the space after launch does not alter the running snapshot.

### Step 5: Add notification warning behavior

Update task notification formatting and tests:

- append one bounded warning summary when Skills were skipped;
- do not include paths, hashes, or full diagnostics;
- notification transport failure remains independent of task success;
- retrying a notification reuses persisted evidence and wording.

### Step 6: Run focused task suites

```powershell
bun test packages/core/src/task-runs.test.ts packages/core/src/engine.test.ts packages/app/src/task-scheduler.test.ts
bun run typecheck
```

## Task 6: Surface Warnings Through Feishu Orchestration

**Files:**

- Modify: `packages/orchestrator/src/format.ts`
- Modify: `packages/orchestrator/src/runtime.ts`
- Modify: `packages/orchestrator/src/runtime.test.ts`
- Modify: `packages/orchestrator/src/learning-commands.ts`
- Modify: `packages/orchestrator/src/learning-commands.test.ts`
- Modify: `packages/orchestrator/src/task-commands.ts`
- Modify: `packages/orchestrator/src/task-commands.test.ts`

### Step 1: Add failing warning-format tests

Cover:

1. No warnings add no extra text.
2. One warning renders one concise paragraph.
3. Multiple warnings are deduplicated and bounded.
4. Total unavailability says the base Agent continued without Skills.
5. Names and messages are plain escaped/quoted text.
6. Absolute Unix, macOS, and Windows paths are removed.
7. Detailed parser errors never reach Feishu.

### Step 2: Implement one warning formatter

Keep reason-code-to-copy mapping in one orchestrator formatter. Callers pass the
safe `SkillWarningView` type and cannot interpolate core diagnostics directly.

### Step 3: Add failing conversation tests

Cover:

1. Group A and group B resolve different space Agents and Skills.
2. Ask replies append the selected Agent's warning block.
3. A successful reply remains successful with warnings.
4. A provider failure still uses the existing provider notice.
5. Cold-start copy and citations remain ahead of the warning block.
6. Personal chats follow their personal-space Agent.

### Step 4: Wire Ask and Dream warnings

- Append `AskResult.skillWarnings` in the normal answer path.
- Append `DreamReport.skillWarnings` in explicit dream responses.
- Background dream failures and logs remain bounded and do not send unsolicited
  warning messages.

### Step 5: Add failing learning-command tests

Cover warning propagation for:

- topic-plan creation;
- assessment response;
- resource refresh;
- lesson delivery;
- learning feedback.

Pure local commands such as list, pause, resume, and delete must not fabricate
Skill warnings.

### Step 6: Wire learning and task command copy

Use `AgentOperationResult<T>` from core. Preserve existing command semantics and
append the same formatter output. Task start replies name the durable run ID;
completion notification uses persisted evidence from Task 5.

### Step 7: Run focused orchestrator suites

```powershell
bun test packages/orchestrator/src/runtime.test.ts packages/orchestrator/src/learning-commands.test.ts packages/orchestrator/src/task-commands.test.ts
bun run typecheck
```

## Task 7: Build the Agent Skill Catalog Read Model and Form Contract

**Files:**

- Modify: `packages/web/src/agent-workbench.ts`
- Modify: `packages/web/src/agent-workbench.test.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`

### Step 1: Add failing presenter tests

Extend the workbench model with:

- grouped catalog entries;
- provider badges;
- selected exact sources;
- legacy unresolved bindings;
- invalid, missing, incompatible, and shadowed states;
- abbreviated source labels;
- aggregate compatibility counts;
- cache age and bounded scan diagnostics.

Cover:

1. Empty catalog.
2. Available shared Skill.
3. Provider-specific Skill.
4. Same-hash grouped sources.
5. Same-name different-hash variants.
6. Selected missing source.
7. Legacy unresolved name.
8. Provider change retaining bindings and recalculating status.
9. Home paths displayed as `~/` while non-home absolute paths remain hidden.
10. Raw `SKILL.md` content never enters the view model.

### Step 2: Run presenter tests and verify RED

```powershell
bun test packages/web/src/agent-workbench.test.ts
```

### Step 3: Replace free-text editor values

Change submitted Skills from a comma-separated string to a bounded list of
source keys. Keep submitted values after validation failures. Validate:

- maximum selected Skills;
- maximum key and request size;
- key syntax;
- current catalog membership for new selections;
- preservation of already-stored missing bindings;
- duplicate keys;
- Agent provider compatibility as a warning, not a hard validation error.

### Step 4: Add failing route tests

Cover:

1. GET Agent pages receive catalog data.
2. Create with valid source keys persists exact bindings.
3. Edit preserves missing bindings during unrelated changes.
4. Unknown newly submitted source keys return 422.
5. Provider-incompatible bindings save with a warning.
6. POST refresh invalidates the cache and redirects to the exact selected/new
   Agent state.
7. Refresh failure degrades the catalog section without breaking the editor.
8. No route accepts a local path or Skill body.
9. Existing CSRF/origin and local-admin protections continue to apply.

### Step 5: Implement route and service integration

- Construct/inject one catalog service with the engine/application lifecycle.
- Build catalog read data once per request.
- Add a narrow refresh form route.
- Use explicit form posts and redirects; do not add a client-side data API.
- Preserve the current Agent create/update/delete behavior and workbench
  selection rules.

### Step 6: Run focused Web model and route tests

```powershell
bun test packages/web/src/agent-workbench.test.ts packages/web/src/app.test.ts
bun run typecheck
```

## Task 8: Render the Inline Agent Capabilities Selector

**Files:**

- Modify: `packages/web/src/agent-workbench-view.ts`
- Modify: `packages/web/src/agent-workbench-view.test.ts`

### Step 1: Add failing layout contract tests

Cover:

1. Edit mode renders **Agent capabilities / Skills** outside Task execution.
2. Create mode uses the same catalog selector.
3. Permission and Workdir remain under Task execution.
4. The old free-text Skills input is absent.
5. Search input, Refresh form, selected chips, Provider badges, source labels,
   and expandable diagnostics render.
6. Every selected binding submits a bounded source key.
7. Empty, invalid, conflict, legacy, missing, incompatible, and shadowed states
   have visible copy.
8. A Provider change does not remove selected bindings.
9. Warnings use status text/icons in addition to color.
10. All catalog metadata is HTML escaped.

### Step 2: Run the view test and verify RED

```powershell
bun test packages/web/src/agent-workbench-view.test.ts
```

### Step 3: Implement server-rendered selector markup

- Render a searchable list with checkbox controls.
- Render selected chips with remove controls.
- Use `<details>` for source and diagnostic expansion.
- Keep the current single Agent editor form; Refresh is a separate non-nested
  POST form.
- Preserve `form="agent-editor-form"` associations for controls rendered in the
  inspector.
- Do not insert nested forms.

### Step 4: Add minimal plain-DOM behavior

The page script must:

1. filter catalog rows by name and description;
2. keep checkboxes and chips synchronized;
3. preserve selections when Provider changes;
4. recalculate only client-visible compatibility labels from safely serialized
   server data;
5. participate in the existing dirty-state warning;
6. focus the first invalid/unresolved Skill control after a failed post;
7. work without JavaScript as a normal checkbox list and explicit Save.

Do not add fetch, client persistence, or a framework.

### Step 5: Add responsive and accessible styling

Cover:

- catalog height and scrolling;
- long names and descriptions;
- source labels without horizontal overflow;
- keyboard-visible focus;
- narrow inspector drawer and mobile editor;
- chips wrapping cleanly;
- status text readable without color;
- reduced-motion behavior consistent with the existing workbench.

### Step 6: Run focused view tests and type checking

```powershell
bun test packages/web/src/agent-workbench-view.test.ts
bun run typecheck
```

## Task 9: Verify Cross-Layer Behavior and Update Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/beta-release-runbook.md`
- Modify as required by failures: focused tests from Tasks 1–8

### Step 1: Add or extend cross-layer acceptance tests

Prove:

1. Feishu group A → team space A → Agent A → Skills A.
2. Feishu group B → team space B → Agent B → Skills B.
3. Personal space → Personal Agent → its Skills.
4. Agent rebinding affects new calls but not a running task snapshot.
5. Ordinary calls are read-only even when the Agent is `full`.
6. Tasks use Agent Permission and Workdir.
7. Partial and total Skill unavailability continue with warnings.
8. No-Agent and no-Skill paths remain unchanged.
9. Restart preserves Agent bindings and task evidence.
10. Space export/restore preserves or safely migrates bindings.

### Step 2: Update product documentation

Document:

- the group → space → Agent → Skills relationship;
- scanned default root classes;
- manual Refresh;
- exact source selection and duplicate handling;
- ordinary read-only versus task permission;
- skip-and-warn behavior;
- "resolved and requested" truthfulness;
- first-release exclusions, especially Git/URL import and daemon sync.

Do not document Mew platform capabilities that HomeAgent does not implement.

### Step 3: Run all focused suites together

```powershell
bun test packages/llm/src/providers.test.ts packages/core/src/skill-catalog.test.ts packages/core/src/agents.test.ts packages/core/src/governance.test.ts packages/core/src/task-runs.test.ts packages/core/src/engine.test.ts packages/core/src/ask.test.ts packages/core/src/dream.test.ts packages/core/src/learning.test.ts packages/core/src/learning-engine.test.ts packages/orchestrator/src/runtime.test.ts packages/orchestrator/src/learning-commands.test.ts packages/orchestrator/src/task-commands.test.ts packages/app/src/task-scheduler.test.ts packages/web/src/agent-workbench.test.ts packages/web/src/agent-workbench-view.test.ts packages/web/src/app.test.ts
bun run typecheck
```

### Step 4: Run the full offline suite

```powershell
bun test
```

Expected: all offline tests pass with no live provider, network, Feishu, or Mew
dependency.

### Step 5: Run product verification

```powershell
bun run verify:crash-recovery
bun run verify:beta
```

If either command depends on external release credentials or a clean release
tree, record the exact external blocker rather than weakening the check.

### Step 6: Manual browser verification

Run:

```powershell
bun run packages/web/src/dev.ts
```

Verify:

1. Create and edit selectors at desktop, tablet, and mobile widths.
2. Search, select, remove, Refresh, save, validation recovery, and Provider
   switching.
3. Empty, invalid, conflict, missing, legacy, incompatible, and shadowed states.
4. Keyboard navigation, focus visibility, details disclosure, and dirty-state
   prompts.
5. No horizontal overflow or new console errors.
6. The management page never displays a raw home path outside the approved
   `~/` abbreviation.

### Step 7: Optional real-provider smoke test

Only when the user explicitly authorizes live local CLI execution:

1. Bind one harmless read-only Skill to a test Agent.
2. Run one ordinary ask and confirm the CLI receives the Skill reference under
   read-only permission.
3. Run one read-only research task and inspect durable Skill evidence.
4. Temporarily make the source unavailable and confirm skip-and-warn behavior.

Do not make this live smoke test part of the offline acceptance gate.

## Completion Checklist

- [ ] Local catalog is bounded, deterministic, and non-executing.
- [ ] Agent bindings identify exact local sources.
- [ ] Legacy string Skills migrate without ambiguous auto-selection.
- [ ] All Agent-backed flows resolve Skills.
- [ ] Ordinary calls stay read-only.
- [ ] Research tasks persist Skill evidence.
- [ ] Feishu warnings are bounded and path-free.
- [ ] Agent workbench uses the inline capabilities selector.
- [ ] No out-of-scope Mew platform subsystem was added.
- [ ] Focused tests, full tests, typecheck, crash recovery, and beta verification
      pass or have an exact external blocker recorded.
