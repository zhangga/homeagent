/**
 * The Knowledge seam (plan §2.2). Upper layers (orchestrator, web) depend ONLY
 * on this interface, never on the SQLite/markdown/LLM internals behind it. That
 * keeps callers decoupled from the FTS/markdown implementation details behind
 * the seam (plan R7).
 */
import type {
  AskResult,
  DreamReport,
  Hit,
  HealthReport,
  Page,
  PageRef,
  RawEntry,
  SpaceId,
} from "@homeagent/shared";
import type {
  AskOptions,
  DreamOptions,
  QuarantineBatchRetryResult,
  QuarantineRecord,
  QuarantineRetryResult,
  RetractionRequest,
  RetractionResult,
  SearchOptions,
} from "./types.ts";
import type {
  KnowledgeCorrectionResult,
  KnowledgeGovernanceSnapshot,
  KnowledgePageDeleteResult,
  KnowledgePageRegenerationResult,
  RawGovernanceDetail,
} from "./knowledge-governance.ts";
import type {
  WikiMaintenanceOptions,
  WikiMaintenanceReport,
} from "./maintenance.ts";
import type { KnowledgePageTrace } from "./traceability.ts";
import type { RawSourceCapture, RawSourceDownload } from "./raw-source-files.ts";

export interface Knowledge {
  /** Cheap capture — persists a raw entry, no LLM call. */
  remember(entry: RawEntry): Promise<string>;
  /** Capture Raw plus one exact immutable original file in the same Space. */
  rememberFile(entry: RawEntry, file: RawSourceCapture): Promise<string>;
  /** Resolve one stored original file through Raw provenance. */
  getRawSource(space: SpaceId, rawId: string, attachmentIndex: number): RawSourceDownload | null;

  /** Read and edit the human-maintained rules and governance history for a space. */
  getSpaceGovernance(space: SpaceId): Promise<KnowledgeGovernanceSnapshot>;
  updateSpaceRules(
    space: SpaceId,
    input: { purpose?: string; schema?: string },
    actor: string,
  ): Promise<KnowledgeGovernanceSnapshot>;
  resetSpaceRule(
    space: SpaceId,
    target: "purpose" | "schema",
    actor: string,
  ): Promise<KnowledgeGovernanceSnapshot>;
  getRawGovernanceDetail(space: SpaceId, rawId: string): Promise<RawGovernanceDetail | null>;
  redistillRaw(
    space: SpaceId,
    rawId: string,
    actor: string,
    model?: string,
  ): Promise<DreamReport>;
  deleteKnowledgePage(
    space: SpaceId,
    slug: string,
    actor: string,
  ): Promise<KnowledgePageDeleteResult>;
  regenerateKnowledgePage(
    space: SpaceId,
    slug: string,
    actor: string,
    model?: string,
  ): Promise<KnowledgePageRegenerationResult>;
  submitKnowledgeCorrection(
    space: SpaceId,
    slug: string,
    correction: string,
    actor: string,
    model?: string,
  ): Promise<KnowledgeCorrectionResult>;

  /** Remove one captured message, enforcing source ownership. */
  retractMessage(space: SpaceId, request: RetractionRequest): Promise<RetractionResult>;

  /** Nightly distillation: turn pending raw entries into wiki pages. */
  runDreamCycle(space: SpaceId, opts?: DreamOptions): Promise<DreamReport>;

  /** Read-only deterministic health inspection of one Space's Knowledge pages. */
  runWikiMaintenanceCycle(
    space: SpaceId,
    opts?: WikiMaintenanceOptions,
  ): Promise<WikiMaintenanceReport>;

  /** Durable failed page generations awaiting an explicit retry. */
  listQuarantines(space: SpaceId): Promise<QuarantineRecord[]>;

  retryQuarantine(space: SpaceId, id: string, model?: string): Promise<QuarantineRetryResult>;
  retryQuarantines(space: SpaceId, model?: string): Promise<QuarantineBatchRetryResult>;

  /**
   * Answer a question over the union of `spaces`. Returns an answer tagged
   * knowledge (grounded, with citations) or general (model fallback).
   */
  ask(spaces: SpaceId[], question: string, opts?: AskOptions): Promise<AskResult>;

  /** FTS fallback search across `spaces`. */
  search(spaces: SpaceId[], keyword: string, opts?: SearchOptions): Promise<Hit[]>;

  getPage(space: SpaceId, slug: string): Promise<Page | null>;
  /** Read-only Page -> Raw evidence chain with derived evidence freshness. */
  getKnowledgePageTrace(space: SpaceId, slug: string): Promise<KnowledgePageTrace | null>;
  upsertPage(space: SpaceId, page: Page): Promise<void>;
  listPages(space: SpaceId, type?: string): Promise<PageRef[]>;

  /** Rebuild a space's index from its markdown files. */
  rebuildIndex(space: SpaceId): Promise<{ rebuilt: number; corrupt: string[] }>;

  health(): Promise<HealthReport>;
}
