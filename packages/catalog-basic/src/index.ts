import { defineCatalog, z } from "@mirage/core";
import * as C from "./components.js";

const gap = z.enum(["sm", "md", "lg"]).default("md");
const text = z.union([z.string(), z.number()]).nullable();

/** The default Mirage catalog. Import `@mirage/catalog-basic/styles.css` once in your app. */
export const basicCatalog = defineCatalog({
  Stack: {
    description: "Vertical stack of children. The usual page root.",
    props: z.object({ gap }),
    component: C.Stack,
    children: true,
  },
  Row: {
    description: "Horizontal row of children, e.g. a heading with a button on the right (align: between).",
    props: z.object({ gap, align: z.enum(["start", "center", "end", "between"]).default("start") }),
    component: C.Row,
    children: true,
  },
  Grid: {
    description: "Equal-width grid of children. Good for a few Stat or Card elements.",
    props: z.object({ columns: z.number().int().min(1).max(6).default(3) }),
    component: C.Grid,
    children: true,
  },
  Heading: {
    description: "A heading. level 1 for the page title.",
    props: z.object({ text, level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1) }),
    component: C.Heading,
  },
  Text: {
    description: "A paragraph of text.",
    props: z.object({ text, tone: z.enum(["default", "muted"]).default("default") }),
    component: C.Text,
  },
  Card: {
    description: "A titled container. Use to group related content.",
    props: z.object({ title: text.optional() }),
    component: C.Card,
    children: true,
  },
  Badge: {
    description: "A small status label.",
    props: z.object({ text, tone: z.enum(["neutral", "success", "warning", "danger"]).default("neutral") }),
    component: C.Badge,
  },
  Stat: {
    description: "A single labelled number or value, with an optional hint.",
    props: z.object({ label: z.string(), value: text, hint: text.optional() }),
    component: C.Stat,
  },
  Button: {
    description: "A clickable button that triggers an action.",
    props: z.object({
      label: z.string(),
      variant: z.enum(["primary", "secondary"]).default("secondary"),
      onPress: z.action(),
    }),
    component: C.Button,
  },
  Table: {
    description: "Tabular data. `rows` must be a binding to an array. onRowClick receives the row object as $event.",
    props: z.object({
      rows: z.ref(),
      columns: z.array(z.object({ key: z.string(), label: z.string() })),
      onRowClick: z.action().optional(),
      emptyText: z.string().default("Nothing here yet."),
    }),
    component: C.Table,
  },
  Form: {
    description: "A form. Children are its fields. onSubmit fires on submit; read field values from $state.",
    props: z.object({ submitLabel: z.string().default("Save"), onSubmit: z.action() }),
    component: C.Form,
    children: true,
  },
  TextInput: {
    description: "A labelled text field. Bind value to $state and write it back with a setState onChange whose value is {\"$event\": \"\"}.",
    props: z.object({
      label: z.string(),
      value: z.union([z.string(), z.number()]).nullable().optional(),
      placeholder: z.string().optional(),
      type: z.enum(["text", "number", "date", "email", "tel"]).default("text"),
      onChange: z.action().optional(),
    }),
    component: C.TextInput,
  },
  Select: {
    description: "A labelled dropdown. onChange receives the selected value as $event.",
    props: z.object({
      label: z.string(),
      value: z.string().nullable().optional(),
      options: z.array(z.object({ value: z.string(), label: z.string() })),
      onChange: z.action().optional(),
    }),
    component: C.Select,
  },
  Tabs: {
    description: "Tabbed panels. One child per label, in the same order.",
    props: z.object({ labels: z.array(z.string()) }),
    component: C.Tabs,
    children: true,
  },
  Dialog: {
    description: "A modal dialog shown while `open` is true. Bind open to $state; onClose should set it false.",
    props: z.object({ title: z.string(), open: z.boolean().nullable().optional(), onClose: z.action().optional() }),
    component: C.Dialog,
    children: true,
  },
});

export * from "./components.js";
