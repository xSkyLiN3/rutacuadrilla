import type { Membership, User } from "../api/types";

interface CrewChooserProps {
  user: User;
  memberships: Membership[];
  demoMode: boolean;
  onSelect: (membership: Membership) => void;
  onLogout: () => void;
}

export function CrewChooser({ user, memberships, demoMode, onSelect, onLogout }: CrewChooserProps) {
  return (
    <>
      <header className="simple-header">
        <a className="brand-link" href="#main-content">
          RutaCuadrilla
        </a>
        <div className="header-actions">
          {demoMode ? <span className="demo-badge">Demo</span> : null}
          <span>{user.name}</span>
          <button className="button button--quiet" type="button" onClick={onLogout}>
            Salir
          </button>
        </div>
      </header>
      <main id="main-content" className="page page--narrow">
        <header className="page-heading">
          <p className="eyebrow">Espacio de trabajo</p>
          <h1>Elige una tripulación</h1>
          <p>Solo verás las rutas y revisiones de la tripulación seleccionada.</p>
        </header>
        <div className="crew-grid">
          {memberships.map((membership) => (
            <button
              className="crew-card"
              key={membership.crewId}
              type="button"
              onClick={() => onSelect(membership)}
            >
              <span className="crew-mark" aria-hidden="true">
                {membership.crewName.slice(0, 1).toLocaleUpperCase("es")}
              </span>
              <span>
                <strong>{membership.crewName}</strong>
                <small>{membership.role === "ADMIN" ? "Administrador" : "Miembro"}</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </main>
    </>
  );
}
