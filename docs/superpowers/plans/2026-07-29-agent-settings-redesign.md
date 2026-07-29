# Agents Settings Workbench Implementation Plan

> **Design spec:** `docs/superpowers/specs/2026-07-29-agent-settings-redesign-design.md`

**Goal:** Replace the current Agents list-and-form page with an honest
Mew-inspired three-pane workbench that exposes local CLI readiness, exact
Agent-attributed task runs, current space/Feishu bindings, and the existing Agent
configuration fields without adding Mew-only device or repository systems.

**Architecture:** Persist the Agent/provider/model selected at task-run launch,
add exact Agent-run and Agent-binding queries to core, assemble one bounded
workbench view model in the Web package, and render the result through a
page-specific Hono view. Keep all mutations as explicit server-side form posts
and use plain DOM only for field synchronization, dirty-state protection,
responsive drawers, and accessible pane resizing.

**Tech stack:** Bun, TypeScript, Hono server-rendered HTML, plain DOM/CSS,
JSON configuration under `data/config`, Bun test.

## Delivery Rules

- Work test-first within each task: add or update a focused test, observe the
  intended failure, implement the minimum behavior, and rerun the focused suite.
- Preserve all unrelated working-tree changes, especially the in-progress Feishu
  integration edits in `packages/web/src/app.ts`, `packages/web/src/views.ts`,
  and their tests.
- Do not add Device, Repository, Environment, Concurrency, Chat, or avatar
  concepts.
- Do not infer historical Agent ownership from a space's current binding.
- Do not expose raw CLI output, credentials, prompts, or task output in list
  summaries.
- Keep existing `agents.json` and version-2 task-run files readable.
- Use Hono escaping for user-controlled values and safely serialized JSON for
  browser catalogs.

## Task 1: Persist Exact Agent Execution Snapshots

**Files:**

- Modify: `packages/core/src/task-runs.ts`
- Modify: `packages/core/src/task-runs.test.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/engine.test.ts`

### Step 1: Add failing TaskRunStore contract tests

Cover:

1. A new run may persist `agentId`, `provider`, and effective `model`.
2. An empty effective model remains absent and means the provider CLI default.
3. Version-2 files still load.
4. Version-3 files validate supported CLI provider identifiers.
5. `listByAgent(agentId, limit)` returns exact matches newest first.
6. Legacy runs without `agentId` are excluded.
7. Limits are clamped to 1 through 100.
8. Returned values are clones and cannot mutate store state.

### Step 2: Run the focused store test and verify RED

```powershell
bun test packages/core/src/task-runs.test.ts
```

Expected: fail because execution snapshot fields and `listByAgent` do not exist.

### Step 3: Implement version-3 task-run persistence

- Add optional `agentId`, `provider`, and `model` fields to `TaskRun`.
- Add the same optional fields to `StartTaskRunInput`.
- Accept persisted file versions 2 and 3; always write version 3.
- Validate `provider` with the existing CLI provider guard.
- Keep old records untouched when they are loaded.
- Add `listByAgent(agentId, limit = 20)`.

### Step 4: Add failing engine attribution tests

Cover:

1. Starting a task in a bound space records the selected Agent ID.
2. The snapshot records the effective global model when Agent and global
   providers match.
3. It records no model when the Agent uses a different provider's CLI default.
4. The provider/model used by the process match the persisted snapshot.
5. Changing a binding after launch does not alter that run.
6. A retry launches a new run using the Agent configuration current at retry
   time while preserving the original run.

### Step 5: Resolve execution once at launch

Add a small internal resolver that returns:

```ts
interface ResolvedAgentExecution {
  agent?: Agent;
  agentId?: string;
  provider: ProviderId;
  model?: string;
}
```

Resolve and clone the selected Agent before the durable run is created. Pass the
same resolved values to `TaskRunStore` and the provider client used by
`executeTaskRun`.

### Step 6: Run focused core tests

```powershell
bun test packages/core/src/task-runs.test.ts packages/core/src/engine.test.ts
bun run typecheck
```

## Task 2: Add Binding-Safe Agent Mutations and Validation

**Files:**

- Modify: `packages/core/src/registry.ts`
- Modify: `packages/core/src/registry.test.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/engine.test.ts`
- Modify: `packages/core/src/agents.ts`
- Modify: `packages/core/src/agents.test.ts`

### Step 1: Add failing registry tests

Cover:

1. `listByAgent(agentId)` returns exact current bindings.
2. `clearAgentBindings(agentId)` clears every exact reference in one persisted
   registry replacement.
3. Other metadata and other Agent bindings remain unchanged.
4. Repeating the clear is safe.
5. Persistence failure leaves the in-memory registry unchanged.

### Step 2: Run the registry test and verify RED

```powershell
bun test packages/core/src/registry.test.ts
```

### Step 3: Implement atomic binding helpers

Use a candidate-map commit pattern in `SpaceRegistry` so multi-space clearing is
one whole-file persistence operation. Return cloned metadata from read methods.

### Step 4: Add Agent mutation tests

Cover:

1. Team-to-Personal update is rejected while team spaces are bound.
2. Personal-to-Team update is rejected while personal spaces are bound.
3. Compatible updates preserve bindings.
4. Delete first clears bindings, then removes the Agent.
5. Registry failure prevents Agent removal.
6. Retrying after bindings were already cleared succeeds.
7. Agent names and instructions enforce the approved bounds.
8. Unsupported providers, visibility, permission, and reasoning values return
   structured validation errors instead of silently normalizing to another
   provider.
9. Write/full permission requires a valid directory.
10. An unavailable but supported provider may be preserved during an unrelated
    edit.

### Step 5: Implement bounded mutation APIs

Add engine-level methods used by Web routes:

- `agentBindings(agentId)`
- `updateAgent(id, input)`
- `removeAgentAndUnbind(id)`
- `listAgentRuns(agentId, limit)`

Return a typed result or throw a typed, field-addressable validation error.
Keep low-level stores focused on persistence and normalization.

### Step 6: Run focused core suites

```powershell
bun test packages/core/src/registry.test.ts packages/core/src/agents.test.ts packages/core/src/engine.test.ts
bun run typecheck
```

## Task 3: Build the Agent Workbench Read Model

**Files:**

- Create: `packages/web/src/agent-workbench.ts`
- Create: `packages/web/src/agent-workbench.test.ts`
- Modify: `packages/web/src/index.ts`

### Step 1: Write presenter tests

Cover:

1. Empty state with no Agents.
2. Default selection of the first Agent.
3. Explicit create state.
4. Explicit selected-Agent state.
5. Available and unavailable provider summaries.
6. Effective-model labels distinguish global inheritance from provider CLI
   default.
7. Running state derives only from exact attributed task runs.
8. Bindings include personal/team space type and the best safe display name.
9. Team bindings use known Feishu group labels when available and fall back to
   registry name or chat ID.
10. Recent runs are newest first, bounded, and contain only safe summary fields.
11. Provider discovery or Feishu enrichment failure degrades its section without
    breaking the editor.
12. Submitted values and field errors override persisted values after a failed
    post.

### Step 2: Run the presenter test and verify RED

```powershell
bun test packages/web/src/agent-workbench.test.ts
```

### Step 3: Implement typed view models

Define small types for:

- `AgentListItemView`
- `AgentBindingView`
- `AgentRunView`
- `AgentEditorValues`
- `AgentFieldErrors`
- `AgentWorkbenchView`

Keep provider detection, engine reads, and optional Feishu snapshot enrichment in
the presenter. Do not pass core stores directly into HTML templates.

### Step 4: Run presenter and type tests

```powershell
bun test packages/web/src/agent-workbench.test.ts
bun run typecheck
```

## Task 4: Render the Three-Pane Workbench and Wire Routes

**Files:**

- Create: `packages/web/src/agents-view.ts`
- Create: `packages/web/src/agents-view.test.ts`
- Modify: `packages/web/src/layout.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`

### Step 1: Add failing HTML contract tests

Cover:

1. The page exposes list, operating-context, and inspector landmarks.
2. Empty state links to `/agents/new`.
3. `/agents` redirects or renders with the first Agent selected.
4. `/agents/new` renders Cancel/Create without persisting a record.
5. `/agents/:id` renders Save and the selected Agent.
6. Mew-only property labels never appear.
7. Provider status includes text, not color alone.
8. Recent runs render status, task, space, provider/model, time, detail link,
   retry action, and an empty state.
9. The initial limit is 20 and load more grows by 20 up to 100.
10. Scope shows bound spaces and group labels.
11. Delete confirmation contains the binding count.
12. Field errors are linked to their controls and retain submitted values.
13. Existing custom models render as custom and survive unrelated saves.
14. Provider changes clear incompatible model/reasoning selections in the
    browser catalog.

### Step 2: Run Web tests and verify RED

```powershell
bun test packages/web/src/agents-view.test.ts packages/web/src/app.test.ts
```

### Step 3: Extract and render the Agent view

Move the Agent-specific markup out of `views.ts` into `agents-view.ts`.

Add page-scoped CSS for:

- full-width workbench mode;
- 240 px list / flexible center / 320 px inspector defaults;
- compact rows and thin pane separators;
- truthful success, warning, failure, and unavailable states;
- a drawer below 1180 px;
- separate list/detail presentation below 760 px;
- accessible focus, errors, buttons, and destructive actions.

Preserve the dark HomeAgent navigation rail and the light content workbench.

### Step 4: Add bounded plain-DOM behavior

Implement:

- provider/model/reasoning synchronization;
- dirty-form tracking and navigation warning;
- pointer and keyboard resizers;
- versioned local pane-width persistence;
- inspector drawer open, close, focus trap, Escape handling, and focus return;
- mobile back-to-list navigation.

Do not add a fetch-based state layer or auto-save.

### Step 5: Rewire routes carefully

- Add `GET /agents/new`.
- Make `GET /agents` choose the first Agent or empty state.
- Build the workbench view model for GET and failed POST responses.
- Use engine-level update/delete operations.
- Return a field-preserving validation response rather than redirecting on
  invalid input.
- Keep successful posts as Post/Redirect/Get.
- Reuse existing task-run detail and retry routes.

Because `app.ts`, `views.ts`, and `app.test.ts` already contain unrelated
working-tree edits, patch only the Agent-specific regions and inspect the final
diff before continuing.

### Step 6: Run Web and nearby integration tests

```powershell
bun test packages/web/src/agents-view.test.ts packages/web/src/agent-workbench.test.ts packages/web/src/app.test.ts packages/web/src/feishu-integration-service.test.ts
bun run typecheck
```

## Task 5: Browser Verification and Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/beta-release-runbook.md` only if the existing Agents release
  checklist needs adjustment

### Step 1: Update documentation

Document:

- the three-pane Agent workbench;
- truthful CLI readiness;
- Agent-attributed research-task history;
- binding-safe Visibility changes and deletion;
- responsive inspector behavior;
- the explicit non-goals.

Preserve unrelated documentation edits already present in the working tree.

### Step 2: Run focused automated verification

```powershell
bun test packages/core/src/task-runs.test.ts packages/core/src/registry.test.ts packages/core/src/agents.test.ts packages/core/src/engine.test.ts
bun test packages/web/src/agent-workbench.test.ts packages/web/src/agents-view.test.ts packages/web/src/app.test.ts packages/web/src/feishu-integration-service.test.ts
bun run typecheck
```

### Step 3: Run the full offline gate

```powershell
bun test
bun run verify:beta
```

If failures come from unrelated dirty-tree work, record that evidence and keep
the Agents-focused suites green rather than rewriting unrelated code.

### Step 4: Verify in the browser

With the local Web app running, verify:

1. desktop three-pane layout at 1440 px and 1920 px;
2. pointer and keyboard pane resizing and persisted widths;
3. inspector drawer at 1024 px;
4. list/detail and settings sheet below 760 px;
5. create, save, dirty-navigation warning, and delete flows;
6. Provider/Model/Reasoning synchronization;
7. unavailable-provider and validation states;
8. exact recent-run attribution, detail navigation, load more, and retry;
9. no horizontal overflow and acceptable keyboard focus order.

### Step 5: Inspect the final diff

Confirm:

- only Agent-related changes and explicitly updated docs are included;
- the in-progress Feishu changes are preserved;
- no `.superpowers/` visualization artifacts are staged;
- no credentials, local absolute paths, generated data, or runtime files are
  included.

## Final Review Checklist

- [ ] Existing Agent files load unchanged.
- [ ] Version-2 and version-3 task-run files load.
- [ ] New task runs store exact Agent/provider/model attribution.
- [ ] No legacy run is guessed onto a current Agent.
- [ ] Bindings and Feishu labels are truthful and bounded.
- [ ] Visibility conflicts are blocked without silent unbinding.
- [ ] Explicit delete clears bindings before removing the Agent.
- [ ] Provider-unavailable state does not make the editor unusable.
- [ ] Desktop, drawer, and mobile layouts are accessible.
- [ ] No Mew-only subsystem was introduced.
- [ ] Focused tests, typecheck, and proportional full verification pass.
