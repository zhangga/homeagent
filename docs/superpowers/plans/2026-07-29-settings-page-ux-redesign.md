# Settings Page UX Redesign Implementation Plan

> **Design spec:** `docs/superpowers/specs/2026-07-29-settings-page-ux-redesign-design.md`

**Goal:** Turn the existing global settings form into an accessible,
responsive, validation-safe workflow while preserving HomeAgent's
server-rendered Hono architecture and persisted configuration format.

**Architecture:** Keep `GET /settings` and `POST /settings` as the public
interface. Render one form with three semantic sections, validate the complete
POST before persisting, and use small progressive-enhancement scripts for dirty
state and the narrow-screen navigation drawer. Shared shell CSS handles
responsive behavior; no frontend dependency or client-side state store is
introduced.

**Tech stack:** Bun, TypeScript, Hono HTML templates, plain CSS and DOM, Bun
test.

## Delivery Rules

- Work in vertical RED→GREEN slices through HTTP route behavior.
- Preserve every unrelated working-tree change, especially current Feishu
  edits in `app.ts`, `views.ts`, `app.test.ts`, and adjacent modules.
- Do not change `settings.json` shape or Provider/Model resolution semantics.
- Keep JavaScript as progressive enhancement.
- Do not add the deferred icon-system or Prompts work.

## Task 1: Accessible Settings Structure

**Files:**

- Modify: `packages/web/src/app.test.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/layout.ts`

1. Add one GET-route test for the three semantic groups, associated labels,
   helper references, truthful impact text, Cancel/Save controls, and
   progressive-enhancement hook.
2. Run the focused test and verify RED.
3. Render the three sections, hourly select, units, helper text, accessible
   flash status, and dirty-form script.
4. Add only the shared styles required by the new markup.
5. Rerun the focused test and verify GREEN.

## Task 2: Whole-Payload Validation

**Files:**

- Modify: `packages/web/src/app.test.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/views.ts`

1. Add one route test proving an invalid numeric payload returns 400, preserves
   all submitted values, renders field errors, and does not persist any part of
   the request.
2. Run the focused test and verify RED.
3. Add a small settings-form parser that returns either a complete
   `PersistedSettings` patch or submitted values plus per-field errors.
4. Re-render the settings page on error with an accessible summary and inline
   messages.
5. Rerun the focused test and verify GREEN.
6. Add focused boundary cases for budget, hour, retention, and port one at a
   time, implementing only behavior required by each new test.

## Task 3: Responsive Navigation Shell

**Files:**

- Modify: `packages/web/src/app.test.ts`
- Modify: `packages/web/src/layout.ts`

1. Add one GET-route test for the navigation trigger, drawer relationship,
   scrim, and keyboard-capable script.
2. Run the focused test and verify RED.
3. Add the narrow-screen top bar, off-canvas rail, ARIA state, Escape/scrim
   close behavior, focus return, inert content, and reduced-motion CSS.
4. Collapse two-column form grids below 720 px and enforce touch-friendly
   control sizes.
5. Rerun the focused test and verify GREEN.

## Task 4: Regression and Browser Verification

1. Run focused Web tests covering settings and layout.
2. Run the complete Web test file.
3. Run the repository typecheck.
4. Inspect the final diff and confirm unrelated edits are unchanged.
5. Verify the live page at desktop, around 900 px, and 375 × 812.
6. Verify no horizontal overflow, keyboard navigation, dirty/reset/submit
   states, validation feedback, and reduced-motion fallback.
