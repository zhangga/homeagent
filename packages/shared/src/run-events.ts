export type RunEventKind =
  | "run.queued"
  | "run.started"
  | "phase.started"
  | "phase.completed"
  | "tool.started"
  | "tool.completed"
  | "assistant.delta"
  | "assistant.snapshot"
  | "delivery.started"
  | "delivery.updated"
  | "delivery.failed"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "run.timed_out"
  | "run.recovered";

export type RunEventVisibility = "public" | "operator";
export type RunEventPhase = "queue" | "prepare" | "provider" | "tool" | "answer" | "delivery";
export type RunEventStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type PublicToolKind = "command" | "file-change" | "mcp" | "web-search";
export type PublicToolStatus = "running" | "completed" | "failed" | "unknown";

export interface PublicLarkExecutionEvidence {
  operation: string;
  requestedIdentity: "user" | "bot" | "unspecified";
  reportedIdentity?: "user" | "bot";
  ok?: boolean;
  count?: number;
  hasMore?: boolean;
}

export interface PublicRunTool {
  type: PublicToolKind;
  status: PublicToolStatus;
  durationMs?: number;
  exitCode?: number;
  lark?: PublicLarkExecutionEvidence;
}

export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  seq: number;
  at: number;
  kind: RunEventKind;
  visibility: RunEventVisibility;
  phase?: RunEventPhase;
  status?: RunEventStatus;
  title: string;
  detail?: string;
  delta?: string;
  tool?: PublicRunTool;
}

export type NewRunEvent = Omit<RunEvent, "schemaVersion" | "seq"> & {
  schemaVersion?: 1;
};

export interface ProviderProgressEvent {
  kind: "phase" | "tool" | "assistant_delta" | "assistant_snapshot";
  at: number;
  title: string;
  detail?: string;
  delta?: string;
  visibility?: RunEventVisibility;
  phase?: RunEventPhase;
  tool?: PublicRunTool;
}
