import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spaceToDir, type SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";

const SPACE: SpaceId = "team/oc_agent_guide";

describe("data repository agent guides", () => {
  let dataDir: string;
  let engine: KnowledgeEngine | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-agent-guides-"));
  });

  afterEach(() => {
    engine?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("initializing a data directory creates a progressive-disclosure root guide", () => {
    engine = new KnowledgeEngine({ dataDir, runProvider: async () => "" });

    const guide = readFileSync(join(dataDir, "AGENTS.md"), "utf8");
    expect(guide).toContain("默认只读");
    expect(guide).toContain("一个 Space");
    expect(guide).toContain("purpose.md");
    expect(guide).toContain("wiki/overview.md");
    expect(guide).toContain("wiki/maps/");
    expect(guide).toContain("wiki/index.md");
    expect(guide).toContain("raw/records/**/*.jsonl");
    expect(guide).toContain("证据时间");
    expect(guide).toContain("search_knowledge");
    expect(guide).toContain("get_page_trace");
  });

  test("creating a Space adds a scoped guide beside its purpose and schema", () => {
    engine = new KnowledgeEngine({ dataDir, runProvider: async () => "" });
    engine.ensureSpace(SPACE);

    const guide = readFileSync(
      join(dataDir, "workspaces", spaceToDir(SPACE), "AGENTS.md"),
      "utf8",
    );
    expect(guide).toContain("当前 Space");
    expect(guide).toContain("purpose.md");
    expect(guide).toContain("schema.md");
    expect(guide).toContain("wiki/index.md");
    expect(guide).toContain("wiki/maps/");
    expect(guide).toContain("wiki/sources/");
    expect(guide).toContain("Raw id");
    expect(guide).toContain("最新且证据链完整");
    expect(guide).toContain("不会自动失效");
    expect(guide).toContain("get_overview");
  });

  test("reopening an existing repository backfills Space guides without replacing its rules", () => {
    const workspace = join(dataDir, "workspaces", spaceToDir(SPACE));
    mkdirSync(join(workspace, "wiki"), { recursive: true });
    writeFileSync(join(workspace, ".spaceid"), SPACE, "utf8");
    writeFileSync(join(workspace, "purpose.md"), "# 自定义意图\n", "utf8");

    engine = new KnowledgeEngine({ dataDir, runProvider: async () => "" });

    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain("当前 Space");
    expect(readFileSync(join(workspace, "purpose.md"), "utf8")).toBe("# 自定义意图\n");
  });

  test("existing root and Space guides remain user-owned", () => {
    const workspace = join(dataDir, "workspaces", spaceToDir(SPACE));
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(dataDir, "AGENTS.md"), "# 我的仓库规则\n", "utf8");
    writeFileSync(join(workspace, ".spaceid"), SPACE, "utf8");
    writeFileSync(join(workspace, "AGENTS.md"), "# 我的空间规则\n", "utf8");

    engine = new KnowledgeEngine({ dataDir, runProvider: async () => "" });
    engine.ensureSpace(SPACE);

    expect(readFileSync(join(dataDir, "AGENTS.md"), "utf8")).toBe("# 我的仓库规则\n");
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe("# 我的空间规则\n");
  });

  test("an unverified workspace directory never receives a scoped guide", () => {
    const workspace = join(dataDir, "workspaces", "team__oc_wrong_directory");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, ".spaceid"), SPACE, "utf8");

    engine = new KnowledgeEngine({ dataDir, runProvider: async () => "" });

    expect(existsSync(join(workspace, "AGENTS.md"))).toBeFalse();
  });
});
