import {
  MAX_LOCAL_EXECUTION_GRANTS, MAX_LOCAL_EXECUTION_GRANTS_PER_AGENT, MAX_LOCAL_EXECUTION_GRANT_BYTES,
  type LocalExecutionGrant,
} from "./local-execution-grants.ts";
import { isLocalExecutionGrantId } from "./execution-identities.ts";

const capacityError = () => new Error("本机完全访问确认超过上限，引用状态未知或仍有版本/运行使用，无法安全清理；请检查运行状态后重新发布");

/** Mutates only a publication candidate; the caller commits it with the revision atomically. */
export function pruneLocalExecutionGrants(
  candidate: Map<string, LocalExecutionGrant>,
  readProtected: () => ReadonlySet<string> | undefined,
): void {
  const counts = new Map<string, number>();
  const sizes = new Map<string, number>();
  // Compact object encoding: braces + each key/value + separators (no pretty-print whitespace).
  let bytes = 2 + Math.max(0, candidate.size - 1);
  for (const [id, grant] of candidate) {
    counts.set(grant.agentId, (counts.get(grant.agentId) ?? 0) + 1);
    const size = Buffer.byteLength(`${JSON.stringify(id)}:${JSON.stringify(grant)}`, "utf8");
    sizes.set(id, size);
    bytes += size;
  }
  const globalExcess = () => candidate.size > MAX_LOCAL_EXECUTION_GRANTS || bytes > MAX_LOCAL_EXECUTION_GRANT_BYTES;
  const agentExcess = (agentId: string) => counts.get(agentId)! > MAX_LOCAL_EXECUTION_GRANTS_PER_AGENT;
  if (!globalExcess() && ![...counts.keys()].some(agentExcess)) return;
  let protectedIds: ReadonlySet<string> | undefined;
  try { protectedIds = readProtected(); } catch { throw capacityError(); }
  if (!(protectedIds instanceof Set) || [...protectedIds].some(id => !isLocalExecutionGrantId(id))) throw capacityError();
  const removable = [...candidate.values()].filter(grant => !protectedIds.has(grant.id))
    .sort((a, b) => a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id));
  const remove = (grant: LocalExecutionGrant) => {
    if (!candidate.delete(grant.id)) return;
    counts.set(grant.agentId, counts.get(grant.agentId)! - 1);
    bytes -= sizes.get(grant.id)! + (candidate.size > 0 ? 1 : 0);
  };
  // Resolve per-Agent pressure first, so a global limit doesn't evict unrelated records unnecessarily.
  for (const grant of removable) if (agentExcess(grant.agentId)) remove(grant);
  for (const grant of removable) {
    if (!globalExcess()) break;
    remove(grant);
  }
  if (globalExcess() || [...counts.keys()].some(agentExcess)) throw capacityError();
}
