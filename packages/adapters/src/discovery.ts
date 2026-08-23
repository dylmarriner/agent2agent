import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export type LocalCliAgentType = "claude-code" | "codex" | "hermes" | "opencode" | "openclaw";
export type LocalCliAuthStatus = "authenticated" | "unauthenticated" | "unknown";
export type LocalCliStatus = "ready" | "installed";
export type AuthProbeKind = "exit-zero" | "nonempty" | "opencode-list" | "openclaw-status";

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
  authProbeKind: AuthProbeKind;
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
    authProbeKind: "exit-zero",
    supportsSessions: true,
    supportsMcp: true,
  },
  {
    type: "codex",
    executable: "codex",
    versionArgs: ["--version"],
    authStatusArgs: ["login", "status"],
    authProbeKind: "exit-zero",
    supportsSessions: true,
    supportsMcp: true,
  },
  {
    type: "hermes",
    executable: "hermes",
    versionArgs: ["--version"],
    authStatusArgs: ["auth", "status"],
    authProbeKind: "nonempty",
    supportsSessions: true,
    supportsMcp: true,
  },
  {
    type: "opencode",
    executable: "opencode",
    versionArgs: ["--version"],
    authStatusArgs: ["auth", "list"],
    authProbeKind: "opencode-list",
    supportsSessions: true,
    supportsMcp: true,
  },
  {
    type: "openclaw",
    executable: "openclaw",
    versionArgs: ["--version"],
    authStatusArgs: ["status", "--json"],
    authProbeKind: "openclaw-status",
    supportsSessions: false,
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
  const discovered = await Promise.all(specs.map((spec) => discoverOne(host, spec)));
  return discovered.filter((entry): entry is DiscoveredLocalCliAgent => entry !== undefined);
}

async function discoverOne(
  host: LocalCliDiscoveryHost,
  spec: LocalCliDiscoverySpec,
): Promise<DiscoveredLocalCliAgent | undefined> {
  const executablePath = await host.locate(spec.executable);
  if (!executablePath) return undefined;

  const [versionProbe, authProbe] = await Promise.all([
    safeProbe(host, executablePath, spec.versionArgs),
    spec.authStatusArgs ? safeProbe(host, executablePath, spec.authStatusArgs) : Promise.resolve(undefined),
  ]);
  const version = versionProbe ? extractVersion(versionProbe.stdout || versionProbe.stderr) : undefined;
  const authStatus = classifyAuthStatus(authProbe, spec.authProbeKind);

  return {
    type: spec.type,
    executable: spec.executable,
    executablePath,
    ...(version ? { version } : {}),
    authStatus,
    status: authStatus === "authenticated" ? "ready" : "installed",
    supportsSessions: spec.supportsSessions,
    supportsMcp: spec.supportsMcp,
  };
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

function classifyAuthStatus(result: DiscoveryProbeResult | undefined, kind: AuthProbeKind): LocalCliAuthStatus {
  if (!result) return "unknown";
  if (result.exitCode !== 0) return "unauthenticated";
  const text = `${result.stdout}\n${result.stderr}`.trim();

  if (kind === "exit-zero") return "authenticated";
  if (kind === "nonempty") return text.length > 0 ? "authenticated" : "unauthenticated";
  if (kind === "opencode-list") {
    if (!text || /no\s+(authenticated\s+)?(providers?|credentials?|accounts?)/i.test(text)) return "unauthenticated";
    return "authenticated";
  }
  if (kind === "openclaw-status") {
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      if (value.ok === true) return "authenticated";
      const gateway = value.gateway;
      if (gateway && typeof gateway === "object") {
        const status = (gateway as Record<string, unknown>).status;
        if (typeof status === "string" && ["ready", "running", "connected", "healthy"].includes(status.toLowerCase())) return "authenticated";
      }
      return "unauthenticated";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
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
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const finish = (result: DiscoveryProbeResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
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
      try { stdout = append(stdout, chunk); } catch (error) { fail(error); }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      try { stderr = append(stderr, chunk); } catch (error) { fail(error); }
    });
    child.on("error", fail);
    child.on("close", (code: number | null) => finish({ exitCode: code ?? 1, stdout, stderr }));

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: 124, stdout, stderr: stderr || "discovery probe timed out" });
    }, 5_000);
    timer.unref();
  });
}
