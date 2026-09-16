import { logger } from "@homeagent/shared";

/** Notification is after durable commit; observer failure cannot roll a commit back. */
export class CommittedStateChanges {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); }
      catch { logger.warn("Committed state observer failed"); }
    }
  }
}
