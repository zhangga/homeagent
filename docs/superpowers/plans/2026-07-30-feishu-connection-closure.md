# Feishu Connection Closure Implementation Plan

> **Design spec:** `docs/superpowers/specs/2026-07-30-feishu-connection-closure-design.md`

**Goal:** Add a derived, per-group Feishu connection closure with one next
action and non-disruptive progress polling.

**Architecture:** Keep binding and test records as the only durable truth. Add
a pure progress derivation module, a bounded cached read method on
`FeishuIntegrationService`, an authenticated JSON endpoint, stable
server-rendered progress slots, and a small framework-free polling controller.
Every mutation continues through existing POST routes.

**Stack:** TypeScript, Bun, Hono, server-rendered HTML, existing JSON binding
store, Bun test.

**Working-tree constraint:** Preserve unrelated Skill Catalog and provider
changes. Stage or commit only files listed in this plan.

## Task 1: Derive Bot and Per-group Progress

**Files**

- Create: `packages/web/src/feishu-connection-progress.ts`
- Create: `packages/web/src/feishu-connection-progress.test.ts`
- Modify: `packages/web/src/index.ts`

### Step 1: Write the failing table tests

Cover:

- Bot stage precedence:
  `not_configured`, `not_verified`, `restart_required`,
  `runtime_unhealthy`, `ready`;
- group stages:
  `waiting_confirmation`, `ready_to_test`, `complete`,
  `needs_reconnect`, `disconnected`;
- successful test plus runtime failure keeps `complete` and changes only health;
- a failed latest test returns to `ready_to_test`;
- missing full-group-message capability keeps mention-only completion valid;
- no current group is incomplete rather than complete;
- disconnected groups do not enter the completion denominator;
- deterministic `createdAt`, then `spaceId` tie-breaking;
- page-level next-action priority;
- unchanged public progress produces the same `revision`;
- polling stops only when there is at least one current group, every current
  group is complete, and runtime health is normal.

Run:

```powershell
bun test packages/web/src/feishu-connection-progress.test.ts
```

Expected: RED because the module does not exist.

### Step 2: Implement the smallest pure model

Export the fixed public enums, `FeishuConnectionProgress`, a narrow
`FeishuConnectionProgressInput`, and:

```ts
deriveFeishuConnectionProgress(
  input: FeishuConnectionProgressInput,
): FeishuConnectionProgress
```

Use only bounded product-owned fields in `revision`. Do not hash raw error
strings or secrets. Set `version: 1` and `pollAfterMs: 5000` only while polling
is useful.

### Step 3: Make the table green

Run the focused test until it passes, then run:

```powershell
bun run typecheck
```

## Task 2: Add a Bounded Progress Read Boundary

**Files**

- Modify: `packages/web/src/feishu-integration-service.ts`
- Modify: `packages/web/src/feishu-integration-service.test.ts`

### Step 1: Write failing service tests

Add tests proving:

1. `progress()` returns the pure derived model.
2. It reads bindings, verified Bot identity, active identity, runtime, and
   capability without calling `listBotChats`.
3. Concurrent reads share one in-flight Bot-status probe and one capability
   probe.
4. Bot status is cached for 5 seconds.
5. capability is cached for 30 seconds.
6. `invalidateProgressProbes()` clears both caches.
7. internal probe failure rejects with a fixed service error and never includes
   injected private text.

Inject a clock into the service options rather than using real sleeps.

Run:

```powershell
bun test packages/web/src/feishu-integration-service.test.ts
```

Expected: RED for the missing progress API.

### Step 2: Implement single-flight TTL probes

Add private cached promises that:

- cache successful Bot status for 5 seconds;
- cache successful capability results for 30 seconds;
- share an in-flight promise;
- clear a failed promise immediately so a later request can retry;
- never cache or expose raw exception text.

Build progress group input directly from `engine.feishuBindings.list()`. Reuse
the same current-App mismatch rule as `snapshot()`, ideally through one focused
private helper so the two read paths cannot diverge.

Add:

```ts
progress(): Promise<FeishuConnectionProgress>
invalidateProgressProbes(): void
```

### Step 3: Run service and derivation tests

```powershell
bun test packages/web/src/feishu-connection-progress.test.ts packages/web/src/feishu-integration-service.test.ts
```

## Task 3: Expose the Authenticated Read-only Endpoint

**Files**

- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`

### Step 1: Write failing route tests

Cover:

- `GET /integrations/progress` returns versioned JSON and
  `Cache-Control: no-store`;
- the existing management token protects it;
- the response omits Bot secrets, raw CLI output, consumer `lastError`, and
  injected private exception text;
- a service failure returns only:

  ```json
  {"error":"temporarily_unavailable","retryAfterMs":10000}
  ```

  with HTTP `503`;
- GET does not change binding files, send a message, reconnect a group, or
  restart the runtime;
- `POST /integrations/bot/verify` invalidates progress probes before the next
  read.

Run the relevant tests by name first:

```powershell
bun test packages/web/src/app.test.ts --test-name-pattern "integration progress"
```

### Step 2: Add the route and invalidation call

Return `c.json(progress)` from the service. Keep the response contract fixed and
sanitize the failure path. Do not accept query parameters for chat, app, route,
or command selection.

Call `invalidateProgressProbes()` after explicit Bot verification, including a
failed verification, so the next progress read cannot reuse stale status.

### Step 3: Run route and service tests

```powershell
bun test packages/web/src/app.test.ts packages/web/src/feishu-integration-service.test.ts
```

## Task 4: Render the Next-step Card and Stable Group Slots

**Files**

- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`

### Step 1: Write failing HTML assertions

Using existing integration test fixtures, assert:

- the page renders exactly one primary next-step region;
- a Bot blocker wins over group work;
- an active untested group produces “发送测试消息”;
- a completed group shows its persisted completion time;
- a completed group plus runtime failure shows both historical completion and
  current degradation;
- a pending group exposes stable stage, description, and action slots;
- missing full-message capability appears as a limitation but does not replace
  the test/complete step for a mention-only group;
- no raw error appears in HTML;
- every group card has a stable `data-space-id` and closure slot;
- editable group forms keep their existing names, actions, and values.

Run:

```powershell
bun test packages/web/src/app.test.ts --test-name-pattern "connection closure"
```

### Step 2: Render from the same pure model

For the initial full-page response, derive progress from the already loaded
integration snapshot. Do not trigger a second Bot/capability probe.

Add the compact top card before the existing Bot card. Add fixed, hidden
allowlisted action blocks and status text slots. For per-group actions:

- top-level actions target an existing control or scroll to a group card;
- test, reconnect, and confirmation actions remain ordinary server-rendered
  forms using existing POST routes;
- the browser never receives a route to evaluate.

Keep the current group settings form and More Bot settings unchanged.

### Step 3: Make the focused Web tests green

Run the filtered tests, then the full `app.test.ts`.

## Task 5: Add the Framework-free Polling Controller

**Files**

- Create: `packages/web/src/feishu-progress-client.ts`
- Create: `packages/web/src/feishu-progress-client.test.ts`
- Modify: `packages/web/src/views.ts`

### Step 1: Test scheduling and application through injected adapters

Keep the controller independent of a browser DOM by accepting small adapters
for:

- fetch progress;
- apply progress enums to slots;
- visibility reads/subscription;
- timeout scheduling/cancellation;
- current monotonic request ID.

Test:

- first poll after 5 seconds;
- no overlapping fetches;
- four-second request abort;
- pause while hidden and immediate fetch when visible;
- successful application schedules the server-provided next interval;
- absent `pollAfterMs` stops;
- consecutive failures use 5, 10, 20, 30, 30 seconds;
- stale request IDs are ignored;
- malformed enum or response triggers the fixed refresh warning;
- applying progress does not replace or write to an editable-form adapter.

Run:

```powershell
bun test packages/web/src/feishu-progress-client.test.ts
```

### Step 2: Implement the controller and a thin DOM adapter

The controller owns scheduling only. The DOM adapter:

- updates `textContent`, badges, hidden flags, and counts;
- toggles only pre-rendered allowlisted action blocks;
- resolves a `spaceId` only against an existing `data-space-id` element;
- never sets `innerHTML`, form actions, external URLs, or input values;
- displays the fixed refresh warning on failure.

Render the bootstrap script only on the Integrations page and start it from the
initial progress object. Escape the serialized JSON for an inline script
context.

### Step 3: Run controller and Web tests

```powershell
bun test packages/web/src/feishu-progress-client.test.ts packages/web/src/app.test.ts
```

## Task 6: Regression and Release Evidence

**Files**

- Modify only if required by discovered regression:
  `scripts/soak-feishu-e2e.ts`
- Modify only if required:
  `scripts/soak-feishu-e2e.test.ts`

### Step 1: Run the focused Feishu regression

```powershell
bun test packages/core/src/feishu-bindings.test.ts packages/connectors/src/lark-setup.test.ts packages/connectors/src/feishu.test.ts packages/web/src/feishu-connection-progress.test.ts packages/web/src/feishu-progress-client.test.ts packages/web/src/feishu-integration-service.test.ts packages/web/src/app.test.ts
```

### Step 2: Run static and full checks

```powershell
bun run typecheck
bun test
bun run verify:beta
git diff --check
```

If a repository-wide failure is unrelated to P1, record the exact command,
failure, and affected existing file. Do not modify unrelated Skill Catalog or
provider work to make this branch green.

### Step 3: Run the deterministic soak harness tests

```powershell
bun test scripts/soak-feishu-e2e.test.ts scripts/soak-runtime.test.ts
```

### Step 4: Leave the supervised real-group gate explicit

A real Feishu run requires an operator-provided test group and intentionally
sends messages and changes connection state. Do not run it without that scope.
When supplied, verify:

1. request administrator confirmation;
2. observe polling move the group to test-ready;
3. click the explicit test action;
4. observe completion;
5. recover a stopped consumer without losing completion evidence;
6. disconnect/reconnect and verify a new test is required.

## Final Review

- Review only P1 files with `git diff -- <paths>`.
- Confirm no credential, token, raw CLI result, consumer error, or message
  content appears in JSON or HTML fixtures.
- Confirm no polling GET path mutates local or external state.
- Confirm unrelated working-tree changes remain untouched and unstaged.
- Report targeted/full verification separately from the supervised real Feishu
  gate.
