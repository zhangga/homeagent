# Machine Provider CLI Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HomeAgent resolve Codex, Claude Code, and TRAE from the host machine's executable `PATH`, never from `<dataDir>/bin` unless an operator explicitly supplies a provider-bin override.

**Architecture:** Keep `packages/llm` as the single Provider resolution seam and stop the bundled composition root from injecting a data-directory Codex path. Preserve explicit environment overrides for controlled deployments and tests, but treat them as ordinary executable paths with the CLI's normal authentication behavior. Make the macOS LaunchAgent merge standard machine executable directories into its persisted `PATH`, and keep the setup UI honest by guiding users to install machine CLIs instead of offering the app-managed downloader.

**Tech Stack:** Bun workspace, TypeScript ESM, Hono server-rendered UI, Bun test, macOS LaunchAgent plist.

---

### Task 1: Lock machine-level Provider resolution at the composition root

**Files:**
- Modify: `packages/app/src/main.ts`
- Test: `packages/app/src/main.test.ts`

- [x] **Step 1: Write the failing runtime-environment test**

Add a test around an exported environment helper that supplies bundled data/log paths without creating `HOMEAGENT_CODEX_BIN`:

```ts
const environment: NodeJS.ProcessEnv = {};
configureRuntimeEnvironment({
  bundled: true,
  dataDir: "/Users/test/HomeAgentData",
  logDir: "/Users/test/Library/Logs/HomeAgent",
}, environment);
expect(environment.HOMEAGENT_DATA_DIR).toBe("/Users/test/HomeAgentData");
expect(environment.HOMEAGENT_LOG_DIR).toBe("/Users/test/Library/Logs/HomeAgent");
expect(environment.HOMEAGENT_CODEX_BIN).toBeUndefined();
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `bun test packages/app/src/main.test.ts`

Expected: FAIL because `configureRuntimeEnvironment` does not exist and bundled startup still assigns `<dataDir>/bin/codex`.

- [x] **Step 3: Implement the runtime seam and remove managed Codex wiring**

Add the helper, call it from `runEntrypoint`, construct `CodexProviderSetup` with its default `codex` executable, use `Bun.which("codex")` for installation presence, and remove the managed-install interface, `CodexReleaseInstaller`, and `isUsableManagedExecutable`.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `bun test packages/app/src/main.test.ts`

Expected: PASS with no data-directory Provider override.

### Task 2: Preserve machine executable directories in the macOS service

**Files:**
- Modify: `packages/app/src/service.ts`
- Test: `packages/app/src/service.test.ts`

- [x] **Step 1: Write the failing LaunchAgent PATH regression test**

Extend the bundled service test so an inherited `PATH=/usr/bin:/bin` still produces a plist containing `/opt/homebrew/bin`, `/usr/local/bin`, and the user's `.local/bin`, without duplicate entries.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `bun test packages/app/src/service.test.ts`

Expected: FAIL because the current implementation uses any inherited PATH verbatim and discards the standard machine directories.

- [x] **Step 3: Implement deterministic PATH merging**

Build the service PATH from the inherited entries followed by unique standard executable directories:

```ts
[
  ...inheritedPathEntries,
  join(homeDir, ".local", "bin"),
  join(homeDir, ".bun", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
]
```

Keep ordering stable and omit empty/duplicate entries.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `bun test packages/app/src/service.test.ts`

Expected: PASS and the bundled plist can resolve common machine-installed CLIs.

### Task 3: Use normal machine Codex authentication semantics

**Files:**
- Modify: `packages/llm/src/provider-setup.ts`
- Modify: `packages/llm/src/providers.ts`
- Test: `packages/llm/src/provider-setup.test.ts`
- Test: `packages/llm/src/providers.test.ts`

- [x] **Step 1: Update tests to require normal CLI argv**

Change Codex login/status expectations from the app-managed keyring override to the machine CLI's native commands:

```ts
["codex", "login", "--device-auth"]
["codex", "login", "status"]
```

Retain coverage that an explicit `HOMEAGENT_CODEX_BIN` path is executed exactly, but do not let that path silently change credential-store behavior.

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `bun test packages/llm/src/provider-setup.test.ts packages/llm/src/providers.test.ts`

Expected: FAIL while `MANAGED_CODEX_AUTH_ARGS` is still injected.

- [x] **Step 3: Remove managed authentication arguments**

Make provider detection and device login call the selected machine executable with its normal `login` commands. Keep restricted Provider execution flags unchanged so user rules, hooks, plugins, history, permissions, and Workdir remain governed by HomeAgent's frozen execution contract.

- [x] **Step 4: Run the focused tests and verify they pass**

Run: `bun test packages/llm/src/provider-setup.test.ts packages/llm/src/providers.test.ts`

Expected: PASS.

### Task 4: Make setup copy and recovery paths match machine CLI ownership

**Files:**
- Modify: `packages/web/src/setup-view.ts`
- Test: `packages/web/src/setup-view.test.ts`

- [x] **Step 1: Write failing setup-view assertions**

Assert that a missing Provider shows machine-install guidance for both Codex and Claude, never mentions a HomeAgent-specific directory, and that an installed-but-disconnected Codex still exposes the ChatGPT device-login action even when Claude is already available.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `bun test packages/web/src/setup-view.test.ts`

Expected: FAIL because the existing view advertises app-managed installation and hides Codex recovery when another ordinary Provider is available.

- [x] **Step 3: Implement machine-owned setup behavior**

Render concise install commands plus “重新检测” for missing machine CLIs. Render only the ChatGPT login flow when `codex` exists, and include that flow below the ordinary Provider picker when Codex is installed but not authenticated.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `bun test packages/web/src/setup-view.test.ts`

Expected: PASS.

### Task 5: Synchronize operator and release contracts

**Files:**
- Modify: `README.md`
- Modify: `docs/beta-release-runbook.md`
- Modify: `scripts/smoke-macos-bundle.ts`

- [x] **Step 1: Replace managed-install claims**

Document that HomeAgent discovers `codex`, `claude`, and `trae-cli` from the service PATH; the user or machine administrator owns installation, upgrades, and CLI authentication; HomeAgent does not place Provider executables in the data directory.

- [x] **Step 2: Update release gates**

Change the clean-machine DMG gate and bundle smoke assertions to install/authenticate at least one supported machine Provider as an explicit prerequisite, verify the LaunchAgent can resolve it after login/restart, and verify `<dataDir>/bin` is not used for Provider discovery.

- [x] **Step 3: Validate documentation consistency**

Run:

```bash
rg -n "安装并连接 ChatGPT|专用数据目录|受托管的 Codex|dataDir.*bin.*codex|HOMEAGENT_CODEX_BIN" README.md docs/beta-release-runbook.md packages/app/src/main.ts
```

Expected: no stale product claim or automatic data-directory override remains.

### Task 6: Final verification

**Files:**
- Verify all modified files.

- [x] **Step 1: Run focused regressions**

Run:

```bash
bun test packages/app/src/main.test.ts packages/app/src/service.test.ts packages/llm/src/provider-setup.test.ts packages/llm/src/providers.test.ts packages/web/src/setup-view.test.ts
```

Expected: PASS.

- [x] **Step 2: Run type checking**

Run: `bun run typecheck`

Expected: PASS.

- [x] **Step 3: Run the supported-host full suite**

Run: `bun test`

Expected: PASS on the current macOS host.

- [ ] **Step 4: Re-run the live read-only readiness probe after restart when authorized**

Use the existing Agent page or Provider detection command to confirm the machine `/opt/homebrew/bin/codex` reports `available: true`. Do not mutate the live HomeAgent data directory.
