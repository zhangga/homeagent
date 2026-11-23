import { expect, test } from "bun:test";

test("CI job environment can be evaluated before a runner is assigned", async () => {
  const source = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  const workflow = Bun.YAML.parse(source) as {
    jobs: Record<string, { env?: Record<string, string> }>;
  };
  for (const [job, { env }] of Object.entries(workflow.jobs)) {
    const runnerExpressions = Object.entries(env ?? {})
      .filter(([, value]) => /\$\{\{[^}]*\brunner\s*(?:\.|\[)/i.test(value));
    expect(runnerExpressions, `jobs.${job}.env`).toEqual([]);
  }
});
