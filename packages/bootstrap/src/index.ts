import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BootstrapRecipe =
  | {
      id: string;
      kind: "npm-global";
      packageName: string;
      executable: string;
      purpose: "agent" | "acp-bridge";
    }
  | {
      id: string;
      kind: "remote-script";
      url: string;
      executable: string;
      purpose: "agent" | "acp-bridge";
      args?: string[];
    };

export interface BootstrapPlanInput {
  installedExecutables: string[];
  enableAcp?: boolean;
  desiredRuntimeIds?: string[];
}

export interface InstallProcessInput {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export interface InstallProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type InstallExecutor = (input: InstallProcessInput) => Promise<InstallProcessResult>;

const RUNTIME_RECIPES: readonly BootstrapRecipe[] = [
  { id: "claude-code", kind: "npm-global", packageName: "@anthropic-ai/claude-code", executable: "claude", purpose: "agent" },
  { id: "codex", kind: "npm-global", packageName: "@openai/codex", executable: "codex", purpose: "agent" },
  { id: "hermes", kind: "remote-script", url: "https://hermes-agent.nousresearch.com/install.sh", executable: "hermes", purpose: "agent" },
  { id: "opencode", kind: "remote-script", url: "https://opencode.ai/install", executable: "opencode", purpose: "agent" },
  { id: "openclaw", kind: "remote-script", url: "https://openclaw.ai/install-cli.sh", executable: "openclaw", purpose: "agent" },
  { id: "antigravity", kind: "remote-script", url: "https://antigravity.google/cli/install.sh", executable: "agy", purpose: "agent" },
  { id: "copilot", kind: "npm-global", packageName: "@github/copilot", executable: "copilot", purpose: "agent" },
  { id: "goose", kind: "remote-script", url: "https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh", executable: "goose", purpose: "agent" },
] as const;

const ACP_RECIPES: readonly BootstrapRecipe[] = [
  { id: "agy-acp", kind: "npm-global", packageName: "agy-acp", executable: "agy-acp", purpose: "acp-bridge" },
] as const;

const DEFAULT_RUNTIME_IDS = RUNTIME_RECIPES.map((recipe) => recipe.id);

export function autoInstallEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.AGENT2AGENT_AUTO_INSTALL?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

export function planBootstrap(input: BootstrapPlanInput): BootstrapRecipe[] {
  const installed = new Set(input.installedExecutables);
  const desired = new Set(input.desiredRuntimeIds ?? DEFAULT_RUNTIME_IDS);
  const recipes = RUNTIME_RECIPES.filter((recipe) => desired.has(recipe.id) && !installed.has(recipe.executable));

  if (input.enableAcp !== false) {
    for (const recipe of ACP_RECIPES) {
      if (!installed.has(recipe.executable)) recipes.push(recipe);
    }
  }

  return recipes.map((recipe) => ({ ...recipe, ...(recipe.kind === "remote-script" && recipe.args ? { args: [...recipe.args] } : {}) }));
}

export interface InstallBootstrapPlanOptions {
  plan: Array<Record<string, unknown>> | BootstrapRecipe[];
  execute?: InstallExecutor;
  env?: Record<string, string | undefined>;
  fetchText?: (url: string) => Promise<string>;
  platform?: NodeJS.Platform;
}

export interface BootstrapInstallResult {
  installed: string[];
}

export async function installBootstrapPlan(options: InstallBootstrapPlanOptions): Promise<BootstrapInstallResult> {
  const execute = options.execute ?? defaultInstallExecutor;
  const env = { ...process.env, ...(options.env ?? {}) };
  const installed: string[] = [];

  for (const rawRecipe of options.plan) {
    const recipe = normalizeRecipe(rawRecipe);
    let result: InstallProcessResult;
    if (recipe.kind === "npm-global") {
      result = await execute({ executable: "npm", args: ["install", "-g", recipe.packageName], env });
    } else {
      result = await installRemoteScript(recipe, {
        execute,
        env,
        fetchText: options.fetchText ?? defaultFetchText,
        platform: options.platform ?? process.platform,
      });
    }

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Failed to install ${recipe.id}: ${detail}`);
    }
    installed.push(recipe.id);
  }

  return { installed };
}

export async function bootstrapMissingRuntimes(options: {
  installedExecutables: string[];
  enableAcp?: boolean;
  desiredRuntimeIds?: string[];
  env?: Record<string, string | undefined>;
  execute?: InstallExecutor;
  fetchText?: (url: string) => Promise<string>;
  platform?: NodeJS.Platform;
}): Promise<BootstrapInstallResult> {
  if (!autoInstallEnabled(options.env ?? process.env)) return { installed: [] };
  const plan = planBootstrap({
    installedExecutables: options.installedExecutables,
    ...(options.enableAcp !== undefined ? { enableAcp: options.enableAcp } : {}),
    ...(options.desiredRuntimeIds ? { desiredRuntimeIds: options.desiredRuntimeIds } : {}),
  });
  return installBootstrapPlan({
    plan,
    ...(options.env ? { env: options.env } : {}),
    ...(options.execute ? { execute: options.execute } : {}),
    ...(options.fetchText ? { fetchText: options.fetchText } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
}

function normalizeRecipe(raw: Record<string, unknown> | BootstrapRecipe): BootstrapRecipe {
  if (raw.kind === "npm-global" && typeof raw.id === "string" && typeof raw.packageName === "string") {
    return {
      id: raw.id,
      kind: "npm-global",
      packageName: raw.packageName,
      executable: typeof raw.executable === "string" ? raw.executable : raw.id,
      purpose: raw.purpose === "acp-bridge" ? "acp-bridge" : "agent",
    };
  }
  if (raw.kind === "remote-script" && typeof raw.id === "string" && typeof raw.url === "string") {
    return {
      id: raw.id,
      kind: "remote-script",
      url: raw.url,
      executable: typeof raw.executable === "string" ? raw.executable : raw.id,
      purpose: raw.purpose === "acp-bridge" ? "acp-bridge" : "agent",
      ...(Array.isArray(raw.args) && raw.args.every((value) => typeof value === "string") ? { args: raw.args as string[] } : {}),
    };
  }
  throw new Error("Invalid bootstrap recipe");
}

async function installRemoteScript(
  recipe: Extract<BootstrapRecipe, { kind: "remote-script" }>,
  options: {
    execute: InstallExecutor;
    env: Record<string, string | undefined>;
    fetchText: (url: string) => Promise<string>;
    platform: NodeJS.Platform;
  },
): Promise<InstallProcessResult> {
  const script = await options.fetchText(recipe.url);
  if (!script.trim()) throw new Error(`Installer for ${recipe.id} was empty`);
  const directory = await mkdtemp(join(tmpdir(), "agent2agent-install-"));
  const isWindows = options.platform === "win32";
  const path = join(directory, isWindows ? "install.ps1" : "install.sh");

  try {
    await writeFile(path, script, { encoding: "utf8", mode: 0o700 });
    if (!isWindows) await chmod(path, 0o700);
    return isWindows
      ? options.execute({ executable: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path, ...(recipe.args ?? [])], env: options.env })
      : options.execute({ executable: "bash", args: [path, ...(recipe.args ?? [])], env: options.env });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Installer download failed (${response.status}) for ${url}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) throw new Error(`Refusing HTML response for installer ${url}`);
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error(`Installer exceeded 2 MiB: ${url}`);
  return text;
}

export const defaultInstallExecutor: InstallExecutor = async (input) => new Promise((resolve, reject) => {
  const child = spawn(input.executable, input.args, {
    env: input.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("error", reject);
  child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
});

export const bootstrapCatalog = {
  runtimes: RUNTIME_RECIPES.map((recipe) => ({ ...recipe })),
  acp: ACP_RECIPES.map((recipe) => ({ ...recipe })),
};
