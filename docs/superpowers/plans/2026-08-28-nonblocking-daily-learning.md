# Non-blocking Daily Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep daily learning plans moving when yesterday's lesson was unanswered, while letting a learner target one of several plans and explicitly opt into changing the next lesson.

**Architecture:** Preserve the durable one-current-session-per-plan model. At the next scheduled delivery window, atomically mark the prior unanswered session skipped before preparing the next lesson; failed preparation remains retryable. Route answers by an explicit `[计划名称]` selector when several plans are awaiting, and apply adaptive focus/route changes only when the answer contains a bounded `下一课要求：...` field.

**Tech Stack:** Bun, TypeScript ESM, adjacent `bun:test` tests, JSON durable learning store.

---

### Task 1: Lock down the daily rollover contract

**Files:**
- Modify: `packages/app/src/learning-scheduler.test.ts`
- Modify: `packages/core/src/learning.test.ts`

- [ ] **Step 1: Write the failing scheduler test**

Add a test that delivers lesson 1, advances the clock to the next configured day, queues lesson 2, and expects one scheduler tick to mark lesson 1 `skipped` and deliver lesson 2 as `awaiting_reply`.

```ts
test("archives an unanswered lesson and delivers the next day's lesson", async () => {
  const created = seedPlan(engine);
  llm.queueText("## 今日目标\n理解第一章");
  const scheduler = new LearningScheduler(engine, { notify: async () => {} });
  await scheduler.tick("day-one", NOW);
  const first = engine.learning.currentSession(created.id)!;

  llm.queueText("## 今日目标\n理解第二章");
  const tomorrow = new Date("2026-07-16T10:00:00+08:00");
  expect(await scheduler.tick("day-two", tomorrow)).toEqual([created.id]);
  expect(engine.learning.sessionsForPlan(created.id)).toEqual([
    expect.objectContaining({ id: first.id, status: "skipped" }),
    expect.objectContaining({ sequence: 2, status: "awaiting_reply" }),
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify the new test fails**

Run: `bun test packages/app/src/learning-scheduler.test.ts packages/core/src/learning.test.ts`

Expected: FAIL because an `awaiting_reply` session currently prevents a second lesson.

- [ ] **Step 3: Add a durable rollover operation**

In `LearningPlanStore`, add an expected-session-id guarded method:

```ts
advanceUnanswered(
  planId: string,
  sessionId: string,
  completedAt = Date.now(),
): LearningSession | undefined
```

It must accept only the plan's current `awaiting_reply` session, clone candidate maps, set the session to `skipped`, set `completedAt`, advance the reading cursor or topic route, persist atomically, then swap in the candidate maps.

- [ ] **Step 4: Run the store tests**

Run: `bun test packages/core/src/learning.test.ts`

Expected: PASS, including reopen/recovery assertions for the auto-advanced session.

### Task 2: Schedule rollover before delivery

**Files:**
- Modify: `packages/app/src/learning-scheduler.ts`
- Modify: `packages/app/src/learning-scheduler.test.ts`

- [ ] **Step 1: Add a pure eligibility helper**

```ts
export function shouldAdvanceUnansweredLearningPlan(
  plan: LearningPlan,
  current: LearningSession | undefined,
  now: Date,
): boolean
```

Return true only for an active plan whose current session is `awaiting_reply`, whose delivery date is before today's local day, and whose configured local hour has arrived.

- [ ] **Step 2: Make stale unanswered sessions due**

Update `shouldRunLearningPlan` so a prior-day `awaiting_reply` session is due after the configured hour, while a same-day one remains blocked.

- [ ] **Step 3: Roll over inside the serialized background run**

Before `deliverLearningSession`, call `advanceUnanswered(plan.id, current.id, now.getTime())` only when the helper is true. Keep prepared-session retry behavior unchanged. Evaluate lesson delivery before friendly follow-up so a stale answer cannot replace the next scheduled lesson with a nudge.

- [ ] **Step 4: Verify delivery and retry behavior**

Run: `bun test packages/app/src/learning-scheduler.test.ts`

Expected: PASS; same-day retries keep one idempotency key, next-day rollover emits the next lesson, and paused/assessment plans remain blocked.

### Task 3: Route answers to a named plan

**Files:**
- Modify: `packages/orchestrator/src/learning-commands.ts`
- Modify: `packages/orchestrator/src/learning-commands.test.ts`
- Modify: `packages/orchestrator/src/runtime.test.ts`

- [ ] **Step 1: Add failing multi-plan answer tests**

Cover these forms:

```text
学习回答：[三年级每日一题思维成长计划] 我的回答
学习回答：[恰到好处的敏感] 我的回答
```

When several plans await, a bare answer must return plan-specific examples instead of requiring the learner to delete or finish other plans. A named answer must complete only that plan.

- [ ] **Step 2: Parse the selector without weakening the explicit prefix**

Keep `parseLearningAnswer` limited to messages beginning with `学习回答：`. In `handleLearningAnswer`, recognize a leading bounded `[计划名称]`, match it case-insensitively against owned candidates, and strip it from the submitted answer. Preserve the legacy bare form when exactly one candidate exists.

- [ ] **Step 3: Run command and runtime tests**

Run: `bun test packages/orchestrator/src/learning-commands.test.ts packages/orchestrator/src/runtime.test.ts`

Expected: PASS; ordinary chat still cannot advance learning state.

### Task 4: Make next-lesson adaptation explicit

**Files:**
- Modify: `packages/core/src/learning.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/learning-engine.test.ts`
- Modify: `packages/orchestrator/src/learning-commands.ts`
- Modify: `packages/orchestrator/src/learning-commands.test.ts`

- [ ] **Step 1: Add failing opt-in tests**

Test that a normal `review` answer records feedback but advances to the next scheduled segment/step without changing `adaptiveFocus`, profile, or route. Test that adding `下一课要求：用图示重新讲解` preserves the existing adaptive review behavior and stores the bounded request.

- [ ] **Step 2: Extend durable session evidence**

Add optional `nextLessonRequest` and `nextLessonAdjusted` fields to `LearningSession`. Validate the request as a non-empty string no longer than 1,000 characters, clone it at store seams, and keep legacy sessions valid.

- [ ] **Step 3: Thread an explicit option through feedback completion**

Extend `answerLearningSession` with an optional `{ nextLessonRequest?: string }` argument. Include the request in a separate trusted prompt section only when present. Pass adaptive topic updates and retain a `review` step only when that option is present; otherwise keep the feedback/mastery evidence but advance the plan and clear one-shot adaptive focus.

- [ ] **Step 4: Parse and bound `下一课要求`**

Support a separate line after the answer:

```text
学习回答：[计划名称] 我的回答
下一课要求：请增加图示并放慢节奏
```

Reject an empty or over-1,000-character request with fixed Chinese copy before invoking the Provider.

- [ ] **Step 5: Verify learning engine behavior**

Run: `bun test packages/core/src/learning-engine.test.ts packages/orchestrator/src/learning-commands.test.ts`

Expected: PASS; verified `ready` evidence still enters Raw, `review` evidence still stays out, and only explicit next-lesson requests mutate future lesson shape.

### Task 5: Update learner-facing copy and validate

**Files:**
- Modify: `packages/app/src/learning-scheduler.ts`
- Modify: `README.md`

- [ ] **Step 1: Update lesson instructions**

Each pushed lesson must show the exact plan-qualified answer form, state that no answer is required to receive tomorrow's lesson, and document the optional `下一课要求：...` line.

- [ ] **Step 2: Synchronize README behavior**

Replace the old “wait for an answer and follow up” contract with daily rollover semantics, named-plan answers, and explicit opt-in next-lesson adaptation. Preserve the existing unrelated README edits.

- [ ] **Step 3: Run focused and repository validation**

Run:

```bash
bun test packages/core/src/learning.test.ts packages/core/src/learning-engine.test.ts packages/app/src/learning-scheduler.test.ts packages/orchestrator/src/learning-commands.test.ts packages/orchestrator/src/runtime.test.ts
bun run typecheck
bun test
```

Expected: all commands pass on macOS. Live Feishu delivery is not run because the task does not authorize a live mutation.

- [ ] **Step 4: Commit only the scoped files if explicitly requested**

The worktree already contains unrelated user changes, so do not create a commit unless the user asks. If requested, stage only the files listed in this plan and inspect `git diff --cached` before committing.
