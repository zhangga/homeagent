import { expect, test } from "bun:test";
import { ProviderRunError, ProviderPreparationError } from "@homeagent/llm";
import {
  MODEL_CAPACITY_NOTICE,
  NATIVE_SESSION_UNAVAILABLE_NOTICE,
  NO_PROVIDER_NOTICE,
  NO_TOOLS_MODE_NOTICE,
  PROVIDER_LOGIN_EXPIRED_NOTICE,
  UNSUPPORTED_IMAGE_NOTICE,
  providerNotice,
} from "./messages.ts";

test("full permission rejection is distinct from a failed host sandbox probe", () => {
  const notice = providerNotice(new Error("provider codex native session rejects full permission"));
  expect(notice).toContain("full 权限");
  expect(notice).toContain("未调用模型，也未降级");
  expect(notice).toContain("发布配置");
  expect(notice).not.toContain("当前设备无法");
});

test("a failed root-deny proof has a precise notice, not login or setup advice", () => {
  const notice = providerNotice(new ProviderPreparationError({ stage: "native-session", reason: "protected-root-readable", exitCode: 75 }));
  expect(notice).toContain("受保护数据目录仍可读取");
  expect(notice).toContain("检查退出码 75");
  expect(notice).toContain("不是登录失败");
  expect(notice).not.toContain("完成 Windows 安全沙箱设置");
  const capacity = providerNotice(new ProviderPreparationError({ stage: "skill-staging", reason: "capacity-exceeded", requestedSkills: 112, stagedSkills: 55 }));
  expect(capacity).toContain("没有使用删减后的目录");
});

test("provider notices explain fail-closed no-tools and visual boundaries", () => {
  expect(providerNotice(
    new Error("provider trae-cli cannot provide a no-tools execution mode"),
  )).toBe(NO_TOOLS_MODE_NOTICE);
  expect(NO_TOOLS_MODE_NOTICE).toContain("TRAE 当前只用于显式任务执行");
  expect(NO_TOOLS_MODE_NOTICE).toContain("Claude 或 Codex");
  expect(UNSUPPORTED_IMAGE_NOTICE).not.toContain("切换到 Codex");
});

test("provider notices expose an allowlisted model-capacity reason", () => {
  const error = new ProviderRunError(
    "codex",
    "provider codex returned Selected model is at capacity. Please try a different model.",
    { costBasis: "unavailable", source: "codex-jsonl" },
  );

  expect(providerNotice(error)).toBe(MODEL_CAPACITY_NOTICE);
  expect(MODEL_CAPACITY_NOTICE).toContain("当前模型容量已满");
  expect(MODEL_CAPACITY_NOTICE).toContain(
    "Selected model is at capacity. Please try a different model.",
  );
});

test("provider notices do not expose unclassified diagnostics", () => {
  const diagnostic = "provider failed with token secret-value at /private/path";

  expect(providerNotice(new Error(diagnostic))).toBe(NO_PROVIDER_NOTICE);
  expect(providerNotice(new Error(diagnostic))).not.toContain("secret-value");
});

test("a revoked local login is reported as a re-login, not a wiring problem", () => {
  // Verbatim text observed from codex-cli when the ambient refresh token was
  // rotated by a console re-login, wrapped exactly as runProviderDetailed does.
  const error = new ProviderRunError(
    "codex",
    "provider codex returned Your access token could not be refreshed because"
      + " your refresh token was revoked. Please log out and sign in again.",
    { costBasis: "unavailable", source: "codex-jsonl" },
  );

  expect(providerNotice(error)).toBe(PROVIDER_LOGIN_EXPIRED_NOTICE);
  expect(providerNotice(error)).not.toBe(NO_PROVIDER_NOTICE);
  expect(PROVIDER_LOGIN_EXPIRED_NOTICE).toContain("codex login");
  // The old copy sent operators to the management backend, which cannot fix an
  // expired CLI credential.
  expect(PROVIDER_LOGIN_EXPIRED_NOTICE).not.toContain("管理后台");
});

test("login-expiry classification covers the common upstream phrasings", () => {
  for (const message of [
    "provider codex returned invalid_grant",
    "provider codex returned 401 Unauthorized",
    "Please log out and sign in again",
  ]) {
    expect(providerNotice(new Error(message))).toBe(PROVIDER_LOGIN_EXPIRED_NOTICE);
  }
});

test("login-expiry classification does not swallow unrelated failures", () => {
  // "refresh" alone must not be enough, or ordinary errors would be misreported
  // as an expired login and send the operator to re-authenticate for nothing.
  for (const message of [
    "provider codex returned failed to refresh the knowledge index",
    "provider codex returned turn.failed",
  ]) {
    expect(providerNotice(new Error(message))).toBe(NO_PROVIDER_NOTICE);
  }
});

test("a failed native-session gate is reported as a config fix, not a connection check", () => {
  // Verbatim preflight error observed on a Feishu group turn whose Agent was
  // still configured with `full` permission.
  const error = new Error(
    "provider codex native session isolation is unavailable",
  );

  expect(providerNotice(error)).toBe(NATIVE_SESSION_UNAVAILABLE_NOTICE);
  expect(providerNotice(error)).not.toBe(NO_PROVIDER_NOTICE);
  // The operator has to change the Agent permission; the old copy sent them to
  // verify Agent/Provider connection status, which cannot fix this.
  expect(NATIVE_SESSION_UNAVAILABLE_NOTICE).toContain("full");
  expect(NATIVE_SESSION_UNAVAILABLE_NOTICE).toContain("write");
  expect(NATIVE_SESSION_UNAVAILABLE_NOTICE).toContain("Windows 沙箱是否就绪");
  expect(NATIVE_SESSION_UNAVAILABLE_NOTICE).toContain("不能据此判断账号未登录");
  expect(NATIVE_SESSION_UNAVAILABLE_NOTICE).not.toContain("Provider 连接状态");
  expect(NATIVE_SESSION_UNAVAILABLE_NOTICE).not.toContain("codex login");
});

test("native-session classification keeps other provider failures distinct", () => {
  // A Claude native-session rejection uses different wording and must not be
  // reported as a Codex permission problem.
  expect(providerNotice(new Error(
    "provider claude cannot provide a no-tools execution mode",
  ))).toBe(NO_TOOLS_MODE_NOTICE);
  // "isolation" alone must not be enough, or unrelated errors would send the
  // operator to change Agent permissions for nothing.
  for (const message of [
    "provider codex returned isolation probe warning",
    "provider codex native session id is invalid",
  ]) {
    expect(providerNotice(new Error(message))).toBe(NO_PROVIDER_NOTICE);
  }
});
