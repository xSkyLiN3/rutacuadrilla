import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "./api/client";
import type {
  LoginResponse,
  Membership,
  SimpleAdminApi,
  SimpleOverview,
  SimplePointState,
  User,
} from "./api/types";
import { LoginView } from "./components/LoginView";

const TOKEN_STORAGE_KEY = "rutacuadrilla.admin.token";
const PUBLIC_DEMO_NOTICE = "Demo pública · datos 100 % sintéticos · no usar en terreno";
const PUBLIC_DEMO_CREDENTIALS = {
  email: "admin@demo.rutacuadrilla.local",
  password: "LocalDemoAdmin-2026!",
};
const EMPTY_OVERVIEW: SimpleOverview = { progress: [], routes: [], users: [] };
const CSV_EXAMPLE = `external_id,street,number,latitude,longitude,point_type,source
casa-001,Los Aromos,101,-0.44890,-0.66930,DWELLING,CSV
casa-002,Los Aromos,103,-0.44875,-0.66910,DWELLING,CSV`;

const STATE_LABELS: Record<SimplePointState, string> = {
  SIN_VISITAR: "Sin visitar",
  SOBRE_ENTREGADO: "Sobre entregado",
  VOLVER: "Volver",
  SIN_RESPUESTA: "Sin respuesta",
  APORTO: "Aportó",
  NO_PARTICIPA: "No participa",
};

const STATE_ORDER = Object.keys(STATE_LABELS) as SimplePointState[];

type Page = "users" | "routes" | "progress";
type AuthenticatedState = { membership: Membership; user: User };

interface SimpleAdminAppProps {
  api: SimpleAdminApi;
  demoMode?: boolean;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "No fue posible completar la operación.";
}

function PublicDemoBanner() {
  return (
    <p className="public-demo-banner" role="note">
      {PUBLIC_DEMO_NOTICE}
    </p>
  );
}

export function SimpleAdminApp({ api, demoMode = false }: SimpleAdminAppProps) {
  const [status, setStatus] = useState<"checking" | "guest" | "ready">("checking");
  const [auth, setAuth] = useState<AuthenticatedState | null>(null);
  const [page, setPage] = useState<Page>("users");
  const [overview, setOverview] = useState<SimpleOverview>(EMPTY_OVERVIEW);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [actionKey, setActionKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [routeSelections, setRouteSelections] = useState<Record<string, string>>({});
  const [routeName, setRouteName] = useState("");
  const [sectorName, setSectorName] = useState("");
  const [csv, setCsv] = useState(CSV_EXAMPLE);

  const loadOverview = useCallback(
    async (membership: Membership, quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const next = await api.getSimpleOverview(membership.crewId);
        setOverview(next);
        setError("");
        setRouteSelections((current) => {
          const result = { ...current };
          for (const user of next.users) {
            if (!(user.id in result)) result[user.id] = user.assignment?.routeId ?? "";
          }
          return result;
        });
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          api.setToken(null);
          setAuth(null);
          setStatus("guest");
          setNotice("Tu sesión expiró. Inicia sesión nuevamente.");
        } else {
          setError(messageFrom(caught));
        }
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [api],
  );

  const acceptSession = useCallback(
    async (response: LoginResponse) => {
      const membership = response.memberships.find((candidate) => candidate.role === "ADMIN");
      if (!membership) {
        await api.logout().catch(() => undefined);
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        api.setToken(null);
        setNotice("Esta cuenta usa la web de terreno, no la administración.");
        setStatus("guest");
        return;
      }
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, response.token);
      const nextAuth = { membership, user: response.user };
      setAuth(nextAuth);
      setStatus("ready");
      setNotice("");
      await loadOverview(membership);
    },
    [api, loadOverview],
  );

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const token = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        setStatus("guest");
        return;
      }
      api.setToken(token);
      try {
        const response = await api.me();
        if (!active) return;
        await acceptSession({ ...response, expiresAt: "", token });
      } catch {
        if (!active) return;
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        api.setToken(null);
        setNotice("No pudimos recuperar la sesión. Ingresa nuevamente.");
        setStatus("guest");
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, [acceptSession, api]);

  useEffect(() => {
    if (!auth) return;
    const refresh = () => void loadOverview(auth.membership, true);
    const interval = window.setInterval(refresh, 15_000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [auth, loadOverview]);

  const availableRoutes = useMemo(
    () => overview.routes.filter((route) => route.publishedRevisionId),
    [overview.routes],
  );

  async function runAction(key: string, action: () => Promise<void>, success: string) {
    if (!auth) return;
    setActionKey(key);
    setError("");
    setNotice("");
    try {
      await action();
      await loadOverview(auth.membership, true);
      setNotice(success);
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setActionKey("");
    }
  }

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    await runAction(
      "create-user",
      async () => {
        await api.createSimpleUser(auth.membership.crewId, { displayName, email, password });
        setDisplayName("");
        setEmail("");
        setPassword("");
      },
      "Usuario creado. Ya puedes asignarle una ruta.",
    );
  }

  async function importRoute(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    await runAction(
      "import-route",
      async () => {
        await api.importSimpleRoute(auth.membership.crewId, {
          csv,
          operationId: crypto.randomUUID(),
          routeName,
          sectorName,
        });
        setRouteName("");
      },
      "Ruta importada y lista para asignar.",
    );
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    api.setToken(null);
    setAuth(null);
    setOverview(EMPTY_OVERVIEW);
    setNotice("Sesión cerrada.");
    setStatus("guest");
  }

  if (status === "checking") {
    return (
      <>
        {demoMode ? <PublicDemoBanner /> : null}
        <main className="centered-page" aria-live="polite">
          <div className="state-panel">
            <span className="spinner" aria-hidden="true" />
            <strong>Preparando administración…</strong>
          </div>
        </main>
      </>
    );
  }

  if (status === "guest" || !auth) {
    return (
      <>
        {demoMode ? <PublicDemoBanner /> : null}
        <LoginView
          api={api}
          demoCredentials={PUBLIC_DEMO_CREDENTIALS}
          demoDescription="Credenciales sintéticas prellenadas para esta demostración."
          demoMode={demoMode}
          notice={notice}
          onAuthenticated={(response) => void acceptSession(response)}
        />
      </>
    );
  }

  return (
    <div className="simple-admin-app">
      {demoMode ? <PublicDemoBanner /> : null}
      <a className="skip-link" href="#main-content">
        Ir al contenido
      </a>
      <header className="simple-admin-header">
        <div>
          <span className="brand-symbol" aria-hidden="true">
            RC
          </span>
          <div>
            <strong>RutaCuadrilla</strong>
            <small>{auth.membership.crewName}</small>
          </div>
        </div>
        <nav aria-label="Administración principal">
          {(["users", "routes", "progress"] as const).map((candidate) => (
            <button
              aria-current={page === candidate ? "page" : undefined}
              key={candidate}
              onClick={() => setPage(candidate)}
              type="button"
            >
              {candidate === "users" ? "Usuarios" : candidate === "routes" ? "Rutas" : "Avance"}
            </button>
          ))}
        </nav>
        <div className="simple-account">
          <span>
            <strong>{auth.user.name}</strong>
            <small>{auth.user.email}</small>
          </span>
          <button className="button button--quiet" onClick={() => void logout()} type="button">
            Salir
          </button>
        </div>
      </header>

      <main id="main-content" className="simple-admin-main">
        {notice ? (
          <p className="notice notice--success" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="simple-alert" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="notice" role="status">
            Actualizando datos…
          </p>
        ) : null}

        {page === "users" ? (
          <section aria-labelledby="users-title">
            <div className="simple-page-heading">
              <div>
                <p className="eyebrow">Acceso de terreno</p>
                <h1 id="users-title">Usuarios y rutas asignadas</h1>
                <p>Cada persona tiene una sola cuenta y ve únicamente la ruta que le asignas.</p>
              </div>
              <span className="simple-count">{overview.users.length} usuarios</span>
            </div>

            <div className="simple-admin-grid">
              <form className="simple-card simple-form" onSubmit={createUser}>
                <div>
                  <p className="eyebrow">Nuevo acceso</p>
                  <h2>Crear usuario</h2>
                </div>
                <label>
                  Nombre
                  <input
                    required
                    maxLength={120}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
                <label>
                  Correo
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                <label>
                  Contraseña inicial
                  <input
                    required
                    minLength={12}
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <small>Mínimo 12 caracteres.</small>
                </label>
                <button
                  className="button button--primary"
                  disabled={actionKey === "create-user"}
                  type="submit"
                >
                  {actionKey === "create-user" ? "Creando…" : "Crear usuario"}
                </button>
              </form>

              <div className="simple-user-list" aria-live="polite">
                {overview.users.length === 0 ? (
                  <div className="simple-card simple-empty">
                    <strong>Aún no hay usuarios.</strong>
                    <span>Crea el primero y asígnale una ruta publicada.</span>
                  </div>
                ) : (
                  overview.users.map((user) => {
                    const selectedRouteId =
                      routeSelections[user.id] ?? user.assignment?.routeId ?? "";
                    const busy =
                      actionKey === `assign-${user.id}` || actionKey === `unassign-${user.id}`;
                    return (
                      <article className="simple-card simple-user-card" key={user.id}>
                        <div>
                          <strong>{user.name}</strong>
                          <span>{user.email}</span>
                          <small>
                            {user.assignment
                              ? `Ruta actual: ${user.assignment.routeName}`
                              : "Sin ruta asignada"}
                          </small>
                        </div>
                        <label>
                          <span className="sr-only">Ruta para {user.name}</span>
                          <select
                            value={selectedRouteId}
                            onChange={(event) =>
                              setRouteSelections((current) => ({
                                ...current,
                                [user.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Selecciona una ruta</option>
                            {availableRoutes.map((route) => (
                              <option
                                disabled={Boolean(
                                  route.assignedUser && route.assignedUser.id !== user.id,
                                )}
                                key={route.id}
                                value={route.id}
                              >
                                {route.name} · {route.pointCount} viviendas
                                {route.assignedUser && route.assignedUser.id !== user.id
                                  ? " · asignada"
                                  : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="button-row">
                          <button
                            className="button button--primary"
                            disabled={
                              busy ||
                              !selectedRouteId ||
                              selectedRouteId === user.assignment?.routeId
                            }
                            onClick={() =>
                              void runAction(
                                `assign-${user.id}`,
                                () =>
                                  api.assignSimpleRoute(
                                    auth.membership.crewId,
                                    user.id,
                                    selectedRouteId,
                                  ),
                                `Ruta asignada a ${user.name}.`,
                              )
                            }
                            type="button"
                          >
                            Asignar
                          </button>
                          {user.assignment ? (
                            <button
                              className="button button--quiet"
                              disabled={busy}
                              onClick={() =>
                                void runAction(
                                  `unassign-${user.id}`,
                                  () => api.unassignSimpleRoute(auth.membership.crewId, user.id),
                                  `Ruta retirada de ${user.name}.`,
                                )
                              }
                              type="button"
                            >
                              Quitar ruta
                            </button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        ) : null}

        {page === "routes" ? (
          <section aria-labelledby="routes-title">
            <div className="simple-page-heading">
              <div>
                <p className="eyebrow">Viviendas</p>
                <h1 id="routes-title">Rutas listas para terreno</h1>
                <p>Una vivienda pertenece a la ruta del lado de calle que atenderá esa persona.</p>
              </div>
              <span className="simple-count">{overview.routes.length} rutas</span>
            </div>
            <div className="simple-admin-grid">
              <form className="simple-card simple-form" onSubmit={importRoute}>
                <div>
                  <p className="eyebrow">Nueva ruta</p>
                  <h2>Importar viviendas</h2>
                </div>
                <label>
                  Nombre de ruta
                  <input
                    required
                    maxLength={120}
                    value={routeName}
                    onChange={(event) => setRouteName(event.target.value)}
                    placeholder="Camión 1 · lado norte"
                  />
                </label>
                <label>
                  Sector
                  <input
                    required
                    maxLength={120}
                    value={sectorName}
                    onChange={(event) => setSectorName(event.target.value)}
                    placeholder="Centro"
                  />
                </label>
                <label>
                  Archivo CSV
                  <input
                    accept=".csv,text/csv"
                    type="file"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void file.text().then(setCsv);
                    }}
                  />
                </label>
                <label>
                  Contenido
                  <textarea required value={csv} onChange={(event) => setCsv(event.target.value)} />
                </label>
                <small>
                  Incluye solo las viviendas que corresponden a esta ruta. Los lados opuestos pueden
                  ir en rutas distintas.
                </small>
                <button
                  className="button button--primary"
                  disabled={actionKey === "import-route"}
                  type="submit"
                >
                  {actionKey === "import-route" ? "Preparando…" : "Crear ruta"}
                </button>
              </form>
              <div className="simple-route-list">
                {overview.routes.length === 0 ? (
                  <div className="simple-card simple-empty">
                    <strong>Aún no hay rutas.</strong>
                    <span>Importa un CSV con viviendas para comenzar.</span>
                  </div>
                ) : (
                  overview.routes.map((route) => (
                    <article className="simple-card simple-route-card" key={route.id}>
                      <div>
                        <strong>{route.name}</strong>
                        <span>{route.sectorName}</span>
                      </div>
                      <dl>
                        <div>
                          <dt>Viviendas</dt>
                          <dd>{route.pointCount}</dd>
                        </div>
                        <div>
                          <dt>Asignación</dt>
                          <dd>{route.assignedUser?.name ?? "Disponible"}</dd>
                        </div>
                      </dl>
                      {!route.publishedRevisionId ? (
                        <small className="simple-warning">
                          La ruta todavía no está lista para asignarse.
                        </small>
                      ) : null}
                    </article>
                  ))
                )}
              </div>
            </div>
          </section>
        ) : null}

        {page === "progress" ? (
          <section aria-labelledby="progress-title">
            <div className="simple-page-heading">
              <div>
                <p className="eyebrow">Seguimiento en línea</p>
                <h1 id="progress-title">Avance por ruta</h1>
                <p>Los contadores se actualizan automáticamente mientras las personas trabajan.</p>
              </div>
              <button
                className="button"
                onClick={() => void loadOverview(auth.membership)}
                type="button"
              >
                Actualizar
              </button>
            </div>
            <div className="simple-progress-grid">
              {overview.progress.length === 0 ? (
                <div className="simple-card simple-empty">
                  <strong>No hay rutas activas asignadas.</strong>
                  <span>Asigna una ruta para comenzar a ver su avance.</span>
                </div>
              ) : (
                overview.progress.map((progress) => {
                  const percentage =
                    progress.total === 0
                      ? 0
                      : Math.round((progress.visited / progress.total) * 100);
                  return (
                    <article
                      className="simple-card simple-progress-card"
                      key={progress.assignmentId}
                    >
                      <div className="simple-progress-title">
                        <div>
                          <p className="eyebrow">{progress.user.name}</p>
                          <h2>{progress.routeName}</h2>
                        </div>
                        <strong>{percentage}%</strong>
                      </div>
                      <div
                        className="simple-progress-track"
                        aria-label={`${progress.visited} de ${progress.total} viviendas visitadas`}
                        aria-valuemax={progress.total}
                        aria-valuemin={0}
                        aria-valuenow={progress.visited}
                        role="progressbar"
                      >
                        <span style={{ width: `${percentage}%` }} />
                      </div>
                      <p>
                        {progress.visited} de {progress.total} viviendas visitadas
                      </p>
                      <dl className="simple-state-grid">
                        {STATE_ORDER.map((state) => (
                          <div data-state={state} key={state}>
                            <dt>{STATE_LABELS[state]}</dt>
                            <dd>{progress.states[state]}</dd>
                          </div>
                        ))}
                      </dl>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
