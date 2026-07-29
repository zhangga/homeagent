# Feishu Group Administrator Confirmation Design

**Date:** 2026-07-29
**Status:** Awaiting written-spec review

## Context

HomeAgent's current first-run flow continues from Bot activation into an
invitation step. Separately, the Feishu integration model requires a local
administrator to connect each group from the Web UI before HomeAgent captures
or answers group messages.

The desired product flow is simpler:

1. First-run setup finishes when the AI provider and Feishu Bot are configured
   and the event consumers are ready.
2. The operator can add the Bot to a group later.
3. HomeAgent detects the join and asks a group owner or administrator to confirm
   activation inside that group.
4. Only after confirmation does HomeAgent create or reuse the group's
   conversation space and begin processing messages.

This design refines the previously approved internal-first setup and explicit
group-binding designs. It removes the remaining group invitation step from
Setup and replaces direct Web activation as the primary group-onboarding path
with an in-group administrator confirmation.

## Goals

- Let first-run setup finish without requiring any Feishu group.
- Automatically detect when the current Bot joins a group.
- Require explicit confirmation from a group owner or administrator before
  activating capture or replies.
- Create the group conversation space only after valid confirmation.
- Use conservative defaults: mention-only responses and thread replies.
- Preserve explicit local disconnect decisions.
- Make duplicate events, commands, and retries safe.
- Provide enough Integrations-page visibility to recover from missed events or
  failed prompts without bypassing group authorization.

## Non-goals

- Automatically activating a group merely because the Bot joined it.
- Capturing pending-group messages for later replay.
- Allowing a regular group member to authorize HomeAgent.
- Supporting natural-language or fuzzy activation commands.
- Creating or changing Feishu group membership.
- Replacing the existing active-group policy editor.
- Adding Bot-removal event handling beyond the current reconnect lifecycle.
- Changing private-message behavior.
- Changing external-sharing publishing or verification.

## Alternatives Considered

### In-group administrator confirmation

On `bot_added`, persist a pending binding and send a one-time prompt. A group
owner or administrator activates the group with an exact mention command. This
keeps setup short, makes consent visible to the group, and verifies authority at
the point of activation. This is the selected approach.

### Immediate mention-only activation

Create the space and enable mention-only behavior as soon as the Bot joins.
This is the fastest flow, but group membership alone is not clear consent to
capture messages. It also makes accidental Bot invitations harder to undo
before data collection begins.

### Web-only confirmation

Show discovered groups in Integrations and require the HomeAgent operator to
activate them there. This matches the existing explicit-binding model, but
requires the operator to switch contexts and does not establish that a group
administrator agreed to activation.

## User Experience

### First-run setup

`SetupStep` becomes:

```text
ai -> feishu -> activate -> done
```

The `invite` step is removed. Setup reaches `done` when:

- the selected AI provider is usable;
- the Feishu Bot identity is verified;
- the running connector uses that identity; and
- the required event consumers are ready.

The completion page presents a non-blocking next step:

> Add the Bot to a Feishu group. A group owner or administrator can then send
> `@HomeAgent 启用群聊` to enable it.

No group binding, group invitation, or external-sharing action blocks Setup
completion.

### Bot joins a group

When HomeAgent receives `bot_added` for a new group, it stores a
`pending_confirmation` binding before attempting any outbound prompt. It does
not create a conversation space and does not capture group content.

HomeAgent then sends one fixed prompt:

> HomeAgent has joined, but is not reading this group's messages yet. A group
> owner or administrator can send `@HomeAgent 启用群聊` to enable it.

The automatic prompt is attempted once per pending lifecycle. Duplicate
`bot_added` events and process restarts do not produce duplicate prompts.

### Administrator confirms

Before applying the normal active-binding gate, the orchestrator recognizes a
group message as an activation command only when:

- it explicitly mentions the currently running Bot;
- the mention is removed from the normalized text;
- the remaining trimmed text is exactly `启用群聊`; and
- the sender is a human user.

Whitespace surrounding the command is ignored. Synonyms, additional prose, and
messages that do not mention the Bot do not match.

For a pending group, HomeAgent asks Feishu whether the sender is the group owner
or an administrator:

- If authorized, HomeAgent creates or reuses `team/<chat_id>`, activates the
  binding, and replies with a success message.
- If unauthorized, HomeAgent keeps the group pending and replies that a group
  owner or administrator must perform the action.
- If authority cannot be verified, HomeAgent fails closed, keeps the group
  pending, and asks the sender to retry later.

An exact activation command can also recover from a missed `bot_added` event.
When no binding exists, HomeAgent verifies current Bot membership, persists a
pending record, and then verifies sender authority before activation. It never
skips authority verification.

For an already active group, the command is idempotent and replies that the
group is already enabled.

For a locally `disconnected` group, `bot_added` and activation commands do not
reactivate it. The HomeAgent operator must first move it back into the pending
confirmation flow from Integrations. This gives the local operator final
control over an intentionally ignored or disconnected group.

## Binding State Model

The durable group-binding model gains `pending_confirmation`:

```text
unregistered
    |
    | bot_added or recoverable exact command
    v
pending_confirmation
    |
    | authorized exact command
    v
active
    |
    | local disconnect/ignore
    v
disconnected

active -- Bot identity changes --> needs_reconnect
needs_reconnect -- current Bot joins --> pending_confirmation
pending_confirmation -- authorized exact command --> active
```

Transition rules:

- `unregistered -> pending_confirmation` stores the current `appId`, derived
  `team/<chat_id>` space ID, safe defaults, and discovery time.
- `pending_confirmation -> active` is allowed only after current membership and
  sender authority are verified.
- Duplicate transitions are idempotent.
- `active + bot_added` is a no-op.
- `disconnected + bot_added` is a no-op and sends no prompt.
- `needs_reconnect + bot_added` changes to `pending_confirmation` for the
  currently running App ID and requests fresh group-administrator consent.
- A local operator may change `disconnected` or `needs_reconnect` to
  `pending_confirmation` by requesting confirmation from Integrations. This
  sends a group prompt but does not activate the group.

## Persistence

Upgrade `data/config/feishu-group-bindings.json` to schema version 2. Version 1
files are migrated on load without changing existing `active`, `disconnected`,
or `needs_reconnect` bindings.

The binding state becomes:

```ts
type FeishuGroupBindingState =
  | "pending_confirmation"
  | "active"
  | "disconnected"
  | "needs_reconnect";

interface FeishuConfirmationPrompt {
  lastAttemptAt: number;
  status: "attempting" | "sent" | "failed";
  lastError?: string;
}

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
  confirmationPrompt?: FeishuConfirmationPrompt;
  lastTestAt?: number;
  lastTestStatus?: "succeeded" | "failed";
  lastError?: string;
}
```

New pending records use:

- `spaceId = team/<chat_id>`;
- `responseMode = mentions_only`;
- no participation level; and
- `replyInThread = true`.

Having a derived `spaceId` in a pending binding does not mean that a
`SpaceRegistry` entry or knowledge directory exists.

Prompt attempts are persisted before sending. A failed or interrupted attempt
is visible in Integrations and is retried only through an explicit local
operator action. This favors avoiding group spam over automatic retry.

The store continues to exclude credentials, tokens, message content, and raw
Feishu responses.

## Component Boundaries

### `FeishuGroupBindingRepository`

Owns version-2 parsing and migration, atomic persistence, uniqueness, prompt
attempt metadata, and idempotent state transitions. It does not call Feishu or
create spaces.

### Feishu group administration port

The Feishu adapter exposes only the capabilities needed by onboarding:

```ts
interface FeishuGroupAdministrationPort {
  getBotChat(chatId: string): Promise<FeishuChatSummary | undefined>;
  isChatAdministrator(chatId: string, userId: string): Promise<boolean>;
  sendOnboardingNotice(
    chatId: string,
    notice: FeishuOnboardingNotice,
    replyToMessageId?: string,
  ): Promise<void>;
}
```

`FeishuOnboardingNotice` is a closed set of fixed message kinds:
confirmation required, administrator required, verification unavailable,
activation succeeded, activation already active, and activation failed. The
orchestrator cannot use this port to send arbitrary unbound-group content.

The production adapter may internally use the existing connector reply and
notice primitives. The restricted interface is the safety boundary.

### Group onboarding service

A focused service coordinates:

- registration of a pending group;
- one-time confirmation prompts;
- exact-command handling;
- Bot membership and App ID validation;
- group-owner/administrator verification;
- space creation or reuse;
- binding activation; and
- fixed onboarding replies.

This keeps onboarding transitions out of the main message-processing path.

### Orchestrator

The orchestrator routes `bot_added` to the onboarding service. For group
messages, it checks the exact onboarding command before dropping messages that
lack an active binding. All other pending or unbound group messages follow the
existing drop path.

Normal capture, classification, agent execution, and outbound replies still
require an `active` binding. The existing pre-send active-binding recheck
remains unchanged.

### Space registry

The registry is called only after an authorized confirmation. It creates or
reuses the group space idempotently. It does not decide authorization or
binding state.

### Web Integrations

The Web layer reads a combined Bot, chat, binding, and prompt-status view from
the integration service. It can request or resend confirmation and mark a group
ignored, but it cannot set a group directly to `active`.

## Data Flows

### Handle `bot_added`

1. Normalize and deduplicate the event.
2. Read the binding for `chatId`.
3. For `active` or `disconnected`, stop without sending.
4. For no binding, create `pending_confirmation` with safe defaults.
5. For `needs_reconnect`, update the binding to `pending_confirmation` for the
   current App ID.
6. If no prompt has been attempted in this pending lifecycle, persist an
   `attempting` prompt record.
7. Send the fixed confirmation-required notice.
8. Persist `sent` or a bounded `failed` summary.

No step creates a space or processes group content.

### Handle the activation command

1. Normalize the message and require an exact Bot mention plus `启用群聊`.
2. Read the binding.
3. Return an idempotent fixed reply for `active`.
4. Ignore `disconnected`.
5. For no binding, verify current Bot membership and persist a pending record.
6. For `needs_reconnect`, verify current Bot membership and change the binding
   to pending for the running App ID.
7. Require the pending binding's `boundAppId` to match the running connector.
8. Verify the sender as group owner or administrator.
9. Fetch current group metadata.
10. Create or reuse `team/<chat_id>`.
11. Atomically change the binding to `active` with mention-only and thread-reply
    defaults.
12. Send the fixed success reply.

If space creation succeeds but binding persistence fails, the inactive space
may remain. No content is captured because the binding is not active. A retry
reuses that space.

### Process ordinary pending-group messages

1. Test for the exact onboarding command.
2. If it does not match, resolve the normal active binding.
3. If no active binding exists, stop.

The message is not persisted, captured, summarized, classified, or answered.

### Recover from Integrations

Integrations lists Bot-visible groups and durable bindings:

- A group with no binding can enter `pending_confirmation` through **Request
  confirmation**.
- A pending group shows discovery time and prompt status and offers **Resend
  prompt** or **Ignore group**.
- A disconnected or reconnect-required group can re-enter
  `pending_confirmation` through **Request confirmation**.
- Active-group edit, test, and disconnect controls remain available.

Requesting or resending confirmation never creates a space or activates a
binding.

## Integrations Presentation

Group rows use these primary labels:

- `pending_confirmation`: Waiting for group administrator
- `active`: Enabled
- `disconnected`: Disconnected
- `needs_reconnect`: Needs reconnection

A pending row shows:

- group name or chat ID fallback;
- first discovery time;
- the exact activation command;
- last prompt attempt and status;
- **Resend prompt**; and
- **Ignore group**.

The page sanitizes prompt failures and never renders raw CLI output. Existing
active-group response-mode, Agent, reply placement, test, and disconnect
controls are unchanged.

## Failure Handling

- A prompt failure leaves the binding pending and records a bounded error.
- Duplicate `bot_added` events do not resend a prompt.
- Bot membership lookup failure creates no active binding.
- Administrator lookup failure fails closed and preserves pending state.
- An unauthorized command does not create a space or activate the group.
- Group metadata or space-creation failure preserves pending state and sends a
  fixed failure reply when possible.
- Binding-write failure after space creation leaves the space inactive; retry
  reuses it.
- Success-reply failure does not roll back a completed activation.
- A running/configured App ID mismatch prevents activation.
- Existing active, disconnected, and reconnect-required version-1 records
  retain their lifecycle states during migration.
- All errors exclude secrets, tokens, message content, and raw CLI responses.

## Testing Strategy

### Binding repository tests

- Version-1 files migrate to version 2 without changing existing lifecycle
  states or policies.
- Pending defaults are deterministic.
- Prompt-attempt state persists and suppresses duplicate automatic prompts.
- Pending, active, disconnected, and reconnect transitions are idempotent.
- Uniqueness and atomic-write guarantees remain intact.

### Command parser and onboarding service tests

- A Bot mention plus exact `启用群聊` matches.
- Missing mentions, additional prose, aliases, and Bot/system senders do not
  match.
- An authorized owner or administrator activates a pending group.
- An ordinary member receives the fixed administrator-required reply.
- Authority lookup failure preserves pending state.
- A missed `bot_added` event can recover through an authorized exact command.
- An active group returns the idempotent already-enabled reply.
- A disconnected group cannot be reactivated by an event or command.
- A reconnect-required group returns to pending for the current App ID.

### Runtime tests

- `bot_added` creates a pending binding but no space.
- Duplicate `bot_added` sends no duplicate prompt.
- Pending-group ordinary messages are not captured or answered.
- Activation creates or reuses the space and enables mention-only behavior.
- In-flight ordinary replies still use the active-binding pre-send gate.
- Private-message behavior is unchanged.

### Web and setup tests

- Setup proceeds directly from activation to done without a group.
- The completion page explains the in-group command as an optional next step.
- Integrations renders all four lifecycle states.
- Request confirmation and resend prompt never activate the group.
- Ignore group changes a pending binding to disconnected.
- Active-group edit, test, and disconnect behavior does not regress.
- Prompt and verification failures are sanitized.

### Real Feishu soak tests

- Adding the Bot produces one group prompt.
- A regular member cannot enable the group.
- A group owner or administrator can enable it.
- The first eligible message after activation is handled with mention-only and
  thread-reply defaults.
- Removing and re-adding a locally disconnected group does not reactivate it.
- The Integrations recovery action can resend a failed or missed prompt.

## Acceptance Criteria

- First-run Setup completes with no Feishu group present.
- Adding the current Bot to a group never starts capture automatically.
- Exactly one automatic confirmation prompt is attempted for a pending
  lifecycle.
- Only a verified group owner or administrator can activate a pending group.
- No pending or disconnected message reaches storage, knowledge capture,
  participation classification, or an Agent.
- Successful activation creates or reuses exactly one `team/<chat_id>` space.
- New groups start in mention-only mode with thread replies enabled.
- Duplicate events and commands are safe.
- Explicit local disconnect decisions survive Bot re-addition.
- Integrations can recover from missed events and failed prompts without
  bypassing group authorization.
- Existing active groups, private messages, external sharing, attachments,
  tasks, reminders, and learning behavior do not regress.

## Rollout

Implementation should proceed in these increments:

1. version-2 binding model and migration;
2. restricted Feishu administration/onboarding port;
3. onboarding service, command parser, and runtime routing;
4. Setup state-machine simplification;
5. Integrations pending-state and recovery controls;
6. unit, runtime, Web, migration, and real Feishu verification.

Bot-removal lifecycle expansion, fuzzy commands, and automatic prompt retry are
separate future designs.
