import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type DataMigrationState =
  | "not-needed"
  | "needs-confirmation"
  | "rejected"
  | "completed";

export type DataMigrationReason =
  | "legacy-source-missing"
  | "source-invalid"
  | "destination-not-empty"
  | "destination-conflict"
  | "paths-overlap"
  | "filesystem-error";

export interface DataMigrationPlan {
  state: Exclude<DataMigrationState, "completed">;
  source: string;
  destination: string;
  reason?: DataMigrationReason;
}

export interface DataMigrationResult {
  state: "completed";
  source: string;
  destination: string;
  recordPath: string;
}

export interface MigrationDirectoryEntry {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
}

export interface MigrationFileSystem {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readDirectory(path: string): MigrationDirectoryEntry[];
  makeDirectory(path: string, recursive: boolean): void;
  copyFile(source: string, destination: string): void;
  writeFile(path: string, contents: string): void;
  removeTree(path: string): void;
  removeEmptyDirectory(path: string): void;
  rename(source: string, destination: string): void;
  syncPath(path: string): void;
}

export interface DataMigrationOptions {
  destinationDir: string;
  homeDir?: string;
  sourceDir?: string;
  stagingDir?: string;
  now?: () => number;
  fileSystem?: MigrationFileSystem;
  /** Run additional synchronous preparation against the complete staging tree. */
  prepareStaging?: (stagingDir: string) => void;
  /** Permit selected destination-root metadata to be preserved in the migrated tree. */
  allowDestinationEntry?: (entry: MigrationDirectoryEntry) => boolean;
}

export type DataMigrationPromptResult = "continue" | "exit";
export type DataMigrationPromptRunner = (argv: string[]) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
}>;

const defaultPromptRunner: DataMigrationPromptRunner = async (argv) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** Ask before copying a legacy source install into the packaged-app data root. */
export async function prepareLegacyDataMigration(
  options: DataMigrationOptions & {
    runner?: DataMigrationPromptRunner;
    beforeCopy?: () => void | Promise<void>;
  },
): Promise<DataMigrationPromptResult> {
  const plan = planDataMigration(options);
  if (plan.state !== "needs-confirmation") return "continue";
  const script = [
    'display dialog "检测到旧版 Homebrain 数据。是否复制到 HomeAgent 数据目录？旧数据会保留不变。"',
    'with title "迁移到 HomeAgent"',
    'buttons {"退出", "迁移"}',
    'default button "迁移" cancel button "退出"',
    "with icon note",
  ].join(" ");
  let prompt: Awaited<ReturnType<DataMigrationPromptRunner>>;
  try {
    prompt = await (options.runner ?? defaultPromptRunner)([
      "/usr/bin/osascript",
      "-e",
      script,
    ]);
  } catch {
    return "exit";
  }
  if (prompt.code !== 0 || !prompt.stdout.includes("button returned:迁移")) return "exit";
  await options.beforeCopy?.();
  confirmDataMigration(options);
  return "continue";
}

export const nodeMigrationFileSystem: MigrationFileSystem = {
  exists: existsSync,
  isDirectory: (path) => lstatSync(path).isDirectory(),
  readDirectory: (path) =>
    readdirSync(path, { withFileTypes: true })
      .map((entry): MigrationDirectoryEntry => ({
        name: entry.name,
        kind: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  makeDirectory: (path, recursive) => {
    mkdirSync(path, { recursive, mode: 0o700 });
  },
  copyFile: (source, destination) => {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, lstatSync(source).mode & 0o777);
  },
  writeFile: (path, contents) => {
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "w" });
  },
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
  removeEmptyDirectory: (path) => rmdirSync(path),
  rename: renameSync,
  syncPath: (path) => {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      fsyncSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== "EINVAL"
        && code !== "ENOTSUP"
        && code !== "EBADF"
        && code !== "EPERM"
      ) throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

export function planDataMigration(options: DataMigrationOptions): DataMigrationPlan {
  const fs = options.fileSystem ?? nodeMigrationFileSystem;
  const home = options.homeDir ?? homedir();
  const previousPackagedSource = resolve(
    home,
    "Library",
    "Application Support",
    "Homebrain",
  );
  const previousSourceInstall = resolve(home, "Applications", "homebrain", "data");
  let source = resolve(options.sourceDir ?? previousPackagedSource);
  const destination = resolve(options.destinationDir);

  try {
    if (
      options.sourceDir === undefined
      && !fs.exists(previousPackagedSource)
      && fs.exists(previousSourceInstall)
    ) {
      source = previousSourceInstall;
    }
  } catch {
    return { state: "rejected", source, destination, reason: "filesystem-error" };
  }

  if (pathsOverlap(source, destination)) {
    return { state: "rejected", source, destination, reason: "paths-overlap" };
  }

  try {
    let destinationEntries: MigrationDirectoryEntry[] = [];
    if (fs.exists(destination)) {
      if (!fs.isDirectory(destination)) {
        return {
          state: "rejected",
          source,
          destination,
          reason: "destination-not-empty",
        };
      }
      destinationEntries = fs.readDirectory(destination);
      if (
        destinationEntries.length > 0
        && (
          !options.allowDestinationEntry
          || destinationEntries.some((entry) => !options.allowDestinationEntry!(entry))
        )
      ) {
        return {
          state: "rejected",
          source,
          destination,
          reason: "destination-not-empty",
        };
      }
    }
    if (!fs.exists(source)) {
      return {
        state: "not-needed",
        source,
        destination,
        reason: "legacy-source-missing",
      };
    }
    if (!fs.isDirectory(source)) {
      return { state: "rejected", source, destination, reason: "source-invalid" };
    }
    if (destinationEntries.length > 0) {
      const sourceNames = new Set(fs.readDirectory(source).map((entry) => entry.name));
      if (destinationEntries.some((entry) => sourceNames.has(entry.name))) {
        return { state: "rejected", source, destination, reason: "destination-conflict" };
      }
    }
  } catch {
    return { state: "rejected", source, destination, reason: "filesystem-error" };
  }

  return { state: "needs-confirmation", source, destination };
}

export function confirmDataMigration(options: DataMigrationOptions): DataMigrationResult {
  const fs = options.fileSystem ?? nodeMigrationFileSystem;
  const plan = planDataMigration(options);
  if (plan.state !== "needs-confirmation") {
    throw new Error(rejectionMessage(plan));
  }

  const at = (options.now ?? Date.now)();
  const destinationParent = dirname(plan.destination);
  const staging = resolve(
    options.stagingDir ??
      join(
        destinationParent,
        `.${basename(plan.destination)}.migration-${at}-${process.pid}`,
      ),
  );
  const backup = dataMigrationBackupPath(plan.destination);
  if (dirname(staging) !== destinationParent) {
    throw new Error("migration staging directory must be a sibling of the destination");
  }
  if (pathsOverlap(plan.source, staging) || pathsOverlap(plan.destination, staging)) {
    throw new Error("migration staging directory overlaps source or destination");
  }
  if (fs.exists(staging)) throw new Error("migration staging directory already exists");
  if (fs.exists(backup)) throw new Error("migration destination backup already exists");

  fs.makeDirectory(destinationParent, true);
  let destinationBackedUp = false;
  let committed = false;
  try {
    copyDirectory(plan.source, staging, fs);
    if (fs.exists(plan.destination)) {
      for (const entry of fs.readDirectory(plan.destination)) {
        copyEntry(
          join(plan.destination, entry.name),
          join(staging, entry.name),
          entry,
          fs,
        );
      }
    }
    options.prepareStaging?.(staging);
    const recordPath = join(staging, "migration-v2.json");
    const record = {
      source: plan.source,
      destination: plan.destination,
      time: new Date(at).toISOString(),
      result: "completed",
    };
    fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    fs.syncPath(recordPath);
    fs.syncPath(staging);

    if (fs.exists(plan.destination)) {
      if (!fs.isDirectory(plan.destination)) {
        throw new Error("migration destination is not a directory");
      }
      if (fs.readDirectory(plan.destination).length > 0) {
        fs.rename(plan.destination, backup);
        destinationBackedUp = true;
      } else {
        fs.removeEmptyDirectory(plan.destination);
      }
      fs.syncPath(destinationParent);
    }
    fs.rename(staging, plan.destination);
    committed = true;
    try {
      fs.syncPath(destinationParent);
    } catch {
      // The destination rename already committed; a sync failure cannot safely roll it back.
    }
    if (destinationBackedUp && fs.exists(backup)) {
      try {
        fs.removeTree(backup);
        fs.syncPath(destinationParent);
      } catch {
        // A leftover backup is recoverable and must not revert a committed migration.
      }
    }

    return {
      state: "completed",
      source: plan.source,
      destination: plan.destination,
      recordPath: join(plan.destination, "migration-v2.json"),
    };
  } catch (error) {
    if (!committed && destinationBackedUp && !fs.exists(plan.destination) && fs.exists(backup)) {
      fs.rename(backup, plan.destination);
      fs.syncPath(destinationParent);
    }
    if (fs.exists(staging)) fs.removeTree(staging);
    throw error;
  }
}

export function dataMigrationBackupPath(destination: string): string {
  const resolved = resolve(destination);
  return join(dirname(resolved), `.${basename(resolved)}.migration-backup`);
}

function copyDirectory(
  source: string,
  destination: string,
  fs: MigrationFileSystem,
): void {
  fs.makeDirectory(destination, false);
  for (const entry of fs.readDirectory(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.kind === "directory") {
      copyDirectory(sourcePath, destinationPath, fs);
    } else if (entry.kind === "file") {
      fs.copyFile(sourcePath, destinationPath);
      fs.syncPath(destinationPath);
    } else {
      throw new Error("legacy data contains an unsupported filesystem entry");
    }
  }
  fs.syncPath(destination);
}

function copyEntry(
  source: string,
  destination: string,
  entry: MigrationDirectoryEntry,
  fs: MigrationFileSystem,
): void {
  if (entry.kind === "directory") {
    copyDirectory(source, destination, fs);
  } else if (entry.kind === "file") {
    fs.copyFile(source, destination);
    fs.syncPath(destination);
  } else {
    throw new Error("migration data contains an unsupported filesystem entry");
  }
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function rejectionMessage(plan: DataMigrationPlan): string {
  switch (plan.reason) {
    case "destination-not-empty":
      return "migration destination is not empty";
    case "destination-conflict":
      return "migration source conflicts with destination metadata";
    case "paths-overlap":
      return "migration source and destination overlap";
    case "source-invalid":
      return "migration source is not a directory";
    case "filesystem-error":
      return "migration filesystem check failed";
    default:
      return "legacy data migration is not needed";
  }
}
