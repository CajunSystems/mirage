import type { ComponentDescription, ToolSignature, ValidationError } from "@mirage/core";
import type { IntentFrontmatter } from "./intent.js";

export type PromptInput = {
  components: ComponentDescription[];
  tools: ToolSignature[];
  intent: { frontmatter: IntentFrontmatter; body: string };
  route: { path: string; params: string[] };
  /** Validation errors from the previous attempt, when repairing. */
  repair?: { errors: ValidationError[]; previous?: string };
};

const RULES = `You design user interfaces by writing a Mirage spec: a JSON object that a renderer turns into React.

Rules:
- Output only a JSON object matching the spec schema. No prose, no code, no Markdown.
- The spec is a flat map: "root" names the top element; "elements" maps short kebab-case ids to { "type", "props", "children" }. Children are lists of element ids and are only allowed on container components.
- Use only the components listed below, with exactly the props they declare. Write "root" and "data" first, then elements from the top of the page down.
- Prefer few elements. Keep the layout simple and purposeful.
- Never invent data. Anything that comes from the outside world must come from a data source: declare it in "data" as { "tool": name, "args": {...} } and read it with a binding. Never write sample rows, placeholder names or lorem ipsum.
- Use only the tools listed below. Tools marked as mutations may only be called from actions, never from "data".
- Bindings: { "$data": source, "path"?: "field.sub" } reads a data source, { "$state": "a.b" } reads local state, { "$param": name } reads a route param. Any prop value may be a binding; props marked "x-mirage": "binding" must be one.
- Declare initial local state in "state" (search text, form drafts, dialog open flags). State changes re-run data sources whose args depend on it.
- Props marked "x-mirage": "action" take an action object:
  { "$action": "tool", "name": tool, "args": {...}, "then"?: [ { "refresh": [source, ...] } | { "navigate": "/path" } | { "setState": { "path": "a.b", "value": ... } } ] }
  { "$action": "navigate", "to": "/path/:id" }  (same-origin paths only; ":name" is filled from the event, then route params)
  { "$action": "setState", "path": "a.b", "value": ... }
  Inside actions, { "$event": "" } is the value the component passes (for example a row object or input text) and { "$event": "id" } a field of it. Args may also use $state and $param bindings.`;

const json = (value: unknown) => JSON.stringify(value);

/** Pure prompt assembly: `{ system, prompt }` for one generation attempt. */
export function buildPrompt(input: PromptInput): { system: string; prompt: string } {
  const components = input.components
    .map((c) => `- ${c.name}${c.container ? " (container)" : ""}: ${c.description}\n  props: ${json(c.props)}`)
    .join("\n");
  const tools = input.tools.length
    ? input.tools
        .map(
          (t) =>
            `- ${t.name}${t.mutation ? " (mutation)" : ""}: ${t.description}\n  input: ${json(t.input)}\n  output: ${json(t.output)}`,
        )
        .join("\n")
    : "(none)";
  const system = `${RULES}\n\n## Components\n${components}\n\n## Tools\n${tools}`;

  const { frontmatter, body } = input.intent;
  const sections = [
    `## Route\npath: ${input.route.path}\nparams: ${input.route.params.length ? input.route.params.join(", ") : "(none)"}`,
    `## Intent\n${frontmatter.title ? `title: ${frontmatter.title}\n` : ""}${
      Object.keys(frontmatter.params).length ? `params: ${json(frontmatter.params)}\n` : ""
    }\n${body}`,
  ];
  if (input.repair) {
    sections.push(
      `## Repair\nYour previous spec was rejected. Fix these problems and output the whole spec again:\n${input.repair.errors
        .map((e) => `- ${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  }
  return { system, prompt: sections.join("\n\n") };
}
