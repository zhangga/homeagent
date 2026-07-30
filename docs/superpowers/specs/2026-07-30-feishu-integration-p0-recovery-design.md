# Feishu Integration P0 Recovery Design

**Date:** 2026-07-30
**Status:** Approved for implementation planning

## Context

The Feishu control center supports full-group listening modes, but the current
production command boundary loses structured `lark-cli` output when a command
exits non-zero. `auth check` uses a non-zero exit to report missing scopes, so
the control center can show `unknown` instead of `unavailable` and disable
advanced response modes without explaining the cause.

The newer control-center presentation also dropped recovery links that existed
in the legacy Integrations page. A restart requirement, failed consumer, or
permission-check failure is visible but not actionable. Its manual existing-app
form also fixes the platform to the current brand instead of letting the
operator choose Feishu or Lark.

## Decision

Implement a bounded diagnostic and recovery loop. HomeAgent will accurately
classify full-group-message capability, explain the result, and provide safe
navigation and retry actions. It will not automatically grant permissions,
publish a Feishu application version, or change external application settings.

## Goals

- Distinguish available, unavailable, and indeterminate full-group-message
  capability in the real command path.
- Preserve enough structured command output to classify an expected non-zero
  result without exposing raw CLI output to the browser.
- Give each degraded control-center state an actionable recovery path.
- Restore explicit Feishu/Lark selection for manual existing-app setup.
- Keep the existing single-current-Bot and restart-required model unchanged.

## Non-goals

- Automatically requesting, granting, or publishing Feishu permissions.
- Multi-Bot runtime routing or hot switching.
- Changing group confirmation, connection, or response-policy semantics.
- Rendering raw stdout, stderr, tokens, credentials, or CLI diagnostics.
- Refactoring every connector command to a new process abstraction.

## Command Boundary

The connector command module will expose a completed-result helper that returns
bounded `code`, `stdout`, and `stderr` instead of throwing on a non-zero exit.
The existing throwing `runFeishuCommand` API will wrap that helper and retain
its current behavior for every existing connector call site.

`bunLarkSetupRunner` will use the completed-result helper so it can preserve
structured stdout and stderr when a setup command exits non-zero. Timeouts and
spawn failures will remain distinguishable from completed commands.

The setup runner is the only consumer that needs this richer result. Existing
connector commands that intentionally throw on non-zero exit remain unchanged.
The result exposed to `LarkCliSetup` continues to be:

```ts
interface LarkSetupCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
```

Captured diagnostic output must have a fixed upper bound. Browser-facing error
messages remain closed, product-owned strings.

## Capability Classification

`fullGroupMessageCapability()` will apply these rules:

1. Valid structured output containing
   `missing: ["im:message.group_msg"]` is `unavailable`, including a non-zero
   command exit.
2. A successful command that explicitly grants the scope, or reports success
   with an empty missing list, is `available`.
3. A timeout, spawn failure, malformed output, or ambiguous result is `unknown`.

The classifier must not treat an ambiguous successful response as proof that
the permission exists.

## Control-Center Recovery

The Bot card will render a short capability explanation:

- `available`: full-group listening is ready.
- `unavailable`: the application lacks the full-group-message capability.
- `unknown`: HomeAgent could not determine the permission state.

For `unavailable`, the page will offer:

- **Open Feishu application**, when a safe developer-console URL is available;
- **Recheck**, using the existing Bot verification route.

For `unknown`, the page will offer:

- **Recheck**;
- **Open runtime status**.

When the configured identity requires a restart, the control center will link
to runtime status with restart-oriented copy. When an event consumer has
failed, it will link to runtime status with recovery-oriented copy. The page
will never display raw consumer errors.

The manual existing-app form under **More Bot settings** will restore a
Feishu/Lark platform selector and submit the selected brand through the existing
setup route.

## Error Handling

- Structured missing-scope output is a normal unavailable state, not an
  exception shown to the user.
- Command timeouts, malformed output, and spawn failures degrade to `unknown`.
- Unsafe or absent application URLs suppress the external link while retaining
  recheck and runtime-status actions.
- Existing secret-handling rules remain unchanged: App Secret is sent over
  stdin and is never rendered or persisted by the Web layer.

## Testing

Implementation follows vertical test-driven slices:

1. A public `LarkCliSetup` capability check using the production setup runner
   maps a completed non-zero command with structured missing-scope output to
   `unavailable`.
2. Malformed and failed command paths remain `unknown`; valid granted output
   remains `available`.
3. The control center renders distinct unavailable and unknown recovery copy
   and links without leaking raw diagnostics.
4. Restart-required and failed-consumer states expose the correct runtime
   recovery actions.
5. The control-center manual form offers both Feishu and Lark and preserves the
   selected brand on submission.

Run the connector setup tests, Web application tests, integration-service
tests, type checking, and the existing Feishu-focused regression set.

## Acceptance Criteria

- A real missing-scope response no longer appears as `unknown`.
- Advanced response modes stay disabled unless capability is confirmed
  available.
- Every permission, restart, and consumer-health degradation shown in the
  control center has a safe next action.
- Manual existing-app setup can select either Feishu or Lark.
- No recovery action automatically changes or publishes external application
  permissions.
- Raw CLI output, credentials, tokens, and consumer errors never reach the
  rendered page.
