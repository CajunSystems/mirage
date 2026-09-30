import { describe, expect, it } from "vitest";
import { defineCatalog, defineTool, toolSignature, validateSpec, z, type Spec } from "@mirage/core";

const Noop = () => null;
const catalog = defineCatalog({
  Stack: { description: "Vertical stack.", props: z.object({ gap: z.enum(["sm", "md"]).default("md") }), component: Noop, children: true },
  Heading: { description: "A heading.", props: z.object({ text: z.string() }), component: Noop },
  Table: {
    description: "Tabular data.",
    props: z.object({
      rows: z.ref(),
      columns: z.array(z.object({ key: z.string(), label: z.string() })),
      onRowClick: z.action().optional(),
    }),
    component: Noop,
  },
  Button: { description: "A button.", props: z.object({ label: z.string(), onPress: z.action() }), component: Noop },
});

const tools = {
  listPlants: { mutation: false },
  addPlant: { mutation: true },
};

const good: Spec = {
  version: 1,
  root: "page",
  data: { plants: { tool: "listPlants", args: { query: { $state: "search" } } } },
  state: { search: "" },
  elements: {
    page: { type: "Stack", children: ["title", "table", "add"] },
    title: { type: "Heading", props: { text: { $param: "bed" } } },
    table: {
      type: "Table",
      props: {
        rows: { $data: "plants" },
        columns: [{ key: "name", label: "Name" }],
        onRowClick: { $action: "navigate", to: "/plants/:id" },
      },
    },
    add: {
      type: "Button",
      props: {
        label: "Add",
        onPress: { $action: "tool", name: "addPlant", args: { name: "Fern" }, then: [{ refresh: ["plants"] }] },
      },
    },
  },
};

const check = (spec: unknown) => validateSpec(spec, { catalog, tools, params: ["bed"] });
const clone = (): any => structuredClone(good);
const errorsOf = (spec: unknown) => {
  const r = check(spec);
  if (r.ok) throw new Error("expected failure");
  return r.errors;
};

describe("validateSpec", () => {
  it("accepts a hand-written spec", () => {
    expect(check(good)).toEqual({ ok: true, spec: good });
  });

  it("rejects unknown component names", () => {
    const s = clone();
    s.elements.title.type = "Marquee";
    expect(errorsOf(s)[0]!.path).toBe("elements.title.type");
  });

  it("rejects bad props", () => {
    const s = clone();
    s.elements.title.props.text = 42;
    expect(errorsOf(s)[0]!.path).toMatch(/^elements\.title\.props\.text/);
  });

  it("rejects children on non-container components", () => {
    const s = clone();
    s.elements.title.children = ["table"];
    expect(errorsOf(s)[0]!.path).toBe("elements.title");
  });

  it("rejects dangling children", () => {
    const s = clone();
    s.elements.page.children.push("ghost");
    expect(errorsOf(s)).toEqual([{ path: "elements.page.children[3]", message: 'child "ghost" does not exist' }]);
  });

  it("rejects a missing root", () => {
    const s = clone();
    s.root = "nope";
    expect(errorsOf(s)[0]).toEqual({ path: "root", message: 'root element "nope" does not exist' });
  });

  it("rejects cycles", () => {
    const s = clone();
    s.elements.inner = { type: "Stack", children: ["outer"] };
    s.elements.outer = { type: "Stack", children: ["inner"] };
    expect(errorsOf(s).some((e) => e.message.startsWith("cycle detected"))).toBe(true);
  });

  it("rejects unknown tools in data sources and actions", () => {
    const s = clone();
    s.data.plants.tool = "dropTables";
    s.elements.add.props.onPress.name = "launchRockets";
    expect(errorsOf(s)).toEqual([
      { path: "data.plants.tool", message: 'unknown tool "dropTables"' },
      { path: "elements.add.props.onPress.name", message: 'unknown tool "launchRockets"' },
    ]);
  });

  it("rejects mutations as data sources", () => {
    const s = clone();
    s.data.plants.tool = "addPlant";
    expect(errorsOf(s)[0]!.message).toMatch(/mutation/);
  });

  it("rejects unknown $data, $state and $param references", () => {
    const s = clone();
    s.elements.table.props.rows = { $data: "trees" };
    s.elements.title.props.text = { $state: "nothing.here" };
    s.data.plants.args.query = { $param: "zone" };
    expect(errorsOf(s).map((e) => e.path)).toEqual([
      "data.plants.args.query",
      "elements.title.props.text",
      "elements.table.props.rows",
    ]);
  });

  it("treats state written by setState as declared", () => {
    const s = clone();
    delete s.state;
    s.elements.add.props.onPress = { $action: "setState", path: "search", value: "x" };
    expect(check(s).ok).toBe(true);
  });

  it("rejects off-origin navigation", () => {
    const s = clone();
    s.elements.table.props.onRowClick.to = "https://evil.example";
    expect(errorsOf(s)[0]!.message).toMatch(/same-origin/);
  });
});

describe("schemas", () => {
  it("describe() is stable", () => {
    expect(catalog.describe()).toMatchSnapshot();
  });

  it("specSchema serializes to JSON Schema", () => {
    expect(z.toJSONSchema(catalog.specSchema)).toMatchSnapshot();
  });

  it("subset() restricts the vocabulary", () => {
    const small = catalog.subset(["Stack", "Heading"]);
    expect(small.names).toEqual(["Stack", "Heading"]);
    expect(validateSpec(good, { catalog: small }).ok).toBe(false);
  });

  it("tool signatures never include the handler", () => {
    const tool = defineTool({
      description: "List plants.",
      input: z.object({ query: z.string().optional() }),
      output: z.array(z.object({ id: z.string() })),
      handler: async () => [],
    });
    const sig = toolSignature("listPlants", tool);
    expect(JSON.stringify(sig)).not.toContain("handler");
    expect(sig).toMatchSnapshot();
  });
});
