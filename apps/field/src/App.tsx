import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FieldApi, FieldApiError } from "./api";
import { HistoryPanel } from "./HistoryPanel";
import { FieldLocalDatabase } from "./local/database";
import {
  type BoundLocalIdentity,
  calculateLocalIdentityExpiry,
  createBoundLocalIdentity,
  type LocalIdentityAuth,
  readBoundLocalIdentity,
} from "./local/identityVault";
import type {
  H40ContextKey,
  H40DeviceAlias,
  H40MetricEventKind,
  H40RunSummary,
} from "./local/protocol";
import { type ConnectionPhase, syncStatusLabel } from "./local/syncStatus";
import { FieldMap } from "./map/FieldMap";
import { PilotEvidencePanel } from "./PilotEvidencePanel";
import { collectPilotDiagnostics, type PilotDiagnosticsReport } from "./pilotDiagnostics";
import {
  createPilotEvidenceExportFromSource,
  generatePilotRunSalt,
  hashPilotProjection,
} from "./pilotEvidence";
import { activateFieldServiceWorkerUpdate, FIELD_UPDATE_AVAILABLE_EVENT } from "./serviceWorker";
import type {
  ConflictResolutionDecision,
  FieldContextSummary,
  FieldMembership,
  FieldPoint,
  LocalContextSummary,
  LocalOperation,
  LocalWorkSession,
  PointState,
} from "./types";

const TOKEN_KEY = "rutacuadrilla.field.token";
const AUTH_KEY = "rutacuadrilla.field.auth";
const SELECTION_KEY = "rutacuadrilla.field.selection";
const DEVICE_KEY = "rutacuadrilla.field.device";
const FIELD_BUILD_ID = import.meta.env.VITE_FIELD_BUILD_ID?.trim() ?? "";
type AuthState = LocalIdentityAuth;

interface Selection {
  contextId: string;
  crewId: string;
}

function readLocalJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function bindAndCacheIdentity(
  localDatabase: FieldLocalDatabase,
  auth: AuthState,
  serverExpiresAt?: string,
  previousIdentity?: BoundLocalIdentity | null,
): Promise<BoundLocalIdentity> {
  const expiresAt = calculateLocalIdentityExpiry(
    serverExpiresAt,
    previousIdentity ? Date.parse(previousIdentity.expiresAt) : null,
  );
  const identity = await createBoundLocalIdentity(auth, expiresAt);
  await localDatabase.bindAccount(auth.user.id, identity.partitionId, identity.subjectBinding);
  localStorage.setItem(AUTH_KEY, identity.serialized);
  return identity;
}

function deviceId(): string {
  const previous = localStorage.getItem(DEVICE_KEY);
  if (previous) return previous;
  const created = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

function measureNextPaint(startedAt: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("H40_VISUAL_MEASUREMENT_TIMEOUT")),
      5_000,
    );
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clearTimeout(timeout);
        resolve(performance.now() - startedAt);
      });
    });
  });
}

function safePilotMetricError(error: unknown): string {
  if (error instanceof FieldApiError) {
    return error.status === 0 ? "NETWORK_UNAVAILABLE" : `HTTP_${error.status}`;
  }
  return "SYNC_FAILED";
}

function pilotFinishBlockLabel(blocking: {
  code: string;
  current: number;
  required: number;
}): string {
  if (blocking.code === "LESS_THAN_30_ACTIONS") {
    return `${blocking.current}/${blocking.required} acciones mínimas`;
  }
  if (blocking.code === "INCOMPLETE_ACTION_METRICS") {
    return `${blocking.current}/${blocking.required} acciones con medición completa`;
  }
  if (blocking.code === "OUTBOX_NOT_EMPTY") {
    return `${blocking.current} operación(es) pendientes de sincronizar`;
  }
  if (blocking.code === "ATTENTION_REQUIRED") {
    return `${blocking.current} conflicto(s) o rechazo(s) por resolver`;
  }
  return blocking.code;
}

export function App() {
  const api = useMemo(() => new FieldApi(), []);
  const localDatabase = useMemo(() => new FieldLocalDatabase(), []);
  const localDeviceId = useMemo(() => deviceId(), []);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [accountPartitionId, setAccountPartitionId] = useState("");
  const [identityExpiresAt, setIdentityExpiresAt] = useState("");
  const [serverAuthenticated, setServerAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState("admin@demo.rutacuadrilla.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedCrew, setSelectedCrew] = useState<FieldMembership | null>(null);
  const [contexts, setContexts] = useState<FieldContextSummary[]>([]);
  const [localContext, setLocalContext] = useState<LocalContextSummary | null>(null);
  const [points, setPoints] = useState<FieldPoint[]>([]);
  const [history, setHistory] = useState<LocalOperation[]>([]);
  const [selectedPointId, setSelectedPointId] = useState("");
  const [phase, setPhase] = useState<ConnectionPhase>(navigator.onLine ? "online" : "offline");
  const [databasePersistent, setDatabasePersistent] = useState(false);
  const [databaseSchemaVersion, setDatabaseSchemaVersion] = useState(0);
  const [databaseReady, setDatabaseReady] = useState(false);
  const [databaseError, setDatabaseError] = useState("");
  const [actionLatency, setActionLatency] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<ServiceWorkerRegistration | null>(null);
  const [conflictReasons, setConflictReasons] = useState<Record<string, string>>({});
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [outboxStatus, setOutboxStatus] = useState({ legacyBlocked: 0, unresolved: 0 });
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [pilotDiagnostics, setPilotDiagnostics] = useState<PilotDiagnosticsReport | null>(null);
  const [pilotRun, setPilotRun] = useState<H40RunSummary | null>(null);
  const [pilotLifecycleReady, setPilotLifecycleReady] = useState(false);
  const [pilotBootReady, setPilotBootReady] = useState(false);
  const [pilotMessage, setPilotMessage] = useState("");
  const syncingRef = useRef(false);
  const mutatingRef = useRef(false);
  const identityScopeRef = useRef({ epoch: 0, partitionId: "" });
  const reloadSequenceRef = useRef(0);
  const selectionEpochRef = useRef(0);
  const pilotBootRecordedRef = useRef(new Set<string>());
  const workSessionOperationIdsRef = useRef({ finish: "", join: "", start: "" });

  const setIdentityPartition = useCallback((partitionId: string) => {
    identityScopeRef.current = {
      epoch: identityScopeRef.current.epoch + 1,
      partitionId,
    };
    reloadSequenceRef.current += 1;
    selectionEpochRef.current += 1;
    setAccountPartitionId(partitionId);
  }, []);

  const selectedPoint = points.find((point) => point.id === selectedPointId);
  const workSession = localContext?.workSession;
  const deviceJoined = Boolean(
    workSession?.devices.some(
      (device) =>
        device.deviceId === localDeviceId && device.membershipId === selectedCrew?.membershipId,
    ),
  );
  const canUseWorkSession = Boolean(workSession?.status === "ACTIVE" && deviceJoined);
  const canOperate = Boolean(canUseWorkSession && outboxStatus.legacyBlocked === 0);
  const pilotInteractionReady =
    pilotLifecycleReady && (pilotRun === null || (pilotRun.status === "RUNNING" && pilotBootReady));
  const canCreateFieldAction = Boolean(canOperate && pilotInteractionReady);

  const pilotContext = useMemo<H40ContextKey | null>(() => {
    if (!accountPartitionId || !selectedCrew || !localContext || !workSession) return null;
    return {
      accountId: accountPartitionId,
      crewId: selectedCrew.crewId,
      sessionId: localContext.sessionId,
      workSessionId: workSession.id,
    };
  }, [accountPartitionId, localContext, selectedCrew, workSession]);

  const reloadLocal = useCallback(
    async (selection: Selection) => {
      const identityScope = identityScopeRef.current;
      if (!auth || !accountPartitionId || identityScope.partitionId !== accountPartitionId) {
        return;
      }
      const requestSequence = reloadSequenceRef.current + 1;
      const selectionEpoch = selectionEpochRef.current;
      reloadSequenceRef.current = requestSequence;
      const [context, nextPoints, nextHistory, nextOutboxStatus] = await Promise.all([
        localDatabase.getContext(identityScope.partitionId, selection.crewId, selection.contextId),
        localDatabase.listPoints(identityScope.partitionId, selection.crewId, selection.contextId),
        localDatabase.listHistory(identityScope.partitionId, selection.crewId, selection.contextId),
        localDatabase.getOutboxStatus(
          identityScope.partitionId,
          selection.crewId,
          selection.contextId,
        ),
      ]);
      if (
        requestSequence !== reloadSequenceRef.current ||
        selectionEpoch !== selectionEpochRef.current ||
        identityScope.epoch !== identityScopeRef.current.epoch ||
        identityScope.partitionId !== identityScopeRef.current.partitionId
      ) {
        return;
      }
      setLocalContext(context);
      setPoints(nextPoints);
      setHistory(nextHistory);
      setOutboxStatus(nextOutboxStatus);
      setSelectedPointId((current) =>
        nextPoints.some((point) => point.id === current) ? current : (nextPoints[0]?.id ?? ""),
      );
      return {
        context,
        history: nextHistory,
        outboxStatus: nextOutboxStatus,
        points: nextPoints,
      };
    },
    [accountPartitionId, auth, localDatabase],
  );

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        const info = await localDatabase.init();
        if (cancelled) return;
        setDatabasePersistent(info.persistent);
        setDatabaseSchemaVersion(info.schemaVersion);
        if (info.recovery.requeuedSending > 0) {
          setRecoveryNotice(
            `${info.recovery.requeuedSending} operación(es) interrumpida(s) volvieron a Pendiente sin duplicarse.`,
          );
        }
        setDatabaseReady(true);
      } catch (caught) {
        if (!cancelled) {
          setDatabaseError(
            caught instanceof Error
              ? caught.message
              : "No fue posible abrir el almacenamiento local.",
          );
          setDatabaseReady(true);
          setAuthLoading(false);
        }
        return;
      }

      const cachedRaw = localStorage.getItem(AUTH_KEY);
      let cachedIdentity: BoundLocalIdentity | null;
      try {
        cachedIdentity = await readBoundLocalIdentity(cachedRaw);
      } catch (caught) {
        if (!cancelled) {
          setDatabaseError(
            caught instanceof Error ? caught.message : "LOCAL_IDENTITY_VAULT_UNAVAILABLE",
          );
          setAuthLoading(false);
        }
        return;
      }
      if (cancelled) return;
      const legacyCacheDetected = Boolean(cachedRaw && !cachedIdentity);
      if (legacyCacheDetected) localStorage.removeItem(AUTH_KEY);
      const token = sessionStorage.getItem(TOKEN_KEY);
      if (!token) {
        if (cachedIdentity) {
          setAuth(cachedIdentity.auth);
          setIdentityPartition(cachedIdentity.partitionId);
          setIdentityExpiresAt(cachedIdentity.expiresAt);
          setPhase(navigator.onLine ? "attention" : "offline");
          setNotice(
            navigator.onLine
              ? "La sesión local sigue activa; vuelve a ingresar antes de sincronizar."
              : "Sesión local vinculada recuperada: puedes registrar cambios en este dispositivo.",
          );
        } else if (legacyCacheDetected) {
          setError(
            "La identidad local anterior necesita una reautenticación online para vincular su partición sin perder la outbox.",
          );
        }
        setAuthLoading(false);
        return;
      }

      api.setToken(token);
      try {
        const response = await api.me();
        const nextAuth = { user: response.user, memberships: response.memberships };
        const identity = await bindAndCacheIdentity(
          localDatabase,
          nextAuth,
          undefined,
          cachedIdentity,
        );
        if (cancelled) return;
        setAuth(nextAuth);
        setIdentityPartition(identity.partitionId);
        setIdentityExpiresAt(identity.expiresAt);
        setServerAuthenticated(true);
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof FieldApiError && caught.status === 0 && cachedIdentity) {
          setAuth(cachedIdentity.auth);
          setIdentityPartition(cachedIdentity.partitionId);
          setIdentityExpiresAt(cachedIdentity.expiresAt);
          setPhase("offline");
          setNotice("Sesión local vinculada recuperada; los cambios se guardarán sin red.");
        } else {
          sessionStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(AUTH_KEY);
          api.setToken(null);
          setError(
            caught instanceof Error
              ? caught.message
              : "No fue posible vincular la identidad local.",
          );
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
      localDatabase.close();
    };
  }, [api, localDatabase, setIdentityPartition]);

  const refreshPilotDiagnostics = useCallback(async () => {
    const expiresAt = Date.parse(identityExpiresAt);
    const report = await collectPilotDiagnostics({
      buildId: FIELD_BUILD_ID,
      databasePersistent,
      identityCurrent: Boolean(auth && Number.isFinite(expiresAt) && expiresAt > Date.now()),
      localSchemaVersion: databaseSchemaVersion,
    });
    setPilotDiagnostics(report);
    return report;
  }, [auth, databasePersistent, databaseSchemaVersion, identityExpiresAt]);

  const recordActivePilotEvent = useCallback(
    async (
      eventKind: H40MetricEventKind,
      counts: {
        applied?: number;
        conflict?: number;
        pending?: number;
        rejected?: number;
        replayed?: number;
        errorCode?: string;
      } = {},
      run = pilotRun,
      context = pilotContext,
    ) => {
      if (run?.status !== "RUNNING" || !context) return;
      await localDatabase.recordH40Metric({
        ...context,
        ...counts,
        eventKind,
        monotonicMs: performance.now(),
        runId: run.runId,
        wallAt: new Date().toISOString(),
      });
    },
    [localDatabase, pilotContext, pilotRun],
  );

  useEffect(() => {
    if (!databaseReady) return;
    void refreshPilotDiagnostics().catch(() => {
      setPilotDiagnostics(null);
    });
  }, [databaseReady, refreshPilotDiagnostics]);

  useEffect(() => {
    let cancelled = false;
    setPilotLifecycleReady(false);
    setPilotBootReady(false);
    if (!databaseReady) {
      setPilotRun(null);
      return;
    }
    if (!pilotContext) {
      setPilotRun(null);
      setPilotLifecycleReady(true);
      return;
    }
    void localDatabase
      .getLatestH40Run(pilotContext)
      .then(async (run) => {
        if (cancelled) return;
        setPilotRun(run);
        if (run?.status !== "RUNNING") {
          setPilotLifecycleReady(true);
          return;
        }
        if (pilotBootRecordedRef.current.has(run.runId)) {
          setPilotBootReady(true);
          setPilotLifecycleReady(true);
          return;
        }
        const record = (eventKind: H40MetricEventKind) =>
          localDatabase.recordH40Metric({
            ...pilotContext,
            eventKind,
            monotonicMs: performance.now(),
            runId: run.runId,
            wallAt: new Date().toISOString(),
          });
        try {
          await record("BOOT");
          if (!navigator.onLine) await record("OFFLINE_START");
          if (cancelled) return;
          pilotBootRecordedRef.current.add(run.runId);
          setPilotBootReady(true);
          setPilotLifecycleReady(true);
        } catch (caught) {
          if (!cancelled) {
            setPilotLifecycleReady(true);
            setPilotMessage(
              caught instanceof Error
                ? caught.message
                : "No fue posible registrar el arranque de la medición H40.",
            );
          }
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setPilotMessage(
            caught instanceof Error ? caught.message : "No fue posible recuperar la medición H40.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [databaseReady, localDatabase, pilotContext]);

  useEffect(() => {
    const online = () => {
      setPhase(serverAuthenticated ? "online" : "attention");
      if (!pilotBootReady) return;
      void recordActivePilotEvent("OFFLINE_END").catch(() => {
        setPilotMessage("No fue posible cerrar el intervalo offline de la evidencia H40.");
      });
    };
    const offline = () => {
      setPhase("offline");
      if (!pilotBootReady) return;
      void recordActivePilotEvent("OFFLINE_START").catch(() => {
        setPilotMessage("No fue posible abrir el intervalo offline de la evidencia H40.");
      });
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [pilotBootReady, recordActivePilotEvent, serverAuthenticated]);

  useEffect(() => {
    const updateAvailable = (event: Event) => {
      const detail = (event as CustomEvent<{ registration?: ServiceWorkerRegistration }>).detail;
      if (detail.registration) setAvailableUpdate(detail.registration);
    };
    window.addEventListener(FIELD_UPDATE_AVAILABLE_EVENT, updateAvailable);
    const updateApplied = () => setAvailableUpdate(null);
    navigator.serviceWorker?.addEventListener("controllerchange", updateApplied);
    return () => {
      window.removeEventListener(FIELD_UPDATE_AVAILABLE_EVENT, updateAvailable);
      navigator.serviceWorker?.removeEventListener("controllerchange", updateApplied);
    };
  }, []);

  useEffect(() => {
    if (!auth || !identityExpiresAt) return;
    const lockIfExpired = () => {
      const expiresAt = Date.parse(identityExpiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return;
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(AUTH_KEY);
      api.setToken(null);
      setServerAuthenticated(false);
      setAuth(null);
      setIdentityPartition("");
      setIdentityExpiresAt("");
      setSelectedCrew(null);
      setLocalContext(null);
      setPilotRun(null);
      setPilotDiagnostics(null);
      setPilotMessage("");
      setPoints([]);
      setHistory([]);
      setSelectedPointId("");
      setContexts([]);
      setError("La sesión local expiró. Vuelve a ingresar; los cambios guardados se conservan.");
    };
    const expiresAt = Date.parse(identityExpiresAt);
    const timer = window.setTimeout(
      lockIfExpired,
      Math.max(0, (Number.isFinite(expiresAt) ? expiresAt : 0) - Date.now()),
    );
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") lockIfExpired();
    };
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [api, auth, identityExpiresAt, setIdentityPartition]);

  function applyAvailableUpdate(): void {
    if (!availableUpdate || busy || mutatingRef.current || syncingRef.current) return;
    if (!pilotLifecycleReady) {
      setError("Espera a que Campo compruebe si existe una medición H40 pendiente.");
      return;
    }
    if (pilotRun) {
      setError("Exporta o descarta la medición H40 antes de actualizar la aplicación.");
      return;
    }
    if (outboxStatus.unresolved > 0) {
      setError(
        "Sincroniza o recupera todas las operaciones locales antes de actualizar la aplicación.",
      );
      return;
    }
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), {
      once: true,
    });
    if (!activateFieldServiceWorkerUpdate(availableUpdate)) {
      setAvailableUpdate(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const identityScope = identityScopeRef.current;
    const selectionEpoch = selectionEpochRef.current;
    const isCurrent = () =>
      !cancelled &&
      identityScope.partitionId.length > 0 &&
      identityScope.partitionId === identityScopeRef.current.partitionId &&
      identityScope.epoch === identityScopeRef.current.epoch &&
      selectionEpoch === selectionEpochRef.current;
    if (!auth || identityScope.partitionId !== accountPartitionId) return;
    const saved = readLocalJson<Selection>(SELECTION_KEY);
    const membership =
      auth.memberships.find((candidate) => candidate.crewId === saved?.crewId) ??
      (auth.memberships.length === 1 ? auth.memberships[0] : null);
    if (membership && isCurrent()) setSelectedCrew(membership);
    if (saved && auth.memberships.some((candidate) => candidate.crewId === saved.crewId)) {
      void reloadLocal(saved)
        .then(async (snapshot) => {
          if (
            !snapshot ||
            !membership ||
            !serverAuthenticated ||
            !navigator.onLine ||
            !isCurrent()
          ) {
            return;
          }
          const activeSession = await api.getCurrentWorkSession(membership.crewId, saved.contextId);
          if (!isCurrent()) return;
          const session =
            activeSession ??
            (snapshot.context.workSession
              ? await api.getWorkSession(membership.crewId, snapshot.context.workSession.id)
              : null);
          if (!session || !isCurrent()) return;
          const result = await localDatabase.saveWorkSession({
            accountId: identityScope.partitionId,
            campaignRouteId: saved.contextId,
            crewId: membership.crewId,
            deviceId: localDeviceId,
            membershipId: membership.membershipId,
            session,
          });
          if (!isCurrent()) return;
          await reloadLocal(saved);
          if (result.legacyBlocked > 0 && isCurrent()) {
            setNotice(
              `${result.legacyBlocked} operación(es) heredada(s) se conservaron bloqueadas: no son atribuibles a esta jornada.`,
            );
          }
        })
        .catch((caught: unknown) => {
          if (isCurrent() && serverAuthenticated && navigator.onLine) {
            setError(
              caught instanceof Error ? caught.message : "No fue posible actualizar la jornada.",
            );
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    accountPartitionId,
    api,
    auth,
    localDatabase,
    localDeviceId,
    reloadLocal,
    serverAuthenticated,
  ]);

  useEffect(() => {
    if (!selectedCrew || phase === "offline" || !serverAuthenticated) return;
    let cancelled = false;
    const identityScope = identityScopeRef.current;
    const crewId = selectedCrew.crewId;
    const isCurrent = () =>
      !cancelled &&
      identityScope.partitionId.length > 0 &&
      identityScope.partitionId === identityScopeRef.current.partitionId &&
      identityScope.epoch === identityScopeRef.current.epoch;
    void api
      .listContexts(crewId)
      .then((nextContexts) => {
        if (isCurrent()) setContexts(nextContexts);
      })
      .catch((caught: unknown) => {
        if (isCurrent()) {
          setError(caught instanceof Error ? caught.message : "No fue posible cargar contextos.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, phase, selectedCrew, serverAuthenticated]);

  async function login(event: FormEvent) {
    event.preventDefault();
    const submittedPassword = password;
    setPassword("");
    setBusy(true);
    setError("");
    try {
      const response = await api.login(email, submittedPassword);
      api.setToken(response.token);
      const nextAuth = { user: response.user, memberships: response.memberships };
      const identity = await bindAndCacheIdentity(localDatabase, nextAuth, response.expiresAt);
      sessionStorage.setItem(TOKEN_KEY, response.token);
      setAuth(nextAuth);
      setIdentityPartition(identity.partitionId);
      setIdentityExpiresAt(identity.expiresAt);
      setServerAuthenticated(true);
      setPhase(navigator.onLine ? "online" : "offline");
      setSelectedCrew(response.memberships.length === 1 ? response.memberships[0] : null);
    } catch (caught) {
      api.setToken(null);
      sessionStorage.removeItem(TOKEN_KEY);
      setError(caught instanceof Error ? caught.message : "No fue posible iniciar sesión.");
    } finally {
      setBusy(false);
      setAuthLoading(false);
    }
  }

  async function persistWorkSession(session: LocalWorkSession, campaignRouteId: string) {
    if (!accountPartitionId || !selectedCrew) return;
    const result = await localDatabase.saveWorkSession({
      accountId: accountPartitionId,
      campaignRouteId,
      crewId: selectedCrew.crewId,
      deviceId: localDeviceId,
      membershipId: selectedCrew.membershipId,
      session,
    });
    await reloadLocal({ contextId: campaignRouteId, crewId: selectedCrew.crewId });
    if (result.legacyBlocked > 0) {
      setNotice(
        `${result.legacyBlocked} operación(es) heredada(s) se conservaron bloqueadas: no son atribuibles a esta jornada y no se enviarán.`,
      );
    }
  }

  async function refreshWorkSession(campaignRouteId: string, knownWorkSessionId?: string) {
    if (!selectedCrew || !serverAuthenticated || !navigator.onLine) return;
    const activeSession = await api.getCurrentWorkSession(selectedCrew.crewId, campaignRouteId);
    const session =
      activeSession ??
      (knownWorkSessionId
        ? await api.getWorkSession(selectedCrew.crewId, knownWorkSessionId)
        : null);
    if (session) await persistWorkSession(session, campaignRouteId);
  }

  async function refreshSelectedWorkSession() {
    if (!localContext || busy || !serverAuthenticated || !navigator.onLine) return;
    setBusy(true);
    setError("");
    try {
      await refreshWorkSession(localContext.campaignRouteId, localContext.workSession?.id);
      setNotice("Estado de jornada actualizado desde el servidor.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible actualizar la jornada.");
    } finally {
      setBusy(false);
    }
  }

  async function startWorkSession() {
    if (!localContext || !selectedCrew || !serverAuthenticated || !navigator.onLine || busy) return;
    if (!pilotLifecycleReady || pilotRun) {
      setError(
        pilotRun
          ? "Exporta o descarta la medición H40 antes de iniciar otra jornada."
          : "Espera a que Campo compruebe si existe una medición H40 pendiente.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    if (!workSessionOperationIdsRef.current.start) {
      workSessionOperationIdsRef.current.start = crypto.randomUUID();
    }
    const operationId = workSessionOperationIdsRef.current.start;
    try {
      const result = await api.startWorkSession(selectedCrew.crewId, localContext.campaignRouteId, {
        deviceId: localDeviceId,
        operationId,
      });
      const canonical = await api.getCurrentWorkSession(
        selectedCrew.crewId,
        localContext.campaignRouteId,
      );
      if (
        !canonical?.devices.some(
          (device) =>
            device.deviceId === localDeviceId && device.membershipId === selectedCrew.membershipId,
        )
      ) {
        throw new Error("El servidor no confirmó el inicio y vínculo de esta jornada.");
      }
      await persistWorkSession(canonical, localContext.campaignRouteId);
      workSessionOperationIdsRef.current.start = "";
      setNotice(
        result.replayed
          ? "La jornada ya había sido iniciada; se recuperó su resultado."
          : "Jornada iniciada y dispositivo vinculado.",
      );
    } catch (caught) {
      let recovered = false;
      if (caught instanceof FieldApiError && (caught.status === 0 || caught.status === 409)) {
        try {
          const current = await api.getCurrentWorkSession(
            selectedCrew.crewId,
            localContext.campaignRouteId,
          );
          if (
            current?.devices.some(
              (device) =>
                device.deviceId === localDeviceId &&
                device.membershipId === selectedCrew.membershipId,
            )
          ) {
            await persistWorkSession(current, localContext.campaignRouteId);
            workSessionOperationIdsRef.current.start = "";
            setNotice("Se recuperó del servidor la jornada iniciada tras perderse la respuesta.");
            recovered = true;
          }
        } catch {
          // Se conserva operationId para un reintento idempotente posterior.
        }
      }
      if (!recovered) {
        setError(caught instanceof Error ? caught.message : "No fue posible iniciar la jornada.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function joinWorkSession() {
    if (
      !localContext ||
      !selectedCrew ||
      !workSession ||
      !serverAuthenticated ||
      !navigator.onLine ||
      busy
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    if (!workSessionOperationIdsRef.current.join) {
      workSessionOperationIdsRef.current.join = crypto.randomUUID();
    }
    const operationId = workSessionOperationIdsRef.current.join;
    try {
      const result = await api.joinWorkSession(selectedCrew.crewId, workSession.id, {
        deviceId: localDeviceId,
        operationId,
      });
      const canonical = await api.getWorkSession(selectedCrew.crewId, result.workSession.id);
      if (
        !canonical.devices.some(
          (device) =>
            device.deviceId === localDeviceId && device.membershipId === selectedCrew.membershipId,
        )
      ) {
        throw new Error("El servidor no confirmó el vínculo de este dispositivo.");
      }
      await persistWorkSession(canonical, localContext.campaignRouteId);
      workSessionOperationIdsRef.current.join = "";
      setNotice(
        result.replayed
          ? "La unión ya estaba registrada; se recuperó su resultado."
          : "Este dispositivo quedó unido a la jornada.",
      );
    } catch (caught) {
      let recovered = false;
      if (caught instanceof FieldApiError && (caught.status === 0 || caught.status === 409)) {
        try {
          const current = await api.getWorkSession(selectedCrew.crewId, workSession.id);
          if (
            current.devices.some(
              (device) =>
                device.deviceId === localDeviceId &&
                device.membershipId === selectedCrew.membershipId,
            )
          ) {
            await persistWorkSession(current, localContext.campaignRouteId);
            workSessionOperationIdsRef.current.join = "";
            setNotice("Se recuperó la unión del dispositivo tras perderse la respuesta.");
            recovered = true;
          }
        } catch {
          // Se conserva operationId para un reintento idempotente posterior.
        }
      }
      if (!recovered) {
        setError(caught instanceof Error ? caught.message : "No fue posible unirse a la jornada.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function finishWorkSession() {
    if (!localContext || !selectedCrew || !workSession || !canOperate || busy) return;
    if (!pilotLifecycleReady || pilotRun) {
      setError(
        pilotRun
          ? "Finaliza y exporta, o descarta, la medición H40 antes de cerrar la jornada."
          : "Espera a que Campo compruebe si existe una medición H40 pendiente.",
      );
      return;
    }
    if (!serverAuthenticated || !navigator.onLine) {
      setError("Conéctate y vuelve a ingresar antes de finalizar la jornada.");
      return;
    }
    if (mutatingRef.current || syncingRef.current) return;
    setBusy(true);
    setError("");
    setNotice("");
    if (!workSessionOperationIdsRef.current.finish) {
      workSessionOperationIdsRef.current.finish = crypto.randomUUID();
    }
    const operationId = workSessionOperationIdsRef.current.finish;
    try {
      const status = await localDatabase.getOutboxStatus(
        accountPartitionId,
        selectedCrew.crewId,
        localContext.sessionId,
      );
      setOutboxStatus(status);
      if (status.unresolved > 0) {
        throw new Error(
          status.legacyBlocked > 0
            ? "No se puede finalizar: hay operaciones heredadas conservadas y no atribuibles a esta jornada."
            : "No se puede finalizar: sincroniza y resuelve toda la outbox de este dispositivo.",
        );
      }
      const result = await api.finishWorkSession(selectedCrew.crewId, workSession.id, {
        expectedVersion: workSession.version,
        operationId,
      });
      const canonical = await api.getWorkSession(selectedCrew.crewId, result.workSession.id);
      if (canonical.status !== "FINISHED") {
        throw new Error("El servidor no confirmó la finalización de la jornada.");
      }
      await persistWorkSession(canonical, localContext.campaignRouteId);
      workSessionOperationIdsRef.current.finish = "";
      setConfirmFinish(false);
      setNotice(
        "Jornada finalizada en el servidor. El mapa queda bloqueado; este corte no acredita reconciliación ni cierre.",
      );
    } catch (caught) {
      let recovered = false;
      if (caught instanceof FieldApiError && (caught.status === 0 || caught.status === 409)) {
        try {
          const current = await api.getWorkSession(selectedCrew.crewId, workSession.id);
          if (current.status === "FINISHED") {
            await persistWorkSession(current, localContext.campaignRouteId);
            workSessionOperationIdsRef.current.finish = "";
            setConfirmFinish(false);
            setNotice("Se recuperó la finalización canónica tras perderse la respuesta.");
            recovered = true;
          }
        } catch {
          // Se conserva operationId para un reintento idempotente posterior.
        }
      }
      if (!recovered) {
        setError(caught instanceof Error ? caught.message : "No fue posible finalizar la jornada.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function prepareContext(contextId: string) {
    if (!auth || !accountPartitionId || !selectedCrew) return;
    selectionEpochRef.current += 1;
    reloadSequenceRef.current += 1;
    setBusy(true);
    setError("");
    try {
      const fieldPackage = await api.downloadContext(selectedCrew.crewId, contextId);
      await localDatabase.installPackage(accountPartitionId, fieldPackage);
      const selection = { crewId: selectedCrew.crewId, contextId };
      localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
      const snapshot = await reloadLocal(selection);
      await refreshWorkSession(contextId, snapshot?.context.workSession?.id);
      setNotice(
        databasePersistent
          ? "Contexto verificado y guardado en SQLite/OPFS."
          : "Contexto cargado en SQLite temporal; OPFS no está disponible en este navegador.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible preparar el contexto.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseAnotherContext() {
    if (!selectedCrew || busy || mutatingRef.current || syncingRef.current) return;
    if (!pilotLifecycleReady || pilotRun) {
      setError(
        pilotRun
          ? "Exporta o descarta la medición H40 antes de cambiar de contexto."
          : "Espera a que Campo compruebe si existe una medición H40 pendiente.",
      );
      return;
    }
    selectionEpochRef.current += 1;
    reloadSequenceRef.current += 1;
    localStorage.removeItem(SELECTION_KEY);
    setLocalContext(null);
    setPilotMessage("");
    setPoints([]);
    setHistory([]);
    setSelectedPointId("");
    setActionLatency(null);
    setOutboxStatus({ legacyBlocked: 0, unresolved: 0 });
    setConfirmFinish(false);
    workSessionOperationIdsRef.current = { finish: "", join: "", start: "" };
    if (!serverAuthenticated || !navigator.onLine) return;
    setBusy(true);
    try {
      setContexts(await api.listContexts(selectedCrew.crewId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible cargar contextos.");
    } finally {
      setBusy(false);
    }
  }

  async function startPilotRun(deviceAlias: H40DeviceAlias) {
    if (
      !pilotContext ||
      !selectedCrew ||
      !canOperate ||
      !pilotLifecycleReady ||
      pilotRun ||
      !serverAuthenticated ||
      !navigator.onLine
    ) {
      setPilotMessage("Conéctate, autentícate y únete a una jornada activa antes de medir.");
      return;
    }
    setBusy(true);
    setPilotMessage("");
    try {
      const diagnostics = await refreshPilotDiagnostics();
      if (diagnostics.status !== "READY") {
        setPilotMessage(
          `La prueba no puede comenzar: ${diagnostics.blockedCodes.join(", ") || "diagnóstico incompleto"}.`,
        );
        return;
      }
      if (!serverAuthenticated || !navigator.onLine || !canOperate) {
        setPilotMessage(
          "La conexión o la jornada cambió durante el diagnóstico. Repite la preparación antes de medir.",
        );
        return;
      }
      const salt = generatePilotRunSalt((bytes) => {
        crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
      });
      const run = await localDatabase.startH40Run({
        ...pilotContext,
        buildId: FIELD_BUILD_ID,
        deviceAlias,
        deviceId: localDeviceId,
        membershipId: selectedCrew.membershipId,
        salt,
      });
      setConfirmFinish(false);
      setPilotRun(run);
      setPilotBootReady(false);
      try {
        await recordActivePilotEvent("BOOT", {}, run, pilotContext);
        if (!navigator.onLine) {
          await recordActivePilotEvent("OFFLINE_START", {}, run, pilotContext);
        }
        pilotBootRecordedRef.current.add(run.runId);
        setPilotBootReady(true);
      } catch (caught) {
        try {
          await localDatabase.abortH40Run({ ...pilotContext, runId: run.runId });
          setPilotRun(null);
        } catch {
          // La corrida permanece visible y bloqueada para que pueda descartarse tras recargar.
        }
        setPilotMessage(
          caught instanceof Error
            ? `No se inició la medición: ${caught.message}`
            : "No se inició la medición; vuelve a intentarlo antes de registrar acciones.",
        );
        return;
      }
      setPilotMessage(
        `Medición iniciada como teléfono ${deviceAlias}. Registra al menos 30 acciones.`,
      );
    } catch (caught) {
      setPilotMessage(
        caught instanceof Error ? caught.message : "No fue posible iniciar la medición H40.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function abortPilotRun() {
    if (!pilotContext || !pilotRun || pilotRun.status !== "RUNNING" || busy) return;
    if (
      !window.confirm(
        "Se descartará esta medición, pero las operaciones y la outbox se conservarán. ¿Continuar?",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await localDatabase.abortH40Run({ ...pilotContext, runId: pilotRun.runId });
      setPilotRun(null);
      setPilotBootReady(false);
      setPilotMessage("Medición descartada. Ninguna operación de terreno fue borrada.");
    } catch (caught) {
      setPilotMessage(
        caught instanceof Error ? caught.message : "No fue posible descartar la medición.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function finishPilotRun() {
    if (!pilotContext || !pilotRun || pilotRun.status !== "RUNNING" || !pilotBootReady || busy) {
      return;
    }
    setBusy(true);
    setPilotMessage("");
    try {
      const result = await localDatabase.finishH40Run({
        ...pilotContext,
        runId: pilotRun.runId,
      });
      setPilotRun(result.summary);
      if (!result.finished) {
        const labels = result.blocking.map(pilotFinishBlockLabel);
        setPilotMessage(`La evidencia aún no puede cerrarse: ${labels.join(", ")}.`);
        return;
      }
      setPilotMessage("Medición cerrada e inmutable. Ya puedes exportar la evidencia segura.");
    } catch (caught) {
      setPilotMessage(
        caught instanceof Error ? caught.message : "No fue posible finalizar la medición.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function exportPilotRun() {
    if (!pilotContext || !pilotRun || pilotRun.status !== "FINISHED" || busy) return;
    setBusy(true);
    setPilotMessage("");
    try {
      const diagnostics = await refreshPilotDiagnostics();
      if (!diagnostics.shellVersion) throw new Error("H40_SHELL_VERSION_UNAVAILABLE");
      const source = await localDatabase.getH40EvidenceSource({
        ...pilotContext,
        runId: pilotRun.runId,
      });
      if (
        diagnostics.status !== "READY" ||
        diagnostics.buildId !== source.summary.buildId ||
        diagnostics.shellVersion !== source.summary.buildId
      ) {
        throw new Error("H40_RUN_BUILD_OR_SHELL_MISMATCH");
      }
      const { projection, ...evidenceSource } = source;
      const projectionHash = await hashPilotProjection(source.salt, projection);
      const evidence = await createPilotEvidenceExportFromSource({
        appVersion: source.summary.buildId,
        counts: {
          conflicts: source.finalOutbox.conflict,
          duplicateOperations: null,
          lostOperations: null,
          pendingOperations: source.finalOutbox.pending + source.finalOutbox.sending,
        },
        environment: {
          crossOriginIsolated: diagnostics.crossOriginIsolated,
          online: diagnostics.online,
          opfsPersistent: diagnostics.databasePersistent && diagnostics.opfsSupported,
          secureContext: diagnostics.isSecureContext,
          serviceWorkerControlled: diagnostics.serviceWorkerControlled,
        },
        evidence: { ...evidenceSource, projectionHash },
        schemaVersion: databaseSchemaVersion,
        shellVersion: diagnostics.shellVersion,
      });
      const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
      const url = URL.createObjectURL(
        new Blob([serialized], { type: "application/json;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `rutacuadrilla-h40-${pilotRun.deviceAlias}-${pilotRun.startedAt.slice(0, 10)}.json`;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
      URL.revokeObjectURL(url);
      anchor.remove();
      const saved = window.confirm(
        "Confirma únicamente si el archivo JSON quedó guardado en el teléfono. Si cancelas, podrás descargarlo de nuevo.",
      );
      if (saved) {
        await localDatabase.markH40RunExported({ ...pilotContext, runId: pilotRun.runId });
        setPilotRun(null);
        setPilotMessage(
          `Evidencia guardada (${evidence.integrity.canonicalContentHash.slice(0, 12)}…). Pérdidas y duplicados siguen sin verificar hasta contrastar el servidor.`,
        );
      } else {
        setPilotMessage(
          "La descarga se inició, pero la evidencia sigue pendiente hasta que confirmes que el archivo quedó guardado.",
        );
      }
    } catch (caught) {
      setPilotMessage(
        caught instanceof Error ? caught.message : "No fue posible exportar la evidencia H40.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function markPoint(toState: PointState) {
    if (
      !auth ||
      !accountPartitionId ||
      !selectedCrew ||
      !localContext ||
      !selectedPoint ||
      !workSession ||
      !canCreateFieldAction
    ) {
      return;
    }
    if (mutatingRef.current || syncingRef.current) return;
    mutatingRef.current = true;
    setBusy(true);
    const startedAt = performance.now();
    const previousState = selectedPoint.state;
    const pointId = selectedPoint.id;
    const activePilot =
      pilotRun?.status === "RUNNING" && pilotBootReady && pilotContext
        ? { context: pilotContext, run: pilotRun }
        : null;
    setError("");
    setNotice("");
    setPoints((current) =>
      current.map((point) => (point.id === pointId ? { ...point, state: toState } : point)),
    );
    const visualLatency = measureNextPaint(startedAt);
    void visualLatency.catch(() => undefined);
    try {
      const operation = await localDatabase.markPoint({
        accountId: accountPartitionId,
        crewId: selectedCrew.crewId,
        sessionId: localContext.sessionId,
        deviceId: localDeviceId,
        membershipId: selectedCrew.membershipId,
        pointId,
        toState,
        workSessionId: workSession.id,
        ...(activePilot ? { h40RunId: activePilot.run.runId } : {}),
      });
      const persistMs = performance.now() - startedAt;
      setHistory((current) => [operation, ...current]);
      setNotice("Cambio guardado en este dispositivo; pendiente de sincronizar.");
      try {
        const visualMs = await visualLatency;
        setActionLatency(visualMs);
        if (activePilot) {
          const summary = await localDatabase.completeH40Action({
            ...activePilot.context,
            operationId: operation.operationId,
            persistMs,
            runId: activePilot.run.runId,
            visualMs,
          });
          setPilotRun(summary);
        }
      } catch (measurementError) {
        setActionLatency(null);
        if (activePilot) {
          setPilotMessage(
            measurementError instanceof Error
              ? measurementError.message
              : "La operación se guardó, pero su medición H40 quedó incompleta.",
          );
        }
      }
    } catch (caught) {
      void visualLatency.catch(() => undefined);
      setPoints((current) =>
        current.map((point) => (point.id === pointId ? { ...point, state: previousState } : point)),
      );
      setActionLatency(null);
      setError(caught instanceof Error ? caught.message : "No fue posible registrar el estado.");
    } finally {
      mutatingRef.current = false;
      setBusy(false);
    }
  }

  async function undoLast() {
    if (
      !auth ||
      !accountPartitionId ||
      !selectedCrew ||
      !localContext ||
      !workSession ||
      !canCreateFieldAction
    ) {
      return;
    }
    if (mutatingRef.current || syncingRef.current) return;
    const latest = history.find(
      (operation) =>
        operation.workSessionId === workSession.id &&
        ["CONFIRMED", "PENDING"].includes(operation.state),
    );
    if (!latest) return;
    mutatingRef.current = true;
    setBusy(true);
    const startedAt = performance.now();
    const activePilot =
      pilotRun?.status === "RUNNING" && pilotBootReady && pilotContext
        ? { context: pilotContext, run: pilotRun }
        : null;
    setNotice("");
    setPoints((current) =>
      current.map((point) =>
        point.id === latest.aggregateId ? { ...point, state: latest.previousState } : point,
      ),
    );
    const visualLatency = measureNextPaint(startedAt);
    void visualLatency.catch(() => undefined);
    try {
      const operation = await localDatabase.undoOperation({
        accountId: accountPartitionId,
        crewId: selectedCrew.crewId,
        sessionId: localContext.sessionId,
        deviceId: localDeviceId,
        membershipId: selectedCrew.membershipId,
        operationId: latest.operationId,
        workSessionId: workSession.id,
        ...(activePilot ? { h40RunId: activePilot.run.runId } : {}),
      });
      const persistMs = performance.now() - startedAt;
      setPoints((current) =>
        current.map((point) =>
          point.id === operation.aggregateId ? { ...point, state: operation.toState } : point,
        ),
      );
      setHistory((current) => [operation, ...current]);
      setNotice("Deshacer guardado en este dispositivo; pendiente de sincronizar.");
      try {
        const visualMs = await visualLatency;
        setActionLatency(visualMs);
        if (activePilot) {
          const summary = await localDatabase.completeH40Action({
            ...activePilot.context,
            operationId: operation.operationId,
            persistMs,
            runId: activePilot.run.runId,
            visualMs,
          });
          setPilotRun(summary);
        }
      } catch (measurementError) {
        setActionLatency(null);
        if (activePilot) {
          setPilotMessage(
            measurementError instanceof Error
              ? measurementError.message
              : "Deshacer se guardó, pero su medición H40 quedó incompleta.",
          );
        }
      }
    } catch (caught) {
      void visualLatency.catch(() => undefined);
      await reloadLocal({ crewId: selectedCrew.crewId, contextId: localContext.sessionId }).catch(
        () => undefined,
      );
      setError(caught instanceof Error ? caught.message : "No fue posible deshacer el cambio.");
    } finally {
      mutatingRef.current = false;
      setBusy(false);
    }
  }

  async function resolveConflict(operation: LocalOperation, decision: ConflictResolutionDecision) {
    if (
      !accountPartitionId ||
      !selectedCrew ||
      !localContext ||
      !workSession ||
      !canUseWorkSession ||
      !pilotInteractionReady
    ) {
      return;
    }
    const reason = conflictReasons[operation.operationId]?.trim() ?? "";
    if (!reason) {
      setError("Describe brevemente el motivo de la resolución.");
      return;
    }
    if (mutatingRef.current || syncingRef.current) return;
    mutatingRef.current = true;
    setBusy(true);
    setError("");
    const startedAt = performance.now();
    const activePilot =
      decision === "REAPPLY_LOCAL" &&
      pilotRun?.status === "RUNNING" &&
      pilotBootReady &&
      pilotContext
        ? { context: pilotContext, run: pilotRun }
        : null;
    try {
      const result = await localDatabase.resolveConflict({
        accountId: accountPartitionId,
        crewId: selectedCrew.crewId,
        decision,
        deviceId: localDeviceId,
        membershipId: selectedCrew.membershipId,
        operationId: operation.operationId,
        reason,
        sessionId: localContext.sessionId,
        workSessionId: workSession.id,
        ...(activePilot ? { h40RunId: activePilot.run.runId } : {}),
      });
      const persistMs = performance.now() - startedAt;
      await reloadLocal({ crewId: selectedCrew.crewId, contextId: localContext.sessionId });
      if (activePilot && result.operation) {
        try {
          const visualMs = await measureNextPaint(startedAt);
          const summary = await localDatabase.completeH40Action({
            ...activePilot.context,
            operationId: result.operation.operationId,
            persistMs,
            runId: activePilot.run.runId,
            visualMs,
          });
          setPilotRun(summary);
        } catch (measurementError) {
          setPilotMessage(
            measurementError instanceof Error
              ? measurementError.message
              : "La reaplicación se guardó, pero su medición H40 quedó incompleta.",
          );
        }
      }
      setConflictReasons((current) => {
        const next = { ...current };
        delete next[operation.operationId];
        return next;
      });
      setNotice(
        decision === "ACCEPT_SERVER"
          ? "Resolución guardada: se aceptó el estado confirmado por el servidor."
          : "Resolución guardada: la decisión local quedó pendiente de sincronizar.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible resolver el conflicto.");
    } finally {
      mutatingRef.current = false;
      setBusy(false);
    }
  }

  async function synchronize() {
    if (
      !auth ||
      !accountPartitionId ||
      !selectedCrew ||
      !localContext ||
      !workSession ||
      !canUseWorkSession ||
      !pilotInteractionReady
    ) {
      setError("Inicia o únete a una jornada activa antes de sincronizar.");
      return;
    }
    if (busy) return;
    if (!navigator.onLine) {
      setPhase("offline");
      return;
    }
    if (!serverAuthenticated) {
      setPhase("attention");
      setError(
        "Vuelve a ingresar para autenticar la sincronización; los cambios locales se conservan.",
      );
      return;
    }
    if (syncingRef.current) return;
    syncingRef.current = true;
    setPhase("syncing");
    setBusy(true);
    setError("");
    let localStateChanged = false;
    let sendingOperationIds: string[] = [];
    let syncMetricErrorCode: string | undefined;
    const syncMetricCounts = { applied: 0, conflict: 0, rejected: 0, replayed: 0 };
    const activePilot =
      pilotRun?.status === "RUNNING" && pilotBootReady && pilotContext
        ? { context: pilotContext, run: pilotRun }
        : null;
    if (activePilot) {
      let pendingBefore: number | undefined;
      try {
        pendingBefore = (
          await localDatabase.listPending(
            accountPartitionId,
            selectedCrew.crewId,
            localContext.sessionId,
          )
        ).length;
      } catch {
        syncMetricErrorCode = "LOCAL_PENDING_READ_FAILED";
      }
      await recordActivePilotEvent(
        "SYNC_START",
        {
          ...(pendingBefore === undefined ? {} : { pending: pendingBefore }),
          ...(syncMetricErrorCode ? { errorCode: syncMetricErrorCode } : {}),
        },
        activePilot.run,
        activePilot.context,
      ).catch(() => {
        setPilotMessage("No fue posible registrar el inicio de sincronización H40.");
      });
    }
    try {
      let attentionDetected = false;
      for (let batchNumber = 0; batchNumber < 10_000; batchNumber += 1) {
        const pending = await localDatabase.listPending(
          accountPartitionId,
          selectedCrew.crewId,
          localContext.sessionId,
        );
        if (pending.length === 0) break;
        const batch = pending.slice(0, 100);
        sendingOperationIds = batch.map((operation) => operation.operationId);
        await localDatabase.markSending(
          accountPartitionId,
          selectedCrew.crewId,
          localContext.sessionId,
          sendingOperationIds,
        );
        localStateChanged = true;
        setHistory((current) =>
          current.map((operation) =>
            sendingOperationIds.includes(operation.operationId)
              ? { ...operation, state: "SENDING" }
              : operation,
          ),
        );
        const results = await api.pushCommands(selectedCrew.crewId, batch);
        for (const result of results) {
          if (result.status === "APPLIED") syncMetricCounts.applied += 1;
          else if (result.status === "CONFLICT") syncMetricCounts.conflict += 1;
          else syncMetricCounts.rejected += 1;
          if (result.replayed) syncMetricCounts.replayed += 1;
        }
        await localDatabase.applyResults(
          accountPartitionId,
          selectedCrew.crewId,
          localContext.sessionId,
          results,
        );
        sendingOperationIds = [];
        if (results.some((result) => result.status !== "APPLIED")) {
          attentionDetected = true;
          break;
        }
        if (batchNumber === 9_999) throw new Error("SYNC_PUSH_DID_NOT_CONVERGE");
      }
      let { cursor } = await localDatabase.getCursor(
        accountPartitionId,
        selectedCrew.crewId,
        localContext.sessionId,
      );
      for (let page = 0; page < 10_000; page += 1) {
        const response = await api.pullChanges(selectedCrew.crewId, cursor);
        await localDatabase.applyChanges(
          accountPartitionId,
          selectedCrew.crewId,
          localContext.sessionId,
          response.cursor,
          response.changes,
        );
        localStateChanged = true;
        cursor = response.cursor;
        if (!response.hasMore) break;
        if (page === 9_999) throw new Error("SYNC_PULL_DID_NOT_CONVERGE");
      }
      const snapshot = await reloadLocal({
        crewId: selectedCrew.crewId,
        contextId: localContext.sessionId,
      });
      const attentionCount =
        snapshot?.history.filter((operation) => ["CONFLICT", "REJECTED"].includes(operation.state))
          .length ?? 0;
      setPhase(attentionDetected || attentionCount > 0 ? "attention" : "online");
      setNotice(
        attentionDetected || attentionCount > 0
          ? `Sincronización terminada con ${attentionCount} cambio(s) que requieren atención.`
          : "Cambios confirmados y cursor actualizado.",
      );
    } catch (caught) {
      syncMetricErrorCode = safePilotMetricError(caught);
      if (sendingOperationIds.length > 0) {
        await localDatabase
          .restorePending(
            accountPartitionId,
            selectedCrew.crewId,
            localContext.sessionId,
            sendingOperationIds,
          )
          .catch(() => undefined);
      }
      const authorizationLost =
        caught instanceof FieldApiError && (caught.status === 401 || caught.status === 403);
      if (caught instanceof FieldApiError && caught.status === 0) setPhase("offline");
      else {
        setPhase("attention");
        if (authorizationLost) {
          sessionStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(AUTH_KEY);
          api.setToken(null);
          setServerAuthenticated(false);
          setAuth(null);
          setIdentityPartition("");
          setIdentityExpiresAt("");
          setSelectedCrew(null);
          setLocalContext(null);
          setPilotRun(null);
          setPilotDiagnostics(null);
          setPilotMessage("");
          setPoints([]);
          setHistory([]);
          setSelectedPointId("");
          setContexts([]);
        }
      }
      setError(caught instanceof Error ? caught.message : "La sincronización requiere atención.");
      if (localStateChanged && !authorizationLost) {
        await reloadLocal({
          crewId: selectedCrew.crewId,
          contextId: localContext.sessionId,
        }).catch(() => undefined);
      }
    } finally {
      if (activePilot) {
        let pendingAfter: number | undefined;
        try {
          pendingAfter = (
            await localDatabase.listPending(
              accountPartitionId,
              selectedCrew.crewId,
              localContext.sessionId,
            )
          ).length;
        } catch {
          syncMetricErrorCode ??= "LOCAL_PENDING_READ_FAILED";
        }
        await recordActivePilotEvent(
          "SYNC_END",
          {
            ...syncMetricCounts,
            ...(pendingAfter === undefined ? {} : { pending: pendingAfter }),
            ...(syncMetricErrorCode ? { errorCode: syncMetricErrorCode } : {}),
          },
          activePilot.run,
          activePilot.context,
        ).catch(() => {
          setPilotMessage("No fue posible cerrar la métrica de sincronización H40.");
        });
      }
      syncingRef.current = false;
      setBusy(false);
    }
  }

  async function lockAccount() {
    setBusy(true);
    try {
      if (serverAuthenticated && navigator.onLine) {
        await api.logout().catch(() => {
          // El bloqueo local no depende de que el servidor esté disponible.
        });
      }
    } finally {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(AUTH_KEY);
      api.setToken(null);
      setServerAuthenticated(false);
      setAuth(null);
      setIdentityPartition("");
      setIdentityExpiresAt("");
      setSelectedCrew(null);
      setLocalContext(null);
      setPilotRun(null);
      setPilotDiagnostics(null);
      setPilotMessage("");
      setPoints([]);
      setHistory([]);
      setSelectedPointId("");
      setContexts([]);
      setOutboxStatus({ legacyBlocked: 0, unresolved: 0 });
      setConfirmFinish(false);
      setNotice("");
      setPassword("");
      setBusy(false);
    }
  }

  function returnToLogin(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(AUTH_KEY);
    api.setToken(null);
    setServerAuthenticated(false);
    setAuth(null);
    setIdentityPartition("");
    setIdentityExpiresAt("");
    setSelectedCrew(null);
    setLocalContext(null);
    setPilotRun(null);
    setPilotDiagnostics(null);
    setPilotMessage("");
    setPoints([]);
    setHistory([]);
    setSelectedPointId("");
    setContexts([]);
    setOutboxStatus({ legacyBlocked: 0, unresolved: 0 });
    setConfirmFinish(false);
    setPassword("");
    setError("");
    setNotice("");
  }

  if (authLoading || !databaseReady) {
    return (
      <main className="centered">
        <p role="status">Preparando almacenamiento local…</p>
      </main>
    );
  }

  if (databaseError) {
    return (
      <main className="centered">
        <h1>Almacenamiento local no disponible</h1>
        <p role="alert">{databaseError}</p>
        <p>Recarga la aplicación. La copia existente no se borrará automáticamente.</p>
      </main>
    );
  }

  if (!auth) {
    return (
      <main className="login-page">
        <section>
          <p className="eyebrow">Cliente técnico de campo</p>
          <h1>RutaCuadrilla</h1>
          <p>Mapa, acciones locales y sincronización causal en un cliente separado.</p>
        </section>
        <form onSubmit={(event) => void login(event)}>
          <h2>Ingresar</h2>
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
          <label>
            Correo
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
          </label>
          <label>
            Contraseña
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </main>
    );
  }

  if (!selectedCrew) {
    return (
      <main className="centered selection-page">
        <h1>Elige una tripulación</h1>
        {auth.memberships.map((membership) => (
          <button type="button" key={membership.crewId} onClick={() => setSelectedCrew(membership)}>
            {membership.crewName}
          </button>
        ))}
        {!serverAuthenticated ? (
          <button type="button" onClick={returnToLogin}>
            Volver a ingresar para conectar
          </button>
        ) : null}
        <button type="button" onClick={() => void lockAccount()} disabled={busy}>
          Cerrar sesión
        </button>
      </main>
    );
  }

  if (!localContext) {
    return (
      <main className="centered selection-page">
        <p className="eyebrow">{selectedCrew.crewName}</p>
        <h1>Preparar contexto operativo</h1>
        <p>
          La revisión queda separada del estado de campaña. El mapa base no forma parte del paquete.
        </p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {contexts.map((context) => (
          <button
            type="button"
            key={context.id}
            disabled={busy}
            onClick={() => void prepareContext(context.id)}
          >
            <strong>{context.campaignName}</strong>
            {context.vehicleName ? <span>Vehículo: {context.vehicleName}</span> : null}
            <span>
              {context.pointCount.toLocaleString("es-CL")} puntos ·{" "}
              {context.segmentCount.toLocaleString("es-CL")} tramos
            </span>
          </button>
        ))}
        {contexts.length === 0 ? <p>No hay contextos técnicos disponibles todavía.</p> : null}
        {!serverAuthenticated ? (
          <button type="button" onClick={returnToLogin}>
            Volver a ingresar para descargar un contexto
          </button>
        ) : null}
        <button type="button" onClick={() => void lockAccount()} disabled={busy}>
          Cerrar sesión
        </button>
      </main>
    );
  }

  if (!workSession || !canUseWorkSession) {
    const canConnect = serverAuthenticated && navigator.onLine;
    return (
      <main className="centered selection-page work-session-gate">
        <p className="eyebrow">{selectedCrew.crewName}</p>
        <h1>{workSession?.status === "FINISHED" ? "Jornada finalizada" : "Preparar jornada"}</h1>
        <p>
          <strong>{localContext.routeName}</strong>
          {localContext.vehicleName ? ` · Vehículo: ${localContext.vehicleName}` : ""}
        </p>
        {workSession ? (
          <section className="work-session-summary" aria-labelledby="work-session-title">
            <h2 id="work-session-title">Jornada {workSession.id.slice(0, 8)}</h2>
            <p>
              Estado: <strong>{workSession.status === "ACTIVE" ? "Activa" : "Finalizada"}</strong> ·
              versión {workSession.version}
            </p>
            <h3>Participantes ({workSession.participants.length})</h3>
            <ul>
              {workSession.participants.map((participant) => (
                <li key={participant.membershipId}>
                  {participant.displayName} · {participant.profile}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p>No existe una jornada activa guardada para esta ruta.</p>
        )}
        {notice ? (
          <p role="status" className="notice">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {!workSession || workSession.status === "FINISHED" ? (
          <button
            type="button"
            disabled={!canConnect || busy || !pilotLifecycleReady || pilotRun !== null}
            onClick={() => void startWorkSession()}
          >
            {busy
              ? "Iniciando…"
              : workSession?.status === "FINISHED"
                ? "Iniciar nueva jornada"
                : "Iniciar jornada"}
          </button>
        ) : workSession.status === "ACTIVE" && !deviceJoined ? (
          <button
            type="button"
            disabled={!canConnect || busy}
            onClick={() => void joinWorkSession()}
          >
            {busy ? "Uniendo…" : "Unir este dispositivo"}
          </button>
        ) : null}
        {canConnect ? (
          <button type="button" disabled={busy} onClick={() => void refreshSelectedWorkSession()}>
            Actualizar jornada
          </button>
        ) : (
          <p>
            Conéctate y vuelve a ingresar para iniciar o unirte. No se inventará una jornada
            offline.
          </p>
        )}
        {!pilotLifecycleReady ? (
          <p role="status">Comprobando si existe una medición H40 pendiente…</p>
        ) : null}
        {pilotRun ? (
          <PilotEvidencePanel
            busy={busy}
            canStart={false}
            diagnostics={pilotDiagnostics}
            message={pilotMessage}
            onAbort={() => void abortPilotRun()}
            onExport={() => void exportPilotRun()}
            onFinish={() => void finishPilotRun()}
            onRefreshDiagnostics={() => void refreshPilotDiagnostics()}
            onStart={(alias) => void startPilotRun(alias)}
            run={pilotRun}
          />
        ) : null}
        <button
          type="button"
          disabled={busy || !pilotLifecycleReady || pilotRun !== null}
          onClick={() => void chooseAnotherContext()}
        >
          Cambiar contexto
        </button>
        <button type="button" disabled={busy} onClick={() => void lockAccount()}>
          Cerrar sesión
        </button>
        {workSession?.status === "FINISHED" ? (
          <p>
            El mapa y sus acciones quedaron bloqueados. Este estado no acredita reconciliación ni
            cierre de campaña.
          </p>
        ) : null}
      </main>
    );
  }

  return (
    <div className="field-app">
      <header className="field-header">
        <div>
          <p className="eyebrow">{selectedCrew.crewName}</p>
          <strong>{localContext.routeName}</strong>
          {localContext.vehicleName ? <span>Vehículo: {localContext.vehicleName}</span> : null}
          <span>
            Jornada activa · {workSession.participants.length} participante(s) · versión{" "}
            {workSession.version}
          </span>
        </div>
        <div className="field-header__actions">
          <div className={`sync-pill sync-pill--${phase}`} role="status" aria-live="polite">
            {syncStatusLabel(phase, history)}
          </div>
          {availableUpdate ? (
            <button
              type="button"
              className="quiet-button"
              disabled={busy || !pilotLifecycleReady || pilotRun !== null}
              onClick={applyAvailableUpdate}
            >
              Actualizar aplicación
            </button>
          ) : null}
          {serverAuthenticated && navigator.onLine ? (
            <button
              type="button"
              className="quiet-button"
              disabled={busy}
              onClick={() => void refreshSelectedWorkSession()}
            >
              Actualizar jornada
            </button>
          ) : null}
          <button
            type="button"
            className="quiet-button"
            disabled={
              busy ||
              !pilotLifecycleReady ||
              pilotRun !== null ||
              outboxStatus.unresolved > 0 ||
              !serverAuthenticated ||
              !navigator.onLine
            }
            onClick={() => setConfirmFinish(true)}
          >
            Finalizar jornada
          </button>
          {serverAuthenticated ? (
            <button
              type="button"
              className="quiet-button"
              disabled={busy || !pilotLifecycleReady || pilotRun !== null}
              onClick={() => void chooseAnotherContext()}
            >
              Cambiar contexto
            </button>
          ) : null}
          {!serverAuthenticated ? (
            <button type="button" className="quiet-button" onClick={returnToLogin}>
              Volver a ingresar
            </button>
          ) : null}
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={() => void lockAccount()}
          >
            Cerrar sesión
          </button>
        </div>
      </header>
      {recoveryNotice ? (
        <p className="notice notice--recovery" role="status">
          Recuperación de arranque: {recoveryNotice}
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
      {outboxStatus.legacyBlocked > 0 ? (
        <p className="error" role="alert">
          {outboxStatus.legacyBlocked} operación(es) heredada(s) permanecen conservadas y
          bloqueadas. No son atribuibles a esta jornada, no se enviarán y bloquean nuevas marcas y
          la finalización.
        </p>
      ) : null}
      {confirmFinish ? (
        <section className="finish-confirmation" aria-labelledby="finish-confirmation-title">
          <h2 id="finish-confirmation-title">Confirmar finalización</h2>
          <p>
            Finalizar bloqueará las marcas de esta jornada. Solo se comprobó la outbox de este
            dispositivo; este corte no reconcilia otro teléfono que siga sin conexión.
          </p>
          <div>
            <button type="button" disabled={busy} onClick={() => setConfirmFinish(false)}>
              Cancelar
            </button>
            <button
              type="button"
              disabled={
                busy || !pilotLifecycleReady || pilotRun !== null || outboxStatus.unresolved > 0
              }
              onClick={() => void finishWorkSession()}
            >
              Confirmar y finalizar
            </button>
          </div>
        </section>
      ) : null}
      <main className="field-main">
        <FieldMap
          points={points}
          segments={localContext.segments}
          selectedPointId={selectedPointId}
          onSelect={setSelectedPointId}
        />
        <aside className="point-card" aria-live="polite">
          {selectedPoint ? (
            <>
              <p className="eyebrow">Punto seleccionado</p>
              <h1>
                {selectedPoint.street || "Calle no informada"} {selectedPoint.number || "S/N"}
              </h1>
              <p>
                Estado actual: <strong>{selectedPoint.state.replaceAll("_", " ")}</strong>
              </p>
              <div className="quick-actions">
                <button
                  type="button"
                  disabled={busy || !canCreateFieldAction}
                  onClick={() => void markPoint("SOBRE_ENTREGADO")}
                >
                  ✓ Entregado
                </button>
                <button
                  type="button"
                  disabled={busy || !canCreateFieldAction}
                  onClick={() => void markPoint("VOLVER")}
                >
                  ↩ Volver
                </button>
                <button
                  type="button"
                  disabled={busy || !canCreateFieldAction}
                  onClick={() => void markPoint("SIN_RESPUESTA")}
                >
                  ? Sin respuesta
                </button>
                <button
                  type="button"
                  disabled={busy || !canCreateFieldAction}
                  onClick={() => void markPoint("APORTO")}
                >
                  $ Aportó
                </button>
                <button
                  type="button"
                  disabled={busy || !canCreateFieldAction}
                  onClick={() => void markPoint("NO_PARTICIPA")}
                >
                  × No participa
                </button>
              </div>
              <div className="secondary-actions">
                <button
                  type="button"
                  onClick={() => void undoLast()}
                  disabled={
                    busy ||
                    !canCreateFieldAction ||
                    !history.some(
                      (operation) =>
                        operation.workSessionId === workSession.id &&
                        ["CONFIRMED", "PENDING"].includes(operation.state),
                    )
                  }
                >
                  Deshacer
                </button>
                <button
                  type="button"
                  disabled={busy || !pilotInteractionReady}
                  onClick={() => void synchronize()}
                >
                  Sincronizar
                </button>
              </div>
              {actionLatency !== null ? (
                <small>Respuesta visual local: {actionLatency.toFixed(1)} ms</small>
              ) : null}
            </>
          ) : (
            <p>Selecciona un punto en el mapa o buscador.</p>
          )}
        </aside>
      </main>
      <PilotEvidencePanel
        busy={busy}
        canStart={Boolean(
          canOperate &&
            pilotLifecycleReady &&
            pilotRun === null &&
            serverAuthenticated &&
            navigator.onLine,
        )}
        diagnostics={pilotDiagnostics}
        message={pilotMessage}
        onAbort={() => void abortPilotRun()}
        onExport={() => void exportPilotRun()}
        onFinish={() => void finishPilotRun()}
        onRefreshDiagnostics={() => void refreshPilotDiagnostics()}
        onStart={(alias) => void startPilotRun(alias)}
        run={pilotRun}
      />
      <HistoryPanel
        busy={busy || !pilotInteractionReady}
        conflictReasons={conflictReasons}
        history={history}
        workSessionId={workSession?.id}
        onReasonChange={(operationId, reason) =>
          setConflictReasons((current) => ({ ...current, [operationId]: reason }))
        }
        onResolve={(operation, decision) => void resolveConflict(operation, decision)}
      />
      <footer className="storage-note">
        SQLite {databasePersistent ? "persistente en OPFS" : "temporal"} · esquema local v
        {databaseSchemaVersion} · contrato provisional v3 · sin mapa base offline
      </footer>
    </div>
  );
}
