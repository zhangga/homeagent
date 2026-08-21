import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSkillStore } from "./managed-skills.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  }).trim();
}

function gitWithInput(repository: string, input: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    input,
  }).trim();
}

function createSkillRepository(): {
  repository: string;
  skillPath: string;
  skillFile: string;
} {
  const repository = temporaryDirectory("ha-managed-skill-repo-");
  const skillPath = "skills/reviewer";
  const skillDirectory = join(repository, "skills", "reviewer");
  mkdirSync(join(skillDirectory, "references"), { recursive: true });
  const skillFile = "---\nname: reviewer\ndescription: Review code\n---\n\nReview carefully.\n";
  writeFileSync(join(skillDirectory, "SKILL.md"), skillFile, "utf8");
  writeFileSync(join(skillDirectory, "references", "rules.md"), "Rule one.\n", "utf8");
  git(repository, "init", "--quiet");
  git(repository, "config", "core.autocrlf", "false");
  git(repository, "config", "user.name", "HomeAgent Test");
  git(repository, "config", "user.email", "homeagent@example.invalid");
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "add skill");
  return { repository, skillPath, skillFile };
}

describe("ManagedSkillStore", () => {
  test("refuses to materialize through a releases ancestor junction outside dataDir", () => {
    const source = createSkillRepository();
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    const external = temporaryDirectory("ha-managed-skill-external-");
    const store = new ManagedSkillStore(dataDir);
    mkdirSync(join(dataDir, "managed-skills"), { recursive: true });
    symlinkSync(
      external,
      join(dataDir, "managed-skills", "releases"),
      "junction",
    );

    expect(() => store.importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    })).toThrow(/symbolic links are not allowed/i);
    expect(readdirSync(external)).toEqual([]);
  });

  test("refuses to load an index through a managed-skills ancestor junction", () => {
    const source = createSkillRepository();
    const externalDataDir = temporaryDirectory("ha-managed-skill-external-data-");
    new ManagedSkillStore(externalDataDir).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    symlinkSync(
      join(externalDataDir, "managed-skills"),
      join(dataDir, "managed-skills"),
      "junction",
    );

    expect(() => new ManagedSkillStore(dataDir))
      .toThrow(/symbolic links are not allowed/i);
  });

  test("refuses to read a release through a replaced releases ancestor junction", () => {
    const source = createSkillRepository();
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    const store = new ManagedSkillStore(dataDir);
    const imported = store.importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    const releasesPath = join(dataDir, "managed-skills", "releases");
    const external = temporaryDirectory("ha-managed-skill-external-");
    const escapedReleases = join(external, "releases");
    renameSync(releasesPath, escapedReleases);
    symlinkSync(escapedReleases, releasesPath, "junction");

    expect(() => store.readSkillFile(imported.bundleHash))
      .toThrow(/symbolic links are not allowed/i);
  });

  test("imports a clean local Git Skill as a persistent content-addressed release", () => {
    const source = createSkillRepository();
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    const imported = new ManagedSkillStore(dataDir).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });

    expect(imported.commit).toBe(git(source.repository, "rev-parse", "HEAD"));
    expect(imported.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(imported.fileCount).toBe(2);
    expect(existsSync(join(
      dataDir,
      "managed-skills",
      "releases",
      imported.bundleHash,
      "SKILL.md",
    ))).toBe(true);
    expect(readdirSync(join(dataDir, "managed-skills", "releases")))
      .toEqual([imported.bundleHash]);
    expect(JSON.parse(readFileSync(
      join(dataDir, "managed-skills", "index.json"),
      "utf8",
    )).version).toBe(1);

    const restored = new ManagedSkillStore(dataDir);
    expect(restored.list()).toEqual([imported]);
    expect(restored.get(imported.bundleHash)).toEqual(imported);
    expect(restored.readSkillFile(imported.bundleHash)).toBe(source.skillFile);
    expect(restored.readSkillFile(imported.bundleHash, "references/rules.md"))
      .toBe("Rule one.\n");
  });

  test("rejects a local Git repository with uncommitted changes", () => {
    const source = createSkillRepository();
    const changedSkill = join(source.repository, "skills", "reviewer", "SKILL.md");
    writeFileSync(changedSkill, `${source.skillFile}\nUncommitted instruction.\n`, "utf8");

    expect(() => new ManagedSkillStore(
      temporaryDirectory("ha-managed-skill-data-"),
    ).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    })).toThrow(/working tree must be clean/i);
  });

  test("rejects a Skill path that can escape the repository tree", () => {
    const source = createSkillRepository();

    expect(() => new ManagedSkillStore(
      temporaryDirectory("ha-managed-skill-data-"),
    ).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: "skills/../skills/reviewer",
    })).toThrow(/skill path must be a safe relative path/i);
  });

  test("rejects symbolic links anywhere in the committed Skill tree", () => {
    const source = createSkillRepository();
    const linkPath = "skills/reviewer/references/linked.md";
    const linkTarget = "../../../outside.md";
    const workingTreeLink = join(source.repository, ...linkPath.split("/"));
    writeFileSync(workingTreeLink, linkTarget, "utf8");
    const objectId = git(source.repository, "hash-object", "-w", workingTreeLink);
    git(
      source.repository,
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${objectId},${linkPath}`,
    );
    git(source.repository, "commit", "--quiet", "-m", "add linked file");
    rmSync(workingTreeLink);
    symlinkSync(linkTarget, workingTreeLink);

    expect(() => new ManagedSkillStore(
      temporaryDirectory("ha-managed-skill-data-"),
    ).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    })).toThrow(/symbolic links are not allowed/i);
  });

  test("rejects non-canonical paths emitted by the committed Git tree", () => {
    const source = createSkillRepository();
    const skillObject = git(
      source.repository,
      "rev-parse",
      "HEAD:skills/reviewer/SKILL.md",
    );
    const unsafeObject = gitWithInput(
      source.repository,
      "unsafe\n",
      "hash-object",
      "-w",
      "--stdin",
    );
    const reviewerTree = gitWithInput(
      source.repository,
      `100644 blob ${skillObject}\tSKILL.md\0`
        + `100644 blob ${unsafeObject}\tunsafe\\name.md\0`,
      "mktree",
      "-z",
    );
    const skillsTree = gitWithInput(
      source.repository,
      `040000 tree ${reviewerTree}\treviewer\0`,
      "mktree",
      "-z",
    );
    const rootTree = gitWithInput(
      source.repository,
      `040000 tree ${skillsTree}\tskills\0`,
      "mktree",
      "-z",
    );
    const commit = git(
      source.repository,
      "commit-tree",
      rootTree,
      "-p",
      "HEAD",
      "-m",
      "unsafe tree entry",
    );

    expect(() => new ManagedSkillStore(
      temporaryDirectory("ha-managed-skill-data-"),
    ).importFromGit({
      repository: source.repository,
      ref: commit,
      skillPath: source.skillPath,
    })).toThrow(/tree entry must be a safe relative path/i);
  });

  test("rejects non-canonical file paths when reading a release", () => {
    const source = createSkillRepository();
    const store = new ManagedSkillStore(temporaryDirectory("ha-managed-skill-data-"));
    const imported = store.importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });

    for (const invalidPath of [
      "",
      ".",
      "./SKILL.md",
      `../${imported.bundleHash}/SKILL.md`,
      "/SKILL.md",
      "C:/SKILL.md",
      "references//rules.md",
      "references\\rules.md",
      "references/\0rules.md",
      "references/rules.md:stream",
      "NUL.md",
    ]) {
      expect(() => store.readSkillFile(imported.bundleHash, invalidPath))
        .toThrow(/file path must be a safe relative path/i);
    }
  });

  test("refuses to follow a symbolic link added to a stored release", () => {
    const source = createSkillRepository();
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    const store = new ManagedSkillStore(dataDir);
    const imported = store.importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    const external = temporaryDirectory("ha-managed-skill-external-");
    writeFileSync(join(external, "rules.md"), "tampered\n", "utf8");
    const references = join(
      dataDir,
      "managed-skills",
      "releases",
      imported.bundleHash,
      "references",
    );
    rmSync(references, { recursive: true, force: true });
    symlinkSync(external, references, "junction");

    expect(() => store.readSkillFile(imported.bundleHash, "references/rules.md"))
      .toThrow(/symbolic links are not allowed/i);
  });

  test("rejects an indexed release whose stored tree was tampered with", () => {
    const source = createSkillRepository();
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    const store = new ManagedSkillStore(dataDir);
    const imported = store.importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    writeFileSync(join(
      dataDir,
      "managed-skills",
      "releases",
      imported.bundleHash,
      "references",
      "rules.md",
    ), "tampered\n", "utf8");

    expect(() => store.readSkillFile(imported.bundleHash, "references/rules.md"))
      .toThrow(/stored tree does not match its content hash/i);
    expect(() => new ManagedSkillStore(dataDir))
      .toThrow(/stored tree does not match its content hash/i);
  });

  test("rejects extra directories added to an indexed release", () => {
    const source = createSkillRepository();
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    const imported = new ManagedSkillStore(dataDir).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    mkdirSync(join(
      dataDir,
      "managed-skills",
      "releases",
      imported.bundleHash,
      "untracked-empty-directory",
    ));

    expect(() => new ManagedSkillStore(dataDir))
      .toThrow(/stored tree does not match its content hash/i);
  });

  test("does not trust a pre-existing directory at a content-addressed release path", () => {
    const source = createSkillRepository();
    const expected = new ManagedSkillStore(
      temporaryDirectory("ha-managed-skill-seed-"),
    ).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    const releasePath = join(
      dataDir,
      "managed-skills",
      "releases",
      expected.bundleHash,
    );
    mkdirSync(releasePath, { recursive: true });
    writeFileSync(join(releasePath, "SKILL.md"), "not the committed Skill\n", "utf8");

    expect(() => new ManagedSkillStore(dataDir).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    })).toThrow(/stored tree does not match its content hash/i);
  });

  test("keeps old releases readable as a branch moves and deduplicates unchanged bundles", () => {
    const source = createSkillRepository();
    const store = new ManagedSkillStore(temporaryDirectory("ha-managed-skill-data-"));
    const first = store.importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    const rules = join(
      source.repository,
      "skills",
      "reviewer",
      "references",
      "rules.md",
    );
    writeFileSync(rules, "Rule two.\n", "utf8");
    git(source.repository, "add", ".");
    git(source.repository, "commit", "--quiet", "-m", "change reference only");

    const second = store.importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    expect(second.bundleHash).not.toBe(first.bundleHash);
    expect(store.readSkillFile(first.bundleHash, "references/rules.md"))
      .toBe("Rule one.\n");
    expect(store.readSkillFile(second.bundleHash, "references/rules.md"))
      .toBe("Rule two.\n");

    writeFileSync(join(source.repository, "README.md"), "Repository note.\n", "utf8");
    git(source.repository, "add", ".");
    git(source.repository, "commit", "--quiet", "-m", "change outside skill");
    const unchangedBundle = store.importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });
    expect(unchangedBundle).toEqual(second);
    expect(store.list()).toHaveLength(2);
  });

  test("rejects Git trees that exceed configured file and byte limits before materialization", () => {
    const source = createSkillRepository();

    expect(() => new ManagedSkillStore(
      temporaryDirectory("ha-managed-skill-data-"),
      { limits: { maxFiles: 1 } },
    ).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    })).toThrow(/file count limit/i);

    expect(() => new ManagedSkillStore(
      temporaryDirectory("ha-managed-skill-data-"),
      { limits: { maxFileBytes: 8 } },
    ).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    })).toThrow(/file size limit/i);

    expect(() => new ManagedSkillStore(
      temporaryDirectory("ha-managed-skill-data-"),
      { limits: { maxTotalBytes: 32 } },
    ).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    })).toThrow(/total size limit/i);
  });

  test("applies configured resource limits again when loading an indexed release", () => {
    const source = createSkillRepository();
    const dataDir = temporaryDirectory("ha-managed-skill-data-");
    new ManagedSkillStore(dataDir).importFromGit({
      repository: source.repository,
      ref: "HEAD",
      skillPath: source.skillPath,
    });

    expect(() => new ManagedSkillStore(dataDir, {
      limits: { maxFileBytes: 8 },
    })).toThrow(/file size limit/i);
  });

  test("reports that URL imports are not implemented", () => {
    const store = new ManagedSkillStore(temporaryDirectory("ha-managed-skill-data-"));

    expect(() => store.importFromUrl({ url: "https://example.com/reviewer.git" }))
      .toThrow(/URL import is not implemented/i);
  });
});
