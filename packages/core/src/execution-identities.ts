/** Durable local execution identities; validation never confers authorization. */
export function isAgentRevisionId(value: unknown): value is string {
  return typeof value === "string" && /^agent_revision_[a-zA-Z0-9-]{1,160}$/.test(value);
}

export function isExecutionScopeEpoch(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isLocalExecutionGrantId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("local_execution_grant_")
    && isExecutionScopeEpoch(value.slice("local_execution_grant_".length));
}
