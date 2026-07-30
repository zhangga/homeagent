import type { FeishuConnectionProgress } from "./feishu-connection-progress.ts";

const FAILURE_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000] as const;
const BOT_STAGES = new Set([
  "not_configured",
  "not_verified",
  "restart_required",
  "runtime_unhealthy",
  "ready",
]);
const GROUP_STAGES = new Set([
  "waiting_confirmation",
  "ready_to_test",
  "complete",
  "needs_reconnect",
  "disconnected",
]);
const HEALTH_STATES = new Set(["healthy", "limited", "degraded"]);
const CAPABILITY_STATES = new Set(["available", "unavailable", "unknown"]);
const NEXT_ACTIONS = new Set([
  "connect_bot",
  "verify_bot",
  "restart_runtime",
  "recover_runtime",
  "connect_group",
  "reconnect_group",
  "test_group",
  "wait_for_confirmation",
  "none",
]);
const GROUP_ACTIONS = new Set([
  "reconnect_group",
  "test_group",
  "wait_for_confirmation",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeSpaceId(
  value: unknown,
): FeishuConnectionProgress["groups"][number]["spaceId"] | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value as FeishuConnectionProgress["groups"][number]["spaceId"]
    : undefined;
}

export function parseFeishuConnectionProgress(
  value: unknown,
): FeishuConnectionProgress | undefined {
  const input = record(value);
  const bot = record(input?.bot);
  const nextAction = record(input?.nextAction);
  if (
    !input
    || !bot
    || !nextAction
    || input.version !== 1
    || typeof input.revision !== "string"
    || input.revision.length === 0
    || input.revision.length > 128
    || !BOT_STAGES.has(bot?.stage as string)
    || !HEALTH_STATES.has(bot?.health as string)
    || !CAPABILITY_STATES.has(bot?.capability as string)
    || !Array.isArray(input.groups)
    || input.groups.length > 1_000
    || !NEXT_ACTIONS.has(nextAction?.kind as string)
  ) {
    return undefined;
  }
  const pollAfterMs = input.pollAfterMs;
  if (
    pollAfterMs !== undefined
    && (
      !Number.isInteger(pollAfterMs)
      || (pollAfterMs as number) < 1_000
      || (pollAfterMs as number) > 300_000
    )
  ) {
    return undefined;
  }
  const groups: FeishuConnectionProgress["groups"] = [];
  const spaces = new Set<string>();
  for (const candidate of input.groups) {
    const group = record(candidate);
    const spaceId = safeSpaceId(group?.spaceId);
    const completedAt = group?.completedAt;
    if (
      !group
      || !spaceId
      || spaces.has(spaceId)
      || !GROUP_STAGES.has(group.stage as string)
      || !HEALTH_STATES.has(group.health as string)
      || (
        completedAt !== undefined
        && (
          typeof completedAt !== "number"
          || !Number.isFinite(completedAt)
          || completedAt < 0
        )
      )
    ) {
      return undefined;
    }
    spaces.add(spaceId);
    groups.push({
      spaceId,
      stage: group.stage as FeishuConnectionProgress["groups"][number]["stage"],
      health: group.health as FeishuConnectionProgress["groups"][number]["health"],
      ...(completedAt === undefined
        ? {}
        : { completedAt }),
    });
  }
  const actionKind = nextAction.kind as FeishuConnectionProgress["nextAction"]["kind"];
  const actionSpace = nextAction.spaceId === undefined
    ? undefined
    : safeSpaceId(nextAction.spaceId);
  if (
    (nextAction.spaceId !== undefined && !actionSpace)
    || (GROUP_ACTIONS.has(actionKind) && (!actionSpace || !spaces.has(actionSpace)))
  ) {
    return undefined;
  }
  return {
    version: 1,
    revision: input.revision,
    ...(pollAfterMs === undefined
      ? {}
      : { pollAfterMs: pollAfterMs as number }),
    bot: {
      stage: bot.stage as FeishuConnectionProgress["bot"]["stage"],
      health: bot.health as FeishuConnectionProgress["bot"]["health"],
      capability: bot.capability as FeishuConnectionProgress["bot"]["capability"],
    },
    groups,
    nextAction: {
      kind: actionKind,
      ...(actionSpace === undefined ? {} : { spaceId: actionSpace }),
    },
  };
}

export interface FeishuProgressView {
  setRoot(input: {
    revision: string;
    pollAfterMs?: number;
    nextAction: FeishuConnectionProgress["nextAction"]["kind"];
    spaceId?: string;
  }): void;
  setSummary(input: { title: string; description: string }): void;
  showAction(kind: FeishuConnectionProgress["nextAction"]["kind"]): void;
  setBot(bot: FeishuConnectionProgress["bot"]): void;
  setGroup(group: FeishuConnectionProgress["groups"][number]): boolean;
}

const NEXT_ACTION_COPY: Record<
  FeishuConnectionProgress["nextAction"]["kind"],
  { title: string; description: string }
> = {
  connect_bot: {
    title: "连接飞书 Bot",
    description: "先创建或连接 Bot，群聊闭环才可以开始。",
  },
  verify_bot: {
    title: "验证飞书 Bot",
    description: "重新验证当前应用身份和权限后再继续群聊连接。",
  },
  restart_runtime: {
    title: "重启并加载新 Bot",
    description: "当前运行中的消费者仍在使用旧身份，重启后再继续。",
  },
  recover_runtime: {
    title: "恢复飞书消息监听",
    description: "历史连接结果仍然保留；先恢复当前消息消费者。",
  },
  connect_group: {
    title: "连接一个群聊",
    description: "选择 Bot 已加入的群，由群管理员确认后再完成测试。",
  },
  reconnect_group: {
    title: "重新连接群聊",
    description: "Bot 身份已变化，需要由群管理员重新确认后再测试。",
  },
  test_group: {
    title: "发送测试消息",
    description: "管理员已确认启用。显式发送测试消息后完成连接。",
  },
  wait_for_confirmation: {
    title: "等待群管理员确认",
    description: "确认完成后会进入待测试状态，不会自动发送测试消息。",
  },
  none: {
    title: "飞书连接已完成",
    description: "当前群聊已经过成功测试；后续运行异常不会抹除完成记录。",
  },
};

export function applyFeishuProgressToView(
  progress: FeishuConnectionProgress,
  view: FeishuProgressView,
): boolean {
  view.setRoot({
    revision: progress.revision,
    ...(progress.pollAfterMs === undefined
      ? {}
      : { pollAfterMs: progress.pollAfterMs }),
    nextAction: progress.nextAction.kind,
    ...(progress.nextAction.spaceId === undefined
      ? {}
      : { spaceId: progress.nextAction.spaceId }),
  });
  view.setSummary(NEXT_ACTION_COPY[progress.nextAction.kind]);
  view.showAction(progress.nextAction.kind);
  view.setBot(progress.bot);
  return progress.groups.every((group) => view.setGroup(group));
}

export interface FeishuProgressClientOptions {
  initial: FeishuConnectionProgress;
  readProgress(signal: AbortSignal): Promise<unknown>;
  applyProgress(progress: FeishuConnectionProgress): boolean | void;
  setWarning(visible: boolean): void;
  isVisible(): boolean;
  subscribeVisibility(listener: () => void): () => void;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface FeishuProgressClient {
  stop(): void;
}

export function startFeishuProgressClient(
  options: FeishuProgressClientOptions,
): FeishuProgressClient {
  let stopped = false;
  let pollTimer: unknown;
  let failureCount = 0;
  let nextRequestId = 0;
  let activeRequest: {
    id: number;
    controller: AbortController;
    timeout: unknown;
  } | undefined;

  const schedulePoll = (delayMs: number) => {
    if (stopped || !options.isVisible()) return;
    pollTimer = options.schedule(poll, delayMs);
  };

  const failRequest = (requestId: number, timedOut = false) => {
    if (stopped || activeRequest?.id !== requestId) return;
    const request = activeRequest;
    activeRequest = undefined;
    options.cancel(request.timeout);
    if (timedOut) request.controller.abort();
    options.setWarning(true);
    const delay = FAILURE_BACKOFF_MS[
      Math.min(failureCount, FAILURE_BACKOFF_MS.length - 1)
    ]!;
    failureCount += 1;
    schedulePoll(delay);
  };

  const finishRequest = (
    requestId: number,
    progress: FeishuConnectionProgress,
  ) => {
    if (stopped || activeRequest?.id !== requestId) return;
    let applied: boolean | void;
    try {
      applied = options.applyProgress(progress);
    } catch {
      failRequest(requestId);
      return;
    }
    if (applied === false) {
      failRequest(requestId);
      return;
    }
    options.cancel(activeRequest.timeout);
    activeRequest = undefined;
    options.setWarning(false);
    failureCount = 0;
    if (progress.pollAfterMs !== undefined) {
      schedulePoll(progress.pollAfterMs);
    }
  };

  const poll = () => {
    pollTimer = undefined;
    if (stopped || activeRequest || !options.isVisible()) return;
    const requestId = ++nextRequestId;
    const controller = new AbortController();
    activeRequest = {
      id: requestId,
      controller,
      timeout: options.schedule(
        () => failRequest(requestId, true),
        4_000,
      ),
    };
    void Promise.resolve()
      .then(() => options.readProgress(controller.signal))
      .then(
        (value) => {
          const progress = parseFeishuConnectionProgress(value);
          if (!progress) {
            failRequest(requestId);
            return;
          }
          finishRequest(requestId, progress);
        },
        () => {
          failRequest(requestId);
        },
      );
  };

  const unsubscribe = options.subscribeVisibility(() => {
    if (stopped) return;
    if (!options.isVisible()) {
      if (pollTimer !== undefined) options.cancel(pollTimer);
      pollTimer = undefined;
      if (activeRequest) {
        const request = activeRequest;
        activeRequest = undefined;
        options.cancel(request.timeout);
        request.controller.abort();
      }
      return;
    }
    poll();
  });

  if (
    options.initial.pollAfterMs !== undefined
    && options.isVisible()
  ) {
    schedulePoll(options.initial.pollAfterMs);
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== undefined) options.cancel(pollTimer);
      if (activeRequest) {
        options.cancel(activeRequest.timeout);
        activeRequest.controller.abort();
        activeRequest = undefined;
      }
      unsubscribe();
    },
  };
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function feishuProgressBrowserScript(
  initial: FeishuConnectionProgress,
): string {
  const safeInitial = parseFeishuConnectionProgress(initial);
  if (!safeInitial) return "";
  const botCopy = {
    not_configured: "尚未配置",
    not_verified: "等待验证",
    restart_required: "需要重启",
    runtime_unhealthy: "消息监听异常",
    ready: "正在运行",
  };
  const groupCopy = {
    waiting_confirmation: "等待群管理员确认",
    ready_to_test: "等待测试",
    complete: "连接已验证",
    needs_reconnect: "需要重新确认",
    disconnected: "已断开",
  };
  const healthCopy = {
    healthy: "",
    limited: "当前能力受限",
    degraded: "当前运行异常",
  };
  return `(function(initial){
var FAILURE_BACKOFF_MS=${inlineJson(FAILURE_BACKOFF_MS)};
var BOT_STAGES=new Set(${inlineJson([...BOT_STAGES])});
var GROUP_STAGES=new Set(${inlineJson([...GROUP_STAGES])});
var HEALTH_STATES=new Set(${inlineJson([...HEALTH_STATES])});
var CAPABILITY_STATES=new Set(${inlineJson([...CAPABILITY_STATES])});
var NEXT_ACTIONS=new Set(${inlineJson([...NEXT_ACTIONS])});
var GROUP_ACTIONS=new Set(${inlineJson([...GROUP_ACTIONS])});
var NEXT_ACTION_COPY=${inlineJson(NEXT_ACTION_COPY)};
var BOT_COPY=${inlineJson(botCopy)};
var GROUP_COPY=${inlineJson(groupCopy)};
var HEALTH_COPY=${inlineJson(healthCopy)};
${record.toString()}
${safeSpaceId.toString()}
${parseFeishuConnectionProgress.toString()}
${applyFeishuProgressToView.toString()}
${startFeishuProgressClient.toString()}
var root=document.querySelector("[data-feishu-progress-root]");
if(!root)return;
var warning=document.querySelector("[data-feishu-refresh-warning]");
function findGroup(spaceId){
  var cards=document.querySelectorAll("[data-space-id]");
  for(var index=0;index<cards.length;index+=1){
    if(cards[index].dataset.spaceId===spaceId)return cards[index];
  }
}
function text(slot,value){
  if(slot)slot.textContent=value;
}
var view={
  setRoot:function(state){
    root.dataset.feishuRevision=state.revision;
    root.dataset.feishuNextAction=state.nextAction;
    root.dataset.nextSpace=state.spaceId||"";
    if(state.pollAfterMs===undefined)delete root.dataset.pollAfter;
    else root.dataset.pollAfter=String(state.pollAfterMs);
  },
  setSummary:function(summary){
    text(root.querySelector("[data-feishu-title]"),summary.title);
    text(root.querySelector("[data-feishu-description]"),summary.description);
  },
  showAction:function(kind){
    var actions=root.querySelectorAll("[data-feishu-action]");
    for(var index=0;index<actions.length;index+=1){
      actions[index].hidden=actions[index].dataset.feishuAction!==kind;
    }
  },
  setBot:function(bot){
    var card=document.querySelector("[data-feishu-bot]");
    if(!card)return;
    card.dataset.feishuStage=bot.stage;
    card.dataset.feishuHealth=bot.health;
    card.dataset.feishuCapability=bot.capability;
    text(card.querySelector("[data-feishu-bot-stage]"),BOT_COPY[bot.stage]);
  },
  setGroup:function(group){
    var card=findGroup(group.spaceId);
    if(!card)return false;
    card.dataset.feishuStage=group.stage;
    card.dataset.completedAt=group.completedAt===undefined?"":String(group.completedAt);
    var stage=card.querySelector("[data-feishu-group-stage]");
    text(stage,GROUP_COPY[group.stage]);
    var completed=card.querySelector("[data-feishu-group-completed]");
    if(completed){
      completed.hidden=group.completedAt===undefined;
      text(completed,group.completedAt===undefined?"":"验证于 "+new Date(group.completedAt).toISOString());
    }
    var health=card.querySelector("[data-feishu-group-health]");
    if(health){
      health.hidden=group.health==="healthy";
      text(health,HEALTH_COPY[group.health]);
    }
    var testAction=card.querySelector("[data-feishu-poll-test]");
    if(testAction)testAction.hidden=group.stage!=="ready_to_test";
    return true;
  }
};
function setWarning(visible){
  if(warning)warning.hidden=!visible;
}
document.addEventListener("click",function(event){
  var target=event.target instanceof Element
    ? event.target.closest("[data-feishu-scroll-group]")
    : null;
  if(!target)return;
  var card=findGroup(root.dataset.nextSpace||"");
  if(card)card.scrollIntoView({behavior:"smooth",block:"center"});
});
startFeishuProgressClient({
  initial:initial,
  readProgress:function(signal){
    return fetch("/integrations/progress",{
      cache:"no-store",
      credentials:"same-origin",
      headers:{"accept":"application/json"},
      signal:signal
    }).then(function(response){
      if(!response.ok)throw new Error("progress unavailable");
      return response.json();
    });
  },
  applyProgress:function(progress){
    return applyFeishuProgressToView(progress,view);
  },
  setWarning:setWarning,
  isVisible:function(){return !document.hidden;},
  subscribeVisibility:function(listener){
    document.addEventListener("visibilitychange",listener);
    return function(){document.removeEventListener("visibilitychange",listener);};
  },
  schedule:function(callback,delay){return window.setTimeout(callback,delay);},
  cancel:function(handle){window.clearTimeout(handle);}
});
})(${inlineJson(safeInitial)});`;
}
