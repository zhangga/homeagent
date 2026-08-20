import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  inspectMacOSBundle,
  smokeMacOSBundle,
} from "./smoke-macos-bundle.ts";

const REQUIRED_FILES = [
  "bun.lock",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release-macos.yml",
  "docs/beta-release-runbook.md",
  "scripts/soak-feishu-e2e.ts",
  "quality/evaluation-cases.json",
  "assets/brand/homeagent-mark.svg",
  "assets/brand/homeagent-glyph.svg",
  "assets/brand/homeagent-feishu-avatar-512.png",
] as const;

const SIGNING_ENVIRONMENT = [
  "APPLE_CERTIFICATE_BASE64",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_KEYCHAIN_PASSWORD",
  "APPLE_CODESIGN_IDENTITY",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_APP_PASSWORD",
] as const;

const RELEASE_SPACE_ARCHIVE_CONTRACT = "homeagent.space v14";
const RELEASE_AGENT_SOAK_SCENARIOS = [
  "agent_revision_lifecycle",
  "writable_task_approval",
  "readonly_task_retry",
] as const;
const RELEASE_WORKFLOW_REQUIRED_COMMANDS = [
  "bun run evaluate:quality",
  "bun run verify:crash-recovery",
  "bun run verify:beta -- --checks-only",
] as const;
const RELEASE_WORKFLOW_REQUIRED_SETTINGS = ["draft: true", "prerelease: true"] as const;

function hasWorkflowRunCommand(workflow: string, command: string): boolean {
  return workflow.split(/\r?\n/).some((line) => line.trim() === `- run: ${command}`);
}

function hasWorkflowSetting(workflow: string, setting: string): boolean {
  return workflow.split(/\r?\n/).some((line) => line.trim() === setting);
}

function declaredAgentPlatformSoakScenarios(source: string): Set<string> {
  const declaration = /export const AGENT_PLATFORM_SOAK_SCENARIOS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source);
  if (!declaration) return new Set();
  return new Set(
    [...declaration[1]!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!),
  );
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BetaCommandRunner = (argv: string[], cwd: string) => Promise<CommandResult>;

export interface BetaReadinessOptions {
  repoRoot?: string;
  allowDirty?: boolean;
  checksOnly?: boolean;
  requireSigningEnvironment?: boolean;
  appPath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: BetaCommandRunner;
  smoke?: (appPath: string) => Promise<void>;
}

export interface BetaReadinessReport {
  scope: "structure-only" | "local-preflight";
  version: string;
  commands: string[];
  localChecksPassed: boolean;
  automatedBrandAssetsVerified: boolean;
  appSmokeTested: boolean;
  signingEnvironmentChecked: boolean;
  manualVisualChecksPending: string[];
  externalGatesPending: string[];
}

const defaultRunner: BetaCommandRunner = async (argv, cwd) => {
  const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};

async function mustRun(
  runner: BetaCommandRunner,
  argv: string[],
  cwd: string,
): Promise<CommandResult> {
  const result = await runner(argv, cwd);
  if (result.code !== 0) {
    throw new Error(
      `${argv.join(" ")} failed (${result.code}): `
      + `${(result.stderr || result.stdout).trim().slice(-600)}`,
    );
  }
  return result;
}

export async function verifyBetaReadiness(
  options: BetaReadinessOptions = {},
): Promise<BetaReadinessReport> {
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dir, ".."));
  const runner = options.runner ?? defaultRunner;
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(repoRoot, file))) throw new Error(`missing beta release input: ${file}`);
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (
    typeof pkg.version !== "string"
    || !/^\d+\.\d+\.\d+-beta(?:\.[0-9A-Za-z.-]+)?$/u.test(pkg.version)
  ) {
    throw new Error("package.json must contain a semantic beta version");
  }
  const releaseRunbook = readFileSync(
    join(repoRoot, "docs/beta-release-runbook.md"),
    "utf8",
  );
  if (!releaseRunbook.includes(RELEASE_SPACE_ARCHIVE_CONTRACT)) {
    throw new Error(
      `beta release runbook must document ${RELEASE_SPACE_ARCHIVE_CONTRACT}`,
    );
  }
  const soakDriver = readFileSync(join(repoRoot, "scripts/soak-feishu-e2e.ts"), "utf8");
  const declaredSoakScenarios = declaredAgentPlatformSoakScenarios(soakDriver);
  for (const scenario of RELEASE_AGENT_SOAK_SCENARIOS) {
    if (!releaseRunbook.includes(scenario) || !declaredSoakScenarios.has(scenario)) {
      throw new Error(`beta release contract is missing Agent soak scenario: ${scenario}`);
    }
  }
  const releaseWorkflow = readFileSync(
    join(repoRoot, ".github/workflows/release-macos.yml"),
    "utf8",
  );
  for (const command of RELEASE_WORKFLOW_REQUIRED_COMMANDS) {
    if (!hasWorkflowRunCommand(releaseWorkflow, command)) {
      throw new Error(`macOS tag release workflow must run ${command}`);
    }
  }
  for (const setting of RELEASE_WORKFLOW_REQUIRED_SETTINGS) {
    if (!hasWorkflowSetting(releaseWorkflow, setting)) {
      throw new Error(`macOS tag release workflow must keep candidate assets private with ${setting}`);
    }
  }
  if (!options.allowDirty) {
    const status = await mustRun(runner, ["git", "status", "--porcelain"], repoRoot);
    if (status.stdout.trim()) throw new Error("working tree must be clean for beta verification");
  }
  if (options.requireSigningEnvironment) {
    const env = options.env ?? process.env;
    const missing = SIGNING_ENVIRONMENT.filter((name) => !env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`missing release environment: ${missing.join(", ")}`);
    }
  }

  const commands: string[] = [];
  if (!options.checksOnly) {
    for (const argv of [
      ["bun", "run", "verify:brand"],
      ["bun", "test"],
      ["bun", "run", "typecheck"],
      ["bun", "run", "evaluate:quality"],
      ["bun", "run", "verify:crash-recovery"],
    ]) {
      await mustRun(runner, argv, repoRoot);
      commands.push(argv.join(" "));
    }
  }
  if (options.appPath) {
    const appPath = resolve(options.appPath);
    inspectMacOSBundle(appPath);
    if (!options.checksOnly) {
      if (process.platform !== "darwin") {
        throw new Error("a macOS app smoke test must run on macOS");
      }
      await (options.smoke ?? smokeMacOSBundle)(appPath);
    }
  }
  return {
    scope: options.checksOnly ? "structure-only" : "local-preflight",
    version: pkg.version,
    commands,
    localChecksPassed: !options.checksOnly,
    automatedBrandAssetsVerified: !options.checksOnly,
    appSmokeTested: options.appPath !== undefined && !options.checksOnly,
    signingEnvironmentChecked: options.requireSigningEnvironment ?? false,
    manualVisualChecksPending: [
      "macos-finder-dock-dmg",
      "admin-setup-restarting",
      "feishu-circular-avatar-crop",
    ],
    externalGatesPending: [
      ...(!options.appPath || options.checksOnly
        ? ["packaged-app-crash-smoke"]
        : []),
      "signed-and-notarized-release-artifacts",
      "fresh-mac-no-terminal-install",
      "real-feishu-24-48h-soak",
    ],
  };
}

export function parseBetaReadinessArgs(args: string[]): BetaReadinessOptions {
  const parsed: BetaReadinessOptions = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (seen.has(arg)) throw new Error(`duplicate argument: ${arg}`);
    if (arg === "--allow-dirty") {
      parsed.allowDirty = true;
      seen.add(arg);
      continue;
    }
    if (arg === "--checks-only") {
      parsed.checksOnly = true;
      seen.add(arg);
      continue;
    }
    if (arg === "--require-signing-env") {
      parsed.requireSigningEnvironment = true;
      seen.add(arg);
      continue;
    }
    if (arg === "--app") {
      const appPath = args[index + 1];
      if (!appPath || appPath.startsWith("--")) throw new Error("--app requires a path");
      parsed.appPath = appPath;
      seen.add(arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const report = await verifyBetaReadiness(parseBetaReadinessArgs(args));
    const outcome = report.scope === "structure-only"
      ? "Beta structure check completed"
      : "Local beta preflight passed";
    console.log(
      `${outcome}; external release gates remain pending: `
      + `${report.externalGatesPending.join(", ")}. ${JSON.stringify(report)}`,
    );
  } catch (error) {
    console.error(`verify:beta: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
