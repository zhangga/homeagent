/** Feishu recipients cannot open the bot host's local filesystem via hyperlinks. */
export function formatFeishuLocalFileLinks(markdown: string): string {
  return markdown.replace(
    /(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`+[^`\n]*`+)|(?<!!)\[([^\]\n]*)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g,
    (original, code: string | undefined, label: string, target: string) => {
      if (code) return original;
      let path = target.trim();
      if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1);
      if (!/^(?:[a-z]:[\\/]|file:\/\/|\/(?!\/)|\\\\)/i.test(path)) return original;
      if (/^file:\/\//i.test(path)) {
        path = path.replace(/^file:\/\/(?:localhost)?/i, "");
        if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
        else if (!path.startsWith("/")) path = `//${path}`;
      }
      try { path = decodeURIComponent(path); } catch { /* Keep literal percent characters in filenames. */ }
      const longest = Math.max(0, ...[...path.matchAll(/`+/g)].map(match => match[0].length));
      const fence = "`".repeat(longest + 1);
      return `${label}（本机文件：${fence} ${path} ${fence}）`;
    },
  );
}
