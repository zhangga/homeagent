import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

export type MacOSTarget = "arm64" | "x64";

export interface MacOSBuildPlan {
  repoRoot: string;
  target: MacOSTarget;
  bunTarget: "bun-darwin-arm64" | "bun-darwin-x64";
  swiftTarget: "arm64-apple-macos13.0" | "x86_64-apple-macos13.0";
  appPath: string;
  larkVersion: string;
  larkAsset: string;
  outputs: string[];
}

const LARK_VERSION = "1.0.69";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MACOS_ICON_FILES = [
  "icon_16x16.png",
  "icon_16x16@2x.png",
  "icon_32x32.png",
  "icon_32x32@2x.png",
  "icon_128x128.png",
  "icon_128x128@2x.png",
  "icon_256x256.png",
  "icon_256x256@2x.png",
  "icon_512x512.png",
  "icon_512x512@2x.png",
] as const;

export function createMacOSBuildPlan(input: {
  repoRoot?: string;
  target: MacOSTarget;
}): MacOSBuildPlan {
  const repoRoot = resolve(input.repoRoot ?? join(import.meta.dir, ".."));
  const upstreamArch = input.target === "arm64" ? "arm64" : "amd64";
  return {
    repoRoot,
    target: input.target,
    bunTarget: input.target === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64",
    swiftTarget: input.target === "arm64" ? "arm64-apple-macos13.0" : "x86_64-apple-macos13.0",
    appPath: join(repoRoot, "dist", "HomeAgent.app"),
    larkVersion: LARK_VERSION,
    larkAsset: `lark-cli-${LARK_VERSION}-darwin-${upstreamArch}.tar.gz`,
    outputs: [
      "HomeAgent.app/Contents/Info.plist",
      "HomeAgent.app/Contents/MacOS/homeagent",
      "HomeAgent.app/Contents/Resources/app/homeagent.js",
      "HomeAgent.app/Contents/Resources/bin/bun",
      "HomeAgent.app/Contents/Resources/bin/lark-cli",
      "HomeAgent.app/Contents/Resources/bin/attachment-extract",
      "HomeAgent.app/Contents/Resources/HomeAgent.icns",
      "HomeAgent.app/Contents/Resources/brand/homeagent-feishu-avatar-512.png",
      "HomeAgent.app/Contents/Resources/LICENSE",
      "HomeAgent.app/Contents/Resources/THIRD_PARTY_NOTICES.md",
    ],
  };
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function mustRun(argv: string[], cwd: string): Promise<string> {
  const result = await run(argv, cwd);
  if (result.code !== 0) {
    throw new Error(`${argv[0]} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(-600)}`);
  }
  return result.stdout;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`refusing non-HTTPS build input: ${url}`);
  const response = await fetch(parsed, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${parsed.hostname}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error("download exceeds the release input limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error("download is empty or exceeds the release input limit");
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedChecksum(checksums: string, asset: string): string {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match?.[2] === asset) return match[1]!.toLowerCase();
  }
  throw new Error(`published checksum is missing ${asset}`);
}

function findFile(root: string, names: Set<string>): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, names);
      if (found) return found;
    } else if (entry.isFile() && names.has(entry.name)) {
      return path;
    }
  }
  return undefined;
}

function bundleVersion(version: string): string {
  const values = version.match(/\d+/g)?.slice(0, 4) ?? ["0"];
  return values.join(".");
}

function assertInside(child: string, parent: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) return;
  throw new Error(`build output escaped its root: ${child}`);
}

async function assertReleaseInputs(plan: MacOSBuildPlan, allowDirty: boolean): Promise<void> {
  const required = [
    "bun.lock",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "assets/macos/Info.plist.template",
    "assets/brand/homeagent-feishu-avatar-512.png",
    ...MACOS_ICON_FILES.map((file) => `assets/macos/AppIcon.iconset/${file}`),
  ];
  for (const file of required) {
    const path = join(plan.repoRoot, file);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`missing release input: ${file}`);
    }
  }
  if (!allowDirty) {
    const status = await mustRun(["git", "status", "--porcelain", "--", "bun.lock"], plan.repoRoot);
    if (status.trim()) throw new Error("bun.lock must be tracked and clean for a release build");
  }
}

async function installLarkCli(plan: MacOSBuildPlan, destination: string, workDir: string): Promise<void> {
  const base = `https://github.com/larksuite/cli/releases/download/v${plan.larkVersion}`;
  const [archive, checksumBytes] = await Promise.all([
    fetchBytes(`${base}/${plan.larkAsset}`),
    fetchBytes(`${base}/checksums.txt`),
  ]);
  const checksums = new TextDecoder().decode(checksumBytes);
  const expected = expectedChecksum(checksums, plan.larkAsset);
  if (sha256(archive) !== expected) throw new Error("lark-cli SHA-256 verification failed");

  const archivePath = join(workDir, plan.larkAsset);
  const extractDir = join(workDir, "lark");
  await Bun.write(archivePath, archive);
  mkdirSync(extractDir, { recursive: true });
  const entries = await mustRun(["/usr/bin/tar", "-tzf", archivePath], plan.repoRoot);
  for (const entry of entries.split(/\r?\n/).filter(Boolean)) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error("lark-cli archive contains an unsafe path");
    }
  }
  await mustRun(["/usr/bin/tar", "-xzf", archivePath, "-C", extractDir], plan.repoRoot);
  const binary = findFile(extractDir, new Set(["lark-cli", "lark"]));
  if (!binary || !lstatSync(binary).isFile()) throw new Error("lark-cli archive did not contain an executable");
  copyFileSync(binary, destination);
  chmodSync(destination, 0o755);
}

async function writeDependencyLicenses(plan: MacOSBuildPlan, resources: string): Promise<void> {
  const licenses = join(resources, "licenses");
  mkdirSync(licenses, { recursive: true });
  const inputs = [
    {
      name: "bun-LICENSE.md",
      url: `https://raw.githubusercontent.com/oven-sh/bun/bun-v${Bun.version}/LICENSE.md`,
    },
    {
      name: "lark-cli-LICENSE",
      url: `https://raw.githubusercontent.com/larksuite/cli/v${plan.larkVersion}/LICENSE`,
    },
  ];
  for (const input of inputs) writeFileSync(join(licenses, input.name), await fetchBytes(input.url), { mode: 0o644 });
  const honoLicense = installedHonoLicense(plan.repoRoot);
  copyFileSync(honoLicense, join(licenses, "hono-LICENSE"));
}

function installedHonoLicense(repoRoot: string): string {
  const hoisted = join(repoRoot, "node_modules", "hono", "LICENSE");
  if (existsSync(hoisted) && lstatSync(hoisted).isFile()) return hoisted;
  const bunStore = join(repoRoot, "node_modules", ".bun");
  const candidates = existsSync(bunStore)
    ? readdirSync(bunStore)
        .filter((entry) => /^hono@[^/]+$/.test(entry))
        .map((entry) => join(bunStore, entry, "node_modules", "hono", "LICENSE"))
        .filter((path) => existsSync(path) && lstatSync(path).isFile())
    : [];
  if (candidates.length === 1) return candidates[0]!;
  throw new Error("Hono license is missing or ambiguous; run bun install first");
}

export async function buildMacOSApp(input: {
  target: MacOSTarget;
  repoRoot?: string;
  allowDirty?: boolean;
  signingIdentity?: string;
}): Promise<MacOSBuildPlan> {
  if (process.platform !== "darwin") throw new Error("HomeAgent.app can only be assembled on macOS");
  const plan = createMacOSBuildPlan(input);
  await assertReleaseInputs(plan, input.allowDirty ?? false);
  const contents = join(plan.appPath, "Contents");
  const macOSDir = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  const appDir = join(resources, "app");
  const binDir = join(resources, "bin");
  const workDir = join(plan.repoRoot, "dist", ".macos-build", plan.target);
  for (const path of [plan.appPath, workDir]) assertInside(path, join(plan.repoRoot, "dist"));
  rmSync(plan.appPath, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(macOSDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const currentTarget = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (currentTarget !== plan.target) {
    throw new Error(`build ${plan.target} on a matching macOS runner (current: ${process.arch})`);
  }
  const executable = join(macOSDir, "homeagent");
  await mustRun([
    "/usr/bin/xcrun",
    "swiftc",
    "-O",
    "-target",
    plan.swiftTarget,
    "-module-cache-path",
    join(workDir, "swift-module-cache"),
    join(plan.repoRoot, "assets", "macos", "launcher.swift"),
    "-o",
    executable,
  ], plan.repoRoot);
  chmodSync(executable, 0o755);

  const appEntry = join(appDir, "homeagent.js");
  await mustRun([
    process.execPath, "build", "--target=bun",
    join(plan.repoRoot, "packages", "app", "src", "main.ts"),
    `--outfile=${appEntry}`,
  ], plan.repoRoot);
  chmodSync(appEntry, 0o644);
  const bundledBun = join(binDir, "bun");
  copyFileSync(process.execPath, bundledBun);
  chmodSync(bundledBun, 0o755);

  const helper = join(binDir, "attachment-extract");
  await mustRun([
    "/usr/bin/xcrun",
    "swiftc",
    "-O",
    "-target",
    plan.swiftTarget,
    "-module-cache-path",
    join(workDir, "swift-module-cache"),
    "-framework",
    "Vision",
    "-framework",
    "PDFKit",
    join(plan.repoRoot, "packages", "orchestrator", "src", "attachment-extract.swift"),
    "-o",
    helper,
  ], plan.repoRoot);
  chmodSync(helper, 0o755);
  await installLarkCli(plan, join(binDir, "lark-cli"), workDir);

  const pkg = JSON.parse(readFileSync(join(plan.repoRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error("package.json must contain a semantic release version");
  }
  const plistTemplate = readFileSync(join(plan.repoRoot, "assets", "macos", "Info.plist.template"), "utf8");
  writeFileSync(
    join(contents, "Info.plist"),
    plistTemplate
      .replaceAll("{{VERSION}}", pkg.version)
      .replaceAll("{{BUILD_VERSION}}", bundleVersion(pkg.version)),
    { mode: 0o644 },
  );
  const iconPath = join(resources, "HomeAgent.icns");
  await mustRun([
    "/usr/bin/iconutil",
    "-c",
    "icns",
    join(plan.repoRoot, "assets", "macos", "AppIcon.iconset"),
    "-o",
    iconPath,
  ], plan.repoRoot);
  if (!existsSync(iconPath) || !lstatSync(iconPath).isFile()) {
    throw new Error("iconutil did not create HomeAgent.icns");
  }
  const brandResources = join(resources, "brand");
  mkdirSync(brandResources, { recursive: true });
  copyFileSync(
    join(plan.repoRoot, "assets", "brand", "homeagent-feishu-avatar-512.png"),
    join(brandResources, "homeagent-feishu-avatar-512.png"),
  );
  copyFileSync(join(plan.repoRoot, "LICENSE"), join(resources, "LICENSE"));
  copyFileSync(join(plan.repoRoot, "THIRD_PARTY_NOTICES.md"), join(resources, "THIRD_PARTY_NOTICES.md"));
  await writeDependencyLicenses(plan, resources);

  const signingIdentity = input.signingIdentity
    ?? process.env.HOMEAGENT_CODESIGN_IDENTITY
    ?? process.env.HOMEBRAIN_CODESIGN_IDENTITY
    ?? "-";
  const signatureFlags = signingIdentity === "-"
    ? ["--timestamp=none"]
    : ["--timestamp", "--options", "runtime"];
  for (const path of [helper, join(binDir, "lark-cli"), executable]) {
    await mustRun(["/usr/bin/codesign", "--force", ...signatureFlags, "--sign", signingIdentity, path], plan.repoRoot);
  }
  await mustRun([
    "/usr/bin/codesign",
    "--force",
    ...signatureFlags,
    "--entitlements",
    join(plan.repoRoot, "assets", "macos", "Bun.entitlements.plist"),
    "--sign",
    signingIdentity,
    bundledBun,
  ], plan.repoRoot);
  await mustRun([
    "/usr/bin/codesign",
    "--force",
    ...signatureFlags,
    "--sign",
    signingIdentity,
    plan.appPath,
  ], plan.repoRoot);
  rmSync(workDir, { recursive: true, force: true });
  return plan;
}

function parseArgs(args: string[]): { target: MacOSTarget; allowDirty: boolean; dryRun: boolean } {
  const at = args.indexOf("--target");
  const value = at >= 0 ? args[at + 1] : process.arch;
  const target = value === "arm64" ? "arm64" : value === "x64" || value === "x86_64" ? "x64" : undefined;
  if (!target) throw new Error("--target must be arm64 or x64");
  return { target, allowDirty: args.includes("--allow-dirty"), dryRun: args.includes("--dry-run") };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const plan = args.dryRun
      ? createMacOSBuildPlan({ target: args.target })
      : await buildMacOSApp({ target: args.target, allowDirty: args.allowDirty });
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(`build:macos: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
