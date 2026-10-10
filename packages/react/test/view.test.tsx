// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { defineCatalog, z, type PartialSpec, type Spec } from "@mirage/core";
import { basicCatalog } from "@mirage/catalog-basic";
import { MirageView, settle } from "@mirage/react";

afterEach(cleanup);

const plants = [
  { id: "p1", name: "Monstera", species: "Monstera deliciosa" },
  { id: "p2", name: "Fern", species: "Nephrolepis exaltata" },
];

function mockTools() {
  return vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "listPlants") {
      const q = String(args.query ?? "").toLowerCase();
      return plants.filter((p) => p.name.toLowerCase().includes(q));
    }
    if (name === "getPlant") return plants.find((p) => p.id === args.id);
    if (name === "addPlant") return { id: "p3" };
    throw new Error(`unknown tool ${name}`);
  });
}

const listSpec: Spec = {
  version: 1,
  root: "page",
  data: { plants: { tool: "listPlants", args: { query: { $state: "search" } } } },
  state: { search: "", draft: { name: "" } },
  elements: {
    page: { type: "Stack", children: ["title", "search", "table", "form"] },
    title: { type: "Heading", props: { text: "Plants" } },
    search: {
      type: "TextInput",
      props: {
        label: "Search",
        value: { $state: "search" },
        onChange: { $action: "setState", path: "search", value: { $event: "" } },
      },
    },
    table: {
      type: "Table",
      props: {
        rows: { $data: "plants" },
        columns: [{ key: "name", label: "Name" }],
        onRowClick: { $action: "navigate", to: "/plants/:id" },
      },
    },
    form: {
      type: "Form",
      props: {
        submitLabel: "Add plant",
        onSubmit: {
          $action: "tool",
          name: "addPlant",
          args: { name: { $state: "draft.name" } },
          then: [{ refresh: ["plants"] }, { setState: { path: "draft", value: { name: "" } } }],
        },
      },
      children: ["name"],
    },
    name: {
      type: "TextInput",
      props: {
        label: "Name",
        value: { $state: "draft.name" },
        onChange: { $action: "setState", path: "draft.name", value: { $event: "" } },
      },
    },
  },
};

describe("MirageView", () => {
  it("renders data, state and actions against mock tools", async () => {
    const callTool = mockTools();
    const navigate = vi.fn();
    render(<MirageView spec={listSpec} catalog={basicCatalog} callTool={callTool} navigate={navigate} />);
    expect(screen.getByRole("heading", { name: "Plants" })).toBeTruthy();
    await screen.findByText("Monstera");
    expect(callTool).toHaveBeenCalledWith("listPlants", { query: "" });

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "fer" } });
    await waitFor(() => expect(screen.queryByText("Monstera")).toBeNull());
    expect(callTool).toHaveBeenLastCalledWith("listPlants", { query: "fer" });

    fireEvent.click(screen.getByText("Fern"));
    expect(navigate).toHaveBeenCalledWith("/plants/p2");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cactus" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Add plant"));
    });
    expect(callTool).toHaveBeenCalledWith("addPlant", { name: "Cactus" });
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(""));
    expect(callTool.mock.calls.filter(([n]) => n === "listPlants").length).toBe(3);
  });

  it("resolves $param and $data paths, with a skeleton while loading", async () => {
    const spec: Spec = {
      version: 1,
      root: "page",
      data: { plant: { tool: "getPlant", args: { id: { $param: "id" } } } },
      elements: {
        page: { type: "Stack", children: ["title"] },
        title: { type: "Heading", props: { text: { $data: "plant", path: "name" } } },
      },
    };
    const { container } = render(<MirageView spec={spec} catalog={basicCatalog} params={{ id: "p1" }} callTool={mockTools()} />);
    expect(container.querySelector("[data-mirage-skeleton]")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Monstera" })).toBeTruthy();
  });

  it("renders partial specs progressively", () => {
    const partial: PartialSpec = {
      version: 1,
      root: "page",
      elements: { page: { type: "Stack", children: ["title", "later"] }, title: { type: "Heading", props: { text: "Hi" } } },
    };
    const { container, rerender } = render(<MirageView spec={partial} catalog={basicCatalog} />);
    expect(screen.getByText("Hi")).toBeTruthy();
    expect(container.querySelectorAll("[data-mirage-skeleton]").length).toBe(1);
    const heading = screen.getByText("Hi");

    rerender(
      <MirageView
        spec={{ ...partial, elements: { ...partial.elements, later: { type: "Text", props: { text: "Done" } } } }}
        catalog={basicCatalog}
      />,
    );
    expect(screen.getByText("Done")).toBeTruthy();
    expect(container.querySelector("[data-mirage-skeleton]")).toBeNull();
    expect(screen.getByText("Hi")).toBe(heading); // not remounted
  });

  it("shows a dev error chip for an invalid element without breaking siblings", () => {
    const spec = {
      version: 1,
      root: "page",
      elements: {
        page: { type: "Stack", children: ["bad", "unknown", "good"] },
        bad: { type: "Heading", props: { text: { nested: true } } },
        unknown: { type: "Marquee" },
        good: { type: "Text", props: { text: "Still here" } },
      },
    } as PartialSpec;
    render(<MirageView spec={spec} catalog={basicCatalog} dev />);
    expect(screen.getAllByRole("alert").length).toBe(2);
    expect(screen.getByText("Still here")).toBeTruthy();
  });

  it("renders nothing for invalid elements in production", () => {
    const spec = { version: 1, root: "bad", elements: { bad: { type: "Heading", props: { text: {} } } } } as PartialSpec;
    const { container } = render(<MirageView spec={spec} catalog={basicCatalog} dev={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("contains a component that throws in an error boundary", () => {
    const Boom = () => {
      throw new Error("boom");
    };
    const catalog = defineCatalog({
      ...basicCatalog.entries,
      Boom: { description: "Throws.", props: z.object({}), component: Boom },
    });
    const spec = {
      version: 1,
      root: "page",
      elements: { page: { type: "Stack", children: ["boom", "ok"] }, boom: { type: "Boom" }, ok: { type: "Text", props: { text: "ok" } } },
    } as PartialSpec;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<MirageView spec={spec} catalog={catalog} dev />);
    spy.mockRestore();
    expect(screen.getByRole("alert").textContent).toContain("boom");
    expect(screen.getByText("ok")).toBeTruthy();
  });
});

describe("settle", () => {
  it("drops possibly incomplete trailing entries", () => {
    expect(settle({ root: "a", data: { x: { tool: "t" }, y: { tool: "lis" } } })).toEqual({ root: "a", data: { x: { tool: "t" } } });
    expect(
      settle({ root: "a", data: { y: { tool: "list" } }, state: { s: 1 }, elements: { a: { type: "Stack" }, b: { type: "Hea" } } }),
    ).toEqual({ root: "a", data: { y: { tool: "list" } }, state: { s: 1 }, elements: { a: { type: "Stack" } } });
  });
});
