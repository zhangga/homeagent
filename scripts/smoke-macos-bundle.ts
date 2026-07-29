import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { KnowledgeEngine, type SpaceArchive } from "@homeagent/core";

const REQUIRED = [
  "Contents/Info.plist",
  "Contents/MacOS/homeagent",
  "Contents/Resources/app/homeagent.js",
  "Contents/Resources/bin/bun",
  "Contents/Resources/bin/lark-cli",
  "Contents/Resources/bin/attachment-extract",
  "Contents/Resources/HomeAgent.icns",
  "Contents/Resources/brand/homeagent-feishu-avatar-512.png",
] as const;
const RECOVERY_SPACE = "team/oc_packaged_recovery" as const;
const RECOVERY_CONTENT = "打包应用崩溃恢复验收：四类持久化数据必须保留。";
const RECOVERY_TASK = "打包应用恢复任务";
const RECOVERY_REMINDER = "打包应用恢复提醒";
const RECOVERY_LEARNING = "打包应用恢复学习计划";

interface RecoverySeed {
  archive: SpaceArchive;
  rawId: string;
  taskId: string;
  reminderId: string;
  learningPlanId: string;
}

export function inspectMacOSBundle(appPath: string): { appPath: string; files: string[] } {
  const resolved = resolve(appPath);
  if (!resolved.endsWith(".app")) throw new Error("bundle path must end in .app");
  const files = REQUIRED.map((file) => join(resolved, file));
  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      const relativePath = file.slice(resolved.length + 1).split(sep).join("/");
      throw new Error(`bundle is missing ${relativePath}`);
    }
  }
  const plist = readFileSync(join(resolved, "Contents", "Info.plist"), "utf8");
  if (
    !/<key>\s*CFBundleIconFile\s*<\/key>\s*<string>\s*HomeAgent\s*<\/string>/.test(
      plist,
    )
  ) {
    throw new Error("Info.plist does not reference HomeAgent.icns");
  }
  return { appPath: resolved, files };
}

function digestTree(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
      else hash.update("non-file");
    }
  };
  visit(root);
  return hash.digest("hex");
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a smoke-test port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      lastStatus = response.status;
      if (response.ok) return response;
    } catch {
      // The standalone process is expected to be briefly unavailable.
    }
    await Bun.sleep(200);
  }
  throw new Error(`smoke probe timed out${lastStatus ? ` (last status ${lastStatus})` : ""}`);
}

async function createRecoverySeed(root: string): Promise<RecoverySeed> {
  const engine = new KnowledgeEngine({
    dataDir: join(root, "archive-source"),
    runProvider: async () => "unused",
  });
  try {
    engine.ensureSpace(RECOVERY_SPACE, { chatId: "oc_packaged_recovery" });
    const rawId = await engine.remember({
      space: RECOVERY_SPACE,
      source: "message",
      author: "ou_packaged_recovery",
      chatId: "oc_packaged_recovery",
      messageId: "om_packaged_recovery",
      content: RECOVERY_CONTENT,
    });
    const task = engine.tasks.create({
      name: RECOVERY_TASK,
      space: RECOVERY_SPACE,
      topic: "确认打包应用异常退出后任务仍存在",
      enabled: false,
      notify: false,
      distillOnRun: false,
    });
    if (!task) throw new Error("failed to create packaged recovery task");
    const reminder = engine.reminders.create({
      title: RECOVERY_REMINDER,
      space: RECOVERY_SPACE,
      chatId: "oc_packaged_recovery",
      creatorId: "ou_packaged_recovery",
      triggerAt: Date.now() + 7 * 24 * 60 * 60_000,
    });
    if (!reminder) throw new Error("failed to create packaged recovery reminder");
    const learning = engine.learning.create({
      name: RECOVERY_LEARNING,
      space: RECOVERY_SPACE,
      creatorId: "ou_packaged_recovery",
      chatId: "oc_packaged_recovery",
      sourceTitle: "packaged-recovery.md",
      sourceContent: RECOVERY_CONTENT,
      sourceRawIds: [rawId],
      sourceMessageId: "om_packaged_recovery",
    });
    return {
      archive: await engine.exportSpace(RECOVERY_SPACE),
      rawId,
      taskId: task.id,
      reminderId: reminder.id,
      learningPlanId: learning.id,
    };
  } finally {
    engine.close();
  }
}

async function restoreRecoverySeed(
  baseUrl: string,
  seed: RecoverySeed,
  timeoutMs: number,
): Promise<void> {
  const body = new FormData();
  body.set(
    "archive",
    new File(
      [JSON.stringify(seed.archive)],
      "packaged-recovery.homeagent.json",
      { type: "application/json" },
    ),
  );
  const response = await fetch(`${baseUrl}/governance/restore`, {
    method: "POST",
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const location = response.headers.get("location") ?? "";
  if (response.status < 300 || response.status >= 400 || decodeURIComponent(location).includes("恢复失败")) {
    throw new Error(`packaged app failed to restore recovery archive (${response.status})`);
  }
}

async function assertRecoverySeed(
  baseUrl: string,
  seed: RecoverySeed,
  timeoutMs: number,
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/spaces/${encodeURIComponent(RECOVERY_SPACE)}/export`,
    { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!response.ok) throw new Error(`packaged recovery export failed (${response.status})`);
  const archive = await response.json() as SpaceArchive;
  if (!archive.raw.some((raw) => raw.id === seed.rawId && raw.content === RECOVERY_CONTENT)) {
    throw new Error("packaged app lost raw knowledge during crash recovery");
  }
  if (!archive.tasks.some((task) => task.id === seed.taskId && task.name === RECOVERY_TASK)) {
    throw new Error("packaged app lost task configuration during crash recovery");
  }
  if (!archive.reminders.some(
    (reminder) => (
      reminder.id === seed.reminderId
      && reminder.title === RECOVERY_REMINDER
      && reminder.status === "scheduled"
    ),
  )) {
    throw new Error("packaged app lost reminder state during crash recovery");
  }
  const plan = archive.learning.plans.find((candidate) => candidate.id === seed.learningPlanId);
  const source = archive.learning.sources.find(
    (candidate) => candidate.id === plan?.sourceId,
  );
  if (
    plan?.name !== RECOVERY_LEARNING
    || plan.status !== "active"
    || source?.content !== RECOVERY_CONTENT
  ) {
    throw new Error("packaged app lost learning progress during crash recovery");
  }
}

async function stopProcess(
  child: ReturnType<typeof Bun.spawn>,
  signal: "SIGKILL" | "SIGTERM",
  failure: string,
): Promise<void> {
  try {
    child.kill(signal);
  } catch {
    // The process may have exited at the signal boundary.
  }
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(10_000).then(() => {
      throw new Error(failure);
    }),
  ]);
  if (signal === "SIGKILL" && exitCode !== 128 + 9) {
    throw new Error(`standalone process exited with ${exitCode}; expected SIGKILL exit 137`);
  }
  if (signal === "SIGTERM" && exitCode !== 0 && exitCode !== 128 + 15) {
    throw new Error(`standalone process exited unexpectedly after SIGTERM: ${exitCode}`);
  }
}

export async function smokeMacOSBundle(appPath: string, timeoutMs = 20_000): Promise<void> {
  const source = inspectMacOSBundle(appPath).appPath;
  const root = mkdtempSync(join(tmpdir(), "homeagent-smoke-"));
  const home = join(root, "home");
  const installed = join(root, "Applications", basename(source));
  cpSync(source, installed, { recursive: true, preserveTimestamps: true });
  const before = digestTree(installed);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const executable = join(installed, "Contents", "MacOS", "homeagent");
  const recoverySeed = await createRecoverySeed(root);
  const env = {
    ...process.env,
    HOME: home,
    HOMEAGENT_DATA_DIR: join(home, "Library", "Application Support", "HomeAgent"),
    HOMEAGENT_LOG_DIR: join(home, "Library", "Logs", "HomeAgent"),
    HOMEAGENT_WEB_HOST: "127.0.0.1",
    HOMEAGENT_WEB_PORT: String(port),
    HOMEAGENT_SERVICE_MANAGED: "0",
    HOMEAGENT_CLAUDE_BIN: join(root, "missing-claude"),
    HOMEAGENT_TRAE_BIN: join(root, "missing-trae"),
  };
  const spawn = () => Bun.spawn([executable, "serve"], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env,
  });
  try {
    const crashed = spawn();
    try {
      await waitFor(`${baseUrl}/healthz`, timeoutMs);
      await restoreRecoverySeed(baseUrl, recoverySeed, timeoutMs);
      await assertRecoverySeed(baseUrl, recoverySeed, timeoutMs);
    } finally {
      await stopProcess(
        crashed,
        "SIGKILL",
        "standalone process did not stop after SIGKILL",
      );
    }

    const restarted = spawn();
    try {
      await waitFor(`${baseUrl}/healthz`, timeoutMs);
      await assertRecoverySeed(baseUrl, recoverySeed, timeoutMs);
      const setup = await waitFor(`${baseUrl}/setup`, timeoutMs);
      const body = await setup.text();
      if (!body.includes("homeagent") || !body.includes("设置进度")) {
        throw new Error("standalone setup page did not render the guided flow");
      }
      if (!body.includes("安装并连接 ChatGPT") || body.includes("npm install")) {
        throw new Error("standalone setup did not expose the zero-terminal AI flow");
      }
    } finally {
      await stopProcess(
        restarted,
        "SIGTERM",
        "standalone process did not stop after SIGTERM",
      );
    }
    if (digestTree(installed) !== before) throw new Error("standalone process modified its app bundle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const at = process.argv.indexOf("--app");
    const app = at >= 0 ? process.argv[at + 1] : join(import.meta.dir, "..", "dist", "HomeAgent.app");
    if (!app) throw new Error("missing --app path");
    await smokeMacOSBundle(app);
    console.log(`Smoke test passed: ${resolve(app)}`);
  } catch (error) {
    console.error(`smoke:macos: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
