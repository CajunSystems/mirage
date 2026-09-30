/** Soil moisture as a horizontal bar. Custom catalog component for this app. */
export function MoistureMeter({ label, value }: { label: string; value: number | null }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const tone = pct < 30 ? "dry" : pct > 80 ? "wet" : "ok";
  return (
    <div className="moisture">
      <div className="moisture-label">
        <span>{label}</span>
        <span>{value == null ? "—" : `${pct}%`}</span>
      </div>
      <div className="moisture-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
        <div className={`moisture-fill moisture-${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
