import { kindOf, type Catalog, type Spec } from "@mirage/core";

const hasBinding = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(hasBinding)
    : !!v && typeof v === "object" && ("$data" in v || "$state" in v || "$param" in v || Object.values(v).some(hasBinding));

const json = (v: unknown) => JSON.stringify(v);
const isIdentifier = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s);

export type EjectOptions = {
  catalog: Catalog;
  /** Route path, e.g. "/plants/:id". */
  route: string;
  /** Import specifier for the catalog module, relative to the page. */
  catalogImport: string;
  catalogExport?: string;
};

/** Turns a spec into a `page.tsx` that renders the same tree with plain JSX. */
export function ejectSpec(spec: Spec, options: EjectOptions): string {
  const { catalog } = options;
  const catalogName = options.catalogExport ?? "catalog";
  const used = new Set<string>();

  const attr = (type: string, key: string, value: unknown): string => {
    const shape = catalog.entries[type]?.props.shape as Record<string, Parameters<typeof kindOf>[0]> | undefined;
    const kind = shape?.[key] ? kindOf(shape[key]) : undefined;
    if (kind === "action") return `${key}={m.action(${json(value)})}`;
    if (kind === "ref") return `${key}={m.ref(${json(value)})}`;
    if (hasBinding(value)) return `${key}={m.value(${json(value)})}`;
    if (typeof value === "string" && !/["{}<>\n\\]/.test(value)) return `${key}=${json(value)}`;
    return `${key}={${json(value)}}`;
  };

  const render = (id: string, depth: number): string => {
    const el = spec.elements[id];
    const pad = "  ".repeat(depth);
    if (!el) return `${pad}{/* missing element "${id}" */}`;
    if (!catalog.entries[el.type]) throw new Error(`Element "${id}" uses unknown component "${el.type}"`);
    if (!isIdentifier(el.type)) throw new Error(`Component name "${el.type}" is not a valid identifier`);
    used.add(el.type);
    // Spell out schema defaults so the page renders exactly what the spec renderer did.
    const props: Record<string, unknown> = { ...el.props };
    for (const [key, schema] of Object.entries(catalog.entries[el.type]!.props.shape)) {
      if (key in props) continue;
      const fallback = (schema as Parameters<typeof kindOf>[0]).safeParse(undefined);
      if (fallback.success && fallback.data !== undefined) props[key] = fallback.data;
    }
    const attrs = Object.entries(props).map(([k, v]) => attr(el.type, k, v));
    const open = attrs.length ? `${el.type} ${attrs.join(" ")}` : el.type;
    const children = el.children ?? [];
    // Element ids survive as comments (not on the root, where JSX allows only one node).
    const comment = id === spec.root ? "" : `${pad}{/* ${id} */}\n`;
    if (!children.length) return `${comment}${pad}<${open} />`;
    return `${comment}${pad}<${open}>\n${children.map((c) => render(c, depth + 1)).join("\n")}\n${pad}</${el.type}>`;
  };

  const body = render(spec.root, 2);
  const components = [...used].sort().map((name) => `const ${name} = ${catalogName}.entries.${name}.component;`);
  return `// Ejected from page.intent.md by \`mirage eject\`. This file is yours now: edit it like any React page.
import { useMirage } from "@mirage/react";
import { ${catalogName} } from ${json(options.catalogImport)};

${components.join("\n")}

const data = ${json(spec.data ?? {})};
const state = ${json(spec.state ?? {})};

export default function Page() {
  const m = useMirage({ route: ${json(options.route)}, data, state });
  return (
${body}
  );
}
`;
}
