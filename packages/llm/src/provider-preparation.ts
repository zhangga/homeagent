/** Fixed, local diagnostic facts: no paths, commands, credentials or provider output. */
export const NATIVE_SESSION_ISSUES = [
  "windows-elevated-sandbox-required", "protected-root-readable", "codex-home-readable",
  "allowed-path-unreadable", "filesystem-probe-timeout", "filesystem-probe-failed",
  "native-cli-unavailable", "mcp-not-isolated", "invalid-execution-contract",
] as const;
export type NativeSessionIssue = typeof NATIVE_SESSION_ISSUES[number];
export type ProviderPreparationFailure =
  | { stage: "native-session"; reason: NativeSessionIssue; exitCode?: number }
  | { stage: "skill-staging"; reason: "capacity-exceeded"; requestedSkills: number; stagedSkills: number };

export const NATIVE_SESSION_ISSUE_LABELS: Record<NativeSessionIssue, string> = {
  "windows-elevated-sandbox-required": "Windows elevated 安全沙箱尚未就绪",
  "protected-root-readable": "受保护数据目录仍可读取，根目录拒绝规则未通过验证",
  "codex-home-readable": "隔离的 Codex 状态目录仍可读取",
  "allowed-path-unreadable": "已授权测试目录无法读取",
  "filesystem-probe-timeout": "文件隔离测试超时",
  "filesystem-probe-failed": "文件隔离测试进程失败",
  "native-cli-unavailable": "Codex 版本或原生 fork 能力检查未通过",
  "mcp-not-isolated": "有效 MCP 列表未能验证为空",
  "invalid-execution-contract": "冻结执行配置或路径未通过隔离验证",
};

export function isProviderPreparationFailure(value: unknown): value is ProviderPreparationFailure {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.stage === "native-session") {
    return Object.keys(item).every(key => ["stage", "reason", "exitCode"].includes(key))
      && NATIVE_SESSION_ISSUES.some(reason => reason === item.reason)
      && (item.exitCode === undefined || (typeof item.exitCode === "number"
        && Number.isSafeInteger(item.exitCode) && Math.abs(item.exitCode) <= 2147483648));
  }
  return item.stage === "skill-staging" && item.reason === "capacity-exceeded"
    && Object.keys(item).every(key => ["stage", "reason", "requestedSkills", "stagedSkills"].includes(key))
    && typeof item.requestedSkills === "number" && Number.isInteger(item.requestedSkills)
    && item.requestedSkills >= 1 && item.requestedSkills <= 2_000
    && typeof item.stagedSkills === "number" && Number.isInteger(item.stagedSkills)
    && item.stagedSkills >= 0 && item.stagedSkills < item.requestedSkills;
}

export class ProviderPreparationError extends Error {
  readonly evidence: Readonly<ProviderPreparationFailure>;
  constructor(evidence: ProviderPreparationFailure) {
    if (!isProviderPreparationFailure(evidence)) throw new Error("Invalid Provider preparation evidence");
    super(evidence.stage === "native-session"
      ? `provider codex native session isolation is unavailable (${evidence.reason})`
      : "provider Skill staging capacity exceeded; frozen catalog was not executed");
    this.name = "ProviderPreparationError";
    this.evidence = Object.freeze(structuredClone(evidence));
  }
}

export function providerPreparationFailure(error: unknown): ProviderPreparationFailure | undefined {
  return error instanceof ProviderPreparationError && isProviderPreparationFailure(error.evidence)
    ? structuredClone(error.evidence) : undefined;
}

// The complete catalog has a separate aggregate ceiling from each 16 MiB bundle.
// Capture/verify one bundle at a time; fail the whole invocation at capacity.
export const SKILL_STAGING_MAX_BYTES = 128 * 1024 * 1024;
export const SKILL_STAGING_MAX_ENTRIES = 200_000;
export class SkillStagingBudget {
  private bytes = 0;
  private entries = 0;
  private staged = 0;
  constructor(private readonly requested: number) {
    if (!Number.isInteger(requested) || requested < 1 || requested > 2_000) throw new Error("Invalid Skill count");
  }
  reserve(bytes: number, entries: number): void {
    if (![bytes, entries].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid Skill size");
    if (this.staged >= this.requested) throw new Error("Invalid Skill count");
    if (this.bytes + bytes > SKILL_STAGING_MAX_BYTES || this.entries + entries > SKILL_STAGING_MAX_ENTRIES) {
      throw new ProviderPreparationError({ stage: "skill-staging", reason: "capacity-exceeded", requestedSkills: this.requested, stagedSkills: this.staged });
    }
    this.bytes += bytes;
    this.entries += entries;
    this.staged++;
  }
}
