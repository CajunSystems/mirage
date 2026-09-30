import matter from "gray-matter";
import { z } from "zod";

export const IntentFrontmatterSchema = z
  .object({
    title: z.string().optional(),
    mode: z.enum(["locked", "cached", "live"]).default("cached"),
    /** Route params, e.g. `{ id: string }`. Informational for the model. */
    params: z.record(z.string(), z.string()).default({}),
    /** Restrict the catalog to these components. */
    catalog: z.array(z.string()).optional(),
    /** Generate a separate spec per param value (param values join the cache key). */
    specPerParams: z.boolean().default(false),
    /** Most specs generated per route by one server process (bounds specPerParams and live mode). */
    maxSpecs: z.number().int().positive().default(100),
    /** Live mode only: seconds an in-memory spec is reused. */
    ttl: z.number().nonnegative().default(60),
  })
  .strict();

export type IntentFrontmatter = z.infer<typeof IntentFrontmatterSchema>;
export type Intent = { frontmatter: IntentFrontmatter; body: string; source: string };

export class IntentError extends Error {}

export function parseIntent(source: string, file = "page.intent.md"): Intent {
  const parsed = matter(source);
  const result = IntentFrontmatterSchema.safeParse(parsed.data ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`).join("; ");
    throw new IntentError(`${file}: invalid frontmatter (${details})`);
  }
  return { frontmatter: result.data, body: parsed.content.trim(), source };
}
