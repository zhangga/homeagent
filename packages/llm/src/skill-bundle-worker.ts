import { parentPort } from "node:worker_threads";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileIdentitiesMatch, type FileIdentity } from "@homeagent/shared";
import { captureProviderSkillBundleAsync, type ProviderSkillInput } from "./providers.ts";
import type { SkillBundleReply } from "./skill-bundle-client.ts";
import { SkillStagingBudget, providerPreparationFailure } from "./provider-preparation.ts";

const verified = new Map<string, SkillBundleReply>();
let budget: SkillStagingBudget | undefined;
let pending = Promise.resolve();
parentPort!.on("message", (message: { id: number; operation: "stage" | "verify" | "remember"; input: ProviderSkillInput; directory?: string; proof?: FileIdentity[]; requestedSkills: number }) => { pending = pending.then(async () => {
  try {
    const { input, operation } = message;
    const key = JSON.stringify(input);
    if (operation === "remember") {
      verified.set(key, { proof: message.proof!, entries: 0, totalBytes: 0 });
      return;
    }
    const previous = verified.get(key);
    if (operation === "verify" && previous && fileIdentitiesMatch(previous.proof)) {
      parentPort!.postMessage({ id: message.id, ...previous });
      return;
    }
    let captured = await captureProviderSkillBundleAsync(input.skillFile);
    if (captured.hash !== input.bundleHash || !fileIdentitiesMatch(captured.proof)) throw new Error("changed");
    if (operation === "stage") {
      budget ??= new SkillStagingBudget(message.requestedSkills);
      budget.reserve(captured.totalBytes, captured.entries);
      const directory = message.directory!;
      mkdirSync(directory, { mode: 0o700 });
      for (const file of captured.files) {
        const path = join(directory, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.content, { flag: "wx", mode: file.mode });
        chmodSync(path, file.mode);
      }
      captured = await captureProviderSkillBundleAsync(join(directory, "SKILL.md"));
      if (captured.hash !== input.bundleHash || !fileIdentitiesMatch(captured.proof)) throw new Error("changed");
    }
    const reply = { proof: captured.proof, entries: captured.entries, totalBytes: captured.totalBytes };
    if (operation === "verify") verified.set(key, reply);
    parentPort!.postMessage({ id: message.id, ...reply });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, failure: providerPreparationFailure(error), error: message.operation === "verify"
      ? "staged Skill bundle failed verification" : "provider Skill input changed after frozen validation" });
  }
}); });
