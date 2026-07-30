# Agent Recent Runs Center Pane Implementation Plan

> **Design spec:** `docs/superpowers/specs/2026-07-30-agent-recent-runs-center-pane-design.md`

**Goal:** Make the existing Agent detail page follow the approved Mew-inspired
information hierarchy: editable name, Instruction, and a compact Recent Runs
list in the center; execution, scope, tools, readiness, bindings, and deletion
in the right property pane.

**Architecture:** Keep the existing Agent-attributed task-run query, bounded
server-side pagination, detail and retry routes, and explicit Agent POST. Extend
the presenter with a durable error summary, render one edit form whose
right-pane controls use the HTML `form` attribute, and restructure only edit
mode. The New Agent experience remains unchanged.

**Tech stack:** Bun, TypeScript, Hono server-rendered HTML, plain DOM/CSS, Bun
test.

## Delivery Rules

- Work test-first within each task: add or update a focused test, observe the
  intended failure, implement the minimum behavior, and rerun the focused suite.
- Preserve all unrelated working-tree changes, especially the in-progress
  Feishu, Setup, orchestrator, README, and Web route edits.
- Do not stage `.superpowers/`, `progress.md`, `task_list.json`, runtime data, or
  unrelated untracked files.
- Do not alter task-run persistence, retention, attribution, retry semantics,
  detail routes, or the bounded `runs` query behavior.
- Do not change the approved New Agent layout.
- Do not add aggregate health cards, filters, status grouping, polling, or a
  client-side data layer.
- Keep retry as a separate POST form; never nest a form or button inside a run
  detail anchor.
- Render all user-controlled values through Hono escaping.

## Task 1: Expose Durable Run Errors in the Workbench Presenter

**Files:**

- Modify: `packages/web/src/agent-workbench.ts`
- Modify: `packages/web/src/agent-workbench.test.ts`

### Step 1: Add failing presenter tests

Cover:

1. A failed run exposes its durable `TaskRun.error` through `AgentRunView`.
2. Timed-out and cancelled runs preserve their durable errors.
3. A run without an error leaves the view field absent.
4. The presenter does not synthesize an error from task output or topic.
5. Existing task name, space, provider/model snapshot, timestamp, status, and
   retryability remain unchanged.
6. Run order and the selected subset remain the order supplied by the bounded
   application query.

### Step 2: Run the focused presenter test and verify RED

```powershell
bun test packages/web/src/agent-workbench.test.ts
```

Expected: fail because `AgentRunView` does not expose the durable run error.

### Step 3: Add the smallest presenter field

- Add `error?: string` to `AgentRunView`.
- Copy only `run.error` during selected-Agent run mapping.
- Do not truncate or transform the stored value in the presenter; visual
  truncation belongs to the view, while Hono handles escaping.
- Keep `AgentInspectorView.runs` temporarily unchanged in this task so the view
  refactor can move it without mixing presenter and layout failures.

### Step 4: Rerun focused tests and type checking

```powershell
bun test packages/web/src/agent-workbench.test.ts
bun run typecheck
```

## Task 2: Move Edit Fields into the Property Pane

**Files:**

- Modify: `packages/web/src/agent-workbench-view.ts`
- Modify: `packages/web/src/agent-workbench-view.test.ts`

### Step 1: Add failing edit-layout contract tests

Cover:

1. Edit mode renders the Agent name as an inline header input.
2. The name input is associated with `agent-editor-form`.
3. Instruction remains in the center pane and is associated with the same form.
4. Provider, Model, reasoning effort, Permission, Visibility, Workdir, and
   Skills render inside `data-pane="agent-inspector"`.
5. Every right-pane edit control references `agent-editor-form`.
6. The inspector heading is `Agent 设置`.
7. Provider readiness, Bindings, and Danger zone remain in the inspector.
8. The old center Identity, Model, and Access sections are absent in edit mode.
9. Create mode keeps its current generated header name, compact core grid,
   Task execution disclosure, and absent inspector.
10. Field errors and submitted values remain beside their corresponding
    controls after a failed edit.

### Step 2: Run the view test and verify RED

```powershell
bun test packages/web/src/agent-workbench-view.test.ts
```

Expected: fail because edit controls still live in the center form sections and
the persisted name is not an inline edit control.

### Step 3: Reuse field template helpers

Refactor only as much as needed to share the existing controls between create
and edit layouts:

- retain the create-mode helpers and composition;
- render edit name in the sticky center header;
- render edit Instruction in the center form body;
- render the seven property controls in compact inspector sections;
- add `form="agent-editor-form"` to every edit control outside the form element;
- keep unique field IDs and the existing error IDs;
- keep the header Save button's existing `form="agent-editor-form"` contract.

Do not duplicate provider/model/reasoning option construction or introduce a
second form action.

### Step 4: Keep dirty state and field synchronization intact

The current page script must continue to:

1. discover all controls associated with `agent-editor-form`, including controls
   outside its DOM subtree;
2. mark edits from the header and right pane as dirty;
3. warn before navigation when unsaved;
4. synchronize Provider, Model, and reasoning effort;
5. focus the first invalid field after a failed edit;
6. open the inspector drawer before focusing an invalid right-pane field at
   narrow widths.

Prefer standards-based form association (`form.elements`) over separate control
lists.

### Step 5: Add compact property-pane CSS

Add page-scoped edit-mode styles for:

- the inline persisted-name control;
- labeled compact select and input rows;
- multi-line Workdir and Skills values without horizontal overflow;
- validation errors inside the property pane;
- clear separation between editable properties and read-only operational
  sections;
- preserved inspector width, resizer, drawer, overlay, focus trap, and mobile
  sheet behavior.

### Step 6: Rerun focused tests and type checking

```powershell
bun test packages/web/src/agent-workbench-view.test.ts
bun run typecheck
```

## Task 3: Render Compact Recent Runs in the Center Pane

**Files:**

- Modify: `packages/web/src/agent-workbench-view.ts`
- Modify: `packages/web/src/agent-workbench-view.test.ts`

### Step 1: Add failing run-list markup tests

Cover:

1. `Recent runs` renders inside `data-pane="agent-editor"`.
2. The inspector no longer contains Recent Runs markup or run links.
3. The section shows the exact total count.
4. Succeeded, running, failed, timed-out, and cancelled states include visible
   status text and stable status classes.
5. Succeeded and running rows use the task name as the primary label.
6. Failed, timed-out, and cancelled rows prefer `error` as the primary label and
   retain task name and execution metadata.
7. Error, task name, topic, space, provider, and model values are escaped.
8. The full non-action row content links to `/tasks/runs/:runId`.
9. Retry is a sibling POST form for retryable statuses, not nested in the
   detail anchor.
10. Running and succeeded rows do not expose Retry.
11. Empty and Load more states remain correct, including `runs=40` from a
    20-item page.

### Step 2: Run the view test and verify RED

```powershell
bun test packages/web/src/agent-workbench-view.test.ts
```

### Step 3: Add focused run-row helpers

Inside `agent-workbench-view.ts`, add small local render helpers for:

- status label and icon;
- primary label selection;
- secondary metadata;
- run detail link content;
- retry action;
- section empty and pagination states.

Use the durable error only for failed, timed-out, and cancelled primary labels.
Fall back to task name when it is absent. Keep the complete error in the markup
text and truncate it with CSS rather than mutating data.

### Step 4: Add compact center-list CSS

Implement the approved Mew-style density:

- one bordered list container with quiet row separators;
- status icon, flexible label/meta column, time, and detail affordance;
- green success, amber running, red failed/timed-out, and neutral cancelled
  states;
- visible status text for every state;
- single-line error and metadata truncation;
- hover and keyboard-focus treatment for the linked content;
- a distinct Retry button with at least a 40 px mobile touch target;
- no card grid, aggregate summary, status grouping, or timeline decoration.

Keep the center body bounded for comfortable reading while allowing the run list
to use more width than the current form.

### Step 5: Implement responsive row behavior

- At 760–1179 px, keep metadata on one line and truncate before overflow.
- Below 760 px, preserve list/detail navigation and the property sheet.
- Below 540 px, hide space and provider/model metadata.
- Keep status, task or error label, time, and Retry available on mobile.
- Prevent long errors, task names, Workdir, Skills, or model names from creating
  horizontal page overflow.

### Step 6: Rerun focused Web tests

```powershell
bun test packages/web/src/agent-workbench.test.ts packages/web/src/agent-workbench-view.test.ts
bun run typecheck
```

## Task 4: Protect Route Behavior and Failed-Edit Recovery

**Files:**

- Modify: `packages/web/src/app.test.ts`
- Modify: `packages/web/src/app.ts` only if view assembly needs a minimal
  edit-mode adjustment

### Step 1: Add route-level regression tests

Cover:

1. `/agents/:id` renders Instruction and Recent Runs in the center and property
   controls in the inspector.
2. Editing and posting all right-pane fields persists the same Agent values as
   before.
3. A `422` validation response preserves name, Instruction, Provider, Model,
   reasoning effort, Permission, Visibility, Workdir, and Skills.
4. Right-pane field errors remain associated with their controls.
5. A failed run error is visible on the Agent page without exposing task output.
6. Run count, ordering, the first 20 records, `runs=40`, detail links, and retry
   actions remain unchanged.
7. New Agent GET/POST markup and persistence remain unchanged.
8. Delete and unbind behavior remains unchanged.

### Step 2: Run route tests and verify failures are scoped

```powershell
bun test packages/web/src/app.test.ts
```

If the tests already pass after the view-only work, do not edit `app.ts`.

### Step 3: Make only necessary view-assembly changes

Preserve the current:

- `agentRunLimit` bounds;
- total-count calculation;
- Post/Redirect/Get behavior;
- `agentValuesFromBody` disabled-field fallbacks;
- selected-Agent query and exact historical attribution.

Patch only Agent-specific hunks because `app.ts` and `app.test.ts` contain
unrelated user changes.

### Step 4: Run the Web regression gate

```powershell
bun test packages/web/src/agent-workbench.test.ts packages/web/src/agent-workbench-view.test.ts packages/web/src/app.test.ts
bun run typecheck
```

## Task 5: Browser and Full Regression Verification

**Files:**

- Modify: `README.md` only if existing documentation materially contradicts the
  final behavior

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

If full verification is blocked by an existing environment-specific failure,
record the exact failing command and evidence. Do not clean or rewrite unrelated
changes to make the gate pass.

### Step 3: Verify in the browser

Use an isolated preview data directory and port so the user's running HomeAgent
instance and durable data are untouched.

Verify:

1. desktop at 1440 px and 1920 px shows list, center activity, and right
   properties with the approved hierarchy;
2. Agent name edits inline and saves with Instruction and right-pane controls;
3. Provider/Model/reasoning synchronization still works;
4. successful, running, failed, timed-out, and cancelled rows are readable and
   keyboard accessible;
5. failed error summary, row detail navigation, and Retry work independently;
6. 20-item pagination and Load more retain the correct Agent;
7. the inspector becomes a drawer at 760–1179 px and opens for invalid fields;
8. mobile rows retain status, primary label, time, and Retry without horizontal
   overflow;
9. create mode remains the approved focused two-pane experience;
10. no new console errors, invalid nested interactive markup, or focus traps
    appear.

### Step 4: Inspect the final diff

Confirm:

- only Agent workbench presenter, view, tests, and a strictly necessary route
  hunk are included;
- no task-run persistence or core execution code changed;
- no aggregate dashboard, filters, grouping, polling, or client data layer was
  added;
- Feishu, Setup, orchestrator, README, and all other dirty-tree changes remain
  unstaged;
- `.superpowers/` visual artifacts and runtime data remain untracked;
- no credentials, local absolute paths, or generated application data appear.

## Final Review Checklist

- [ ] Existing Agent detail uses the approved three-pane responsibilities.
- [ ] Name and Instruction are editable in the center.
- [ ] Recent Runs is compact, central, status-readable, and paginated.
- [ ] Retry remains a separate POST action.
- [ ] Execution, scope, and tools are editable in the right property pane.
- [ ] One explicit Save operation covers center and right-pane controls.
- [ ] Provider readiness, bindings, and deletion remain available.
- [ ] Failed edit values and errors survive in the correct pane.
- [ ] New Agent behavior is unchanged.
- [ ] No core storage, attribution, execution, or retry semantics changed.
- [ ] Focused tests, type checking, full regression checks, and responsive
      browser verification pass.
