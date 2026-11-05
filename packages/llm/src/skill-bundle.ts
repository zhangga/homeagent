import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileIdentity, fileIdentitiesMatch, type FileIdentity } from "@homeagent/shared";
import { SKILL_STAGING_MAX_BYTES } from "./provider-preparation.ts";

interface ProviderSkillBundleFile { path: string; mode: number; content: Buffer }
interface ProviderSkillBundleSnapshot {
  hash: string;
  files: ProviderSkillBundleFile[];
  entries: number;
  totalBytes: number;
  proof: FileIdentity[];
}
interface BundleManifest {
  canonicalRoot: string;
  files: { path: string; fullPath: string; mode: number; identity: FileIdentity }[];
  entries: number;
  totalBytes: number;
  proof: FileIdentity[];
}

// Content reads can be slow on a cold filesystem. Bound simultaneous I/O without
// reducing the existing bundle size, entry limits, or installed dependencies.
const CONTENT_READ_CONCURRENCY = 16;

function scanBundle(skillFile: string, maxEntries = 50_000, maxTotalBytes = SKILL_STAGING_MAX_BYTES): BundleManifest {
  const root = dirname(skillFile);
  const rootBefore = lstatSync(root);
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) throw new Error("Skill bundle root is invalid");
  const canonicalRoot = realpathSync(root);
  const manifest: BundleManifest = { canonicalRoot, files: [], entries: 0, totalBytes: 0, proof: [fileIdentity(root, rootBefore)] };
  const pending = [{ directory: root, relativeDir: "", depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 32) throw new Error("Skill bundle is too deeply nested");
    const directoryBefore = lstatSync(current.directory);
    const fromRoot = relative(canonicalRoot, realpathSync(current.directory));
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()
      || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Skill bundle directory escapes its root");
    }
    const children = readdirSync(current.directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (++manifest.entries > maxEntries) throw new Error("Skill bundle has too many entries");
      const fullPath = join(current.directory, child.name);
      const metadata = lstatSync(fullPath);
      const identity = fileIdentity(fullPath, metadata);
      manifest.proof.push(identity);
      if (metadata.isSymbolicLink()) throw new Error("Skill bundle cannot contain symbolic links");
      const fromRoot = relative(canonicalRoot, realpathSync(fullPath));
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error("Skill bundle entry escapes its root");
      }
      const path = join(current.relativeDir, child.name).split(sep).join("/");
      if (metadata.isDirectory()) {
        pending.push({ directory: fullPath, relativeDir: path, depth: current.depth + 1 });
      } else {
        if (!metadata.isFile()) throw new Error("Skill bundle contains a non-regular file");
        manifest.totalBytes += metadata.size;
        if (manifest.totalBytes > maxTotalBytes) throw new Error("Skill bundle is too large");
        manifest.files.push({ path, fullPath, mode: metadata.mode & 0o777, identity });
      }
    }
  }
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  if (!manifest.files.some(file => file.path === "SKILL.md")) throw new Error("Skill bundle has no SKILL.md");
  return manifest;
}

function checkReadPath(manifest: BundleManifest, file: BundleManifest["files"][number]): void {
  // Queued reads must not follow an entry replaced after traversal.
  if (!fileIdentitiesMatch([file.identity])) throw new Error("Skill bundle changed while it was being captured");
  const fromRoot = relative(manifest.canonicalRoot, realpathSync(file.fullPath));
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Skill bundle entry escapes its root");
  }
}

function finishBundle(manifest: BundleManifest, contents: Buffer[]): ProviderSkillBundleSnapshot {
  if (!fileIdentitiesMatch(manifest.proof)
    || manifest.files.some((file, index) => contents[index]?.length !== file.identity.size)) {
    throw new Error("Skill bundle changed while it was being captured");
  }
  const files = manifest.files.map((file, index) => ({ path: file.path, mode: file.mode, content: contents[index]! }));
  const hash = createHash("sha256");
  if (files.length === 1 && files[0]!.path === "SKILL.md") hash.update(files[0]!.content);
  else {
    hash.update("homeagent-skill-bundle-v1\0");
    for (const file of files) {
      hash.update(`${Buffer.byteLength(file.path)}:${file.path}\0${file.mode}\0${file.content.length}\0`);
      hash.update(file.content);
    }
  }
  return { hash: hash.digest("hex"), files, entries: manifest.entries, totalBytes: manifest.totalBytes, proof: manifest.proof };
}

export function captureProviderSkillBundle(skillFile: string, maxEntries?: number, maxTotalBytes?: number): ProviderSkillBundleSnapshot {
  const manifest = scanBundle(skillFile, maxEntries, maxTotalBytes);
  return finishBundle(manifest, manifest.files.map(file => {
    checkReadPath(manifest, file);
    return readFileSync(file.fullPath);
  }));
}

/** All paths/limits are checked before reading; failure drains readers before cleanup. */
export async function captureProviderSkillBundleAsync(
  skillFile: string, maxEntries?: number, maxTotalBytes?: number,
  read: (path: string) => Promise<Buffer> = readFile,
): Promise<ProviderSkillBundleSnapshot> {
  const manifest = scanBundle(skillFile, maxEntries, maxTotalBytes);
  const contents: Buffer[] = new Array(manifest.files.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(CONTENT_READ_CONCURRENCY, manifest.files.length) }, async () => {
    while (!failure && next < manifest.files.length) {
      const index = next++;
      try {
        const file = manifest.files[index]!;
        checkReadPath(manifest, file);
        contents[index] = await read(file.fullPath);
      }
      catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
  return finishBundle(manifest, contents);
}

/** The sync and async paths retain the same complete, frozen v1 manifest. */
export function hashProviderSkillBundle(skillFile: string, maxEntries?: number, maxTotalBytes?: number): string {
  return captureProviderSkillBundle(skillFile, maxEntries, maxTotalBytes).hash;
}

export async function hashProviderSkillBundleAsync(skillFile: string, maxEntries?: number, maxTotalBytes?: number): Promise<string> {
  return (await captureProviderSkillBundleAsync(skillFile, maxEntries, maxTotalBytes)).hash;
}
