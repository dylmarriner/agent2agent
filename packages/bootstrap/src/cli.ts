import { bootstrapMissingRuntimes } from "./index.js";
import { defaultLocalCliDiscoveryHost, localCliDiscoverySpecs } from "../../adapters/src/discovery.js";

const candidates = [...new Set([...localCliDiscoverySpecs.map((spec) => spec.executable), "agy-acp"])];
const installedExecutables: string[] = [];

for (const executable of candidates) {
  if (await defaultLocalCliDiscoveryHost.locate(executable)) installedExecutables.push(executable);
}

const result = await bootstrapMissingRuntimes({
  installedExecutables,
  enableAcp: true,
});

const remaining: string[] = [];
for (const executable of candidates) {
  if (await defaultLocalCliDiscoveryHost.locate(executable)) remaining.push(executable);
}

process.stdout.write(`${JSON.stringify({
  installed: result.installed,
  detectedExecutables: remaining,
}, null, 2)}\n`);
