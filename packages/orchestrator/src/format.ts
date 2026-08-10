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
      return `[[${citation.slug}|${title}]]`;
    }).join("、");
    parts.push("", `— 依据：${list}`);
  }

  if (res.gaps && res.gaps.length > 0) {
    parts.push("", `（尚缺：${res.gaps.join("；")}）`);
  }

  const skillWarning = formatSkillWarnings(res.skillWarnings);
  if (skillWarning) parts.push("", skillWarning);

  return parts.join("\n");
}
