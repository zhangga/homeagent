# Feishu Integration Configuration Implementation Plan

> **Design spec:** `docs/superpowers/specs/2026-07-29-feishu-integration-configuration-design.md`

**Goal:** Turn the current Feishu Integrations page into a single-current-bot
configuration center with explicit group discovery, connect, edit, test,
disconnect, and reconnect behavior, while preserving knowledge and enforcing
that unconnected groups are neither captured nor answered.

**Architecture:** Add a versioned Feishu group-binding repository owned by
`KnowledgeEngine`. Reuse `LarkCliSetup` as the bounded Bot administration
adapter for chat discovery, membership verification, and capability checks.
Put orchestration in a `FeishuIntegrationService` used by Web routes, and make
the Orchestrator consult the binding repository before any group command,
capture, attachment processing, classification, or reply. Keep one configured
Bot; replacement and reactivation still require restart.

**Tech stack:** Bun, TypeScript, Hono, existing `lark-cli` subprocess runner,
JSON configuration under `data/config`, Bun test, existing Feishu soak harness.

## Delivery Rules

- Follow red-green-refactor within each task: add the focused failing test,
  observe the expected failure, implement the minimum behavior, then run the
  focused suite again.
- Do not store App Secret, tenant/user tokens, raw CLI output, message content,
  or unbounded errors in the binding file or health read model.
- Do not implement Bot disconnect with `lark-cli config remove`; it clears the
  complete application configuration and user authorization. Bot disconnect is
  a HomeAgent-local disable.
- Do not remove legacy `SpaceMeta` reply fields in this change. Migrate and stop
  writing them, then clean them up in a later compatibility change.
- Do not add multi-Bot routing or Bot hot switching.
- Preserve unrelated working-tree changes if implementation starts from a dirty
  tree.

## Task 1: Add the Versioned Group-Binding Domain and Store

**Files:**

- Create: `packages/core/src/feishu-bindings.ts`
- Create: `packages/core/src/feishu-bindings.test.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/index.ts`

### Step 1: Write the store and migration contract tests

Cover these cases in `feishu-bindings.test.ts`:

1. A new store has schema version `1` and no bindings.
2. `connect` creates one active binding keyed uniquely by both `chatId` and
   team `spaceId`.
3. Repeating the same connect is idempotent.
4. Reconnecting a disconnected binding preserves `createdAt`, updates
   `boundAppId`, and returns it to `active`.
5. Disconnecting is idempotent and does not touch the corresponding workspace.
6. Marking an app replaced moves only that app's active bindings to
   `needs_reconnect`.
7. Test success and failure persist bounded status; failure text is normalized
   and truncated.
8. A corrupt or unsupported-version file throws instead of silently appearing
   empty.
9. Persistence writes a complete versioned file through a same-directory
   temporary file and atomic replacement.
10. Migration maps legacy settings exactly:
    - `mentionsOnly === false` with no participation level ->
      `all_messages`;
    - an existing participation level -> `smart` with the same level;
    - remaining current team configurations -> `smart` + `balanced`;
    - unset `replyInThread` -> `true`.
11. Migration binds to a verified current app when available; otherwise it
    leaves `boundAppId` absent and uses `needs_reconnect`.
12. Repeating migration does not duplicate or overwrite post-migration edits.

Use temporary data directories and real files. Include a filesystem seam only
where needed to force an atomic-replacement failure.

### Step 2: Run the focused test and verify RED

```powershell
bun test packages/core/src/feishu-bindings.test.ts
```

Expected: fail because the binding types and store do not exist.

### Step 3: Implement the binding model

Export:

```ts
export type FeishuGroupBindingState =
  | "active"
  | "disconnected"
  | "needs_reconnect";

export type FeishuResponseMode =
  | "mentions_only"
  | "smart"
  | "all_messages";

export interface FeishuGroupBinding {
  chatId: string;
  spaceId: SpaceId;
  boundAppId?: string;
  state: FeishuGroupBindingState;
  responseMode: FeishuResponseMode;
  participationLevel?: GroupParticipationLevel;
  replyInThread: boolean;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
  lastTestAt?: number;
  lastTestStatus?: "succeeded" | "failed";
  lastError?: string;
}
```

Implement `FeishuGroupBindingStore` with focused methods rather than exposing
its internal array:

- `list()`
- `getByChatId(chatId)`
- `getBySpace(spaceId)`
- `activeByChatId(chatId)`
- `connect(input)`
- `updatePolicy(spaceId, patch)`
- `disconnect(spaceId)`
- `markAppNeedsReconnect(appId)`
- `recordTest(spaceId, result)`
- `migrateLegacy(spaces, currentAppId?)`

Use `data/config/feishu-group-bindings.json`. Reject duplicate chat/space
records and invalid team space IDs when reading. Sort persisted bindings by
`chatId` for deterministic diffs and tests.

Add `readonly feishuBindings` to `KnowledgeEngine`, constructed from the same
`dataDir`, and export the new module from `packages/core/src/index.ts`.

### Step 4: Run the focused and nearby core suites

```powershell
bun test packages/core/src/feishu-bindings.test.ts packages/core/src/space.test.ts packages/core/src/agents.test.ts
bun run typecheck
```

Expected: pass.

### Step 5: Suggested commit

```powershell
git add packages/core/src/feishu-bindings.ts packages/core/src/feishu-bindings.test.ts packages/core/src/engine.ts packages/core/src/index.ts
git commit -m "feat: add Feishu group binding store"
```

## Task 2: Add Bounded Bot Chat Discovery and Capability Checks

**Files:**

- Modify: `packages/shared/src/lark.ts`
- Modify: `packages/connectors/src/lark-setup.ts`
- Modify: `packages/connectors/src/lark-setup.test.ts`
- Modify: `packages/web/src/integrations.ts`

### Step 1: Write connector contract tests

Add tests for:

1. `listBotChats` invokes:

   ```text
   lark-cli im +chat-list --as bot --page-size 100 --json
   ```

2. Pagination passes the returned `page_token`, rejects a repeated token, and
   has a hard page limit.
3. `{ chats: null }` normalizes to an empty list.
4. Only safe public fields are returned: `chatId`, `name`, `description`,
   `external`, `ownerId`, and optional timestamps.
5. Malformed, missing, or duplicate chat IDs fail the call without exposing raw
   output.
6. `getBotChat` invokes:

   ```text
   lark-cli im chats get --chat-id <id> --as bot --json
   ```

7. A non-member/not-found response becomes `undefined`; private diagnostics do
   not enter the returned error.
8. Full group-message capability invokes:

   ```text
   lark-cli auth check --scope im:message.group_msg --json
   ```

9. Exit `0` with granted scope maps to `available`.
10. A nonzero exit with valid structured `missing` data maps to `unavailable`.
11. Parse failure, timeout, or an ambiguous response maps to `unknown`.
12. `_notice` update metadata is ignored.

### Step 2: Run the connector test and verify RED

```powershell
bun test packages/connectors/src/lark-setup.test.ts
```

Expected: fail because the administration methods do not exist.

### Step 3: Add shared value types and extend the setup port

Add to `packages/shared/src/lark.ts`:

```ts
export interface LarkChatSummary {
  chatId: string;
  name: string;
  description?: string;
  external?: boolean;
  ownerId?: string;
}

export type LarkCapabilityState =
  | "available"
  | "unavailable"
  | "unknown";
```

Extend the Web-side `LarkSetupPort` structurally with:

- `listBotChats?(): Promise<LarkChatSummary[]>`
- `getBotChat?(chatId: string): Promise<LarkChatSummary | undefined>`
- `fullGroupMessageCapability?(): Promise<LarkCapabilityState>`

Keep them optional until production assembly and existing tests are migrated.

### Step 4: Implement bounded methods in `LarkCliSetup`

Reuse `LarkSetupCommandRunner`; do not create a second subprocess executor.

For list pagination:

- use page size `100`;
- accept only nonempty opaque page tokens from structured output;
- track seen tokens;
- stop at `has_more === false`;
- cap at 100 pages;
- deduplicate by `chatId`;
- return chats sorted by display name then chat ID.

For capability checks, parse valid structured output even when the process exit
code is nonzero. Never surface the CLI suggestion verbatim; the UI will provide
its own app-scoped repair guidance.

### Step 5: Run connector and type tests

```powershell
bun test packages/connectors/src/lark-setup.test.ts packages/connectors/src/lark-app-registration.test.ts packages/shared/src/config.test.ts
bun run typecheck
```

Expected: pass.

### Step 6: Suggested commit

```powershell
git add packages/shared/src/lark.ts packages/connectors/src/lark-setup.ts packages/connectors/src/lark-setup.test.ts packages/web/src/integrations.ts
git commit -m "feat: discover Bot-visible Feishu groups"
```

## Task 3: Build the Feishu Integration Application Service

**Files:**

- Create: `packages/web/src/feishu-integration-service.ts`
- Create: `packages/web/src/feishu-integration-service.test.ts`
- Modify: `packages/web/src/integrations.ts`
- Modify: `packages/web/src/index.ts`

### Step 1: Write service tests before routes

Use a real `KnowledgeEngine` with a temporary data directory and fake
administration/send ports. Cover:

1. The read model combines verified Bot status, running identity, capability,
   bindings, space metadata, Team Agents, and test health.
2. Candidate discovery excludes current active bindings.
3. Candidate discovery includes disconnected and `needs_reconnect` groups that
   the current Bot can still read.
4. `connectGroup` rejects an unverified Bot or missing `appId`.
5. `connectGroup` rereads the selected chat before any local write.
6. A membership failure creates neither binding nor space.
7. A valid connect creates or reuses `team/<chat_id>`.
8. Reconnect preserves existing pages/raw records and updates `boundAppId`.
9. A binding write failure rolls back a newly created empty space, but never
   removes a preexisting space.
10. Update validates Team Agent visibility through `engine.updateSpaceMeta`.
11. Update writes reply placement and response policy to the binding store, not
    legacy `SpaceMeta` reply fields.
12. `mentions_only` can be selected without full-message capability.
13. New `smart` or `all_messages` configuration is rejected when capability is
    `unavailable` or `unknown`.
14. A migrated smart/all binding remains visible as degraded rather than being
    rewritten silently.
15. Disconnect preserves the space, pages, raw records, tasks, reminders, and
    learning plans.
16. Test success/failure updates bounded status and does not change connection
    state.
17. A binding whose `boundAppId` differs from the current app reads as
    `needs_reconnect`.
18. Bot disconnect records local disable, marks bindings reconnect-required,
    calls the injected runtime-disable hook, and never calls a CLI remove
    operation.

### Step 2: Run the service test and verify RED

```powershell
bun test packages/web/src/feishu-integration-service.test.ts
```

Expected: fail because the service does not exist.

### Step 3: Define a narrow service API

Use explicit inputs and public read models:

```ts
interface FeishuIntegrationService {
  snapshot(): Promise<FeishuIntegrationSnapshot>;
  listConnectionCandidates(): Promise<LarkChatSummary[]>;
  connectGroup(input: ConnectFeishuGroupInput): Promise<void>;
  updateGroup(input: UpdateFeishuGroupInput): Promise<void>;
  disconnectGroup(space: SpaceId): Promise<void>;
  testGroup(space: SpaceId): Promise<void>;
  disconnectBot(): Promise<void>;
}
```

Dependencies:

- `KnowledgeEngine`
- `LarkSetupPort`
- running Bot identity/status provider
- Feishu runtime-health provider
- bounded test-message sender
- runtime-disable callback
- settings persistence callback

Keep fixed public error codes/messages for route redirects. Log only error class,
operation, chat/space ID, and bounded sanitized summaries.

### Step 4: Implement transaction ordering

For connect:

1. verify current Bot and app ID;
2. fetch the chat;
3. validate the target `SpaceId` and storage collision;
4. remember whether the space existed;
5. ensure the space;
6. write the binding;
7. if step 6 fails, remove only the newly created empty space.

For group update, validate all fields and Agent visibility before persisting
either store. Persist the binding policy first, then update name/Agent metadata.
Tests must prove rejected input changes neither.

For Bot disconnect:

- set `feishuConnectionDisabledAppId` to the current app ID;
- mark current app bindings `needs_reconnect`;
- call the runtime-disable hook;
- keep Bot name/open ID and `lark-cli` credentials for diagnosis/reconnection.

### Step 5: Run service, core, and type tests

```powershell
bun test packages/web/src/feishu-integration-service.test.ts packages/core/src/feishu-bindings.test.ts
bun run typecheck
```

Expected: pass.

### Step 6: Suggested commit

```powershell
git add packages/web/src/feishu-integration-service.ts packages/web/src/feishu-integration-service.test.ts packages/web/src/integrations.ts packages/web/src/index.ts
git commit -m "feat: add Feishu integration service"
```

## Task 4: Enforce Bindings and Response Modes in the Runtime

**Files:**

- Modify: `packages/orchestrator/src/runtime.ts`
- Modify: `packages/orchestrator/src/runtime.test.ts`
- Modify: `packages/orchestrator/src/messages.ts`

### Step 1: Update the runtime test harness

In the common group test setup, add an active binding for `oc_team`. Keep a
separate helper for intentionally unbound tests. This makes existing runtime
expectations explicit instead of relying on implicit space creation.

### Step 2: Add failing runtime tests

Cover:

1. An unbound group message does not create a space, capture content, download
   attachments, invoke an LLM, or reply.
2. An unbound group `/task`, reminder, learning, retraction, and governance
   command is also ignored.
3. A disconnected or `needs_reconnect` binding behaves like unbound.
4. A Bot-added event creates neither a space nor an active binding and sends no
   configuration notice.
5. Private messages remain unaffected by the group-binding gate.
6. An active `mentions_only` binding captures delivered messages but replies
   only when addressed to the Bot.
7. An active `smart` binding uses the configured participation level.
8. An active `all_messages` binding answers eligible human messages without
   invoking the participation classifier.
9. All modes retain guards for Bot/system messages and text explicitly
   addressed to another member.
10. Reply placement comes from the binding.
11. Disconnecting while an AI answer is in flight suppresses the outbound
    reply.
12. Disconnect does not remove content captured before it completed.

### Step 3: Run the runtime test and verify RED

```powershell
bun test packages/orchestrator/src/runtime.test.ts
```

Expected: the new privacy and response-mode tests fail against implicit group
space creation and legacy `SpaceMeta` policy reads.

### Step 4: Add the binding gate before all group behavior

For group messages, resolve `engine.feishuBindings.activeByChatId(msg.chatId)`
before parsing control commands or ensuring a space. Return immediately when no
active binding exists.

For Bot-added events, record only bounded operational logging. Do not create a
space or send `GROUP_ADDED_NOTICE`; remove that message constant if it becomes
unused.

Use the binding's `spaceId`, response mode, participation level, and
`replyInThread`. Stop consulting legacy reply fields in production runtime
behavior.

Before `connector.reply`, recheck that the binding is still active for group
messages. Private-message sends bypass this check.

### Step 5: Run runtime and regression suites

```powershell
bun test packages/orchestrator/src/runtime.test.ts packages/orchestrator/src/units.test.ts packages/core/src/group-participation.test.ts
bun run typecheck
```

If `group-participation.test.ts` does not exist, run the runtime and units suites
only; do not create an empty test file merely to satisfy this command.

Expected: pass.

### Step 6: Suggested commit

```powershell
git add packages/orchestrator/src/runtime.ts packages/orchestrator/src/runtime.test.ts packages/orchestrator/src/messages.ts
git commit -m "feat: gate Feishu groups by explicit bindings"
```

## Task 5: Migrate Before Consumers Start and Implement Safe Bot Disable

**Files:**

- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/config.test.ts`
- Modify: `packages/app/src/main.ts`
- Modify: `packages/app/src/main.test.ts`
- Modify: `packages/app/src/health.ts`
- Modify: `packages/app/src/health.test.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`

### Step 1: Add failing configuration and assembly tests

Cover:

1. `feishuConnectionDisabledAppId` persists as a non-secret optional setting.
2. Startup constructs `LarkCliSetup` before starting the Orchestrator.
3. Legacy binding migration completes before connector consumers start.
4. A verified app ID produces active migrated bindings.
5. Missing/unverified app status produces `needs_reconnect` bindings.
6. Migration failure prevents Feishu consumers from starting.
7. A locally disabled current app does not start event consumers.
8. Private/group outbound notification helpers reject delivery while disabled,
   so scheduler state remains retryable.
9. Calling the runtime-disable callback first flips the process-local outbound
   guard, then stops and drains the Orchestrator.
10. Verifying or configuring a Bot clears the local-disabled marker but still
    reports restart required until the running identity matches.
11. Health distinguishes locally disabled, needs restart, starting, ready, and
    failed states without exposing credentials.

### Step 2: Run focused tests and verify RED

```powershell
bun test packages/shared/src/config.test.ts packages/app/src/main.test.ts packages/app/src/health.test.ts packages/web/src/app.test.ts
```

Expected: fail because the disabled setting, migration order, and runtime hook
do not exist.

### Step 3: Add the local-disabled setting

Add `feishuConnectionDisabledAppId` to `Config`, `PersistedSettings`, editable
keys, loading, clearing, and tests. It contains only the app ID.

Do not clear `feishuBotName`, `feishuBotOpenId`, external-sharing evidence, or
user authorization when locally disabling the Bot.

### Step 4: Reorder production assembly

In `main.ts`:

1. construct `KnowledgeEngine`;
2. construct `LarkCliSetup`;
3. read bounded Bot status;
4. run the idempotent legacy binding migration;
5. construct connector and Orchestrator;
6. start the Orchestrator unless the verified current app is locally disabled;
7. construct Web and schedulers.

Allow private messages when the Bot is enabled even if legacy group bindings
were conservatively marked `needs_reconnect`.

Create one `sendFeishuNotice` helper used by task, learning, reminder, and
integration-test delivery. It checks a mutable process-local enabled flag before
calling `connector.notice`.

The Web runtime-disable callback must set this flag to false immediately and
then stop/drain the Orchestrator. A later reverify clears the persisted disabled
marker but does not restart consumers in process.

### Step 5: Run assembly and scheduler regressions

```powershell
bun test packages/shared/src/config.test.ts packages/app/src/main.test.ts packages/app/src/health.test.ts packages/app/src/task-scheduler.test.ts packages/app/src/reminder-scheduler.test.ts packages/app/src/learning-scheduler.test.ts
bun run typecheck
```

Expected: pass.

### Step 6: Suggested commit

```powershell
git add packages/shared/src/config.ts packages/shared/src/config.test.ts packages/app/src/main.ts packages/app/src/main.test.ts packages/app/src/health.ts packages/app/src/health.test.ts packages/web/src/app.ts packages/web/src/app.test.ts
git commit -m "feat: migrate Feishu bindings before startup"
```

## Task 6: Add Connect, Edit, Test, Disconnect, and Reconnect UI

**Files:**

- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/layout.ts`
- Modify: `packages/web/src/setup.ts`
- Modify: `packages/web/src/setup.test.ts`
- Modify: `packages/web/src/setup-view.ts`
- Modify: `packages/web/src/setup-view.test.ts`

### Step 1: Add failing HTTP and HTML tests

Cover:

1. Integrations shows the current Bot, connection/activation state, and compact
   group rows.
2. The primary group action is **连接群聊**.
3. `GET /integrations/groups/connect` lists safe candidate names/IDs and never
   includes active groups.
4. Connect POST rejects forged chat IDs not returned by the current Bot.
5. Successful connect redirects with a fixed success message.
6. Edit exposes Team Agent, reply placement, response mode, and smart
   participation level only when relevant.
7. Personal Agents remain absent/rejected.
8. Capability-unavailable smart/all options are disabled with an actionable
   app-scoped explanation.
9. Test POST records success/failure and does not echo raw errors.
10. Disconnect POST requires an existing team binding and preserves the space.
11. Reconnect uses the same space.
12. Bot disconnect form has an explicit confirmation explaining that HomeAgent
    stops listening/sending but keeps local knowledge and keychain
    authorization.
13. No route calls or renders `lark-cli config remove`.
14. More settings contains manual App ID/Secret, external sharing, and
    diagnostics after the primary workflow.
15. Admin authentication and same-origin mutation protection apply to all new
    routes.
16. App Secret, CLI notices, raw errors, and capability payloads never enter
    HTML or JSON.

### Step 2: Run Web tests and verify RED

```powershell
bun test packages/web/src/app.test.ts packages/web/src/setup.test.ts packages/web/src/setup-view.test.ts
```

Expected: fail because the page still renders expanded implicit-space forms and
the routes do not exist.

### Step 3: Route all group mutations through the service

Implement:

- `GET /integrations/groups/connect`
- `POST /integrations/groups/connect`
- `POST /integrations/groups/:space`
- `POST /integrations/groups/:space/test`
- `POST /integrations/groups/:space/disconnect`
- `POST /integrations/bot/disconnect`

Keep existing automatic/manual Bot creation and verification routes. After a
successful create/configure/verify, clear the local-disabled marker and retain
the current restart-required calculation.

Use allowlisted `returnTo` values (`/integrations` or `/setup`) rather than
reflecting arbitrary redirects.

### Step 4: Render the Mew-style server-side UI

Bot card:

- current identity and app ID;
- current/disabled/needs restart/ready/degraded status;
- create, replace, verify, and local disconnect actions.

Group list:

- group name;
- inherited or assigned Agent;
- Topic reply or normal reply;
- @ only, smart + activity, or all messages;
- active/reconnect/degraded/test status;
- Edit, Send test, Disconnect.

Connection page:

- Bot-visible candidates;
- reconnect badge for preserved spaces;
- empty state instructing the user to add the Bot to the target group and
  refresh.

Keep forms and controls accessible with server-rendered labels, unique names,
and keyboard-usable details/dialog behavior. Do not introduce a frontend
framework.

### Step 5: Update first-run setup

The onboarding invite step must count active bindings, not all `team/*` spaces.
Adding the Bot to a group no longer creates a space automatically.

Show:

- **选择并连接群聊** when candidates are available;
- **先把机器人加入群，再刷新** when none are visible;
- completion only after one active binding exists.

Do not reintroduce automatic group capture to make the old setup test pass.

### Step 6: Run Web and integration regressions

```powershell
bun test packages/web/src/feishu-integration-service.test.ts packages/web/src/app.test.ts packages/web/src/setup.test.ts packages/web/src/setup-view.test.ts packages/web/src/external-sharing.test.ts packages/web/src/verification-url.test.ts
bun run typecheck
```

Expected: pass.

### Step 7: Suggested commit

```powershell
git add packages/web/src/app.ts packages/web/src/app.test.ts packages/web/src/views.ts packages/web/src/layout.ts packages/web/src/setup.ts packages/web/src/setup.test.ts packages/web/src/setup-view.ts packages/web/src/setup-view.test.ts
git commit -m "feat: add explicit Feishu group management"
```

## Task 7: Extend Documentation, Soak Coverage, and Release Gates

**Files:**

- Modify: `README.md`
- Modify: `scripts/soak-runtime.ts`
- Modify: `scripts/soak-runtime.test.ts`
- Modify: `scripts/soak-feishu-e2e.ts`
- Modify: `scripts/soak-feishu-e2e.test.ts`
- Modify: `docs/beta-release-runbook.md`

### Step 1: Add failing soak contract tests

Add a `group_binding_lifecycle` scenario and test:

1. it is part of the release evidence set;
2. it can be selected independently;
3. the driver accepts `--admin-url` and reads an optional admin token only from
   `HOMEAGENT_SOAK_ADMIN_TOKEN`;
4. admin requests use Bearer authorization without logging the token or adding
   it to process arguments;
5. mutating requests use same-origin headers;
6. the scenario connects the target chat through the HTTP route;
7. mention reply works while active;
8. disconnect stops new capture and replies;
9. reconnect reuses the original workspace and capture resumes;
10. cleanup leaves the target group in its original active/disconnected state.

Keep `network_recovery` supervised as today.

### Step 2: Run soak tests and verify RED

```powershell
bun test scripts/soak-runtime.test.ts scripts/soak-feishu-e2e.test.ts
```

Expected: fail because the lifecycle scenario and admin HTTP options are absent.

### Step 3: Implement bounded admin control in the soak driver

Add:

- `--admin-url`, defaulting to the local configured Web URL;
- `HOMEAGENT_SOAK_ADMIN_TOKEN`, optional and never printed or copied into
  evidence;
- a small HTTP helper with fixed paths, redirect disabled, bounded response
  text, and same-origin headers;
- state capture and `finally` restoration for the original binding state.

Do not edit `feishu-group-bindings.json` directly in the soak driver; exercise
the public administration surface.

When full group-message scope is missing:

- `group_binding_lifecycle` still validates connect, mention reply,
  disconnect, and reconnect in `mentions_only` mode;
- existing `proactive_participation` fails with an actionable capability
  precondition instead of pretending smart mode works;
- all-message acceptance is run only with a Bot whose enterprise approval is
  verified.

### Step 4: Update user and release documentation

Document:

- one current Bot;
- explicit group connection;
- unconnected/disconnected privacy behavior;
- non-destructive disconnect;
- @ only, smart, and all-message modes;
- sensitive permission degradation;
- Bot local disable preserving keychain and user document authorization;
- Bot replacement/reactivation restart requirement.

Update the beta runbook with the exact lifecycle soak command and its required
admin/chat/Bot inputs. Never place a real token in the example.

### Step 5: Run focused tests

```powershell
bun test scripts/soak-runtime.test.ts scripts/soak-feishu-e2e.test.ts
```

Expected: pass.

### Step 6: Run full offline verification

```powershell
bun test
bun run typecheck
bun run verify:beta -- --allow-dirty
```

Expected:

- all offline tests pass;
- type checking exits zero;
- beta preflight passes with the intentional dirty-tree allowance during
  implementation.

### Step 7: Run supervised real Feishu verification

With a disposable or approved test group:

```powershell
bun run soak:feishu -- --chat-id oc_test --bot-open-id ou_test --admin-url http://127.0.0.1:3000 --scenarios group_binding_lifecycle,mention_answer
```

Then, only when `im:message.group_msg` is verified:

```powershell
bun run soak:feishu -- --chat-id oc_test --bot-open-id ou_test --admin-url http://127.0.0.1:3000 --scenarios proactive_participation,message_capture
```

If the management backend uses an admin token, provide it through
`HOMEAGENT_SOAK_ADMIN_TOKEN` using the operator's secret-injection mechanism.
Do not place the token in command arguments, shell history, logs, screenshots,
or evidence artifacts.

Expected:

- connection lifecycle evidence is recorded;
- disconnected messages are neither captured nor answered;
- reconnect reuses the original knowledge space;
- smart/all-message evidence is recorded only with verified capability.

### Step 8: Suggested commit

```powershell
git add README.md scripts/soak-runtime.ts scripts/soak-runtime.test.ts scripts/soak-feishu-e2e.ts scripts/soak-feishu-e2e.test.ts docs/beta-release-runbook.md
git commit -m "test: cover Feishu group binding lifecycle"
```

## Final Review Checklist

- [ ] No unconnected/disconnected group path reaches command parsing, capture,
      attachment download, LLM classification, or reply.
- [ ] Private messages continue to work for an enabled Bot.
- [ ] Disconnecting a group preserves all workspace data.
- [ ] Disconnecting the Bot never runs `lark-cli config remove`.
- [ ] Every scheduler and manual test uses the outbound-enabled guard.
- [ ] Bot replacement/reactivation still requires restart.
- [ ] Existing migrated behavior remains smart/balanced unless it was legacy
      respond-all.
- [ ] Permission unknown/unavailable never enables new smart/all configuration.
- [ ] Group connection revalidates Bot membership at submit time.
- [ ] New routes retain admin authentication and same-origin mutation checks.
- [ ] Binding and health persistence contain no secret, token, raw message
      content, or unbounded error.
- [ ] External sharing remains app-scoped and works after the UI move.
- [ ] Full tests, typecheck, beta preflight, and supervised Feishu soak pass.

## Expected Final File Set

New:

- `packages/core/src/feishu-bindings.ts`
- `packages/core/src/feishu-bindings.test.ts`
- `packages/web/src/feishu-integration-service.ts`
- `packages/web/src/feishu-integration-service.test.ts`

Modified:

- shared Lark/config contracts;
- connector setup administration methods and tests;
- core engine exports;
- Orchestrator runtime and tests;
- app assembly and health;
- Web routes, setup flow, views, CSS, and tests;
- Feishu soak driver, release evidence, README, and beta runbook.

No production credential file, generated data directory, or real Feishu
identifier belongs in the commit.
