/**
 * Render an AskResult into the markdown a connector will send. Encodes the
 * source distinction (plan Q1): grounded answers list their citations; general
 * fallback answers are already self-flagged by the ask pipeline. We keep the
 * formatting minimal and feishu-friendly (markdown reply).
 */
import type { AskResult, SkillWarningView } from "@homeagent/shared";

function plainWarningText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/[<>\[\]`*_~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function formatSkillWarnings(
  warnings: readonly SkillWarningView[] | undefined,
  limit = 5,
): string {
  if (!warnings?.length || limit <= 0) return "";
  const seen = new Set<string>();
  const items: string[] = [];
  for (const warning of warnings) {
    const name = plainWarningText(warning.name, 80);
    const message = plainWarningText(warning.message, 120);
    if (!name || !message) continue;
    const key = `${warning.code}\0${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(`${name}：${message}`);
    if (items.length >= Math.trunc(limit)) break;
  }
  return items.length > 0
    ? `⚠️ Skill 提示：${items.join("；")}。基础 Agent 已继续执行。`
    : "";
}

function citationEvidenceText(citation: AskResult["citations"][number]): string {
  const evidence = citation.evidence;
  if (!evidence) return "";
  const parts: string[] = [];
  if (
    typeof evidence.latestSourceAt === "number"
    && Number.isFinite(evidence.latestSourceAt)
    && Math.abs(evidence.latestSourceAt) <= 8_640_000_000_000_000
  ) {
    parts.push(`最新证据：${new Date(evidence.latestSourceAt).toISOString().slice(0, 10)}`);
  }
  const freshnessLabel = {
    recent: "证据较新",
    aging: "证据较久",
    stale: "证据陈旧",
    unknown: "证据时间未知",
  }[evidence.freshness];
  if (freshnessLabel) parts.push(freshnessLabel);
  if (Number.isInteger(evidence.sourceCount) && evidence.sourceCount >= 0) {
    parts.push(`${evidence.sourceCount} 条 Raw`);
  }
  if (!evidence.complete) parts.push("证据链不完整");
  return parts.length > 0 ? `（${parts.join(" · ")}）` : "";
}

export function formatAnswer(res: AskResult): string {
  const parts: string[] = [res.answer.trim()];

  if (res.source === "knowledge" && res.citations.length > 0) {
    const list = res.citations.map((citation) => {
      const scope = citation.space?.startsWith("personal/")
        ? "个人空间"
        : citation.space?.startsWith("team/")
          ? "群空间"
          : undefined;
      const title = scope ? `${citation.title}（${scope}）` : citation.title;
      return `[[${citation.slug}|${title}]]${citationEvidenceText(citation)}`;
    }).join("、");
    parts.push("", `— 依据：${list}`);
  }

  if (!res.context && res.gaps && res.gaps.length > 0) {
    parts.push("", `（尚缺：${res.gaps.join("；")}）`);
  }

  const skillWarning = formatSkillWarnings(res.skillWarnings);
  if (skillWarning) parts.push("", skillWarning);

  return parts.join("\n");
}
