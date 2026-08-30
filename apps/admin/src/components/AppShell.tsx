import type { ReactNode } from "react";
import type { Membership, User } from "../api/types";

export type AdminPageName = "routes" | "import" | "detail" | "campaigns";

interface AppShellProps {
  user: User;
  membership: Membership;
  demoMode: boolean;
  currentPage: AdminPageName;
  canChangeCrew: boolean;
  children: ReactNode;
  onNavigate: (page: "routes" | "import" | "campaigns") => void;
  onChangeCrew: () => void;
  onLogout: () => void;
}

export function AppShell({
  user,
  membership,
  demoMode,
  currentPage,
  canChangeCrew,
  children,
  onNavigate,
  onChangeCrew,
  onLogout,
}: AppShellProps) {
  const canManageCampaigns = membership.capabilities
    ? membership.capabilities.includes("CAMPAIGN_MANAGE")
    : membership.role === "ADMIN";
  const canEditRoutes = membership.capabilities
    ? membership.capabilities.includes("ROUTE_DRAFT_EDIT")
    : membership.role === "ADMIN";
  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main-content">
        Saltar al contenido principal
      </a>
      <header className="admin-header">
        <button
          className="brand-button"
          type="button"
          onClick={() => onNavigate("routes")}
          aria-label="Ir al listado de rutas"
        >
          <span className="brand-symbol" aria-hidden="true">
            RC
          </span>
          <span>
            <strong>RutaCuadrilla</strong>
            <small>Administración</small>
          </span>
        </button>

        <nav className="main-nav" aria-label="Administración">
          <button
            type="button"
            aria-current={currentPage === "routes" ? "page" : undefined}
            onClick={() => onNavigate("routes")}
          >
            Rutas
          </button>
          {canEditRoutes ? (
            <button
              type="button"
              aria-current={currentPage === "import" ? "page" : undefined}
              onClick={() => onNavigate("import")}
            >
              Importar CSV
            </button>
          ) : null}
          {canManageCampaigns ? (
            <button
              type="button"
              aria-current={currentPage === "campaigns" ? "page" : undefined}
              onClick={() => onNavigate("campaigns")}
            >
              Campañas
            </button>
          ) : null}
        </nav>

        <div className="account-area">
          {demoMode ? <span className="demo-badge">Demo</span> : null}
          <div>
            <strong>{membership.crewName}</strong>
            <small>{user.name}</small>
          </div>
          {canChangeCrew ? (
            <button className="button button--quiet" type="button" onClick={onChangeCrew}>
              Cambiar
            </button>
          ) : null}
          <button className="button button--quiet" type="button" onClick={onLogout}>
            Salir
          </button>
        </div>
      </header>
      <main id="main-content" className="page">
        {children}
      </main>
    </div>
  );
}
