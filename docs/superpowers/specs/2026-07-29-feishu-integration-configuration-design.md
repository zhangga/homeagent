# Feishu Integration Configuration Design

**Date:** 2026-07-29
**Status:** Approved for implementation planning

## Context

HomeAgent already supports one-click Feishu app creation, secure `lark-cli`
credential storage, group and private-message consumers, group-specific Agents,
thread replies, intelligent group participation, external-sharing verification,
test messages, and runtime health reporting.

The current Integrations page exposes these capabilities as technical controls.
It also treats a team knowledge space as the implicit Feishu group binding. A
group becomes configured when the bot-added event or a message creates a
`team/<chat_id>` space, and there is no non-destructive disconnect lifecycle.

The reference Mew page presents a simpler model:

1. choose or bind a Lark bot;
2. connect groups;
3. show each group's Agent and reply policy in a compact row;
4. edit or remove a group connection;
5. keep manual setup under More settings.

This design adopts that information architecture while retaining HomeAgent's
stronger setup, knowledge, health, and intelligent-participation capabilities.

## Decision

Build a single-current-bot Feishu configuration center.

The first release will not run multiple bots concurrently and will not hot-switch
the bot event consumers. It will separate Feishu group bindings from knowledge
spaces, add an explicit group connection lifecycle, clarify response modes, and
make permission and health failures actionable.

## Goals

- Make the current bot, connected groups, and per-group behavior understandable
  from one page.
- Let an administrator connect a group the current bot has already joined.
- Let an administrator disconnect and later reconnect a group without deleting
  its knowledge or scheduled work.
- Prevent unconnected or disconnected groups from being captured or answered.
- Provide explicit `mentions_only`, `smart`, and `all_messages` response modes.
- Preserve secure credential handling: App Secret and tokens remain owned by
  `lark-cli`.
- Migrate existing team spaces without losing data or changing their current
  reply behavior.
- Keep existing private-message, attachment, external-sharing, task,
  reminder, and learning behavior working.

## Non-goals

- Multiple Feishu bots running at the same time.
- Runtime hot-switching of the active bot.
- Automatically creating Feishu groups or modifying group membership.
- Deleting a knowledge space when a Feishu group is disconnected.
- Replacing `lark-cli` as the credential and API-client boundary.
- Introducing a client-side frontend framework.

## Alternatives Considered

### UI-only refresh

Rearrange the existing page into compact rows without changing the data model.
This is the smallest change, but it cannot implement a durable disconnect,
reconnect, or current-bot mismatch state. A disconnected group would be
recreated by its next inbound message.

### Single-bot configuration center

Add a group-binding model and integration service while keeping one active bot.
This creates a correct lifecycle and a Mew-like experience without multiplying
credential and event-routing complexity. This is the selected approach.

### Single-bot configuration center with hot switching

Also stop the old consumers, promote a new credential profile, start new
consumers, and roll back on failure. Current `lark-cli` configuration is global
and does not expose an application-profile switcher, so safe rollback would
require additional credential-profile infrastructure. This is deferred.

## Information Architecture

The Integrations page has three sections.

### Feishu bot

Show:

- current bot name and open ID;
- app ID and Feishu/Lark brand;
- connection, verification, activation, and consumer health;
- whether the configured identity differs from the running connector identity.

Offer:

- create and connect a bot;
- replace the current bot;
- reverify the current configuration;
- disconnect the bot with explicit confirmation.

A successfully replaced bot remains visibly `needs_restart` until the running
connector identity matches. The UI must not imply that hot switching occurred.

Disconnect is a HomeAgent-local disable operation. It stops Feishu consumers
and outbound delivery but deliberately keeps the `lark-cli` application and
user authorization in the system keychain. HomeAgent must not implement this
action with `lark-cli config remove`, because that command clears the complete
application configuration and all tokens, including user authorization used for
document access.

### Feishu groups

Show a primary **Connect group** action and compact connected-group rows.

Each row shows:

- group name;
- inherited or assigned Team Agent;
- topic or normal reply placement;
- response mode;
- connection and test health.

Each row offers:

- Edit;
- Send test;
- Disconnect.

Editing expands or opens the existing server-rendered form. Disconnecting
changes only the binding state. Deleting a space remains a separate management
operation with its existing stronger confirmation.

The Connect group view lists groups returned by `lark-cli im +chat-list --as
bot` that are not actively bound. It also lists disconnected or
`needs_reconnect` bindings that are visible to the current bot. When the bot is
not in the desired group, the page explains how to add it and offers a refresh;
HomeAgent does not create the group or change its membership.

### More settings

Keep secondary and diagnostic controls here:

- connect an existing application with App ID and App Secret;
- external-sharing publishing and verification;
- permission and event diagnostics;
- recent verification and fixed-length error summaries.

One-click creation remains the primary setup path.

## Domain Model

The current bot remains a singleton. Its status is a read model composed from
verified `lark-cli` status, persisted non-secret identity metadata, and the
running connector identity. App Secret and tokens are not part of the model.

Add a versioned group-binding store at:

`data/config/feishu-group-bindings.json`

The store uses atomic replacement and contains no credentials or message
content.

```ts
type FeishuGroupBindingState =
  | "active"
  | "disconnected"
  | "needs_reconnect";

type FeishuResponseMode =
  | "mentions_only"
  | "smart"
  | "all_messages";

interface FeishuGroupBinding {
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

interface FeishuGroupBindingFile {
  version: 1;
  bindings: FeishuGroupBinding[];
}
```

`available` is a live group-list result, not a persisted binding state.
`degraded` is computed health, not a persisted lifecycle state.

`SpaceMeta` continues to own the group display name, `chatId`, and `agentId`
because those identify the knowledge space and its Agent. Feishu-only reply
placement, response policy, connection state, and test health move to
`FeishuGroupBinding`.

There is at most one binding per `chatId` and at most one binding per team
`spaceId`.

## State Model

```text
available --connect--> active --disconnect--> disconnected
                         |
                      bot replaced
                         v
                  needs_reconnect --reconnect--> active
```

- Connect validates that the current bot can still read the target chat before
  writing the binding.
- Disconnect is idempotent and preserves the space.
- Reconnect validates the current bot, updates `boundAppId`, and reuses the
  existing space.
- When the verified current app differs from `boundAppId`, the service computes
  or persists `needs_reconnect`; it never silently transfers the binding.
- Disabling the active bot leaves knowledge intact and makes prior bindings
  require reconnection.

## Component Boundaries

### `FeishuGroupBindingRepository`

Owns versioned persistence, atomic writes, uniqueness validation, idempotent
state transitions, and legacy migration. It does not call Feishu or mutate
knowledge content.

### `FeishuChatAdministrationPort`

Provides the bounded Feishu operations required by configuration:

```ts
interface FeishuChatAdministrationPort {
  listBotChats(): Promise<FeishuChatSummary[]>;
  getBotChat(chatId: string): Promise<FeishuChatSummary | undefined>;
  sendTestMessage(chatId: string, markdown: string): Promise<void>;
}
```

The production adapter uses the bundled `lark-cli` with Bot identity. Results
are parsed into fixed public value types; raw CLI output is not returned to the
Web layer.

### `FeishuIntegrationService`

Coordinates:

- current bot status;
- chat discovery and membership verification;
- binding state transitions;
- knowledge-space creation or reuse;
- Team Agent validation;
- response-policy capability checks;
- test-message status;
- the read model consumed by the UI.

This service is the only boundary the integration routes use for group
configuration.

### Runtime binding gate

The orchestrator asks the binding service for an active binding before
capturing or responding to a group event. Private messages do not use this
gate.

The runtime rechecks the binding before an outbound reply. If a group was
disconnected while an AI request was running, HomeAgent suppresses the late
reply. Disconnect does not retroactively delete content accepted before the
disconnect completed.

## Data Flows

### Connect a group

1. Read the verified current bot.
2. List chats visible to that bot.
3. Exclude active bindings; include disconnected and reconnectable matches.
4. On submit, reread the target chat using Bot identity.
5. Reject the operation without a local write if membership cannot be verified.
6. Create or reuse `team/<chat_id>`.
7. Atomically upsert an active binding for the current `appId`.
8. Return to Integrations with the compact group row.

Connecting does not automatically send a Feishu message. Sending a test message
is an explicit separate action.

### Process a group message

1. Normalize the event and reject Bot/system events as today.
2. Resolve an active binding by `chatId`.
3. If no active binding exists, do not create a space, capture content, classify
   participation, or reply.
4. Capture the message for an active binding.
5. Apply the configured response mode.
6. Before sending, confirm that the same binding is still active.

The bot-added event no longer creates a team space or an active binding. It may
update operational health, but the group becomes active only through the
explicit Connect group flow.

### Response modes

- `mentions_only`: reply only when the bot is mentioned, replied to, or receives
  an explicit supported control command.
- `smart`: use the existing participation classifier and its
  `reserved`/`balanced`/`active` thresholds for otherwise unaddressed messages.
- `all_messages`: reply to every eligible human message while retaining guards
  for Bot/system messages and messages clearly addressed to another member.

An active connected group continues to capture all group messages that Feishu
actually delivers to HomeAgent. Response mode governs replies, not retrospective
knowledge deletion.

### Disconnect and reconnect

Disconnect atomically marks the binding `disconnected`. Subsequent group events
are ignored even if the bot remains a group member. Reconnect verifies current
membership and app identity, reactivates the binding, and reuses the prior
space.

### Replace the bot

The existing secure provisioning flow configures and verifies the new
application. The page marks it as awaiting restart until the running connector
identity matches. Bindings created for the previous `appId` become
`needs_reconnect`; HomeAgent does not claim the new bot belongs to those chats.

### Disconnect the bot

Persist the current app ID as locally disabled, mark its bindings
`needs_reconnect`, stop the event consumers, and reject Feishu outbound
deliveries. Keep `lark-cli` credentials untouched. Reverification or connection
of a bot clears the local-disabled marker, but activating its consumers still
follows the explicit restart path.

## Permission and Capability Behavior

`mentions_only` is always selectable when the base group-mention capability is
available.

`smart` and `all_messages` require the sensitive full group-message capability.
The setup flow already requests it, but enterprise approval may still be
pending or denied.

The integration service exposes a capability result with `available`,
`unavailable`, or `unknown` state. When full-message capability is unavailable
or unknown:

- `smart` and `all_messages` are disabled for new configuration;
- the UI shows the relevant Feishu approval or repair action;
- existing affected bindings are displayed as degraded;
- runtime behavior falls back to mention-addressed messages and never claims
  full-message coverage.

External-sharing publishing remains app-scoped and stays under More settings.

## Routes

Keep:

- `GET /integrations`
- `POST /setup/feishu/automatic`
- `POST /integrations/bot/setup`
- `POST /integrations/bot/verify`

Add:

- `GET /integrations/groups/connect`
- `POST /integrations/groups/connect`
- `POST /integrations/groups/:space/disconnect`
- `POST /integrations/bot/disconnect`

Retain and route through `FeishuIntegrationService`:

- `POST /integrations/groups/:space`
- `POST /integrations/groups/:space/test`

All mutating routes retain the management authentication boundary. Bot
disconnect and group disconnect require explicit UI confirmation. Public error
messages are fixed or sanitized and never echo subprocess output.

`POST /integrations/bot/disconnect` changes HomeAgent state only; it never calls
`lark-cli config remove`.

## Failure Handling

- Chat-list failure leaves persisted bindings unchanged and offers retry.
- Membership-verification failure creates no binding or space.
- Atomic persistence failure leaves the previous complete binding file in
  place.
- Test-message failure keeps the binding active, records a bounded error
  summary, and displays degraded test health.
- Bot unavailability makes integration controls read-only where mutation cannot
  be verified; knowledge remains available.
- Current-bot mismatch marks bindings `needs_reconnect`.
- Duplicate connect, reconnect, and disconnect submissions are idempotent.
- A binding-state check before reply suppresses responses completed after a
  disconnect.
- Secrets, tokens, raw CLI payloads, and message content are excluded from
  binding state and health logs.

## Migration and Compatibility

Run an idempotent migration before Feishu event consumers begin accepting
events.

For each existing `team/*` `SpaceMeta`:

- use its `chatId` or derive the chat ID from the space ID;
- default `replyInThread` to `true`;
- map legacy `mentionsOnly === false` with no `participationLevel` to
  `all_messages`;
- map an existing `participationLevel` to `smart` with the same level;
- map remaining current configurations to `smart` with `balanced`;
- bind to the verified current `appId` and mark `active` when a verified current
  bot exists;
- otherwise leave `boundAppId` absent and mark the binding `needs_reconnect`.

The migration does not rename, move, or delete spaces or their contents.

During the compatibility window, reads can derive reply settings from legacy
`SpaceMeta` only when no migrated binding record exists. New writes go only to
the binding store. After migration and release validation, the obsolete
Feishu-only fields can be removed from `SpaceMeta` in a separate cleanup.

If migration cannot produce a valid, atomically persisted binding store,
Feishu readiness fails instead of starting consumers with ambiguous capture
rules.

## Testing Strategy

### Unit tests

- versioned store parsing and atomic-write behavior;
- uniqueness and idempotent transitions;
- exact legacy-mode migration and repeated migration;
- current-bot mismatch and reconnect;
- Team Agent validation;
- permission gating and safe fallback;
- bounded parsing of `lark-cli` chat-list, chat-get, and test failures.

### Web and service tests

- candidate list excludes active groups and includes reconnectable groups;
- connection revalidates membership;
- connection creates or reuses the correct space;
- disconnect preserves pages, raw records, tasks, reminders, and learning plans;
- Personal Agents cannot be assigned to team groups;
- compact rows render Agent, reply placement, response mode, and health;
- Bot replacement visibly requires restart;
- App Secret, tokens, and raw errors never appear in HTML, JSON, settings, or
  logs.

### Runtime tests

- unbound and disconnected group messages are ignored without creating spaces;
- active group messages are captured;
- each response mode has explicit positive and negative cases;
- disconnect during an in-flight AI answer suppresses the outbound reply;
- private-message behavior is unchanged;
- missing full-message capability safely degrades to mention-addressed behavior.

### Real Feishu soak tests

Extend the existing soak driver to verify:

- a group the Bot has joined appears as connectable;
- connecting enables mention replies and test messages;
- smart and all-message modes work only with verified capability;
- disconnect stops capture and replies;
- reconnect reuses the original space;
- external-group verification still works.

## Acceptance Criteria

- An administrator can connect a Bot-visible group from Integrations in no more
  than three interactions.
- Group setting changes take effect without restarting HomeAgent.
- Bot replacement explicitly requires restart and never appears hot-switched.
- Disconnecting a group does not delete knowledge or scheduled work.
- Unbound and disconnected groups are not captured or answered.
- Permission status never overstates full-message availability.
- Existing private chat, attachments, external sharing, task notifications,
  reminders, and learning behavior do not regress.
- Targeted tests, the full test suite, type checking, beta preflight, and the
  extended real Feishu soak gate pass.

## Rollout

Implementation should proceed in coherent increments:

1. binding store, migration, and integration-service boundary;
2. runtime binding gate and response modes;
3. group discovery, connection, edit, test, and disconnect routes;
4. Mew-style Integrations presentation and actionable health;
5. regression, migration, and real Feishu soak verification.

Bot hot switching and multi-bot routing require a separate future design.
