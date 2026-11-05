import { Worker } from "node:worker_threads";
import type { FileIdentity } from "@homeagent/shared";
import type { ProviderSkillInput } from "./providers.ts";
import { ProviderPreparationError, type ProviderPreparationFailure } from "./provider-preparation.ts";

export interface SkillBundleReply {
  proof: FileIdentity[];
  entries: number;
  totalBytes: number;
}

/** Owned by a prepared library, and closed only after its in-flight work settles. */
export class SkillBundleWorker {
  private readonly worker = new Worker(new URL("./skill-bundle-worker.ts", import.meta.url));
  private sequence = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (reply: SkillBundleReply) => void; reject: (error: Error) => void }>();

  constructor(private readonly requestedSkills: number) {
    this.worker.on("message", (reply: SkillBundleReply & { id: number; error?: string; failure?: ProviderPreparationFailure }) => {
      const pending = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      if (reply.error) pending?.reject(reply.failure ? new ProviderPreparationError(reply.failure) : new Error(reply.error));
      else pending?.resolve(reply);
      if (this.pending.size === 0) this.worker.unref();
    });
    const fail = () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("Skill bundle worker stopped"));
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", fail);
    this.worker.unref();
  }

  remember(input: ProviderSkillInput, proof: FileIdentity[]): void {
    this.worker.postMessage({ operation: "remember", input, proof });
  }

  async run(operation: "stage" | "verify", input: ProviderSkillInput, directory?: string, signal?: AbortSignal): Promise<SkillBundleReply> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Skill bundle worker stopped");
    const id = ++this.sequence;
    this.worker.ref();
    const reply = await new Promise<SkillBundleReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation, input, directory, requestedSkills: this.requestedSkills });
    });
    // Await the worker before cleanup; abort must never race a directory write.
    signal?.throwIfAborted();
    return reply;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.worker.terminate();
  }
}
