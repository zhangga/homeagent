import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";

export interface ManagedSkillGitSource {
  kind: "local-git";
  repository: string;
  ref: string;
  skillPath: string;
}

export interface ManagedSkillRelease {
  bundleHash: string;
  commit: string;
  source: ManagedSkillGitSource;
  fileCount: number;
  importedAt: number;
}

export interface ImportManagedSkillFromGitInput {
  repository: string;
  ref: string;
  skillPath: string;
}

export interface ImportManagedSkillFromUrlInput {
  url: string;
}

export interface ManagedSkillResourceLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface ManagedSkillStoreOptions {
  limits?: Partial<ManagedSkillResourceLimits>;
}

const DEFAULT_MANAGED_SKILL_LIMITS: ManagedSkillResourceLimits = {
  maxFiles: 2_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

interface ManagedSkillIndexFile {
  mode: GitTreeFile["mode"];
  relativePath: string;
}

interface ManagedSkillIndexRelease extends ManagedSkillRelease {
  files: ManagedSkillIndexFile[];
}

interface ManagedSkillIndexV1 {
  version: 1;
  releases: ManagedSkillIndexRelease[];
}

interface GitTreeFile {
  mode: "100644" | "100755";
  objectId: string;
  relativePath: string;
  content: Buffer;
}

function cloneRelease(release: ManagedSkillRelease): ManagedSkillRelease {
  return {
    bundleHash: release.bundleHash,
    commit: release.commit,
    source: { ...release.source },
    fileCount: release.fileCount,
    importedAt: release.importedAt,
  };
}

function cloneIndexRelease(release: ManagedSkillIndexRelease): ManagedSkillIndexRelease {
  return {
    ...cloneRelease(release),
    files: release.files.map((file) => ({ ...file })),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function canonicalizeProspectiveDirectory(path: string): string {
  let existing = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new Error("Managed Skill data directory has no existing ancestor");
    }
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  const canonicalExisting = realpathSync(existing);
  if (!lstatSync(canonicalExisting).isDirectory()) {
    throw new Error("Managed Skill data directory ancestor must be a directory");
  }
  return join(canonicalExisting, ...missingSegments);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ""
    || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

function assertSafeRelativePath(value: string, label: string): string {
  const segments = value.split("/");
  if (
    value.length === 0
    || value.length > 1_024
    || value.includes("\\")
    || value.startsWith("/")
    || /^[a-zA-Z]:\//u.test(value)
    || segments.some((segment) =>
      segment === ""
      || segment.length > 255
      || segment === "."
      || segment === ".."
      || /[\u0000-\u001f\u007f<>:"|?*]/u.test(segment)
      || /[ .]$/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
    )
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}

function resolveResourceLimits(
  input: ManagedSkillStoreOptions["limits"],
): ManagedSkillResourceLimits {
  const limits = {
    ...DEFAULT_MANAGED_SKILL_LIMITS,
    ...input,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Managed Skill ${name} must be a positive integer`);
    }
  }
  return limits;
}

function assertSafeGitRef(value: string): string {
  if (
    value.length === 0
    || value.startsWith("-")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Managed Skill Git ref is invalid");
  }
  return value;
}

function assertPathHasNoSymbolicLinks(root: string, relativePath: string): string {
  let current = root;
  if (lstatSync(current).isSymbolicLink()) {
    throw new Error("Managed Skill symbolic links are not allowed");
  }
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Managed Skill symbolic links are not allowed");
    }
  }
  return current;
}

function syncRegularFile(path: string): void {
  const descriptor = openSync(path, "r+");
  try {
    durableFsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    durableFsyncSync(descriptor, {
      allowUnsupportedDirectoryOnWindows: true,
    });
  } finally {
    closeSync(descriptor);
  }
}

function gitText(repository: string, args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function gitBuffer(repository: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", repository, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitTextWithInput(
  repository: string,
  args: string[],
  input: string,
): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function gitBufferWithInput(
  repository: string,
  args: string[],
  input: string,
  maxBuffer: number,
): Buffer {
  return execFileSync("git", ["-C", repository, ...args], {
    input,
    maxBuffer,
  });
}

function readGitTree(
  repository: string,
  commit: string,
  skillPath: string,
  limits: ManagedSkillResourceLimits,
): GitTreeFile[] {
  const tree = `${commit}:${skillPath}`;
  const output = gitBuffer(repository, ["ls-tree", "-r", "-z", tree]);
  const entries: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let start = 0; start < output.length;) {
    const end = output.indexOf(0, start);
    if (end === -1) {
      throw new Error("Managed Skill Git tree output is invalid");
    }
    try {
      entries.push(decoder.decode(output.subarray(start, end)));
    } catch {
      throw new Error("Managed Skill Git tree paths must be UTF-8");
    }
    start = end + 1;
  }
  if (entries.length > limits.maxFiles) {
    throw new Error("Managed Skill tree exceeds the file count limit");
  }
  const metadata = entries.map((entry) => {
    const match = /^(\d{6}) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new Error("Managed Skill tree contains an unsupported Git entry");
    const [, mode, type, objectId, rawRelativePath] = match;
    if (mode === "120000") {
      throw new Error("Managed Skill symbolic links are not allowed");
    }
    if ((mode !== "100644" && mode !== "100755") || type !== "blob") {
      throw new Error("Managed Skill tree contains an unsupported Git entry");
    }
    const relativePath = assertSafeRelativePath(
      rawRelativePath!,
      "Managed Skill tree entry",
    );
    return {
      mode: mode as GitTreeFile["mode"],
      objectId: objectId!,
      relativePath,
    };
  });
  const objectInput = `${metadata.map((file) => file.objectId).join("\n")}\n`;
  const sizeLines = gitTextWithInput(
    repository,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    objectInput,
  ).split("\n");
  if (sizeLines.length !== metadata.length) {
    throw new Error("Managed Skill Git object metadata is invalid");
  }
  let totalBytes = 0;
  const sizes = sizeLines.map((line, index) => {
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/u.exec(line);
    const size = Number(match?.[2]);
    if (
      !match
      || match[1] !== metadata[index]!.objectId
      || !Number.isSafeInteger(size)
      || size < 0
    ) {
      throw new Error("Managed Skill Git object metadata is invalid");
    }
    if (size > limits.maxFileBytes) {
      throw new Error("Managed Skill tree exceeds the file size limit");
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw new Error("Managed Skill tree exceeds the total size limit");
    }
    return size;
  });
  const objectOutput = gitBufferWithInput(
    repository,
    ["cat-file", "--batch"],
    objectInput,
    Math.max(1024 * 1024, totalBytes + metadata.length * 160 + 1024),
  );
  let offset = 0;
  const files = metadata.map((file, index) => {
    const headerEnd = objectOutput.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new Error("Managed Skill Git object output is invalid");
    }
    const header = objectOutput.subarray(offset, headerEnd).toString("ascii");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/u.exec(header);
    const size = sizes[index]!;
    if (match?.[1] !== file.objectId || Number(match?.[2]) !== size) {
      throw new Error("Managed Skill Git object output is invalid");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= objectOutput.length || objectOutput[contentEnd] !== 0x0a) {
      throw new Error("Managed Skill Git object output is invalid");
    }
    offset = contentEnd + 1;
    return {
      ...file,
      content: Buffer.from(objectOutput.subarray(contentStart, contentEnd)),
    };
  });
  if (offset !== objectOutput.length) {
    throw new Error("Managed Skill Git object output is invalid");
  }
  return files;
}

function hashTree(files: readonly GitTreeFile[]): string {
  const hash = createHash("sha256");
  hash.update("homeagent-managed-skill-tree-v1\0");
  for (const file of [...files].sort((a, b) =>
    compareText(a.relativePath, b.relativePath)
  )) {
    hash.update(file.mode);
    hash.update("\0");
    hash.update(file.relativePath);
    hash.update("\0");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(file.content.byteLength));
    hash.update(size);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

function isRelease(value: unknown): value is ManagedSkillRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ManagedSkillRelease>;
  return typeof candidate.bundleHash === "string"
    && /^[0-9a-f]{64}$/u.test(candidate.bundleHash)
    && typeof candidate.commit === "string"
    && /^[0-9a-f]{40,64}$/u.test(candidate.commit)
    && typeof candidate.fileCount === "number"
    && Number.isInteger(candidate.fileCount)
    && candidate.fileCount > 0
    && typeof candidate.importedAt === "number"
    && Number.isFinite(candidate.importedAt)
    && !!candidate.source
    && candidate.source.kind === "local-git"
    && typeof candidate.source.repository === "string"
    && typeof candidate.source.ref === "string"
    && typeof candidate.source.skillPath === "string";
}

function isIndexRelease(value: unknown): value is ManagedSkillIndexRelease {
  if (!isRelease(value)) return false;
  const candidate = value as Partial<ManagedSkillIndexRelease>;
  return Array.isArray(candidate.files)
    && candidate.files.length === candidate.fileCount
    && candidate.files.some((file) => file?.relativePath === "SKILL.md")
    && candidate.files.every((file) =>
      !!file
      && (file.mode === "100644" || file.mode === "100755")
      && typeof file.relativePath === "string"
    );
}

interface StoredTreeSnapshot {
  files: string[];
  directories: string[];
}

function storedTreeSnapshot(
  root: string,
  limits: ManagedSkillResourceLimits,
): StoredTreeSnapshot {
  const files: string[] = [];
  const directories: string[] = [];
  const pending: Array<{ directory: string; prefix: string }> = [{
    directory: root,
    prefix: "",
  }];
  while (pending.length > 0) {
    const { directory, prefix } = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeRelativePath(relativePath, "Managed Skill stored tree entry");
      const path = join(directory, entry.name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) {
        throw new Error("Managed Skill symbolic links are not allowed");
      }
      if (status.isDirectory()) {
        directories.push(relativePath);
        if (directories.length > limits.maxFiles * 4) {
          throw new Error("Managed Skill stored tree exceeds the directory count limit");
        }
        pending.push({ directory: path, prefix: relativePath });
      } else if (status.isFile()) {
        files.push(relativePath);
        if (files.length > limits.maxFiles) {
          throw new Error("Managed Skill stored tree exceeds the file count limit");
        }
      } else {
        throw new Error("Managed Skill stored tree contains an unsupported entry");
      }
    }
  }
  return {
    files: files.sort(compareText),
    directories: directories.sort(compareText),
  };
}

export class ManagedSkillStore {
  private readonly dataDir: string;
  private readonly root: string;
  private readonly releasesRoot: string;
  private readonly indexPath: string;
  private readonly limits: ManagedSkillResourceLimits;
  private readonly releases: Map<string, ManagedSkillIndexRelease>;

  constructor(dataDir: string, options: ManagedSkillStoreOptions = {}) {
    this.dataDir = canonicalizeProspectiveDirectory(dataDir);
    this.root = join(this.dataDir, "managed-skills");
    this.releasesRoot = join(this.root, "releases");
    this.indexPath = join(this.root, "index.json");
    this.limits = resolveResourceLimits(options.limits);
    this.releases = this.load();
  }

  private assertTrustedRootChain(): void {
    for (const path of [this.dataDir, this.root, this.releasesRoot]) {
      const status = lstatIfPresent(path);
      if (!status) continue;
      if (status.isSymbolicLink()) {
        throw new Error("Managed Skill symbolic links are not allowed in the storage root chain");
      }
      if (!status.isDirectory()) {
        throw new Error("Managed Skill storage root chain must contain directories only");
      }
      const canonical = realpathSync(path);
      if (
        canonicalPathKey(canonical) !== canonicalPathKey(path)
        || !pathIsWithin(this.dataDir, canonical)
      ) {
        throw new Error("Managed Skill symbolic links are not allowed in the storage root chain");
      }
    }
  }

  list(): ManagedSkillRelease[] {
    return [...this.releases.values()]
      .sort((a, b) => a.importedAt - b.importedAt || compareText(a.bundleHash, b.bundleHash))
      .map(cloneRelease);
  }

  get(bundleHash: string): ManagedSkillRelease | undefined {
    const release = this.releases.get(bundleHash);
    return release ? cloneRelease(release) : undefined;
  }

  importFromGit(input: ImportManagedSkillFromGitInput): ManagedSkillRelease {
    this.assertTrustedRootChain();
    const skillPath = assertSafeRelativePath(input.skillPath, "Managed Skill path");
    const ref = assertSafeGitRef(input.ref);
    const repository = realpathSync(input.repository);
    if (gitText(repository, ["status", "--porcelain=v1", "--untracked-files=all"])) {
      throw new Error("Managed Skill Git working tree must be clean");
    }
    const commit = gitText(repository, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
      throw new Error("Managed Skill Git ref did not resolve to an immutable commit");
    }
    const files = readGitTree(repository, commit, skillPath, this.limits);
    if (!files.some((file) => file.relativePath === "SKILL.md")) {
      throw new Error("Managed Skill tree must contain SKILL.md");
    }
    const bundleHash = hashTree(files);
    const existing = this.releases.get(bundleHash);
    if (existing) return cloneRelease(existing);

    const release: ManagedSkillIndexRelease = {
      bundleHash,
      commit,
      source: {
        kind: "local-git",
        repository,
        ref,
        skillPath,
      },
      fileCount: files.length,
      importedAt: Date.now(),
      files: files.map(({ mode, relativePath }) => ({ mode, relativePath })),
    };
    this.assertTrustedRootChain();
    mkdirSync(this.releasesRoot, { recursive: true, mode: 0o700 });
    this.assertTrustedRootChain();
    const releasePath = join(this.releasesRoot, bundleHash);
    if (!existsSync(releasePath)) {
      this.materializeRelease(releasePath, files);
    }
    this.validateStoredRelease(release);

    const next = new Map(this.releases);
    next.set(bundleHash, release);
    this.persist(next);
    this.releases.set(bundleHash, release);
    return cloneRelease(release);
  }

  importFromUrl(_input: ImportManagedSkillFromUrlInput): never {
    throw new Error("Managed Skill URL import is not implemented");
  }

  readSkillFile(bundleHash: string, relativePath = "SKILL.md"): string {
    this.assertTrustedRootChain();
    const release = this.releases.get(bundleHash);
    if (!release) {
      throw new Error(`Unknown Managed Skill release: ${bundleHash}`);
    }
    // A release can be modified after this Store instance loaded. Re-hash the
    // whole tree at every trust boundary instead of relying on constructor-time
    // validation or the content-addressed directory name alone.
    this.validateStoredRelease(release);
    const safePath = assertSafeRelativePath(relativePath, "Managed Skill file path");
    const releasePath = join(this.releasesRoot, bundleHash);
    return readFileSync(assertPathHasNoSymbolicLinks(releasePath, safePath), "utf8");
  }

  private materializeRelease(releasePath: string, files: readonly GitTreeFile[]): void {
    this.assertTrustedRootChain();
    const temporaryPath = join(
      this.releasesRoot,
      `.tmp-${process.pid}-${randomUUID()}`,
    );
    try {
      mkdirSync(temporaryPath, { recursive: false, mode: 0o700 });
      for (const file of files) {
        const destination = join(temporaryPath, file.relativePath);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, file.content, {
          mode: file.mode === "100755" ? 0o700 : 0o600,
        });
        syncRegularFile(destination);
      }
      const tree = storedTreeSnapshot(temporaryPath, this.limits);
      for (const directory of [...tree.directories].sort((left, right) =>
        right.split("/").length - left.split("/").length || compareText(right, left)
      )) {
        syncDirectory(join(temporaryPath, ...directory.split("/")));
      }
      syncDirectory(temporaryPath);
      try {
        durableRenameSync(temporaryPath, releasePath);
      } catch (error) {
        // Another importer may have won the same content-addressed rename.
        // The caller validates the visible destination before indexing it.
        if (!existsSync(releasePath)) throw error;
      }
      syncDirectory(this.releasesRoot);
      this.assertTrustedRootChain();
    } finally {
      if (existsSync(temporaryPath)) {
        rmSync(temporaryPath, { recursive: true, force: true });
      }
    }
  }

  private load(): Map<string, ManagedSkillIndexRelease> {
    this.assertTrustedRootChain();
    if (!existsSync(this.indexPath)) return new Map();
    const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as Partial<ManagedSkillIndexV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.releases)) {
      throw new Error("Unsupported Managed Skill index");
    }
    const releases = new Map<string, ManagedSkillIndexRelease>();
    for (const release of parsed.releases) {
      if (!isIndexRelease(release) || releases.has(release.bundleHash)) {
        throw new Error("Invalid Managed Skill index");
      }
      this.validateStoredRelease(release);
      releases.set(release.bundleHash, cloneIndexRelease(release));
    }
    return releases;
  }

  private validateStoredRelease(release: ManagedSkillIndexRelease): void {
    this.assertTrustedRootChain();
    if (release.fileCount > this.limits.maxFiles) {
      throw new Error("Managed Skill stored tree exceeds the file count limit");
    }
    const releasePath = join(this.releasesRoot, release.bundleHash);
    let storedTree: StoredTreeSnapshot;
    try {
      const status = lstatSync(releasePath);
      if (status.isSymbolicLink()) {
        throw new Error("Managed Skill symbolic links are not allowed");
      }
      if (!status.isDirectory()) throw new Error("not a directory");
      storedTree = storedTreeSnapshot(releasePath, this.limits);
    } catch (error) {
      if (
        error instanceof Error
        && /(symbolic links are not allowed|limit)/u.test(error.message)
      ) {
        throw error;
      }
      throw new Error("Managed Skill stored tree does not match its content hash");
    }
    const indexedFiles = [...release.files].sort((a, b) =>
      compareText(a.relativePath, b.relativePath)
    );
    const indexedPaths = indexedFiles.map((file) =>
      assertSafeRelativePath(file.relativePath, "Managed Skill indexed tree entry")
    );
    const indexedDirectories = [...new Set(indexedPaths.flatMap((path) => {
      const segments = path.split("/");
      return segments.slice(0, -1).map((_, index) =>
        segments.slice(0, index + 1).join("/")
      );
    }))].sort(compareText);
    if (
      JSON.stringify(storedTree.files) !== JSON.stringify(indexedPaths)
      || JSON.stringify(storedTree.directories) !== JSON.stringify(indexedDirectories)
    ) {
      throw new Error("Managed Skill stored tree does not match its content hash");
    }
    let totalBytes = 0;
    const files: GitTreeFile[] = indexedFiles.map((file) => {
      const path = assertPathHasNoSymbolicLinks(releasePath, file.relativePath);
      const size = lstatSync(path).size;
      if (size > this.limits.maxFileBytes) {
        throw new Error("Managed Skill stored tree exceeds the file size limit");
      }
      totalBytes += size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.limits.maxTotalBytes) {
        throw new Error("Managed Skill stored tree exceeds the total size limit");
      }
      return {
        ...file,
        objectId: "",
        content: readFileSync(path),
      };
    });
    if (hashTree(files) !== release.bundleHash) {
      throw new Error("Managed Skill stored tree does not match its content hash");
    }
  }

  private persist(releases: Map<string, ManagedSkillIndexRelease>): void {
    this.assertTrustedRootChain();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.assertTrustedRootChain();
    const temporaryPath = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    const file: ManagedSkillIndexV1 = {
      version: 1,
      releases: [...releases.values()].sort((a, b) =>
        a.importedAt - b.importedAt || compareText(a.bundleHash, b.bundleHash)
      ),
    };
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const descriptor = openSync(temporaryPath, "r+");
      try {
        durableFsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      durableRenameSync(temporaryPath, this.indexPath);
      const directoryDescriptor = openSync(this.root, "r");
      try {
        durableFsyncSync(directoryDescriptor, {
          allowUnsupportedDirectoryOnWindows: true,
        });
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A successful rename consumes the temporary path.
      }
      throw error;
    }
  }
}
