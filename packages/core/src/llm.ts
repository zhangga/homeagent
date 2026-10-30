/**
 * The narrow LLM surface the knowledge engine depends on. Wrapping the gateway
 * behind this interface lets dream/ask be unit-tested with a fake client (no
 * network) and keeps the engine decoupled from the transport (plan R6/R7).
 */
import {
  complete as gwComplete,
  completeJSON as gwCompleteJSON,
  type CompleteOptions,
  type CompleteResult,
  type JSONOptions,
} from "@homeagent/llm";
import { config } from "@homeagent/shared";

export interface LlmClient {
  /** Stable effective provider configuration; absent clients do not reuse persistent extraction results. */
  readonly cacheIdentity?: string;
  readonly model?: string;
  readonly provider?: string;
  /** Explicit stage selection. Ordinary calls retain their frozen client configuration. */
  forModel?(model: string): LlmClient;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
  completeJSON<T>(opts: JSONOptions<T>): Promise<{ value: T; result: CompleteResult }>;
}

/** The production client, backed by the real gateway. */
export const gatewayClient: LlmClient = {
  get cacheIdentity() { return new Bun.CryptoHasher("sha256").update(JSON.stringify(["gateway-v1", config().gatewayBaseUrl])).digest("hex"); },
  complete: gwComplete,
  completeJSON: gwCompleteJSON,
};
