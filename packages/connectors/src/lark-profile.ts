import { normalizeFeishuAppId } from "@homeagent/shared";

/** Select a local app without changing lark-cli's user-wide default profile. */
export function withLarkProfile(command: string[], profile?: string): string[] {
  const appId = normalizeFeishuAppId(profile);
  return appId ? [command[0]!, "--profile", appId, ...command.slice(1)] : command;
}
