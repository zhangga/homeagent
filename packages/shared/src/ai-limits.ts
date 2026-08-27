/**
 * Stability-first limits for production AI work.
 *
 * These values are deliberately generous. HomeAgent already bounds prompt
 * inputs, persisted artifacts, and concurrency independently, so completion
 * latency and output length should not become the usual failure mode. Callers
 * should rely on explicit cancellation when an operator no longer wants a run.
 */
export const AI_OPERATION_TIMEOUT_MINUTES = 6 * 60;
export const AI_OPERATION_TIMEOUT_MS = AI_OPERATION_TIMEOUT_MINUTES * 60_000;
export const AI_MAX_CONFIGURABLE_TIMEOUT_MINUTES = 24 * 60;
export const AI_QUEUE_TIMEOUT_MS = AI_MAX_CONFIGURABLE_TIMEOUT_MINUTES * 60_000;

/** Structured routing/classification results remain bounded but have ample headroom. */
export const AI_ROUTING_MAX_TOKENS = 8_192;

/** Full answers, knowledge pages, and learning material may use a large output budget. */
export const AI_GENERATION_MAX_TOKENS = 65_536;
