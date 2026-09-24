import type { HttpMethod } from "@pistachio/protocol";
import { normalizeOrigin } from "@pistachio/protocol";

export interface AdapterActionRule {
  id: string;
  label: string;
  method: HttpMethod;
  path: string;
  consequential: boolean;
  reversible: boolean;
  dataLeaving: string[];
  resource: string;
}

export interface AdapterManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  origins: string[];
  actions: AdapterActionRule[];
}

export interface NetworkObservation {
  url: string;
  method: HttpMethod;
}

export interface SemanticAction extends AdapterActionRule {
  adapterId: string;
  adapterVersion: string;
  url: string;
}

export class AdapterRegistry {
  readonly #manifests: AdapterManifest[];

  constructor(manifests: AdapterManifest[]) {
    this.#manifests = manifests.map((manifest) => validateManifest(structuredClone(manifest)));
  }

  resolve(observation: NetworkObservation): SemanticAction | null {
    const url = new URL(observation.url);
    const origin = normalizeOrigin(url.toString());
    const candidates: SemanticAction[] = [];
    for (const manifest of this.#manifests) {
      if (!manifest.origins.map(normalizeOrigin).includes(origin)) continue;
      for (const rule of manifest.actions) {
        if (rule.method !== observation.method || !matchesPath(rule.path, url.pathname)) continue;
        candidates.push({
          ...structuredClone(rule),
          adapterId: manifest.id,
          adapterVersion: manifest.version,
          url: observation.url,
        });
      }
    }
    return candidates.sort((a, b) => pathSpecificity(b.path) - pathSpecificity(a.path))[0] ?? null;
  }
}

export function validateManifest(manifest: AdapterManifest): AdapterManifest {
  if (manifest.schemaVersion !== 1) throw new Error("unsupported adapter schema version");
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/u.test(manifest.id)) throw new Error("invalid adapter id");
  if (manifest.origins.length === 0) throw new Error("adapter must declare an origin");
  manifest.origins = [...new Set(manifest.origins.map(normalizeOrigin))];
  const ids = new Set<string>();
  for (const action of manifest.actions) {
    if (ids.has(action.id)) throw new Error(`duplicate adapter action ${action.id}`);
    ids.add(action.id);
    if (!action.path.startsWith("/")) throw new Error(`adapter path must be absolute: ${action.path}`);
    for (const segment of action.path.split("/")) {
      if (segment.includes("*") && segment !== "*") {
        throw new Error(`wildcards must occupy a full path segment: ${action.path}`);
      }
    }
  }
  return manifest;
}

function matchesPath(pattern: string, path: string): boolean {
  const expected = pattern.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (segment === "*") return true;
    if (actual[index] === undefined) return false;
    if (segment?.startsWith(":")) continue;
    if (segment !== actual[index]) return false;
  }
  return expected.length === actual.length;
}

function pathSpecificity(path: string): number {
  return path
    .split("/")
    .filter(Boolean)
    .reduce((score, segment) => score + (segment === "*" ? 0 : segment.startsWith(":") ? 1 : 3), 0);
}
