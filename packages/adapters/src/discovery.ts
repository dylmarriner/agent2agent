import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export type LocalCliAgentType = "claude-code" | "codex" | "hermes" | "opencode" | "openclaw";
export type LocalCliAuthStatus = "authenticated" | "unauthenticated" | "unknown";
export type LocalCliStatus = "ready" | "installed";

export interface DiscoveryProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LocalCliDiscoveryHost {
  locate(executable: string): Promise<string | undefined>;
  run(executable: string, args: string[]): Promise<DiscoveryProbeResult>;
}

export interface LocalCliDiscoverySpec {
  type: LocalCliAgentType;
  executable: string;
  versionArgs: string[];
  authStatusArgs?: string[];
  supportsSessions: boolean;
  supportsMcp: boolean;
}

export interface DiscoveredLocalCliAgent {
  type: LocalCliAgentType;
  executable: string;
  executablePath: string;
  version?: string;
  authStatus: LocalCliAuthStatus;
  status: LocalCliStatus;
  supportsSessions: boolean;
  supportsMcp: boolean;
}

export const localCliDiscoverySpecs: readonly LocalCliDiscoverySpec[] = [
  {
    type: "claude-code",
    executable: "claude",
    versionArgs: ["--version"],
    authStatusArgs: ["auth", "status"],
    supportsSessions: true,
    supportsMcp: true,
  },
  {
    type: "codex",
    executable: "codex",
    versionArgs: ["--version"],
    authStatusArgs: ["login", "status"],
    supportsSessions: true,
    supportsMcp: true,
  },
  {
    type: "hermes",
    executable: "hermes",
    versionArgs: ["--version"],
    authStatusArgs: ["auth", "status"],
    supportsSessions: true,
    supportsMcp: true,
  },
  {
    type: "opencode",
    executable: "opencode",
    versionArgs: ["--version"],
    authStatusArgs: ["auth", "list"],
    supportsSessions: true,
    supportsMcp: true,
  },
  {
    type: "openclaw",
    executable: "openclaw",
    versionArgs: ["--version"],
    authStatusArgs: ["status", "--json"],
    supportsSessions: true,
    supportsMcp: false,
  },
] as const;

export interface DiscoverLocalCliAgentsOptions {
  host?: LocalCliDiscoveryHost;
  specs?: readonly LocalCliDiscoverySpec[];
}

export async function discoverLocalCliAgents(
  options: DiscoverLocalCliAgentsOptions = {},
): Promise<DiscoveredLocalCliAgent[]> {
  const host = options.host ?? defaultLocalCliDiscoveryHost;
  const specs = options.specs ?? localCliDiscoverySpecs;
  const discovered: DiscoveredLocalCliAgent[] = [];

  for (const spec of specs) {
    const executablePath = await host.locate(spec.executable);
    if (!executablePath) continue;

    const versionProbe = await safeProbe(host, executablePath, spec.versionArgs);
    const authProbe = spec.authStatusArgs
      ? await safeProbe(host, executablePath, spec.authStatusArgs)
      : undefined;
    const authStatus = classifyAuthStatus(authProbe);

    discovered.push({
      type: spec.type,
      executable: spec.executable,
      executablePath,
      ...(versionProbe ? { version: extractVersion(versionProbe.stdout || versionProbe.stderr) } : {}),
      authStatus,
      status: authStatus === "authenticated" ? "ready" : "installed",
      supportsSessions: spec.supportsSessions,
      supportsMcp: spec.supportsMcp,
    });
  }

  return discovered;
}

async function safeProbe(
  host: LocalCliDiscoveryHost,
  executable: string,
  args: string[],
): Promise<DiscoveryProbeResult | undefined> {
  try {
    return await host.run(executable, args);
  } catch {
    return undefined;
  }
}

function classifyAuthStatus(result: DiscoveryProbeResult | undefined): LocalCliAuthStatus {
  if (!result) return "unknown";
  if (result.exitCode !== 0) return "unauthenticated";
  return `${result.stdout}\n${result.stderr}`.trim().length > 0 ? "authenticated" : "unknown";
}

function extractVersion(output: string): string | undefined {
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0];
}

export const defaultLocalCliDiscoveryHost: LocalCliDiscoveryHost = {
  locate: locateExecutable,
  run: runProbe,
};

async function locateExecutable(executable: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? "";
  if (!pathValue) return undefined;
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep scanning PATH. Discovery must tolerate partially configured hosts.
      }
    }
  }
  return undefined;
}

async function runProbe(executable: string, args: string[]): Promise<DiscoveryProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBytes = 1024 * 1024;

    const finish = (result: DiscoveryProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxBytes) {
        child.kill("SIGKILL");
        throw new Error(`CLI discovery output exceeded ${maxBytes} bytes`);
      }
      return next;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      try { stdout = append(stdout, chunk); } catch (error) { reject(error); }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      try { stderr = append(stderr, chunk); } catch (error) { reject(error); }
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => finish({ exitCode: code ?? 1, stdout, stderr }));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: 124, stdout, stderr: stderr || "discovery probe timed out" });
    }, 5_000);
    timer.unref();
  });
}
