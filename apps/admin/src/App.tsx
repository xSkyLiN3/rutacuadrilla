import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "./api/client";
import type { AdminApi, LoginResponse, Membership, MeResponse, User } from "./api/types";
import { type AdminPageName, AppShell } from "./components/AppShell";
import { CrewChooser } from "./components/CrewChooser";
import { CampaignsView } from "./components/CampaignsView";
import { ImportRouteView } from "./components/ImportRouteView";
import { LoginView } from "./components/LoginView";
import { RouteDetailView } from "./components/RouteDetailView";
import { RoutesView } from "./components/RoutesView";
import { ErrorState, LoadingState } from "./components/Shared";
import { RoutePackageStore } from "./local/routePackage";

const TOKEN_STORAGE_KEY = "rutacuadrilla.admin.token";

interface AuthenticatedState {
  user: User;
  memberships: Membership[];
}

interface AppProps {
  api: AdminApi;
  demoMode?: boolean;
}

export default function App({ api, demoMode = false }: AppProps) {
  const [authStatus, setAuthStatus] = useState<"checking" | "guest" | "authenticated" | "error">(
    "checking",
  );
  const [auth, setAuth] = useState<AuthenticatedState | null>(null);
  const [authNotice, setAuthNotice] = useState("");
  const [authError, setAuthError] = useState("");
  const [selectedMembership, setSelectedMembership] = useState<Membership | null>(null);
  const [page, setPage] = useState<AdminPageName>("routes");
  const [routeId, setRouteId] = useState("");
  const [routesRefreshKey, setRoutesRefreshKey] = useState(0);
  const routePackageStore = useMemo(() => new RoutePackageStore(), []);

  useEffect(() => () => routePackageStore.close(), [routePackageStore]);

  const restoreSession = useCallback(async () => {
    const token = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!token) {
      api.setToken(null);
      setAuthStatus("guest");
      return;
    }

    setAuthStatus("checking");
    setAuthError("");
    api.setToken(token);
    try {
      const response: MeResponse = await api.me();
      setAuth({ user: response.user, memberships: response.memberships });
      setSelectedMembership(response.memberships.length === 1 ? response.memberships[0] : null);
      setAuthStatus("authenticated");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        api.setToken(null);
        setAuthNotice("Tu sesión expiró. Inicia sesión nuevamente.");
        setAuthStatus("guest");
      } else {
        setAuthError(
          caught instanceof Error ? caught.message : "No fue posible validar la sesión.",
        );
        setAuthStatus("error");
      }
    }
  }, [api]);

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  function handleAuthenticated(response: LoginResponse) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, response.token);
    setAuth({ user: response.user, memberships: response.memberships });
    setSelectedMembership(response.memberships.length === 1 ? response.memberships[0] : null);
    setAuthNotice("");
    setAuthStatus("authenticated");
    setPage("routes");
  }

  const handleUnauthorized = useCallback(() => {
    if (auth?.user.id) void routePackageStore.clearAccount(auth.user.id).catch(() => undefined);
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    api.setToken(null);
    setAuth(null);
    setSelectedMembership(null);
    setAuthNotice("Tu sesión expiró o fue revocada.");
    setAuthStatus("guest");
  }, [api, auth?.user.id, routePackageStore]);

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // El cierre local no debe quedar bloqueado por una API no disponible.
    } finally {
      if (auth?.user.id) await routePackageStore.clearAccount(auth.user.id).catch(() => undefined);
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      api.setToken(null);
      setAuth(null);
      setSelectedMembership(null);
      setAuthNotice("Sesión cerrada.");
      setAuthStatus("guest");
    }
  }

  function navigate(nextPage: "routes" | "import" | "campaigns") {
    setPage(nextPage);
    setRouteId("");
  }

  if (authStatus === "checking") {
    return (
      <main id="main-content" className="centered-page">
        <LoadingState label="Validando sesión…" />
      </main>
    );
  }

  if (authStatus === "error") {
    return (
      <main id="main-content" className="centered-page">
        <ErrorState
          title="No pudimos validar la sesión"
          message={authError}
          onRetry={() => void restoreSession()}
          action={
            <button className="button button--quiet" type="button" onClick={handleUnauthorized}>
              Volver al ingreso
            </button>
          }
        />
      </main>
    );
  }

  if (authStatus === "guest" || !auth) {
    return (
      <LoginView
        api={api}
        demoMode={demoMode}
        notice={authNotice}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  if (!selectedMembership) {
    return (
      <CrewChooser
        user={auth.user}
        memberships={auth.memberships}
        demoMode={demoMode}
        onSelect={(membership) => {
          setSelectedMembership(membership);
          setPage("routes");
        }}
        onLogout={() => void handleLogout()}
      />
    );
  }

  return (
    <AppShell
      user={auth.user}
      membership={selectedMembership}
      demoMode={demoMode}
      currentPage={page}
      canChangeCrew={auth.memberships.length > 1}
      onNavigate={navigate}
      onChangeCrew={() => {
        setSelectedMembership(null);
        setPage("routes");
        setRouteId("");
      }}
      onLogout={() => void handleLogout()}
    >
      {page === "routes" ? (
        <RoutesView
          api={api}
          membership={selectedMembership}
          refreshKey={routesRefreshKey}
          onImport={() => navigate("import")}
          onOpenRoute={(selectedRouteId) => {
            setRouteId(selectedRouteId);
            setPage("detail");
          }}
          onUnauthorized={handleUnauthorized}
        />
      ) : null}

      {page === "import" ? (
        <ImportRouteView
          api={api}
          membership={selectedMembership}
          demoMode={demoMode}
          onCancel={() => navigate("routes")}
          onCreated={(createdRouteId) => {
            setRoutesRefreshKey((key) => key + 1);
            setRouteId(createdRouteId);
            setPage("detail");
          }}
          onUnauthorized={handleUnauthorized}
        />
      ) : null}

      {page === "detail" && routeId ? (
        <RouteDetailView
          accountId={auth.user.id}
          api={api}
          membership={selectedMembership}
          routeId={routeId}
          onBack={() => navigate("routes")}
          onRouteChanged={() => setRoutesRefreshKey((key) => key + 1)}
          onUnauthorized={handleUnauthorized}
          routePackageStore={routePackageStore}
        />
      ) : null}

      {page === "campaigns" ? (
        <CampaignsView
          api={api}
          membership={selectedMembership}
          onUnauthorized={handleUnauthorized}
        />
      ) : null}
    </AppShell>
  );
}
