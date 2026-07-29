# Agent Create Experience Redesign

Date: 2026-07-29

## 1. Context

HomeAgent already has a three-pane Agents workbench:

- Agent list on the left;
- Agent editor in the center;
- real CLI, binding, and task-run inspection on the right.

The edit experience benefits from all three panes, but the create state currently
retains an empty inspector and uses the same vertically segmented form as the edit
state. The result is less focused than Mew's create experience even though
HomeAgent has fewer concepts to configure.

This design uses Mew's create-page hierarchy as a reference without copying Mew
features that HomeAgent does not implement. In particular, the create page must
not expose Device, Repositories, Environment, Concurrency, Chats, or other
device-management concepts.

This document extends
`docs/superpowers/specs/2026-07-29-agent-settings-redesign-design.md`. It changes
only the create experience; the established edit workbench and Agent data model
remain intact.

## 2. Goals

- Make creating an Agent feel focused and fast.
- Retain the Agent list so users keep workspace context.
- Use the available editor width instead of showing an empty inspector.
- Generate a useful, unique name from the selected provider.
- Keep core configuration visible while moving task-only controls behind
  progressive disclosure.
- Preserve truthful CLI/model choices and all existing server-side validation.
- Keep desktop, tablet, mobile, keyboard, and no-JavaScript behavior usable.

## 3. Non-goals

- Recreating Mew's Device, Repository, or Environment configuration.
- Adding a separate Agent creation wizard.
- Creating a second form implementation.
- Changing Agent persistence or adding new Agent fields.
- Changing the edit-state inspector, binding, deletion, or task-history behavior.
- Auto-saving partial Agents.

## 4. Chosen Approach

The existing workbench gains a dedicated create-state presentation.

On `GET /agents/new`:

- the global navigation and Agent list remain visible on desktop;
- the inspector pane is omitted from the layout;
- the editor expands into the space normally used by the inspector;
- the name is editable directly in the sticky editor header;
- Cancel and Create remain in the upper-right action area;
- Instruction spans the full editor width;
- Provider, Model, Visibility, and reasoning effort use a compact two-column
  grid;
- Permission, Workdir, and Skills live in a collapsible Task execution section.

After a successful create, the app redirects to the standard three-pane Agent
detail page. The inspector then shows real CLI status, bindings, and task runs.

The alternatives were rejected:

- retaining the inspector produces a low-value empty column;
- a separate create template duplicates field rendering and interaction logic;
- a multi-step wizard adds unnecessary navigation for the current field count;
- a create-only readiness inspector introduces a second status surface without
  improving server-side correctness.

## 5. Page Structure

### 5.1 Header

The sticky editor header contains:

- a text input for the proposed Agent name;
- an unsaved-state indicator when the form differs from its initial values;
- Cancel;
- Create.

The name input replaces the duplicated static title used by the current create
state. The page body starts with a short explanation:

> Configure response behavior and the local CLI used by research tasks.

A compact readiness badge shows the selected provider's real detected CLI state.
It does not imply that an Agent exists before submission.

### 5.2 Core fields

Instruction is the first field and spans the full width because it benefits from
horizontal space.

The following fields use a two-column grid on wide screens:

| Left | Right |
| --- | --- |
| Provider | Model |
| Visibility | Reasoning effort |

Reasoning effort remains disabled and omitted from submission for non-Codex
providers. Provider and Model continue to use the detected-provider and
maintained-model catalogs already used by the edit page.

### 5.3 Task execution

Permission, Workdir, and Skills are grouped in a native `<details>` element
labelled `任务执行`.

- The section is collapsed on the first render.
- The summary explains that these settings affect research tasks only.
- Permission and Workdir use two columns on wide screens.
- Skills spans the full section width.
- A validation error in Permission, Workdir, or Skills renders the section open.

Closing the section does not disable or clear its controls. Native form
submission therefore remains correct without JavaScript.

### 5.4 Responsive behavior

- At desktop widths, the left Agent list remains and the create editor occupies
  all remaining workbench width.
- At tablet widths, the same two-pane structure remains when space permits;
  field grids collapse before they cause horizontal overflow.
- Below the existing mobile breakpoint, the Agent list is hidden while editing,
  the back control returns to `/agents?view=list`, and all fields become one
  column.
- The create state never exposes an inspector drawer because no inspector exists
  until the Agent has been created.

## 6. Automatic Naming

The server generates the initial name from the selected provider:

| Provider | Base name |
| --- | --- |
| `claude` | `Claude Code Agent` |
| `codex` | `Codex Agent` |
| `trae-cli` | `Trae CLI Agent` |

If the base name already exists, the server selects the lowest available suffix:
`Codex Agent (2)`, `Codex Agent (3)`, and so on. Comparison uses the same exact
stored names shown in the Agent list.

The create view exposes the generated-name candidates needed by its existing
inline script.

Client behavior:

1. The initially generated name is considered automatic.
2. Switching Provider replaces the name with that provider's unique generated
   candidate while the name remains automatic.
3. Any user input in the name field marks it as manual.
4. Later Provider changes do not overwrite a manual name.

Server behavior remains authoritative. The submitted name is trimmed and
validated through the existing create validation. The server does not silently
rename a manually submitted duplicate because duplicate Agent names are
currently allowed; the suffix logic applies only to generated defaults.

## 7. Data Flow and Error Handling

### 7.1 Initial render

`GET /agents/new`:

1. detects providers and loads model catalogs;
2. chooses the first available provider, falling back to the configured CLI
   default under the existing rules;
3. builds unique generated-name candidates using the current Agent list;
4. renders create mode with no selected Agent and no inspector.

No Agent record is written during this request.

### 7.2 Submission

`POST /agents` continues to:

1. parse all editor fields;
2. validate name, provider, model, reasoning effort, visibility, permission,
   Workdir, and Skills on the server;
3. create exactly one Agent only after validation succeeds;
4. redirect to `/agents/:id?ok=...`.

### 7.3 Validation failure

On a `422` response:

- every submitted value is preserved;
- field errors remain associated with their controls;
- the form-level message remains visible;
- the Task execution section opens when one of its fields has an error;
- the first invalid field receives focus through the progressive-enhancement
  script;
- the submitted name is treated as manual and is not regenerated.

Cancel returns to `/agents` and does not persist anything.

## 8. Implementation Boundaries

The change stays inside the current workbench architecture:

- `agent-workbench.ts` owns generated-name candidates and create-state view data;
- `agent-workbench-view.ts` owns create-mode markup, scoped CSS, and the small
  progressive-enhancement script;
- `app.ts` continues to assemble the view model and handle normal Hono form
  routes;
- existing Agent store, engine, registry, and task-run persistence formats do
  not change.

The create and edit states continue to share field rendering so labels, options,
validation, and accessibility cannot drift. The create-mode layout is selected
with state-specific classes rather than a second page template.

No new runtime dependency is required.

## 9. Accessibility

- The name input has a persistent accessible label.
- Cancel and Create remain reachable in logical tab order.
- Task execution uses native `<details>` and `<summary>` keyboard behavior.
- Error messages remain connected with `aria-describedby`.
- Invalid fields retain `aria-invalid`.
- The responsive layout changes visual placement without changing DOM reading
  order.
- Provider-driven name updates are reflected in the input value without moving
  focus.
- Create mode contains no inert or visually hidden inspector controls.

## 10. Testing

### 10.1 View-model tests

- maps each supported provider to its base generated name;
- chooses the lowest unused numeric suffix;
- exposes provider-specific candidates for the create script;
- keeps create mode inspector-free;
- preserves submitted values after validation failure.

### 10.2 View tests

- create markup has the header name input and Cancel/Create actions;
- core fields use the create grid;
- Task execution is collapsed by default;
- task-field errors render Task execution open;
- no Device, Repositories, Environment, Concurrency, or Chats fields appear;
- no inspector or inspector toggle appears in create mode;
- edit mode retains its existing inspector.

### 10.3 Route tests

- `/agents/new` renders the generated unique name;
- a valid POST creates once and redirects to the new detail page;
- a `422` response keeps values and opens the relevant section;
- Cancel has no persistence side effect.

### 10.4 Browser verification

- automatic names follow Provider changes until manually edited;
- a manual name survives later Provider changes;
- Provider, Model, and reasoning effort remain synchronized;
- Task execution is operable by mouse and keyboard;
- desktop, tablet, and mobile layouts have no horizontal overflow;
- successful creation enters the standard three-pane detail view;
- the browser console contains no new warning or error.

## 11. Acceptance Criteria

The redesign is complete when:

- the create page visually follows the approved focused Mew-inspired hierarchy;
- no Mew-only infrastructure fields are present;
- the inspector is absent before creation and present after successful creation;
- the initial name is useful and unique, and user edits are never overwritten;
- task-only fields use accessible progressive disclosure;
- existing validation and persistence guarantees remain authoritative;
- focused tests, type checking, and responsive browser verification pass.
