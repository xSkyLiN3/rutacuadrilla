import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { PointStatePanel } from "./PointStatePanel";
import { POINT_STATE_OPTIONS, type PointFeedback } from "./pointStates";
import {
  SimpleFieldApi,
  SimpleFieldApiError,
  type SimpleFieldApiPort,
  type SimpleFieldAssignment,
} from "./simpleApi";
import type { FieldPoint, FieldUser, PointState } from "./types";

const TOKEN_KEY = "rutacuadrilla.simple-field.token";
const PUBLIC_DEMO_NOTICE = "Demo pública · datos 100 % sintéticos · no usar en terreno";
const PUBLIC_DEMO_CREDENTIALS = {
  email: "miembro@demo.rutacuadrilla.local",
  password: "LocalDemoField-2026!",
};

const LazyFieldMap = lazy(async () => {
  const { FieldMap } = await import("./map/FieldMap");
  return { default: FieldMap };
});

export function FieldMapLoadingFallback() {
  return (
    <section aria-live="polite" className="map-fallback" role="status">
      <strong>Cargando mapa…</strong>
      <span>Mientras tanto, puedes usar la pestaña Lista.</span>
    </section>
  );
}

export function FieldMapErrorFallback({ onUseList }: { onUseList(): void }) {
  return (
    <section className="map-fallback" role="alert">
      <strong>No fue posible cargar el mapa.</strong>
      <span>La ruta y sus acciones siguen disponibles en la vista de lista.</span>
      <button className="simple-field-secondary" onClick={onUseList} type="button">
        Usar vista de lista
      </button>
    </section>
  );
}

interface FieldMapErrorBoundaryProps {
  children: ReactNode;
  onUseList(): void;
}

class FieldMapErrorBoundary extends Component<FieldMapErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <FieldMapErrorFallback onUseList={this.props.onUseList} />;
    }
    return this.props.children;
  }
}

interface SimpleFieldAppProps {
  demoMode?: boolean;
  providedApi?: SimpleFieldApiPort;
}

function pointAddress(point: FieldPoint): string {
  return [point.street, point.number].filter(Boolean).join(" ") || point.externalId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "No fue posible completar la operación.";
}

function PublicDemoBanner() {
  return (
    <p className="public-demo-banner" role="note">
      {PUBLIC_DEMO_NOTICE}
    </p>
  );
}

export function SimpleFieldApp({ demoMode = false, providedApi }: SimpleFieldAppProps = {}) {
  const api = useMemo(() => providedApi ?? new SimpleFieldApi(), [providedApi]);
  const [authStatus, setAuthStatus] = useState<"checking" | "guest" | "ready">("checking");
  const [user, setUser] = useState<FieldUser | null>(null);
  const [email, setEmail] = useState(demoMode ? PUBLIC_DEMO_CREDENTIALS.email : "");
  const [password, setPassword] = useState(demoMode ? PUBLIC_DEMO_CREDENTIALS.password : "");
  const [assignment, setAssignment] = useState<SimpleFieldAssignment | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingPointId, setSavingPointId] = useState("");
  const [savingState, setSavingState] = useState<PointState | null>(null);
  const [selectedPointId, setSelectedPointId] = useState("");
  const [pointFeedback, setPointFeedback] = useState<PointFeedback | null>(null);
  const [view, setView] = useState<"map" | "list">("map");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(navigator.onLine);

  const loadAssignment = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const nextAssignment = await api.assignment();
        // Un 304 conserva la referencia del cliente: mantenerla evita recalcular
        // GeoJSON y fuentes de mapa para toda la ruta en cada polling.
        setAssignment((current) => (current === nextAssignment ? current : nextAssignment));
        setError("");
      } catch (caught) {
        if (caught instanceof SimpleFieldApiError && caught.status === 401) {
          window.sessionStorage.removeItem(TOKEN_KEY);
          api.setToken(null);
          setUser(null);
          setEmail(demoMode ? PUBLIC_DEMO_CREDENTIALS.email : "");
          setPassword(demoMode ? PUBLIC_DEMO_CREDENTIALS.password : "");
          setAuthStatus("guest");
          setNotice("Tu sesión expiró. Inicia sesión nuevamente.");
        } else if (!quiet) {
          setError(errorMessage(caught));
        }
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [api, demoMode],
  );

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const token = window.sessionStorage.getItem(TOKEN_KEY);
      if (!token) {
        setAuthStatus("guest");
        return;
      }
      api.setToken(token);
      try {
        const response = await api.me();
        if (!active) return;
        setUser(response.user);
        setAuthStatus("ready");
        await loadAssignment();
      } catch {
        if (!active) return;
        window.sessionStorage.removeItem(TOKEN_KEY);
        api.setToken(null);
        setEmail(demoMode ? PUBLIC_DEMO_CREDENTIALS.email : "");
        setPassword(demoMode ? PUBLIC_DEMO_CREDENTIALS.password : "");
        setAuthStatus("guest");
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, [api, demoMode, loadAssignment]);

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void loadAssignment(true);
    };
    const onOffline = () => setOnline(false);
    const onFocus = () => {
      if (navigator.onLine && user) void loadAssignment(true);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadAssignment, user]);

  useEffect(() => {
    if (!user) return;
    const interval = window.setInterval(() => {
      if (navigator.onLine && !savingPointId) void loadAssignment(true);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [loadAssignment, savingPointId, user]);

  const selectedPoint = assignment?.points.find((point) => point.id === selectedPointId);
  const filteredPoints = useMemo(() => {
    if (!assignment) return [];
    const normalized = query.trim().toLocaleLowerCase("es");
    if (!normalized) return assignment.points;
    return assignment.points.filter((point) =>
      [point.externalId, point.street, point.number, point.state]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("es").includes(normalized)),
    );
  }, [assignment, query]);

  function selectPoint(pointId: string) {
    setPointFeedback(null);
    setSelectedPointId(pointId);
  }

  function clearSelectedPoint() {
    setPointFeedback(null);
    setSelectedPointId("");
  }

  function changeView(nextView: "map" | "list") {
    if (nextView === view) return;
    clearSelectedPoint();
    setView(nextView);
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await api.login(email, password);
      api.setToken(response.token);
      window.sessionStorage.setItem(TOKEN_KEY, response.token);
      setUser(response.user);
      setPassword("");
      setAuthStatus("ready");
      setAssignment(await api.assignment());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    window.sessionStorage.removeItem(TOKEN_KEY);
    api.setToken(null);
    setUser(null);
    setEmail(demoMode ? PUBLIC_DEMO_CREDENTIALS.email : "");
    setPassword(demoMode ? PUBLIC_DEMO_CREDENTIALS.password : "");
    setAssignment(null);
    setSelectedPointId("");
    setNotice("Sesión cerrada.");
    setAuthStatus("guest");
  }

  async function setPointState(point: FieldPoint, state: PointState) {
    if (!online || savingPointId) return;
    setSavingPointId(point.id);
    setSavingState(state);
    setError("");
    setNotice("");
    const label = POINT_STATE_OPTIONS.find((option) => option.state === state)?.label ?? state;
    setPointFeedback({
      kind: "saving",
      message: `Guardando ${label.toLocaleLowerCase("es-CL")}…`,
      pointId: point.id,
    });
    try {
      const result = await api.updatePoint(point.id, {
        expectedVersion: point.version,
        operationId: crypto.randomUUID(),
        state,
      });
      setAssignment((current) =>
        current
          ? {
              ...current,
              points: current.points.map((candidate) =>
                candidate.id === result.point.id
                  ? { ...candidate, state: result.point.state, version: result.point.version }
                  : candidate,
              ),
              progress: result.progress,
            }
          : current,
      );
      setNotice(`${pointAddress(point)}: ${label}.`);
      setPointFeedback({ kind: "success", message: `Guardado: ${label}.`, pointId: point.id });
    } catch (caught) {
      if (caught instanceof SimpleFieldApiError && caught.code === "POINT_VERSION_CONFLICT") {
        const canonical = caught.details as { state?: PointState; version?: number } | undefined;
        if (canonical?.state && Number.isInteger(canonical.version)) {
          setAssignment((current) =>
            current
              ? {
                  ...current,
                  points: current.points.map((candidate) =>
                    candidate.id === point.id
                      ? {
                          ...candidate,
                          state: canonical.state as PointState,
                          version: canonical.version as number,
                        }
                      : candidate,
                  ),
                }
              : current,
          );
        }
        await loadAssignment(true);
      }
      const message = errorMessage(caught);
      setError(message);
      setPointFeedback({ kind: "error", message, pointId: point.id });
    } finally {
      setSavingPointId("");
      setSavingState(null);
    }
  }

  if (authStatus === "checking") {
    return (
      <>
        {demoMode ? <PublicDemoBanner /> : null}
        <main className="centered">
          <strong>Preparando tu ruta…</strong>
        </main>
      </>
    );
  }

  if (authStatus === "guest" || !user) {
    return (
      <>
        {demoMode ? <PublicDemoBanner /> : null}
        <main className="login-page simple-field-login">
          <section>
            <p className="eyebrow">RutaCuadrilla · Terreno</p>
            <h1>Tu ruta, vivienda por vivienda.</h1>
            <p>Ingresa desde el teléfono, toca una casa y guarda su estado al instante.</p>
          </section>
          <form onSubmit={login}>
            <div>
              <p className="eyebrow">Acceso personal</p>
              <h2>Iniciar sesión</h2>
            </div>
            {notice ? (
              <p className="notice" role="status">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <label>
              Correo
              <input
                autoComplete="username"
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Contraseña
              <input
                autoComplete="current-password"
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button disabled={loading || !email.trim() || !password} type="submit">
              {loading ? "Ingresando…" : "Ingresar"}
            </button>
          </form>
        </main>
      </>
    );
  }

  if (loading) {
    return (
      <>
        {demoMode ? <PublicDemoBanner /> : null}
        <main className="centered">
          <strong>Cargando tu ruta…</strong>
        </main>
      </>
    );
  }

  if (!assignment) {
    return (
      <>
        {demoMode ? <PublicDemoBanner /> : null}
        <main className="centered simple-no-assignment">
          <p className="eyebrow">Hola, {user.name}</p>
          <h1>Aún no tienes una ruta asignada.</h1>
          <p>Cuando el administrador te asigne una ruta, aparecerán aquí sus viviendas.</p>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="simple-field-row">
            <button onClick={() => void loadAssignment()} type="button">
              Comprobar de nuevo
            </button>
            <button className="simple-field-secondary" onClick={() => void logout()} type="button">
              Salir
            </button>
          </div>
        </main>
      </>
    );
  }

  const percentage =
    assignment.progress.total === 0
      ? 0
      : Math.round((assignment.progress.visited / assignment.progress.total) * 100);

  return (
    <div className="field-app simple-field-app">
      {demoMode ? <PublicDemoBanner /> : null}
      <header className="field-header simple-field-header">
        <div>
          <p className="eyebrow">{assignment.crew.name}</p>
          <strong>{assignment.route.name}</strong>
          <span>{user.name}</span>
        </div>
        <div className="field-header__actions">
          <span className={`sync-pill${online ? "" : " sync-pill--offline"}`}>
            {online ? "En línea" : "Sin conexión"}
          </span>
          <button className="quiet-button" onClick={() => void logout()} type="button">
            Salir
          </button>
        </div>
      </header>

      {!online ? (
        <p className="simple-offline" role="alert">
          Necesitas conexión para guardar estados. Puedes seguir consultando la ruta visible.
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="simple-field-progress" aria-label="Avance de la ruta">
        <div>
          <strong>{percentage}%</strong>
          <span>
            {assignment.progress.visited} de {assignment.progress.total} visitadas
          </span>
        </div>
        <div className="simple-field-track">
          <span style={{ width: `${percentage}%` }} />
        </div>
        <dl>
          {POINT_STATE_OPTIONS.map((option) => (
            <div data-state={option.state} key={option.state}>
              <dt>{option.label}</dt>
              <dd>{assignment.progress.states[option.state]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="simple-view-tabs" role="tablist" aria-label="Vista de ruta">
        <button
          aria-selected={view === "map"}
          onClick={() => changeView("map")}
          role="tab"
          type="button"
        >
          Mapa
        </button>
        <button
          aria-selected={view === "list"}
          onClick={() => changeView("list")}
          role="tab"
          type="button"
        >
          Lista
        </button>
      </div>

      {view === "map" ? (
        <main className="simple-field-map-main">
          <FieldMapErrorBoundary onUseList={() => changeView("list")}>
            <Suspense fallback={<FieldMapLoadingFallback />}>
              <LazyFieldMap
                feedback={pointFeedback}
                online={online}
                onClearSelection={clearSelectedPoint}
                onSelect={selectPoint}
                onSetPointState={(point, state) => void setPointState(point, state)}
                points={assignment.points}
                savingPointId={savingPointId}
                savingState={savingState}
                segments={assignment.segments}
                selectedPointId={selectedPointId || undefined}
              />
            </Suspense>
          </FieldMapErrorBoundary>
        </main>
      ) : (
        <main className="simple-field-list">
          <label>
            Buscar vivienda
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Calle, número o identificador"
            />
          </label>
          <ul>
            {filteredPoints.map((point) => {
              const state = POINT_STATE_OPTIONS.find((option) => option.state === point.state);
              return (
                <li key={point.id}>
                  <button onClick={() => selectPoint(point.id)} type="button">
                    <span>
                      <strong>{pointAddress(point)}</strong>
                      <small>{point.externalId}</small>
                    </span>
                    <span data-state={point.state}>{state?.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </main>
      )}

      {view === "list" && selectedPoint ? (
        <PointStatePanel
          className="simple-point-sheet"
          feedback={pointFeedback?.pointId === selectedPoint.id ? pointFeedback : null}
          online={online}
          onClose={clearSelectedPoint}
          onSetState={(point, state) => void setPointState(point, state)}
          point={selectedPoint}
          savingState={savingPointId === selectedPoint.id ? savingState : null}
        />
      ) : null}
    </div>
  );
}
