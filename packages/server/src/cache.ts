import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_VERSION, type Catalog, type Spec, type ToolSignature } from "@mirage/core";
import { z } from "zod";

/** Bump when generation changes in a way that should invalidate every cached spec. */
export const GENERATOR_VERSION = 1;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function catalogHash(catalog: Catalog): string {
  return sha256(JSON.stringify([catalog.describe(), z.toJSONSchema(catalog.specSchema, { unrepresentable: "any" })]));
}

export function toolsHash(tools: ToolSignature[]): string {
  return sha256(JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name))));
}

export function cacheKey(input: {
  intentSource: string;
  catalogHash: string;
  toolsHash: string;
  params?: Record<string, string>;
}): string {
  const params = input.params ? Object.fromEntries(Object.entries(input.params).sort(([a], [b]) => a.localeCompare(b))) : null;
  return sha256(
    JSON.stringify([input.intentSource, input.catalogHash, input.toolsHash, params, SPEC_VERSION, GENERATOR_VERSION]),
  );
}

/** File cache under `.mirage/specs/<hash>.json`. */
export class SpecCache {
  constructor(private dir: string) {}

  async get(key: string): Promise<Spec | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${key}.json`), "utf8")) as Spec;
    } catch {
      return undefined;
    }
  }

  async set(key: string, spec: Spec): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(spec, null, 2) + "\n");
  }
}

/** In-memory TTL cache for live mode. Expired entries are swept on write; the oldest go past `maxEntries`. */
export class MemoryCache {
  private entries = new Map<string, { spec: Spec; expires: number }>();
  constructor(private maxEntries = 1000) {}
  get size() {
    return this.entries.size;
  }
  get(key: string): Spec | undefined {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.spec;
    this.entries.delete(key);
    return undefined;
  }
  set(key: string, spec: Spec, ttlSeconds: number) {
    const now = Date.now();
    for (const [k, entry] of this.entries) if (entry.expires <= now) this.entries.delete(k);
    if (ttlSeconds <= 0) return;
    this.entries.delete(key); // re-insert so Map order stays oldest-first
    this.entries.set(key, { spec, expires: now + ttlSeconds * 1000 });
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
    }
  }
}
