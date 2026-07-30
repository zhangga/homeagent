# Feishu Connection Closure Design

**Date:** 2026-07-30
**Status:** Approved for implementation planning

## Context

HomeAgent already has the pieces of a complete Feishu connection lifecycle:

- verified Bot setup;
- full-group-message capability detection;
- runtime and event-consumer health;
- Bot-visible group discovery;
- in-group administrator confirmation;
- durable group bindings;
- explicit outbound test messages;
- disconnect and reconnect behavior.

These pieces currently appear as separate controls and badges. An operator can
complete the connection, but the page does not say which step is blocking
progress, what the single best next action is, or when one group has been
verified end to end. External changes such as an administrator confirming in
the group also require a manual page reload before the page reflects the new
state.

P0 made degraded Bot, permission, and runtime states truthful and actionable.
This P1 change turns those existing states into a lightweight connection
closure without introducing a second workflow database or a multi-page wizard.

## Decision

Add a derived, read-only connection-progress model. It composes existing Bot,
capability, runtime, binding, confirmation, and test state into:

- one Bot stage;
- one closure stage per group;
- current health independent from historical verification;
- one page-level next action;
- a polling decision.

The Integrations page will render a compact next-step card above the existing
Bot and group controls. While work or a current health incident remains, a
small browser script will poll an authenticated, read-only progress endpoint
and update dedicated status/action slots without reloading the page or
overwriting forms.

No new workflow state is persisted. Existing binding state and successful-test
evidence remain the source of truth across process restarts.

## Goals

- Make the next required action unambiguous.
- Define completion independently for each connected group.
- Reflect administrator confirmation and runtime recovery without a full-page
  refresh.
- Require an explicit, operator-triggered successful test message before a
  group is called complete.
- Preserve successful verification evidence while showing current runtime
  degradation separately.
- Keep the current server-rendered page, routes, security boundaries, and
  single-current-Bot model.

## Non-goals

- Persisting connection sessions, workflow events, or analytics.
- Automatically sending a test message after administrator confirmation.
- Automatically granting, publishing, or modifying Feishu permissions.
- Multiple active Bots, credential profiles, or Bot hot switching.
- Replacing the existing group-management forms with a multi-page wizard.
- Treating full-group-message permission as mandatory for mention-only use.
- Polling raw CLI output or exposing internal errors to the browser.

## Progress Model

Introduce a focused module whose public operation is conceptually:

```ts
deriveFeishuConnectionProgress(
  snapshot: FeishuIntegrationSnapshot,
): FeishuConnectionProgress
```

The derivation is pure. It does not call `lark-cli`, write binding state, send
messages, or repair the runtime.

The public model contains fixed enums and bounded public values:

```ts
type FeishuBotProgressStage =
  | "not_configured"
  | "not_verified"
  | "restart_required"
  | "runtime_unhealthy"
  | "ready";

type FeishuGroupProgressStage =
  | "waiting_confirmation"
  | "ready_to_test"
  | "complete"
  | "needs_reconnect"
  | "disconnected";

type FeishuProgressHealth = "healthy" | "limited" | "degraded";

type FeishuNextActionKind =
  | "connect_bot"
  | "verify_bot"
  | "restart_runtime"
  | "recover_runtime"
  | "connect_group"
  | "reconnect_group"
  | "test_group"
  | "wait_for_confirmation"
  | "none";

interface FeishuConnectionProgress {
  version: 1;
  revision: string;
  pollAfterMs?: number;
  bot: {
    stage: FeishuBotProgressStage;
    health: FeishuProgressHealth;
    capability: LarkCapabilityState;
  };
  groups: Array<{
    spaceId: SpaceId;
    stage: FeishuGroupProgressStage;
    health: FeishuProgressHealth;
    completedAt?: number;
  }>;
  nextAction: {
    kind: FeishuNextActionKind;
    spaceId?: SpaceId;
  };
}
```

The endpoint uses these public enum names and semantics. Internal helper types
can remain private. The response must not contain Bot secrets, access tokens,
raw CLI output, message content, consumer errors, arbitrary URLs, or arbitrary
HTML.

`revision` is a stable digest or equivalent deterministic value over public
progress fields. It lets the browser ignore unchanged and out-of-order
responses; it is not a durable sequence number.

## Bot Progress

Bot stage precedence is:

1. `not_configured` when no usable application configuration exists;
2. `not_verified` when configuration exists but Bot identity is not verified;
3. `restart_required` when the verified configured identity differs from the
   active connector identity;
4. `runtime_unhealthy` when the current identity is active but required
   consumers are not ready or have failed;
5. `ready` otherwise.

Full-group-message capability does not determine whether the base Bot
connection is complete. An `unavailable` or `unknown` capability makes Bot
health `limited`, retains the P0 recovery controls, and prevents new `smart` or
`all_messages` policies. Mention-only groups can still complete.

Runtime failure makes current health `degraded`. It does not delete group test
history.

## Per-group Closure

Each group is independent. One group completing does not complete or block
another group.

Group stages are derived as follows:

- `waiting_confirmation`: the current Bot has requested in-group administrator
  confirmation and the binding remains `pending_confirmation`;
- `ready_to_test`: the binding is active for the current Bot and does not have
  a successful test for that current activation;
- `complete`: the binding is active for the current Bot and its persisted last
  test status is `succeeded`;
- `needs_reconnect`: the binding belongs to a different Bot identity or the
  existing binding state explicitly requires reconnection;
- `disconnected`: the group is locally disconnected and is not an incomplete
  active connection.

A successful `testGroup` call remains the completion evidence. A failed later
test changes the persisted last-test status to `failed`, so the group returns
to `ready_to_test`. Temporary runtime failure leaves the historical completion
timestamp visible but overlays degraded current health.

Requesting confirmation for a different Bot or reconnecting uses the existing
binding transition, which clears stale test evidence. Therefore, a successful
test from a previous Bot or activation cannot complete the new connection.

The test remains explicit. Administrator confirmation never automatically
sends a message.

## Page-level Next Action

The next-step card provides one primary direction while leaving every existing
Bot and group control accessible below it.

The deterministic priority is:

1. configure or verify the Bot;
2. restart for a changed Bot identity;
3. recover an unhealthy runtime;
4. test the oldest active group in `ready_to_test`;
5. reconnect the oldest `needs_reconnect` group;
6. wait for the oldest `waiting_confirmation` group, with its existing resend
   option available in the group card;
7. connect a group when there is no current active, pending, or reconnecting
   group;
8. show a complete summary and no primary action when all current connected
   groups are complete and runtime health is normal.

Ties use `createdAt`, then `spaceId`, so the choice is stable.

Missing or unknown full-group-message capability is a visible limitation, not
a base-connection blocker. When all groups are otherwise complete, the page
shows permission recovery as a secondary action while retaining the completed
state.

Disconnected groups are excluded from the completion denominator. A page with
no current connected group is not complete.

## Presentation

Keep the current control-center information architecture:

1. compact next-step card;
2. current Bot card and its P0 recovery actions;
3. independent group cards;
4. secondary Bot settings.

The next-step card contains:

- a short current-stage label;
- the target Bot or group when applicable;
- one primary action or waiting instruction;
- Bot readiness and completed-group count.

Each group card exposes a stable closure-status area in every binding state.
The area can move from administrator confirmation, to test, to complete without
requiring the rest of the card to be replaced.

Successful verification and current health are visually separate. For example,
a group can show “verified on 2026-07-30” together with “current runtime
unhealthy.”

The page does not introduce a global linear stepper because multiple groups can
occupy different stages at the same time.

## Progress Endpoint

Add:

```text
GET /integrations/progress
```

The endpoint:

- uses the same administrator protection as the Integrations management page;
- returns `FeishuConnectionProgress` as JSON;
- sets `Cache-Control: no-store`;
- performs no writes or external mutations;
- returns only product-owned enums and bounded metadata;
- maps internal failures to a fixed public unavailable response or HTTP status
  without returning exception text.

The server reuses the integration snapshot inputs needed for progress, but
polling must not list Bot-visible chats because chat discovery is not needed
for closure. Bot-status probes use a single-flight five-second cache.
Capability probes use a single-flight thirty-second cache. Explicit P0
re-verification invalidates both caches before checking again. These bounds
prevent concurrent page views from creating an unbounded `lark-cli` process
rate.

If progress cannot be derived, the endpoint returns HTTP `503` with only:

```json
{
  "error": "temporarily_unavailable",
  "retryAfterMs": 10000
}
```

## Browser Polling

The server-rendered page includes a small framework-free controller:

- starts only when `pollAfterMs` is present;
- uses the server-provided five-second normal interval;
- never overlaps requests;
- aborts an individual request after four seconds;
- pauses while `document.visibilityState` is hidden;
- checks immediately when the page becomes visible;
- ignores a response older than the latest applied revision/request;
- stops when no polling interval is returned;
- keeps the current UI on network, timeout, parsing, or server failure;
- shows a product-owned refresh warning and retries after 5, 10, 20, then 30
  seconds on consecutive failures; later failures remain at 30 seconds.

The existing page pre-renders allowlisted status and action slots. The browser
controller uses enums to toggle those slots and updates text with `textContent`.
It does not evaluate server-provided HTML, construct arbitrary routes, or
replace the page or editable forms.

All mutating actions continue through the existing POST routes. Polling never
connects a group, resends confirmation, sends a test, restarts the service, or
changes settings.

## Data Flows

### Administrator confirms a group

1. The existing inbound administrator command changes the binding from
   `pending_confirmation` to `active`.
2. The next progress request derives `ready_to_test`.
3. The page updates the group closure area and makes that group the next action
   when no higher-priority blocker exists.
4. No test message is sent automatically.

### Operator sends a test

1. The existing test POST calls `FeishuIntegrationService.testGroup`.
2. Delivery success persists `lastTestStatus: "succeeded"` and `lastTestAt`.
3. The redirected page and subsequent progress responses derive `complete`.
4. Delivery failure persists `failed`, keeps the group `ready_to_test`, and
   surfaces only the existing bounded product error.

### Runtime fails after completion

1. Successful group-test evidence remains persisted.
2. Bot and group current health become degraded.
3. The next action points to runtime recovery.
4. After recovery, polling restores healthy presentation without requiring
   another test.

### Bot identity changes

1. The page first derives `restart_required`.
2. Existing bindings for the old application derive `needs_reconnect`.
3. After restart, each affected group must repeat administrator confirmation
   and the explicit test.
4. Prior knowledge, tasks, reminders, and learning state remain untouched.

## Error Handling and Security

- A progress-derivation failure is `unknown`/unavailable, never success.
- A polling failure never clears a prior successful-test record in the UI.
- Invalid or unrecognized enum values are ignored by the browser and trigger
  the fixed refresh warning.
- Internal exception text, consumer `lastError`, CLI stdout/stderr, App Secret,
  tokens, and message content never appear in the endpoint or DOM.
- The endpoint cannot accept a chat ID, application ID, route, or command from
  the browser.
- Existing allowlisted redirect and form-handling rules remain unchanged.
- A slow request is aborted before the next retry; requests do not accumulate.

## Testing

### Pure progress tests

Use a table of snapshots to cover:

- every Bot stage and precedence;
- every group stage;
- stable tie-breaking for the next action;
- multiple groups at different stages;
- no-group behavior;
- successful historical test plus current runtime failure;
- failed later test returning a group to `ready_to_test`;
- Bot change and reconnect invalidating old completion;
- missing full-group-message capability allowing mention-only completion;
- capability limitations degrading advanced response modes without erasing
  completion.

### Service and route tests

- The progress endpoint requires management authentication.
- It sets `Cache-Control: no-store`.
- It performs no binding write, message send, group connection, or restart.
- Its response contains no injected raw CLI or consumer error.
- Concurrent progress reads share bounded setup probes.
- Explicit Bot verification refreshes stale capability/Bot probe state.

### Web tests

- The next-step card renders the correct initial action.
- Each group card contains stable closure slots.
- Confirmation-to-test and test-to-complete responses expose the correct
  transition.
- Completion history and current degradation render simultaneously.
- Full-message capability remains a limitation rather than a mention-only
  blocker.
- The polling controller pauses when hidden, avoids overlap, stops on
  completion, ignores stale responses, and backs off on failure.
- Editable group forms are not replaced during polling.

### Regression

Run connector setup tests, Feishu integration-service tests, Web application
tests, binding-store tests, runtime tests, TypeScript type checking, and the
existing Feishu soak harness. A supervised real-group run should verify:

1. request administrator confirmation;
2. observe automatic transition to test-ready;
3. explicitly send the test;
4. observe per-group completion;
5. stop and recover consumers without losing the completion timestamp;
6. disconnect and reconnect the group, then require a new test.

## Acceptance Criteria

- The page always provides at most one primary next action.
- Bot and group state update without a full-page refresh while closure or
  recovery remains in progress.
- Each group completes independently only after administrator confirmation and
  an explicit successful test.
- Completion history survives process restart and temporary runtime failure.
- A changed Bot or reconnected group cannot reuse stale test evidence.
- Mention-only connection can complete without full-group-message permission.
- Polling stops when all current groups are complete and current runtime health
  is normal.
- Polling never performs a write and never exposes credentials, raw diagnostics,
  consumer errors, or message content.
- Existing group settings, disconnect/reconnect semantics, knowledge retention,
  private messages, attachments, tasks, reminders, and learning behavior do not
  regress.
