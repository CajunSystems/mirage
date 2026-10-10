import { useState, type ReactNode } from "react";
import type { DataResult } from "@cajunsystems/mirage-core";

type Handler = (event?: unknown) => void;
type Gap = "sm" | "md" | "lg";
type Text = string | number | null | undefined;

const show = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : String(v));

export function Stack({ gap = "md", children }: { gap?: Gap; children?: ReactNode }) {
  return <div className={`mi-stack mi-gap-${gap}`}>{children}</div>;
}

export function Row({
  gap = "md",
  align = "start",
  children,
}: {
  gap?: Gap;
  align?: "start" | "center" | "end" | "between";
  children?: ReactNode;
}) {
  return <div className={`mi-row mi-gap-${gap} mi-align-${align}`}>{children}</div>;
}

export function Grid({ columns = 3, children }: { columns?: number; children?: ReactNode }) {
  return (
    <div className="mi-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

export function Heading({ text, level = 1 }: { text: Text; level?: 1 | 2 | 3 }) {
  const Tag = `h${level}` as const;
  return <Tag className="mi-heading">{show(text)}</Tag>;
}

export function Text({ text, tone = "default" }: { text: Text; tone?: "default" | "muted" }) {
  return <p className={`mi-text mi-tone-${tone}`}>{show(text)}</p>;
}

export function Card({ title, children }: { title?: Text; children?: ReactNode }) {
  return (
    <section className="mi-card">
      {title != null && <h3 className="mi-card-title">{show(title)}</h3>}
      {children}
    </section>
  );
}

export function Badge({ text, tone = "neutral" }: { text: Text; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return <span className={`mi-badge mi-badge-${tone}`}>{show(text)}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: Text; hint?: Text }) {
  return (
    <div className="mi-stat">
      <div className="mi-stat-label">{label}</div>
      <div className="mi-stat-value">{show(value)}</div>
      {hint != null && <div className="mi-stat-hint">{show(hint)}</div>}
    </div>
  );
}

export function Button({
  label,
  variant = "secondary",
  onPress,
}: {
  label: string;
  variant?: "primary" | "secondary";
  onPress: Handler;
}) {
  return (
    <button type="button" className={`mi-button mi-button-${variant}`} onClick={() => onPress()}>
      {label}
    </button>
  );
}

export function Table({
  rows,
  columns,
  onRowClick,
  emptyText = "Nothing here yet.",
}: {
  rows: DataResult;
  columns: { key: string; label: string }[];
  onRowClick?: Handler;
  emptyText?: string;
}) {
  const items = Array.isArray(rows.data) ? (rows.data as Record<string, unknown>[]) : [];
  const message = rows.error ? `Could not load: ${rows.error}` : rows.loading && !items.length ? "Loading…" : !items.length ? emptyText : null;
  return (
    <table className="mi-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {message ? (
          <tr>
            <td colSpan={columns.length} className="mi-table-message">
              {message}
            </td>
          </tr>
        ) : (
          items.map((row, i) => (
            <tr
              key={String(row.id ?? i)}
              className={onRowClick ? "mi-clickable" : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key}>{show(row[c.key])}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

export function Form({
  submitLabel = "Save",
  onSubmit,
  children,
}: {
  submitLabel?: string;
  onSubmit: Handler;
  children?: ReactNode;
}) {
  return (
    <form
      className="mi-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <div className="mi-form-actions">
        <button type="submit" className="mi-button mi-button-primary">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function TextInput({
  label,
  value,
  placeholder,
  type = "text",
  onChange,
}: {
  label: string;
  value?: string | number | null;
  placeholder?: string;
  type?: "text" | "number" | "date" | "email" | "tel";
  onChange?: Handler;
}) {
  return (
    <label className="mi-field">
      <span className="mi-field-label">{label}</span>
      <input
        className="mi-input"
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        readOnly={!onChange}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </label>
  );
}

export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value?: string | null;
  options: { value: string; label: string }[];
  onChange?: Handler;
}) {
  return (
    <label className="mi-field">
      <span className="mi-field-label">{label}</span>
      <select className="mi-input" value={value ?? ""} onChange={(e) => onChange?.(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Tabs({ labels, children }: { labels: string[]; children?: ReactNode }) {
  const [active, setActive] = useState(0);
  const panels = Array.isArray(children) ? children : [children];
  return (
    <div className="mi-tabs">
      <div className="mi-tab-list" role="tablist">
        {labels.map((label, i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={i === active}
            className="mi-tab"
            onClick={() => setActive(i)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{panels[active]}</div>
    </div>
  );
}

export function Dialog({
  title,
  open = false,
  onClose,
  children,
}: {
  title: string;
  open?: boolean | null;
  onClose?: Handler;
  children?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="mi-dialog-backdrop" onClick={() => onClose?.()}>
      <div className="mi-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="mi-row mi-gap-md mi-align-between">
          <h3 className="mi-card-title">{title}</h3>
          {onClose && (
            <button type="button" className="mi-button mi-button-secondary" onClick={() => onClose()}>
              Close
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
