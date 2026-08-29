import * as bootstrap from "../packages/bootstrap/src/index.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(value: unknown, message = "Expected truthy value"): asserts value { if (!value) throw new Error(message); }

type InstallExecutor = (input: { executable: string; args: string[]; env: Record<string, string | undefined> }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

await test("plans only missing allowlisted runtimes and ACP bridges", async () => {
  const plan = (bootstrap as unknown as Record<string, unknown>).planBootstrap;
  ok(typeof plan === "function", "planBootstrap must be exported");
  const result = (plan as (input: { installedExecutables: string[]; enableAcp: boolean }) => Array<Record<string, unknown>>)({
    installedExecutables: ["claude", "codex", "agy"],
    enableAcp: true,
  });

  equal(result.map((item) => [item.id, item.kind]), [
    ["hermes", "remote-script"],
    ["opencode", "remote-script"],
    ["openclaw", "remote-script"],
    ["copilot", "npm-global"],
    ["goose", "remote-script"],
    ["agy-acp", "npm-global"],
  ]);
});

await test("executes package installs without a shell and stops on failure", async () => {
  const install = (bootstrap as unknown as Record<string, unknown>).installBootstrapPlan;
  ok(typeof install === "function", "installBootstrapPlan must be exported");
  const calls: Array<[string, string[]]> = [];
  const execute: InstallExecutor = async (input) => {
    calls.push([input.executable, input.args]);
    if (input.args.includes("bad-package")) return { exitCode: 2, stdout: "", stderr: "failed" };
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };
  let failedInstall = false;
  try {
    await (install as (options: { plan: Array<Record<string, unknown>>; execute: InstallExecutor }) => Promise<unknown>)({
      execute,
      plan: [
        { id: "one", kind: "npm-global", packageName: "good-package" },
        { id: "two", kind: "npm-global", packageName: "bad-package" },
        { id: "three", kind: "npm-global", packageName: "never-run" },
      ],
    });
  } catch { failedInstall = true; }
  equal(failedInstall, true);
  equal(calls, [
    ["npm", ["install", "-g", "good-package"]],
    ["npm", ["install", "-g", "bad-package"]],
  ]);
});

await test("auto bootstrap can be disabled explicitly", async () => {
  const enabled = (bootstrap as unknown as Record<string, unknown>).autoInstallEnabled;
  ok(typeof enabled === "function", "autoInstallEnabled must be exported");
  equal((enabled as (env: Record<string, string | undefined>) => boolean)({ AGENT2AGENT_AUTO_INSTALL: "false" }), false);
  equal((enabled as (env: Record<string, string | undefined>) => boolean)({}), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} bootstrap tests failed`);
