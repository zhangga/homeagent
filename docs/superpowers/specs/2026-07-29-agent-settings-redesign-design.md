# HomeAgent Agents Settings Redesign

**Date:** 2026-07-29
**Status:** Approved design
**Reference:** Mew Agents workbench at `mew.bytedance.net`

## 1. Context

HomeAgent already supports configurable Agents with a local CLI provider, model,
Codex reasoning effort, visibility, task permission, workdir, and skills. The
current management page exposes those fields in a two-column list-and-form
layout, but it does not make Agent bindings, provider readiness, or task history
easy to understand.

This redesign adopts Mew's three-pane information architecture without copying
Mew-only concepts that HomeAgent does not implement. The page remains a
server-rendered Hono interface backed by HomeAgent's local stores.

## 2. Goals

- Make the Agents page a desktop workbench rather than a generic settings form.
- Keep the Agent list, operating context, and editable properties visible
  together.
- Show only truthful HomeAgent state: local CLI readiness, active tasks, current
  bindings, and durable research-task runs.
- Preserve exact historical attribution when an Agent is rebound or its provider
  and model change.
- Make create, edit, delete, validation, and recovery behavior explicit.
- Remain usable on narrow desktop and mobile widths.
- Keep the implementation small and consistent with the existing Hono and plain
  DOM stack.

## 3. Non-goals

This work does not add:

- remote or local Device management;
- repositories;
- environment variables;
- Agent-level concurrency controls;
- a Chat product or "start chat" action;
- Agent avatar upload;
- unified run history for ordinary questions, dream cycles, or learning;
- a frontend framework or client-side application shell.

## 4. Chosen Information Architecture

The Agents route uses a page-specific full-width workbench. It is not constrained
by the global `main` element's current 920 px maximum width.

### 4.1 Left pane: Agent list

The left pane contains:

- the page title and a New Agent action;
- every Agent's name;
- provider and effective model summary;
- a readiness indicator derived from provider discovery;
- an active-run indicator when a durable task run for that Agent is running;
- selected, hover, unavailable, and empty states.

The readiness indicator means only that the configured local CLI is runnable.
It must not be labelled as device online, idle, or offline.

### 4.2 Center pane: operating context

The center pane contains:

- a header with the Agent name and primary actions;
- the Instruction editor;
- a Recent runs section for durable research-task runs attributed to the Agent;
- run status, task name, space name, provider/model snapshot, start time, and a
  link to the existing run detail route;
- retry access for failed, timed-out, and cancelled runs;
- an empty state when the Agent has no attributable runs.

The first response renders at most 20 runs. "Load more" increases a bounded
`runs` query parameter in increments of 20, up to 100, without introducing a
client-side data layer. The page never shows more than the durable history
retained by `TaskRunStore`.

Ordinary questions, dream cycles, and learning activity do not appear here
because they do not currently have durable Agent-level run records.

### 4.3 Right pane: property inspector

The inspector groups fields by meaning:

**Execution**

- Provider
- Model
- Codex reasoning effort
- task Permission

**Scope**

- Visibility
- bound personal or team spaces
- associated Feishu group name for a bound team space, when available

**Task tools**

- Workdir
- Skills

**Metadata**

- created time
- updated time
- identifier, exposed as secondary copyable text

Mew-only properties are omitted rather than shown disabled.

## 5. Page States and Routes

### 5.1 Routes

- `GET /agents` selects the first Agent when one exists.
- `GET /agents` shows an onboarding-style empty state when there are no Agents.
- `GET /agents/new` renders the create state while retaining the left list.
- `GET /agents/:id` renders the selected Agent and its workbench data.
- Create, update, delete, run-detail, retry, and the new load-more action remain
  normal Hono routes and forms.

### 5.2 Create state

The center header shows Cancel and Create. The form starts with:

- a generated placeholder name that the user can replace;
- the first available provider;
- the global/default model selection;
- Team visibility;
- read-only task permission;
- no workdir or skills.

Creation is explicit. No Agent record is written until Create succeeds.

### 5.3 Edit state

The center header shows Save and an overflow menu containing Delete. Directly
editable fields participate in one form, including inspector controls.

The page does not auto-save. When supported by the browser, changing a field
marks the form dirty and warns before navigating away. A successful save clears
the dirty state and returns to the selected Agent with a concise confirmation.

### 5.4 Delete state

The confirmation names the Agent and the number of affected spaces. On
confirmation:

1. one registry-store commit clears `agentId` from every space that references
   the Agent;
2. those spaces immediately fall back to the configured default provider/model;
3. the Agent is deleted;
4. historical task runs retain their stored Agent/provider/model snapshot.

If the registry commit fails, deletion stops and reports the error. It must not
silently leave a partially deleted Agent. A process interruption after the
registry commit but before Agent deletion can leave the Agent unbound; retrying
the operation is safe.

## 6. Responsive Behavior

### Desktop

- Breakpoint: viewport width at least 1180 px.
- Navigation rail: existing HomeAgent rail.
- Agent list: 240 px default, adjustable from 200 to 360 px.
- Center: flexible and always retains enough width for Instruction and run rows.
- Inspector: 320 px default, adjustable from 260 to 420 px.
- Both separators support pointer drag and keyboard adjustment.
- User-selected pane widths are stored under a versioned HomeAgent-specific
  browser-local key.

### Narrow desktop/tablet

- Breakpoint: 760 through 1179 px.
- The Agent list remains visible.
- The inspector becomes a settings drawer opened from the center header.
- The center pane uses the available width.

### Mobile

- Breakpoint: viewport width below 760 px.
- The list and detail use separate screens within the same routes.
- The detail header includes a Back to Agents action.
- The inspector is a full-width sheet.
- All actions remain keyboard and screen-reader accessible.

## 7. Truthful State and Historical Attribution

### 7.1 Provider readiness

Provider readiness comes from the existing provider detector:

- available: the configured CLI is runnable;
- unavailable: the configured CLI is absent or failed its probe;
- running: one or more durable task runs attributed to the Agent are active.

The list and inspector expose the detector's safe explanation for unavailable
providers. Raw command output and credentials are not displayed.

### 7.2 Task-run snapshot

`TaskRun` gains optional execution snapshot fields:

```ts
agentId?: string;
provider?: ProviderId;
model?: string;
```

At task-run launch, the engine resolves the space's Agent and effective provider
and model once. Those values are passed to `TaskRunStore` and persisted before
provider execution begins.

The execution path uses the same resolved values, preventing the persisted
snapshot from disagreeing with the provider process that was started.

Optional fields keep existing history readable. The task-runs file version is
bumped from 2 to 3, and its loader accepts both old and new records. Old records
without an Agent snapshot remain visible on their task pages but are not
retroactively assigned to the Agent currently bound to the space.

### 7.3 Agent-run query

The core/query boundary provides an Agent-oriented read method that:

- filters by exact persisted `agentId`;
- sorts newest first;
- accepts a bounded limit or cursor;
- returns cloned/read-only run values;
- never infers historical ownership from the space's current Agent binding.

## 8. Bindings and Visibility

The workbench view model obtains bound spaces by filtering registry metadata for
the exact Agent ID. It enriches team spaces with the available Feishu binding
label without making the view depend on connector internals.

Visibility rules remain:

- Team Agents may bind only to team spaces.
- Personal Agents may bind only to personal spaces.

Changing Visibility is rejected when current bindings would become invalid. The
response identifies the blocking spaces and tells the user to unbind them first.
The application does not silently drop bindings during an ordinary save.

Deleting an Agent is different: its explicit confirmation authorizes clearing
all bindings as described in section 5.4.

## 9. Validation and Error Handling

Validation errors render next to the relevant field and preserve submitted
values. They do not collapse into a generic redirect message.

Validation covers:

- an Agent name of 1 through 100 trimmed characters;
- an Instruction of at most 20,000 characters;
- a supported CLI provider identifier;
- provider/model/reasoning compatibility, while preserving an already stored
  custom model when it is left unchanged;
- a supported Visibility and Permission;
- write or full permission requiring a valid Workdir;
- Workdir expansion, existence, and directory type;
- normalized, bounded skill names;
- incompatible visibility changes while bindings exist.

An existing Agent whose provider becomes unavailable remains editable. Saving
unrelated fields does not require that CLI to become available first.

An empty model has two explicit labels and meanings:

- when the Agent provider matches the global default provider, inherit the
  global default model;
- otherwise, use that provider CLI's own default model.

Changing Provider clears an incompatible selected model and requires a new
selection or the relevant default. A legacy custom model remains visible as
custom and may be saved unchanged, but it is not silently carried across a
Provider change.

Provider discovery failures degrade to an unavailable status; they do not
prevent the rest of the page from rendering.

Run or binding enrichment failures are isolated to their respective sections
and produce a compact section-level error rather than breaking the Agent editor.

## 10. Component and Code Boundaries

### 10.1 Web view

Move the Agents workbench out of the large `packages/web/src/views.ts` module
into `packages/web/src/agents-view.ts`. It owns:

- typed view-model interfaces;
- server-rendered markup for list, center, inspector, create, edit, and empty
  states;
- page-scoped CSS;
- the small DOM script for provider/model/reasoning synchronization, dirty-form
  protection, inspector drawer behavior, and resizable panes.

The markup remains escaped by Hono's `html` helpers. Embedded catalogs continue
to use safely serialized JSON.

### 10.2 View-model assembly

Add `packages/web/src/agent-workbench.ts` as the focused query/presenter boundary
rather than assembling registry, provider, Feishu, and task-run data inside the
template. It returns:

- the selected Agent or create state;
- list summaries for all Agents;
- provider/model catalogs;
- selected-Agent bindings;
- selected-Agent recent runs;
- field errors and flash state.

The presenter depends on stable engine and integration snapshot methods, not
connector process details.

### 10.3 Core

Core changes are limited to:

- task-run execution snapshot persistence and backward-compatible loading;
- exact Agent-run queries;
- binding-aware visibility validation;
- `SpaceRegistry.clearAgentBindings(agentId)` as one atomic registry commit;
- explicit remove-and-unbind orchestration.

The Agent storage format otherwise remains unchanged.

## 11. Visual Direction

The page retains HomeAgent's dark navigation rail and uses a restrained, light
workbench for the three panes. It follows Mew's density and hierarchy:

- thin separators instead of floating cards for primary panes;
- compact list rows;
- generous center-pane whitespace;
- quiet property labels and stronger values;
- green, amber, and red reserved for real operational states;
- minimal shadows, used only for drawers and transient overlays.

Provider logos may use simple local glyphs or text marks. No external assets are
required.

## 12. Accessibility

- Every input has a visible label and programmatic association.
- Status is conveyed by text as well as color.
- Pane resizers have separator semantics, keyboard controls, and announced
  values.
- Drawer focus is trapped while open and returns to its trigger on close.
- Error summaries link to field-level messages.
- Destructive actions require an explicit confirmation and remain reachable
  without pointer input.

## 13. Testing

### Core tests

- new task runs persist exact Agent/provider/model snapshots;
- old task-run files load without snapshots;
- Agent-run queries exclude legacy and differently attributed runs;
- binding lookup returns only exact current references;
- incompatible Visibility changes are rejected;
- delete-and-unbind clears all current references and is safe to retry;
- failure during unbinding prevents Agent deletion.

### Web route and view tests

- empty, create, edit, and not-found states;
- three-pane workbench landmarks and accessible labels;
- unavailable provider state;
- provider/model/reasoning synchronization catalog;
- submitted values and field errors survive validation failures;
- bound-space and Feishu-group labels render correctly;
- Recent runs order, limit, load more, detail links, and retry actions;
- delete confirmation includes the affected binding count.

### Browser verification

- desktop three-pane layout;
- pointer and keyboard pane resize;
- narrow-screen inspector drawer;
- mobile list/detail navigation;
- create, save, dirty-navigation warning, and delete flows;
- Provider/Model/Reasoning interaction;
- run detail and retry navigation;
- no horizontal overflow at supported breakpoints.

## 14. Rollout and Compatibility

- Existing `agents.json` files require no migration.
- Existing task-run records continue to load and remain on their task pages.
- New snapshot fields are optional and contain no prompt, output, credential, or
  environment content.
- Spaces without an assigned Agent still use the global default exactly as
  before.
- Removing the redesign would not affect stored knowledge or existing Agent
  configuration.
