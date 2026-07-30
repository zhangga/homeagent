# Agent Recent Runs Center Pane

**Date:** 2026-07-30
**Status:** Approved design
**Reference:** Mew Agents workbench at `mew.bytedance.net`
**Related design:** `2026-07-29-agent-settings-redesign-design.md`

## 1. Context

The Agents workbench already has durable Agent-attributed task-run data, run
detail and retry routes, bounded pagination, and a three-pane shell. The current
implementation places Recent task runs in the narrow right inspector, while the
approved Agents redesign describes the center pane as the Agent's operating
context.

This change corrects that mismatch and follows Mew's clearer information
hierarchy:

- the left pane selects an Agent;
- the center pane explains what the Agent does and what it recently did;
- the right pane edits how and where the Agent runs.

The selected visual direction is a compact Mew-style run list rather than a
dashboard, status grouping, or timeline.

## 2. Goals

- Move Recent Runs from the right inspector into the center pane.
- Make task history fast to scan at desktop widths.
- Make successful, running, failed, timed-out, and cancelled runs visually
  distinct without relying on color alone.
- Make the run detail destination available from the full non-action portion of
  a row.
- Keep retry available directly on retryable rows.
- Move existing Agent execution and access fields into the right property pane
  so each pane has one clear responsibility.
- Preserve the current server-rendered form, validation, run history, detail,
  retry, and pagination behavior.

## 3. Non-goals

This change does not add:

- a new run store, API, or client-side data layer;
- new run retention or pagination rules;
- aggregate run-health statistics;
- status grouping or filtering;
- live streaming of run progress;
- auto-save;
- changes to the New Agent experience;
- changes to task execution, attribution, retry semantics, or stored run
  snapshots.

## 4. Information Architecture

### 4.1 Left pane: Agent selection

The left pane remains unchanged. It contains the Agent list, current selection,
provider/model summary, readiness, and active-run indicator.

### 4.2 Center pane: Agent context and activity

For an existing Agent, the center pane contains:

1. the sticky Agent header;
2. an inline editable Agent name;
3. the existing Save action and secondary actions;
4. the Instruction editor;
5. Recent Runs.

The Agent name input remains part of the same explicit save operation as the
other Agent fields. Instruction is the only large form control in the center
body. Recent Runs follows it with enough vertical space to read as the primary
activity surface rather than a secondary inspector section.

The existing Agent form introduction and the Model and Access form sections are
removed from the center pane in edit mode.

### 4.3 Right pane: Agent properties

For an existing Agent, the right property pane contains compact editable
controls grouped by meaning:

**Execution**

- Provider
- Model
- Codex reasoning effort
- Permission

**Scope and tools**

- Visibility
- Workdir
- Skills

The pane then shows the existing read-only operational sections:

- provider readiness;
- bound spaces;
- destructive delete action.

All editable right-pane controls still submit through `agent-editor-form`.
Controls rendered outside the form element use the HTML `form` attribute rather
than introducing a second save flow or nesting forms. The existing header Save
button remains the only primary save action.

The right pane heading changes from “运行与绑定” to “Agent 设置”. The narrower
provider-status, binding, and danger sections remain visually secondary to
editable properties.

### 4.4 Create and empty states

The New Agent page retains its current focused creation form and does not gain a
Recent Runs section or right inspector. The empty workbench state is unchanged.

## 5. Recent Runs Design

### 5.1 Section header

The section header displays:

- “Recent runs”;
- the total number of runs attributed to the selected Agent;
- no aggregate status cards or filters.

The first response renders at most 20 runs. The existing Load more link
increases the bounded `runs` query parameter by 20, up to 100.

### 5.2 Compact row

Each row presents, from left to right:

1. a status icon with accessible status text;
2. the primary run label;
3. secondary execution metadata;
4. the formatted start time;
5. a detail arrow or equivalent affordance.

For succeeded and running runs, the primary label is the task name. Secondary
metadata combines the space label and the persisted provider/model snapshot.

For failed, timed-out, and cancelled runs, the primary label is a concise error
summary when an error exists. The task name and execution metadata remain
visible as secondary content so the user can identify the attempted work.
Errors are rendered as escaped text and visually truncated to one line; the
full durable error remains available on the existing run detail page.

The complete non-action portion of a row links to
`/tasks/runs/:runId`. Retry is a separate POST form and button beside the linked
content. The markup must not nest a button or form inside an anchor.

### 5.3 Status presentation

- Running uses an amber activity indicator and visible “运行中” text.
- Succeeded uses a green success indicator and visible “已完成” text.
- Failed uses a red failure indicator and visible “失败” text.
- Timed out uses a red warning indicator and visible “已超时” text.
- Cancelled uses a neutral indicator and visible “已取消” text.

Only failed, timed-out, and cancelled runs expose Retry, matching the existing
retryability rules. A retry submission continues to use the current run route
and redirect behavior.

### 5.4 Empty and pagination states

When no run is attributed to the Agent, the section shows a compact empty
message instead of a large card. When more retained runs exist, Load more
displays the visible count and total count. The page never displays more than
the durable history returned by the existing store.

## 6. Data Flow and Code Boundaries

No core or persistence change is required.

The existing application boundary continues to:

1. query Agent-attributed runs through the exact persisted `agentId`;
2. sort newest first;
3. apply the bounded run limit;
4. pass the selected subset and total count to the workbench presenter.

`AgentRunView` gains an optional escaped-display source for the durable run error
so the template can produce a concise failure summary. The presenter continues
to snapshot task name, space, provider, model, timestamps, status, and
retryability. It does not infer attribution from current bindings.

`agent-workbench-view.ts` remains responsible for:

- center-pane and inspector markup;
- compact run-row rendering;
- status presentation;
- responsive styles;
- form association and dirty-state behavior.

No additional browser fetches, hydration, or run-specific JavaScript are
introduced.

## 7. Validation and Error Handling

- Existing Agent validation remains unchanged.
- Field errors for right-pane controls render next to those controls.
- Submitted values survive validation failures in both center and right panes.
- The dirty-form warning continues to cover the full Agent form, including
  controls associated through the `form` attribute.
- A missing run error falls back to the task name and status label.
- Long run errors and long metadata are truncated visually without changing the
  stored value.
- A run-list assembly failure remains isolated from the editable Agent form. The
  center section renders a compact “暂时无法加载运行记录” message while the Agent
  form remains editable.

## 8. Responsive Behavior

### Desktop: at least 1180 px

- Agent list keeps the current 244 px default and remains resizable.
- Center remains flexible and receives the primary horizontal space.
- Right properties keep the current 324 px default and remain resizable.
- Recent Runs uses the compact single-row layout.

### Narrow desktop and tablet: 760–1179 px

- Agent list remains visible.
- The right property pane becomes the existing settings drawer.
- Recent Runs remains in the center pane and uses the available width.
- Secondary metadata stays on one line and truncates before causing horizontal
  overflow.

### Mobile: below 760 px

- Existing list/detail navigation remains.
- The property pane remains a full-width sheet.
- Run rows keep status, task or error label, time, and applicable Retry action.
- Space and provider/model metadata is hidden below 540 px.
- Touch targets remain at least 40 px high even though the desktop list is
  visually compact.

## 9. Accessibility

- Status always has readable text in addition to color and iconography.
- The linked row content has a descriptive accessible name including status,
  task, space, and provider/model when available.
- Retry has an explicit accessible name tied to the task.
- Keyboard focus styles remain visible for the row link and Retry button.
- Right-pane controls keep visible labels, error associations, and the existing
  form semantics.
- Drawer focus trapping and focus return behavior remain unchanged.

## 10. Testing

### Presenter and view tests

- Recent Runs renders in the center pane and not in the inspector.
- Existing Agent edit fields render in their approved center or right pane.
- Right-pane inputs reference `agent-editor-form`.
- Name and Instruction remain part of the same save operation.
- Each run status renders the correct text and styling hook.
- Failed runs prefer a concise error summary while preserving task metadata.
- Long error content is escaped and visually truncatable.
- The non-action row content links to the run detail route.
- Retryable rows render a separate POST form without invalid nested
  interactive markup.
- Empty and Load more states render correctly.

### Route tests

- Agent updates include values submitted from right-pane controls.
- Validation failures preserve right-pane values and errors.
- Run ordering, limits, total count, detail routes, and retry routes remain
  unchanged.

### Browser verification

- Desktop center-pane density matches the approved compact direction.
- Right-pane editing and header Save work together.
- Narrow-screen property drawer preserves all controls.
- Mobile rows do not overflow and retain usable touch targets.
- Keyboard navigation reaches the row link, Retry, Save, and property controls
  in a predictable order.

## 11. Rollout and Compatibility

The change is a server-rendered information-architecture correction. It requires
no data migration and does not alter existing Agent or task-run files. Existing
URLs, form actions, retry behavior, and bounded `runs` query parameters remain
compatible.
