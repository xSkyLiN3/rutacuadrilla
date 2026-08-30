import { useState } from "react";
import type { H40DeviceAlias, H40RunSummary } from "./local/protocol";
import type { PilotDiagnosticsReport } from "./pilotDiagnostics";

export interface PilotEvidencePanelProps {
  busy: boolean;
  canStart: boolean;
  diagnostics: PilotDiagnosticsReport | null;
  message?: string;
  onAbort: () => void;
  onExport: () => void;
  onFinish: () => void;
  onRefreshDiagnostics: () => void;
  onStart: (alias: H40DeviceAlias) => void;
  run: H40RunSummary | null;
}

function resultLabel(value: boolean): string {
  return value ? "Apto" : "Bloqueado";
}

function latency(value: number | null): string {
  return value === null ? "Sin muestras" : `${value.toFixed(1)} ms`;
}

function runStatusLabel(status: H40RunSummary["status"]): string {
  if (status === "RUNNING") return "midiendo";
  if (status === "FINISHED") return "finalizada";
  return "descartada";
}

export function PilotEvidencePanel({
  busy,
  canStart,
  diagnostics,
  message,
  onAbort,
  onExport,
  onFinish,
  onRefreshDiagnostics,
  onStart,
  run,
}: PilotEvidencePanelProps) {
  const [alias, setAlias] = useState<H40DeviceAlias | "">("");
  const pending = diagnostics === null;
  const ready = diagnostics?.status === "READY";
  const running = run?.status === "RUNNING";
  const finished = run?.status === "FINISHED";

  return (
    <section className="pilot-panel" aria-busy={busy} aria-labelledby="pilot-panel-title">
      <div className="pilot-panel__heading">
        <div>
          <p className="eyebrow">Evidencia técnica local</p>
          <h2 id="pilot-panel-title">Modo de prueba H40</h2>
        </div>
        <span
          className={`pilot-panel__status pilot-panel__status--${pending ? "pending" : ready ? "ready" : "blocked"}`}
        >
          {pending ? "Diagnóstico pendiente" : ready ? "Diagnóstico apto" : "Diagnóstico bloqueado"}
        </span>
      </div>

      <p>
        Registra latencias y conteos agregados en SQLite. El export no incluye viviendas,
        coordenadas, estados por punto ni identificadores de personas.
      </p>

      {diagnostics ? (
        <dl className="pilot-diagnostics">
          <div>
            <dt>Origen seguro y aislamiento</dt>
            <dd>{resultLabel(diagnostics.isSecureContext && diagnostics.crossOriginIsolated)}</dd>
          </div>
          <div>
            <dt>Shell productivo</dt>
            <dd>
              {diagnostics.serviceWorkerActivated && diagnostics.shellVersion
                ? `Apto · ${diagnostics.shellVersion}`
                : "Bloqueado"}
            </dd>
          </div>
          <div>
            <dt>Build de Campo</dt>
            <dd>{diagnostics.buildId ?? "Bloqueado"}</dd>
          </div>
          <div>
            <dt>SQLite local</dt>
            <dd>
              {diagnostics.databasePersistent &&
              diagnostics.opfsSupported &&
              diagnostics.localSchemaVersion === diagnostics.expectedLocalSchemaVersion
                ? `Apto · esquema v${diagnostics.localSchemaVersion ?? "?"}`
                : "Bloqueado"}
            </dd>
          </div>
          <div>
            <dt>Identidad vigente</dt>
            <dd>{resultLabel(diagnostics.identityCurrent)}</dd>
          </div>
        </dl>
      ) : (
        <p role="status">Diagnóstico pendiente.</p>
      )}

      {diagnostics?.blockedCodes.length ? (
        <details>
          <summary>Ver {diagnostics.blockedCodes.length} bloqueo(s) técnico(s)</summary>
          <ul>
            {diagnostics.blockedCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {!run ? (
        <div className="pilot-panel__actions">
          <label>
            Alias del teléfono
            <select
              disabled={busy}
              value={alias}
              onChange={(event) => setAlias(event.target.value as H40DeviceAlias | "")}
            >
              <option value="">Selecciona este teléfono</option>
              <option value="A">Teléfono A</option>
              <option value="B">Teléfono B</option>
            </select>
          </label>
          <button
            type="button"
            disabled={busy || !ready || !canStart || !alias}
            onClick={() => {
              if (alias) onStart(alias);
            }}
          >
            Iniciar medición
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={onRefreshDiagnostics}
          >
            Repetir diagnóstico
          </button>
          {ready && !canStart ? (
            <p className="pilot-panel__hint">
              Para iniciar, conecta el teléfono, autentícate y únete a una jornada activa.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="pilot-run">
          <div className="pilot-run__summary" role="status">
            <strong>
              Teléfono {run.deviceAlias} · {runStatusLabel(run.status)}
            </strong>
            <span>
              {run.completedActionCount}/{Math.max(30, run.actionCount)} acciones con medición
            </span>
          </div>
          <progress
            aria-label="Acciones H40 medidas"
            max={Math.max(30, run.actionCount)}
            value={Math.min(run.completedActionCount, Math.max(30, run.actionCount))}
          />
          <dl className="pilot-latencies">
            <div>
              <dt>Feedback p50</dt>
              <dd>{latency(run.visualMs.p50)}</dd>
            </div>
            <div>
              <dt>Feedback p95</dt>
              <dd>{latency(run.visualMs.p95)}</dd>
            </div>
            <div>
              <dt>Persistencia p95</dt>
              <dd>{latency(run.persistMs.p95)}</dd>
            </div>
          </dl>
          <div className="pilot-panel__actions">
            {running ? (
              <>
                <button type="button" disabled={busy} onClick={onFinish}>
                  Cerrar medición
                </button>
                <button type="button" className="quiet-button" disabled={busy} onClick={onAbort}>
                  Descartar medición
                </button>
              </>
            ) : null}
            {finished ? (
              <button type="button" disabled={busy} onClick={onExport}>
                Exportar evidencia segura
              </button>
            ) : null}
          </div>
          {running ? (
            <p className="pilot-panel__hint">
              Cerrar congela la evidencia local; el verificador externo aún comprobará 20 minutos
              offline, p95, convergencia, pérdidas y duplicados.
            </p>
          ) : null}
        </div>
      )}

      {message ? (
        <p className="pilot-panel__message" role="status">
          {message}
        </p>
      ) : null}
      <small>
        Esta medición no acredita por sí sola la prueba humana de dos teléfonos ni cambia el
        porcentaje del proyecto.
      </small>
    </section>
  );
}
