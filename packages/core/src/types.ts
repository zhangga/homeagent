/**
 * Core-internal types layered on the shared domain vocabulary. Options bags for
 * the Knowledge seam live here so the interface file stays declarative.
 */
import type { ImageInput, NativeSessionRequest } from "@homeagent/llm";
import type { DreamReport, SpaceId } from "@homeagent/shared";
import type { AggregatedRunUsage } from "./usage.ts";
import type { DreamTrigger } from "./dream-progress.ts";

export interface AskFailureTrace {
  traceId: string;
  usage?: AggregatedRunUsage;
}

export interface DreamOptions {
  /** Observational labels; do not alter execution, permissions or persistence. */
  trigger?: DreamTrigger;
  batch?: { index: number; total: number };
  /** cap on Raw entries processed in one bounded prompt batch */
  maxEntries?: number;
  /** process only these raw entries; when set, the normal 40-entry batch cap is not applied */
  rawIds?: string[];
  /** re-distill even if the source hash is unchanged */
  force?: boolean;
  /** model override for distillation */
  model?: string;
  /** cancel the active CLI work without starting more distillation steps */
  signal?: AbortSignal;
}

export interface AskOptions {
  /** Host-provided handoff instructions for a scoped, writable Chat Run. */
  sourceCaptureInstruction?: string;
  onExecutionEvidence?: import("@homeagent/llm").RunInput["onExecutionEvidence"];
  onProgress?: import("@homeagent/shared").ProviderProgressEvent extends infer T ? (event: T) => void | Promise<void> : never;
  /** model override for synthesis */
  model?: string;
  /** agent persona / extra system instruction injected into synthesis + fallback */
  instruction?: string;
  /** local images supplied with the current user turn */
  images?: ImageInput[];
  /** max wiki pages loaded whole into the synthesis context */
  maxPages?: number;
  /** when true, never fall back to general knowledge (knowledge-only) */
  knowledgeOnly?: boolean;
  /** Bounded non-KB context that may ground an ordinary answer. */
  fallbackContext?: "agent-workdir" | "message-source";
  /** cancel the active provider call when the owning Run is cancelled. */
  signal?: AbortSignal;
  /** maximum runtime for each provider call in this answer */
  timeoutMs?: number;
  /** Provider-owned topic conversation request for the single final answer call. */
  nativeSession?: NativeSessionRequest;
  /** Observe the durable quality trace recorded before a failed ask is rethrown. */
  onFailureTrace?: (trace: AskFailureTrace) => void;
}

export interface SearchOptions {
  limit?: number;
}

export interface RetractionRequest {
  chatId: string;
  messageId: string;
  requestedBy: string;
  /** Connector-resolved original author; never accept this from message text. */
  targetAuthor?: string;
  /** trusted role assertion supplied by the chat connector */
  requesterIsAdmin?: boolean;
}

export type RetractionStatus = "retracted" | "already_retracted" | "not_found" | "forbidden";

export interface RetractionResult {
  status: RetractionStatus;
  /** content pages removed because they included the retracted source */
  affectedPages: string[];
  /** exact surviving source ids to rebuild before confirming the retraction */
  requeuedSourceIds: string[];
}

/** A durable record for raw sources whose generated knowledge page failed validation or execution. */
export interface QuarantinedDreamOperation {
  type: "entity" | "concept" | "source" | "analysis";
  name: string;
  title: string;
  rawIds: string[];
  /** Hash of the Knowledge page base used by the failed generation; null means create. */
  basePageHash: string | null;
}

export interface QuarantineRecord {
  /** Safe filename-backed identifier used by management actions. */
  id: string;
  space: SpaceId;
  slug: string;
  error: string;
  rawIds: string[];
  createdAt: number;
  /** Frozen generate plan. Legacy records may not have one and fail closed on retry. */
  operation?: QuarantinedDreamOperation;
}

export type QuarantineRetryStatus = "recovered" | "failed" | "not_found";

export interface QuarantineRetryResult {
  status: QuarantineRetryStatus;
  id: string;
  report?: DreamReport;
  reason?: string;
}

export interface QuarantineBatchRetryResult {
  total: number;
  recovered: number;
  failed: number;
  results: QuarantineRetryResult[];
}

/** A space and its on-disk purpose/schema, as tracked by the registry. */
export interface SpaceMeta {
  id: SpaceId;
  createdAt: number;
  lastDreamAt?: number;
  /** Last completed deterministic Wiki Maintenance cycle. */
  lastMaintenanceAt?: number;
  /** Bounded summary from the last completed Wiki Maintenance cycle. */
  lastMaintenanceScannedPages?: number;
  lastMaintenanceIssueCount?: number;
  lastMaintenanceTruncated?: boolean;
  /** feishu chat_id this space is bound to (team spaces) */
  chatId?: string;
  /** human-readable display name for the group (management backend) */
  name?: string;
  /** id of the Agent assigned to answer in this space (undefined => default) */
  agentId?: string;
  /** Local binding incarnation; never accepted from a patch or a Space archive. */
  agentBindingEpoch?: string;
  /**
   * Whether replies thread ("Topic reply" in mew). Defaults to true for team
   * spaces and false for personal when unset (see runtime send()).
   */
  replyInThread?: boolean;
  /**
   * Legacy group reply switch. `false` without a participationLevel keeps the
   * former respond-to-every-message behavior for backward compatibility.
   */
  mentionsOnly?: boolean;
  /** How readily the bot proactively joins unmentioned group conversation. */
  participationLevel?: GroupParticipationLevel;
}

export type GroupParticipationLevel = "reserved" | "balanced" | "active";

export type SpaceMetaPatch = Partial<Pick<
  SpaceMeta,
  "name" | "agentId" | "replyInThread" | "mentionsOnly" | "participationLevel" | "chatId"
>>;
