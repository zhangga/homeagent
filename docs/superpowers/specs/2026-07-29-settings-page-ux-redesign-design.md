# HomeAgent Settings Page UX Redesign

**Date:** 2026-07-29

**Status:** Approved direction; awaiting written-spec review

**Reference:** Mew workspace settings at `mew.bytedance.net`

## 1. Context

HomeAgent's global settings page currently exposes the correct configuration
surface—default Provider and Model, daily budget, distillation hour, raw-message
retention, and the Web port—but presents all fields in one card. The save button
is always active, field help is compressed into labels, invalid numeric input is
partly corrected silently, and the global shell is not usable on a 375 px
viewport because the fixed 220 px navigation rail leaves too little width for
the two-column form.

Mew demonstrates useful settings patterns: clear semantic grouping, persistent
impact descriptions, disabled save/cancel actions until a change exists, and
scenario-specific configuration. This redesign adopts those interaction
principles without copying Mew's second sidebar or its desktop whitespace.

The implementation remains server-rendered Hono HTML with plain CSS and a small
progressive-enhancement DOM script.

## 2. Goals

- Make the settings page usable without horizontal scrolling at 375 px.
- Give every form control a visible, programmatically associated label and
  persistent help text.
- Organize the six settings into three understandable sections.
- Keep Cancel and Save disabled until the form differs from its initial state.
- Warn before discarding unsaved changes and prevent duplicate submissions.
- Show validation errors beside the relevant fields while preserving submitted
  values.
- Explain immediate, scheduled, and restart-required effects truthfully.
- Preserve the current routes, persistence format, provider discovery behavior,
  and server-rendered architecture.

## 3. Non-goals

This work does not:

- add a Mew-style secondary settings sidebar;
- add workspace members, cloud images, prompt templates, or other new settings;
- replace the global navigation icon set;
- introduce a frontend framework, client-side router, or autosave;
- change the persisted configuration schema;
- change Provider/Model resolution semantics;
- redesign unrelated management pages beyond the responsive navigation shell
  needed to make them reachable on narrow screens.

## 4. Considered Approaches

### A. Minimal accessibility and CSS patch

Associate labels, collapse the settings grid, and leave the rest of the page
unchanged.

This is the smallest change, but it leaves weak information hierarchy, an
always-active save action, silent validation behavior, and the fixed navigation
rail problem.

### B. Focused settings workflow redesign — chosen

Keep one route and one form, split it into three semantic sections, add a small
dirty-form controller, render field-level validation, and make the global rail
an accessible drawer on narrow screens.

This provides the largest usability improvement without adding a frontend
framework or changing the configuration model.

### C. Full Mew-style settings area

Add a second sidebar, separate routes for each setting category, and future
Prompts-style editors.

The current six fields do not justify the additional navigation and route
complexity. It would also consume scarce width on smaller desktop screens.

## 5. Information Architecture

The page keeps the existing title and short global description, followed by one
form containing three sections.

### 5.1 Default Agent

- **Default Provider**
  - Existing detected CLI options and availability behavior remain.
  - Help text explains that this Provider is used only when an Agent does not
    override it.
- **Default Model**
  - Continues to update when Provider changes.
  - Help text explains that the empty choice delegates to the CLI default.

### 5.2 Runtime Policy

- **Daily budget**
  - Numeric input, minimum 0, with a visible `USD / day` unit.
  - Help text explains that the limit affects only billable Providers.
- **Distillation time**
  - A native select containing 24 hourly choices, rendered as `00:00` through
    `23:00`.
  - `Asia/Shanghai` appears as persistent help text.
  - The submitted value remains the existing integer hour.

### 5.3 Data and System

- **Raw-message retention**
  - Integer input with a visible `days` unit.
  - Help text states that `0` means permanent retention and only distilled raw
    messages are cleaned.
- **Web port**
  - Integer input constrained to 1–65535.
  - A text badge says `Restart required`; color is supplementary, not the only
    signal.
  - Help text states that saving does not restart the service.

Section headings and descriptions establish hierarchy. The form remains one
transaction: the user saves or cancels all changed values together.

## 6. Form Interaction

### 6.1 Initial and dirty states

- Cancel and Save are disabled on initial render.
- Input and change events compare the form's current successful controls with a
  captured initial snapshot.
- When values differ, both actions become enabled.
- Reset returns all native controls to their server-rendered defaults and
  recomputes the clean state.
- If JavaScript is unavailable, Save remains usable through progressive
  enhancement rather than leaving the form permanently disabled.

The no-JavaScript fallback is implemented by rendering Save normally and having
the enhancement script opt the form into managed disabled states after it
initializes.

### 6.2 Submission

- On valid submit, the Save button becomes disabled and reads `Saving…`.
- The form is allowed to perform its normal POST.
- A successful POST keeps the current redirect-after-post behavior.
- The success message is announced through an `aria-live="polite"` region and
  remains visually concise.

### 6.3 Unsaved navigation

- While dirty, `beforeunload` protects refresh, tab close, and external
  navigation.
- Submitting the form clears the dirty flag before navigation.
- Resetting the form clears the dirty flag.
- No custom confirmation wording is assumed because browsers control the
  `beforeunload` message.

## 7. Validation and Error Handling

The POST route validates the complete payload before calling `saveSettings`.
Invalid requests do not persist a partial patch.

Validation rules:

- Provider and Model retain current parsing and compatibility behavior.
- Daily budget must be finite and at least 0.
- Distillation hour must be an integer from 0 through 23.
- Raw-message retention must be an integer from 0 through 36,500.
- Web port must be an integer from 1 through 65,535.

On validation failure:

- return HTTP 400 with the settings page;
- preserve the user's submitted values;
- render an error summary above the form;
- render a specific message beneath each invalid control;
- connect each message with `aria-describedby`;
- mark invalid controls with `aria-invalid="true"`;
- focus the error summary after the response loads using `autofocus` on a
  programmatically focusable summary.

Error messages state both the problem and the valid range. Values are not
silently clamped.

## 8. Responsive Navigation and Layout

### Desktop: above 900 px

- Keep the existing 220 px dark navigation rail.
- Keep the settings content at the existing readable maximum width.
- Default Agent may use two columns.
- Runtime Policy and Data and System may use two columns where space permits.

### Narrow screens: 900 px and below

- Replace the persistent rail with a compact top bar containing the HomeAgent
  brand and a `Navigation` button.
- The existing rail becomes an off-canvas drawer.
- The button exposes `aria-expanded` and `aria-controls`.
- Opening the drawer shows a scrim; clicking the scrim or pressing Escape
  closes it.
- Closing returns focus to the trigger.
- The drawer does not trap focus because its contents are a short navigation
  list and the scrim makes the rest of the page inert only while open.
- Content takes the full viewport width with 16–20 px adaptive gutters.

### Form layout: 720 px and below

- Every two-column settings group becomes one column.
- Inputs and buttons have a minimum 44 px interactive height.
- Units wrap without forcing horizontal overflow.
- The action row remains visible in document flow; it is not fixed over content.

The redesign must produce
`document.documentElement.scrollWidth === window.innerWidth` at 375 px for the
settings page.

## 9. Accessibility

- Every control has a unique ID and a `label[for]`.
- Section groups use `fieldset` and `legend` where the semantics fit.
- Help and error text are connected through `aria-describedby`.
- Error state uses text and semantics in addition to color.
- Focus rings remain visible.
- Disabled actions use both native `disabled` state and a distinct visual state.
- Navigation drawer state is announced and keyboard operable.
- Success feedback uses a polite live region and does not steal focus.
- Heading order remains sequential.
- Motion is limited to short opacity/transform drawer transitions and respects
  `prefers-reduced-motion`.

## 10. Code Boundaries

### `packages/web/src/views.ts`

- Expand the settings view model to accept submitted string values and per-field
  errors.
- Render the three sections, associated labels, help text, error summary, action
  row, and page-scoped dirty-form script.
- Keep Hono escaping for all submitted values and error text.

### `packages/web/src/app.ts`

- Parse and validate the complete settings payload.
- On error, re-render the settings page with status 400 and no persistence.
- On success, persist once and retain redirect-after-post.

### `packages/web/src/layout.ts`

- Add the responsive navigation trigger, drawer semantics, scrim, and small
  progressive-enhancement script.
- Add shared responsive form and disabled-state rules.
- Preserve the existing desktop rail and active-route rendering.

No new runtime dependency or persisted browser state is required.

## 11. Testing

### View and route tests

- Settings controls render associated `for`/`id` pairs.
- Help IDs and `aria-describedby` references are present.
- Three section legends and truthful effect descriptions render.
- Managed Cancel and Save controls and the dirty-form script render.
- Valid POST persists all values and redirects.
- Invalid budget, hour, retention, and port values each return 400.
- Invalid POST preserves submitted values and writes nothing.
- Error summary and field-level accessible errors render.
- Existing custom Provider/Model behavior remains readable.

### Layout tests

- Mobile navigation trigger has correct ARIA relationships.
- Desktop rail markup and active route remain unchanged.
- Drawer script supports toggle, scrim click, and Escape.

### Browser verification

- Desktop settings layout at 1440 px and 1920 px.
- Tablet layout around 900 px.
- 375 × 812 mobile layout with no horizontal overflow.
- Keyboard traversal through navigation, fields, Cancel, and Save.
- Dirty/clean transitions, reset, submit loading state, and navigation warning.
- Success and validation-error feedback.
- Reduced-motion behavior for the drawer.

## 12. Rollout and Compatibility

- Existing `settings.json` files require no migration.
- Existing GET and POST route URLs remain unchanged.
- JavaScript is an enhancement: server submission still works without it.
- The responsive navigation change applies to the shared management shell, but
  does not change page content or routes.
- Unrelated in-progress Feishu and Agent work must remain untouched.
