import { timingSafeEqual } from "node:crypto";

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split(".").slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return false;
}

export function assertSecureControlPlaneBind(host: string, apiToken: string | undefined): void {
  if (isLoopbackHost(host)) return;
  if (apiToken?.trim()) return;
  throw new Error(`Refusing non-loopback Agent2Agent bind (${host}) without AGENT2AGENT_API_TOKEN authentication`);
}

export function bearerTokenMatches(authorization: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expectedToken, "utf8");
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}
