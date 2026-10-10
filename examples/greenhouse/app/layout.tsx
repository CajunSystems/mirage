import { NavLink } from "react-router";
import { Outlet } from "@cajunsystems/mirage-react";

export default function RootLayout() {
  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "16px 16px 48px" }}>
      <nav style={{ display: "flex", gap: 16, alignItems: "baseline", padding: "8px 0 24px" }}>
        <strong>🌿 Greenhouse</strong>
        <NavLink to="/" end>
          Today
        </NavLink>
        <NavLink to="/plants">Plants</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
