import { parentPort } from "node:worker_threads";
import { fileIdentitiesMatch } from "@homeagent/shared";
import { SkillCatalog, type SkillCatalogOptions, type SkillCatalogResolution, type SkillCatalogRequest, type SkillCatalogSnapshot } from "./skill-catalog.ts";

const port = parentPort!;
let catalog: SkillCatalog | undefined;
let sequence = 0;
let scans = 0;
const leases = new Map<number, { request: SkillCatalogRequest; resolution: SkillCatalogResolution; references: number }>();
const current = new Map<string, number>();
let pending = Promise.resolve();

port.on("message", (message: { id: number; operation: "resolve" | "validate" | "release"; options?: Omit<SkillCatalogOptions, "now">; request?: SkillCatalogRequest; ticket?: number; snapshot?: SkillCatalogSnapshot }) => { pending = pending.then(async () => {
  try {
    if (message.operation === "release") {
      const lease = leases.get(message.ticket!);
      if (lease && --lease.references === 0 && current.get(JSON.stringify(lease.request)) !== message.ticket) leases.delete(message.ticket!);
      return;
    }
    if (message.operation === "resolve") {
      catalog ??= new SkillCatalog(message.options!);
      const request = message.request!;
      const key = JSON.stringify(request);
      const oldTicket = current.get(key);
      let lease = oldTicket === undefined ? undefined : leases.get(oldTicket);
      let ticket = oldTicket;
      if (!lease || !fileIdentitiesMatch(lease.resolution.proof)) {
        scans++;
        const resolution = await catalog.captureResolutionAsync(request, message.snapshot);
        if (!fileIdentitiesMatch(resolution.proof)) throw new Error("changed");
        if (lease?.references === 0) leases.delete(oldTicket!);
        ticket = ++sequence;
        lease = { request, resolution, references: 0 };
        // Keep only the latest idle resolution per Provider; active Runs retain
        // their own leases until completion, independently of this cache.
        for (const [otherKey, otherTicket] of current) {
          if (otherKey === key) continue;
          const other = leases.get(otherTicket);
          if (other?.request.provider === request.provider) {
            current.delete(otherKey);
            if (other.references === 0) leases.delete(otherTicket);
          }
        }
        leases.set(ticket, lease); current.set(key, ticket);
      }
      lease.references++;
      const { proof: _proof, ...resolution } = lease.resolution;
      port.postMessage({ id: message.id, scans, ticket, resolution });
      return;
    }
    const lease = leases.get(message.ticket!);
    if (!lease || !catalog) throw new Error("missing");
    if (!fileIdentitiesMatch(lease.resolution.proof)) {
      scans++;
      const next = await catalog.captureResolutionAsync(lease.request);
      if (!fileIdentitiesMatch(next.proof)
        || JSON.stringify(next.skills.resolved) !== JSON.stringify(lease.resolution.skills.resolved)
        || JSON.stringify(next.inputs) !== JSON.stringify(lease.resolution.inputs)) throw new Error("changed");
      lease.resolution = next;
    }
    port.postMessage({ id: message.id, scans });
  } catch {
    port.postMessage({ id: message.id, scans, error: "Queued Run Skill snapshot changed after enqueue; refusing to execute mutable Skill content." });
  }
}); });
