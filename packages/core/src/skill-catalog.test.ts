import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSkillRoots,
  providerSkillRootKinds,
  SkillCatalog,
} from "./skill-catalog.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "homeagent-skills-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SkillCatalog", () => {
  test("lists the approved provider-native and shared default roots", () => {
    expect(defaultSkillRoots("/Users/alice")).toEqual([
      {
        kind: "shared-agents",
        path: join("/Users/alice", ".agents", "skills"),
        providerIds: ["claude", "codex", "trae-cli"],
      },
      {
        kind: "codex-user",
        path: join("/Users/alice", ".codex", "skills"),
        providerIds: ["codex"],
      },
      {
        kind: "codex-plugin",
        path: join("/Users/alice", ".codex", "plugins", "cache"),
        providerIds: ["codex"],
      },
      {
        kind: "codex-vendor",
        path: join("/Users/alice", ".codex", "vendor_imports", "skills"),
        providerIds: ["codex"],
      },
      {
        kind: "claude-user",
        path: join("/Users/alice", ".claude", "skills"),
        providerIds: ["claude"],
      },
      {
        kind: "claude-plugin",
        path: join("/Users/alice", ".claude", "plugins", "cache"),
        providerIds: ["claude"],
      },
      {
        kind: "claude-marketplace",
        path: join("/Users/alice", ".claude", "plugins", "marketplaces"),
        providerIds: ["claude"],
      },
      {
        kind: "trae-user",
        path: join("/Users/alice", ".trae", "skills"),
        providerIds: ["trae-cli"],
      },
    ]);
  });

  test("exposes deterministic Skill root precedence for every provider", () => {
    expect(providerSkillRootKinds("codex")).toEqual([
      "codex-user",
      "shared-agents",
      "codex-plugin",
      "codex-vendor",
    ]);
    expect(providerSkillRootKinds("claude")).toEqual([
      "claude-user",
      "shared-agents",
      "claude-plugin",
      "claude-marketplace",
    ]);
    expect(providerSkillRootKinds("trae-cli")).toEqual([
      "trae-user",
      "shared-agents",
    ]);
    expect(providerSkillRootKinds("gateway")).toEqual([]);
  });

  test("discovers a shared Skill as a stable provider-compatible source", () => {
    const skillDir = join(dir, "skills", "code-review");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = [
      "---",
      "name: code-review",
      "description: Review code through observable behavior.",
      "---",
      "",
      "# Code Review",
      "",
    ].join("\n");
    writeFileSync(join(skillDir, "SKILL.md"), skillFile, "utf8");

    const result = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: join(dir, "skills"),
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    }).refresh();

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      sourceKey: "shared-agents:code-review",
      rootKind: "shared-agents",
      relativeDir: "code-review",
      name: "code-review",
      description: "Review code through observable behavior.",
      providerIds: ["claude", "codex", "trae-cli"],
      skillFile: join(skillDir, "SKILL.md"),
      skillFileHash: new Bun.CryptoHasher("sha256").update(skillFile).digest("hex"),
      status: "available",
      diagnostics: [],
    });
  });

  test("keeps a Skill with a missing name visible but unavailable", () => {
    const skillDir = join(dir, "skills", "broken");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "description: Missing its public name.", "---", "", "# Broken"].join("\n"),
      "utf8",
    );

    const result = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: join(dir, "skills"),
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    }).refresh();

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.status).toBe("invalid");
    expect(result.sources[0]?.diagnostics).toEqual([{
      code: "invalid_name",
      message: "SKILL.md frontmatter must contain a valid name",
    }]);
  });

  test("does not treat body text as SKILL.md frontmatter", () => {
    const skillDir = join(dir, "skills", "broken");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["# Broken", "", "name: body-only", "description: Also body text."].join("\n"),
      "utf8",
    );

    const result = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: join(dir, "skills"),
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    }).refresh();

    expect(result.sources[0]).toMatchObject({
      name: "",
      description: "",
      status: "invalid",
    });
  });

  test("keeps scanning healthy roots when another root is unavailable", () => {
    const skillDir = join(dir, "shared", "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: review", "description: Review safely.", "---"].join("\n"),
      "utf8",
    );

    const result = new SkillCatalog({
      roots: [
        {
          kind: "codex-user",
          path: join(dir, "missing"),
          providerIds: ["codex"],
        },
        {
          kind: "shared-agents",
          path: join(dir, "shared"),
          providerIds: ["claude", "codex", "trae-cli"],
        },
      ],
    }).refresh();

    expect(result.sources.map((source) => source.name)).toEqual(["review"]);
  });

  test("discovers Skills nested inside provider plugin roots", () => {
    const root = join(dir, "plugins");
    const skillDir = join(root, "publisher", "package", "skills", "browser");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: browser", "description: Browser control.", "---"].join("\n"),
      "utf8",
    );

    const result = new SkillCatalog({
      roots: [{
        kind: "codex-plugin",
        path: root,
        providerIds: ["codex"],
      }],
    }).refresh();

    expect(result.sources.map((source) => ({
      sourceKey: source.sourceKey,
      relativeDir: source.relativeDir,
    }))).toEqual([{
      sourceKey: "codex-plugin:publisher/package/skills/browser",
      relativeDir: "publisher/package/skills/browser",
    }]);
  });

  test("does not traverse beyond the configured maximum depth", () => {
    const root = join(dir, "plugins");
    const skillDir = join(root, "one", "two", "three");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: too-deep", "description: Must stay outside the scan.", "---"].join("\n"),
      "utf8",
    );

    const result = new SkillCatalog({
      roots: [{ kind: "codex-plugin", path: root, providerIds: ["codex"] }],
      limits: { maxDepth: 2 },
    }).refresh();

    expect(result.sources).toEqual([]);
  });

  test("keeps an oversized SKILL.md visible without reading it as available", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "oversized");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: oversized", "description: Too large.", "---", "x".repeat(200)].join("\n"),
      "utf8",
    );

    const result = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
      limits: { maxFileBytes: 100 },
    }).refresh();

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      name: "oversized",
      status: "invalid",
      skillFileHash: "",
      diagnostics: [{
        code: "file_too_large",
        message: "SKILL.md exceeds the 100 byte scan limit",
      }],
    });
  });

  test("stops after the configured maximum number of Skills", () => {
    const root = join(dir, "skills");
    for (const name of ["beta", "alpha"]) {
      const skillDir = join(root, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        ["---", `name: ${name}`, `description: ${name}`, "---"].join("\n"),
        "utf8",
      );
    }

    const result = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
      limits: { maxSkills: 1 },
    }).refresh();

    expect(result.sources.map((source) => source.name)).toEqual(["alpha"]);
  });

  test("stops reading Skill files at the configured total byte budget", () => {
    const root = join(dir, "skills");
    for (const name of ["alpha", "beta"]) {
      const skillDir = join(root, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        ["---", `name: ${name}`, `description: ${"x".repeat(30)}`, "---"].join("\n"),
        "utf8",
      );
    }

    const firstFileBytes = Buffer.byteLength(
      ["---", "name: alpha", `description: ${"x".repeat(30)}`, "---"].join("\n"),
    );
    const result = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
      limits: { maxTotalBytes: firstFileBytes },
    }).refresh();

    expect(result.sources.map((source) => source.name)).toEqual(["alpha"]);
  });

  test("bounds the number of filesystem entries visited during discovery", () => {
    const root = join(dir, "skills");
    for (const name of ["alpha", "beta"]) {
      const skillDir = join(root, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        ["---", `name: ${name}`, `description: ${name}`, "---"].join("\n"),
        "utf8",
      );
    }

    const result = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
      limits: { maxEntries: 3 },
    }).refresh();

    expect(result.sources.map((source) => source.name)).toEqual(["alpha"]);
  });

  test("does not follow a directory symlink into another Skill tree", () => {
    const root = join(dir, "skills");
    const external = join(dir, "external", "linked-skill");
    mkdirSync(root, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(
      join(external, "SKILL.md"),
      ["---", "name: linked", "description: Must not be followed.", "---"].join("\n"),
      "utf8",
    );
    symlinkSync(join(dir, "external"), join(root, "linked"), "junction");

    const result = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    }).refresh();

    expect(result.sources).toEqual([]);
  });

  test("deduplicates roots that resolve to the same directory", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );

    const result = new SkillCatalog({
      roots: [
        {
          kind: "shared-agents",
          path: root,
          providerIds: ["claude", "codex", "trae-cli"],
        },
        {
          kind: "shared-agents",
          path: root,
          providerIds: ["claude", "codex", "trae-cli"],
        },
      ],
    }).refresh();

    expect(result.sources.map((source) => source.sourceKey)).toEqual([
      "shared-agents:review",
    ]);
  });

  test("groups identical same-name SKILL.md files while retaining every source", () => {
    const skillFile = [
      "---",
      "name: review",
      "description: Shared review instructions.",
      "---",
    ].join("\n");
    for (const [rootName, skillName] of [["shared", "review"], ["codex", "review"]] as const) {
      const skillDir = join(dir, rootName, skillName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), skillFile, "utf8");
    }

    const result = new SkillCatalog({
      roots: [
        {
          kind: "shared-agents",
          path: join(dir, "shared"),
          providerIds: ["claude", "codex", "trae-cli"],
        },
        {
          kind: "codex-user",
          path: join(dir, "codex"),
          providerIds: ["codex"],
        },
      ],
    }).refresh();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.sources.map((source) => source.sourceKey)).toEqual([
      "codex-user:review",
      "shared-agents:review",
    ]);
  });

  test("reports an unavailable root without exposing it as a Skill source", () => {
    const result = new SkillCatalog({
      roots: [{
        kind: "codex-user",
        path: join(dir, "missing"),
        providerIds: ["codex"],
      }],
    }).refresh();

    expect(result.sources).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: "root_unavailable",
      rootKind: "codex-user",
      message: "Skill root is unavailable",
    }]);
  });

  test("resolves an exact compatible source into a provider invocation request", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    const catalog = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    });
    const source = catalog.refresh().sources[0]!;

    const result = catalog.resolve([{
      sourceKey: source.sourceKey,
      name: source.name,
    }], "codex");

    expect(result).toEqual({
      requested: [{
        kind: "source",
        sourceKey: "shared-agents:review",
        name: "review",
      }],
      resolved: [{
        sourceKey: "shared-agents:review",
        name: "review",
        invocationName: "review",
        reference: "$review",
        skillFileHash: source.skillFileHash,
      }],
      skipped: [],
      warnings: [],
    });
  });

  test("maps a legacy name only when one provider-effective content variant exists", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    const catalog = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    });

    expect(catalog.resolveLegacyName("review", "codex")).toEqual({
      sourceKey: "shared-agents:review",
      name: "review",
    });
  });

  test("validates a submitted source binding against the current catalog and provider", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    const catalog = new SkillCatalog({
      roots: [{ kind: "codex-user", path: root, providerIds: ["codex"] }],
    });

    expect(catalog.hasSourceBinding({
      sourceKey: "codex-user:review",
      name: "review",
    }, "codex")).toBe(true);
    expect(catalog.hasSourceBinding({
      sourceKey: "codex-user:review",
      name: "renamed",
    }, "codex")).toBe(false);
    expect(catalog.hasSourceBinding({
      sourceKey: "codex-user:review",
      name: "review",
    }, "claude")).toBe(false);
  });

  test("rechecks a bound source file directly before resolving it", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    const path = join(skillDir, "SKILL.md");
    writeFileSync(
      path,
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    const catalog = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    });
    const source = catalog.refresh().sources[0]!;
    rmSync(path);

    const result = catalog.resolve([{
      sourceKey: source.sourceKey,
      name: source.name,
    }], "codex");

    expect(result.resolved).toEqual([]);
    expect(result.skipped).toEqual([{
      sourceKey: "shared-agents:review",
      name: "review",
      code: "missing_source",
      message: "Skill source is unavailable",
    }]);
  });

  test("captures the current SKILL.md hash when a bound source changes", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    const path = join(skillDir, "SKILL.md");
    writeFileSync(
      path,
      ["---", "name: review", "description: First version.", "---"].join("\n"),
      "utf8",
    );
    const catalog = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    });
    const source = catalog.refresh().sources[0]!;
    const updated = ["---", "name: review", "description: Second version.", "---"].join("\n");
    writeFileSync(path, updated, "utf8");

    const result = catalog.resolve([{
      sourceKey: source.sourceKey,
      name: source.name,
    }], "codex");

    expect(result.resolved[0]?.skillFileHash).toBe(
      new Bun.CryptoHasher("sha256").update(updated).digest("hex"),
    );
    expect(result.resolved[0]?.skillFileHash).not.toBe(source.skillFileHash);
  });

  test("skips a bound Skill whose current metadata is no longer invocable", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    const path = join(skillDir, "SKILL.md");
    writeFileSync(
      path,
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    const catalog = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    });
    catalog.refresh();
    writeFileSync(
      path,
      ["---", "name: ../escape", "description: Changed.", "---"].join("\n"),
      "utf8",
    );

    const result = catalog.resolve([{
      sourceKey: "shared-agents:review",
      name: "review",
    }], "codex");

    expect(result.resolved).toEqual([]);
    expect(result.skipped).toEqual([{
      sourceKey: "shared-agents:review",
      name: "review",
      code: "invalid_skill",
      message: "Skill metadata is invalid",
    }]);
  });

  test("does not read a bound SKILL.md that grew beyond the file limit", () => {
    const root = join(dir, "skills");
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    const path = join(skillDir, "SKILL.md");
    writeFileSync(
      path,
      ["---", "name: review", "description: Small.", "---"].join("\n"),
      "utf8",
    );
    const catalog = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
      limits: { maxFileBytes: 100 },
    });
    catalog.refresh();
    writeFileSync(
      path,
      ["---", "name: review", "description: Too large.", "---", "x".repeat(200)].join("\n"),
      "utf8",
    );

    const result = catalog.resolve([{
      sourceKey: "shared-agents:review",
      name: "review",
    }], "codex");

    expect(result.resolved).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      sourceKey: "shared-agents:review",
      code: "invalid_skill",
    });
  });

  test("skips a lower-precedence same-name source for the selected provider", () => {
    for (const [rootName, description] of [
      ["shared", "Shared instructions."],
      ["codex", "Codex-specific instructions."],
    ] as const) {
      const skillDir = join(dir, rootName, "review");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        ["---", "name: review", `description: ${description}`, "---"].join("\n"),
        "utf8",
      );
    }
    const catalog = new SkillCatalog({
      roots: [
        {
          kind: "shared-agents",
          path: join(dir, "shared"),
          providerIds: ["claude", "codex", "trae-cli"],
        },
        {
          kind: "codex-user",
          path: join(dir, "codex"),
          providerIds: ["codex"],
        },
      ],
    });
    catalog.refresh();

    const result = catalog.resolve([{
      sourceKey: "shared-agents:review",
      name: "review",
    }], "codex");

    expect(result.resolved).toEqual([]);
    expect(result.skipped).toEqual([{
      sourceKey: "shared-agents:review",
      name: "review",
      code: "shadowed_source",
      message: "Skill source is shadowed by codex-user:review for codex",
    }]);
  });

  test("resolves an identical grouped binding through the provider-effective source", () => {
    const content = [
      "---",
      "name: review",
      "description: Identical instructions.",
      "---",
    ].join("\n");
    for (const rootName of ["shared", "codex"]) {
      const skillDir = join(dir, rootName, "review");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
    }
    const catalog = new SkillCatalog({
      roots: [
        {
          kind: "shared-agents",
          path: join(dir, "shared"),
          providerIds: ["claude", "codex", "trae-cli"],
        },
        {
          kind: "codex-user",
          path: join(dir, "codex"),
          providerIds: ["codex"],
        },
      ],
    });
    catalog.refresh();

    const result = catalog.resolve([{
      sourceKey: "shared-agents:review",
      name: "review",
    }], "codex");

    expect(result.resolved).toEqual([{
      sourceKey: "codex-user:review",
      name: "review",
      invocationName: "review",
      reference: "$review",
      skillFileHash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    }]);
    expect(result.skipped).toEqual([]);
  });

  test("reuses a fresh catalog snapshot and refreshes it after the cache expires", () => {
    const root = join(dir, "skills");
    mkdirSync(root, { recursive: true });
    let now = 100;
    const catalog = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: root,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
      cacheTtlMs: 50,
      now: () => now,
    });

    expect(catalog.current().sources).toEqual([]);
    const skillDir = join(root, "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    now = 149;
    expect(catalog.current().sources).toEqual([]);
    now = 150;
    expect(catalog.current().sources.map((source) => source.name)).toEqual(["review"]);
  });
});
