# Agent Create Experience Redesign Implementation Plan

> **Design spec:** `docs/superpowers/specs/2026-07-29-agent-create-experience-redesign-design.md`

**Goal:** Turn `/agents/new` into the approved focused Mew-inspired create
experience: keep the Agent list, remove the empty inspector, generate a useful
provider-specific name, use a compact two-column core form, and place task-only
settings in accessible progressive disclosure without adding Mew-only concepts.

**Architecture:** Extend the existing Agent workbench view model with
server-generated name candidates and explicit create-state metadata. Keep one
shared field-rendering path in `agent-workbench-view.ts`, selecting a
create-specific layout through state classes and semantic containers. Reuse the
current Hono POST route and server validation; plain DOM only enhances automatic
name switching, provider/model synchronization, dirty tracking, error focus, and
responsive behavior.

**Tech stack:** Bun, TypeScript, Hono server-rendered HTML, plain DOM/CSS, Bun
test.

## Delivery Rules

- Work test-first: add a focused failing test, verify the intended failure,
  implement the smallest behavior, and rerun the focused suite.
- Preserve unrelated dirty-tree changes in `README.md`, `packages/web/src/app.ts`,
  `packages/web/src/app.test.ts`, Setup, Feishu, and orchestrator files.
- Do not stage `.superpowers/`, `progress.md`, `task_list.json`, runtime data, or
  unrelated untracked files.
- Do not add Device, Repositories, Environment, Concurrency, Chats, or a generic
  device abstraction.
- Do not change the Agent JSON format, core Agent store, binding behavior, or
  task-run attribution.
- Keep create as normal server-rendered GET/POST with no auto-save and no
  fetch-based state layer.
- Treat all user values as untrusted and keep Hono escaping plus safe JSON
  serialization for inline catalogs.

## Task 1: Add Provider-Specific Unique Name Generation

**Files:**

- Modify: `packages/web/src/agent-workbench.ts`
- Modify: `packages/web/src/agent-workbench.test.ts`

### Step 1: Add failing name-generation tests

Cover:

1. `claude` maps to `Claude Code Agent`.
2. `codex` maps to `Codex Agent`.
3. `trae-cli` maps to `Trae CLI Agent`.
4. An unused base name is returned unchanged.
5. Existing base and `(2)` names produce `(3)`.
6. A gap uses the lowest available suffix.
7. Names that merely contain the base string do not consume a suffix.
8. Name comparison uses exact stored names.
9. The generated candidate for every supported provider is available in create
   view data.
10. Edit mode keeps the persisted name and does not enable automatic naming.
11. Submitted values after a failed create are marked manual and remain
    unchanged.

### Step 2: Run the presenter test and verify RED

```powershell
bun test packages/web/src/agent-workbench.test.ts
```

Expected: fail because provider name candidates and create-name state do not
exist.

### Step 3: Implement bounded naming helpers

Add small pure helpers:

```ts
type AgentNameCandidates = Record<ProviderId, string>;

function generatedAgentName(
  provider: ProviderId,
  agents: Pick<Agent, "name">[],
): string;

function generatedAgentNames(
  agents: Pick<Agent, "name">[],
): AgentNameCandidates;
```

Use a constant provider-to-base-name map. Check the base first, then suffixes
starting at `2`; do not mutate Agent data and do not reserve names.

Extend `AgentWorkbenchView` with:

- `generatedNames`;
- `automaticName`, true only for a fresh create render using a generated value.

Let `buildAgentWorkbench` derive the initial create editor name from the selected
provider and candidates. Explicit `values` from a failed POST always win and set
`automaticName` to false.

### Step 4: Rerun focused tests and type checking

```powershell
bun test packages/web/src/agent-workbench.test.ts
bun run typecheck
```

## Task 2: Render a Focused Create-State Layout

**Files:**

- Modify: `packages/web/src/agent-workbench-view.ts`
- Modify: `packages/web/src/agent-workbench-view.test.ts`

### Step 1: Add failing HTML contract tests

Cover:

1. Create mode has a header name input associated with
   `agent-editor-form`.
2. The header input contains the generated unique name.
3. Create mode renders Cancel and Create actions.
4. Create mode does not render the inspector aside, inspector toggle, overlay,
   resizer, binding copy, or task-history copy.
5. Edit mode retains the inspector and its current controls.
6. Instruction spans the create form width.
7. Provider/Model and Visibility/Reasoning use the core two-column container.
8. Permission, Workdir, and Skills are inside one native `<details>` labelled
   `任务执行`.
9. Task execution is closed by default.
10. Permission, Workdir, or Skills errors render the `<details>` open.
11. The real selected-provider readiness label appears in create mode.
12. Device, Repositories, Environment, Concurrency, and Chats labels are absent.
13. Generated-name candidates are serialized safely for the page script.
14. A failed-create value is marked manual rather than automatic.

### Step 2: Run the view test and verify RED

```powershell
bun test packages/web/src/agent-workbench-view.test.ts
```

### Step 3: Refactor field rendering without duplicating the form

Extract small local template helpers inside `agent-workbench-view.ts` for:

- name control;
- Instruction control;
- Provider control;
- Model control;
- reasoning control;
- Visibility control;
- Permission control;
- Workdir control;
- Skills control.

Use the same helpers in both modes:

- create mode places the name control in the sticky header;
- edit mode keeps the name control in Identity;
- create mode composes core fields in a two-column grid and task fields inside
  `<details>`;
- edit mode retains the established Identity, Model, and Access sections.

Do not introduce a second route view or a second set of field IDs.

### Step 4: Add create-specific layout CSS

Add page-scoped classes for:

- a two-pane create workbench: list plus flexible editor;
- a wider but bounded create form;
- sticky inline name input;
- compact core grid;
- readiness badge with textual status;
- Task execution summary and panel;
- single-column collapse at the existing responsive breakpoint;
- mobile create detail without an inspector drawer.

The create layout must not depend on `:has()` to hide a pane that is still
present; the inspector should be absent from create markup.

### Step 5: Add progressive-enhancement behavior

Extend the existing page script:

1. Read the safely serialized provider-to-generated-name map.
2. Track whether the name is still automatic.
3. On Provider change, replace the name only while it remains automatic.
4. On any user input in the name control, permanently mark it manual for that
   page lifecycle.
5. Include the header name input in dirty-state comparison through its `form`
   association.
6. On a failed render, focus the first `[aria-invalid="true"]` control.
7. Preserve existing Provider/Model/Reasoning synchronization.
8. Skip all inspector-drawer setup when create markup has no inspector.

Without JavaScript, the server-generated initial name, native form submission,
and `<details>` behavior remain usable.

### Step 6: Run view tests and type checking

```powershell
bun test packages/web/src/agent-workbench-view.test.ts
bun run typecheck
```

## Task 3: Wire Create Routes and Preserve Failed Input

**Files:**

- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`

### Step 1: Add failing route tests

Cover:

1. `/agents/new` selects the first available provider and renders its generated
   base name.
2. Existing names cause the expected lowest unused suffix.
3. No Agent is persisted by GET.
4. A valid POST creates exactly once and redirects to the created Agent detail.
5. A `422` response preserves name, Instruction, provider, model, reasoning,
   visibility, permission, Workdir, and Skills.
6. A task-field error renders Task execution open.
7. A failed submit does not regenerate or replace the submitted name.
8. Create mode contains no inspector while the post-create detail does.
9. Existing edit, delete, binding, and run-history routes remain unchanged.

### Step 2: Run route tests and verify RED

```powershell
bun test packages/web/src/app.test.ts
```

### Step 3: Simplify create view assembly

- Let `renderAgentWorkbench({ mode: "create" })` build the initial generated
  values from the current Agent list and detected providers.
- Remove redundant create-route value assembly if the presenter now owns it.
- Keep `agentValuesFromBody` for POST parsing and disabled-field fallbacks.
- On validation failure, pass explicit submitted values so the view marks the
  name manual.
- Keep successful create as Post/Redirect/Get.

Patch only Agent-specific hunks in `app.ts` and `app.test.ts`; both files contain
unrelated user changes.

### Step 4: Run Web regression tests

```powershell
bun test packages/web/src/agent-workbench.test.ts packages/web/src/agent-workbench-view.test.ts packages/web/src/app.test.ts
bun run typecheck
```

## Task 4: Browser and Regression Verification

**Files:**

- Modify: `README.md` only if the final behavior is not already described

### Step 1: Run focused automated verification

```powershell
bun test packages/web/src/agent-workbench.test.ts packages/web/src/agent-workbench-view.test.ts packages/web/src/app.test.ts
bun test packages/core/src/agents.test.ts packages/core/src/engine.test.ts packages/core/src/registry.test.ts packages/core/src/task-runs.test.ts
bun run typecheck
```

### Step 2: Run proportional full verification

```powershell
bun test
bun run verify:beta
```

If full verification is blocked by known Windows-only failures or the existing
dirty worktree, record the exact evidence. Do not modify or clean unrelated
changes to make the gate pass.

### Step 3: Verify in the browser

Use an isolated preview data directory and a port that does not affect the
user's running HomeAgent instance.

Verify:

1. desktop create state at 1440 px and 1920 px uses list plus wide editor;
2. create markup has no inspector, overlay, or empty inspector spacing;
3. generated name and suffix are correct;
4. Provider switching updates an untouched generated name;
5. manual name editing prevents later Provider changes from replacing it;
6. core two-column fields collapse cleanly on tablet and mobile;
7. Task execution opens by mouse and keyboard;
8. task-field validation returns with the section open and the first error
   focused;
9. Create reaches the normal three-pane detail page;
10. Cancel persists nothing;
11. no horizontal overflow or new console errors occur.

### Step 4: Inspect the final diff

Confirm:

- only the approved create-experience files are included;
- no Mew-only fields or device concepts were added;
- existing edit mode remains unchanged;
- Setup, Feishu, orchestrator, brand, and other dirty-tree changes remain
  unstaged;
- `.superpowers/` visual artifacts and runtime data remain untracked;
- no credentials, absolute local paths, or generated application data appear.

## Final Review Checklist

- [ ] Fresh create uses a provider-specific unique generated name.
- [ ] User-edited names are never overwritten by Provider changes.
- [ ] Create mode has no inspector before persistence.
- [ ] Successful create enters the existing three-pane detail.
- [ ] Core fields use the approved compact grid.
- [ ] Task-only fields use accessible progressive disclosure.
- [ ] Validation remains server-authoritative and preserves all values.
- [ ] Edit, binding, deletion, and run-history behavior is unchanged.
- [ ] No Device, Repositories, Environment, Concurrency, or Chats field exists.
- [ ] Focused tests, type checking, and responsive browser verification pass.
