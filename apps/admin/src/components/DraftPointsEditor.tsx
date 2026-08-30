import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type {
  AdminApi,
  EditRevisionPointsResponse,
  ImportIssue,
  RouteRevision,
} from "../api/types";
import { parseRouteCsv, serializeRoutePointsCsv } from "../lib/csv";
import { SchematicMap } from "./Shared";

interface DraftPointsEditorProps {
  api: AdminApi;
  crewId: string;
  routeId: string;
  revision: RouteRevision;
  onCancel: () => void;
  onSaved: (response: EditRevisionPointsResponse) => void;
  onUnauthorized: () => void;
}

function createEditKey(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `edit-${Date.now().toString(36)}`;
}

export function DraftPointsEditor({
  api,
  crewId,
  routeId,
  revision,
  onCancel,
  onSaved,
  onUnauthorized,
}: DraftPointsEditorProps) {
  const editorId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editKey] = useState(createEditKey);
  const [csv, setCsv] = useState(() => serializeRoutePointsCsv(revision.points));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [serverIssues, setServerIssues] = useState<ImportIssue[]>([]);
  const preview = useMemo(() => parseRouteCsv(csv), [csv]);
  const valid =
    preview.globalErrors.length === 0 && preview.errorCount === 0 && preview.validRows.length > 0;
  const mapPoints = preview.validRows.map((row) => ({
    id: `edit-preview-${row.externalId}`,
    street: row.street || undefined,
    number: row.number || undefined,
    latitude: row.latitude as number,
    longitude: row.longitude as number,
  }));

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function save() {
    if (!valid || saving) {
      return;
    }
    setSaving(true);
    setError("");
    setServerIssues([]);
    try {
      const response = await api.editRevisionPoints(crewId, routeId, revision.id, {
        editKey,
        csv,
      });
      if (response.errors && response.errors.length > 0) {
        setServerIssues(response.errors);
        setError("El servidor informó errores y no confirmó la corrección.");
        return;
      }
      onSaved(response);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 401) {
          onUnauthorized();
          return;
        }
        setError(caught.message);
        if (Array.isArray(caught.details)) {
          setServerIssues(caught.details as ImportIssue[]);
        }
      } else {
        setError("No fue posible guardar la corrección de puntos.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="draft-editor" aria-labelledby={`${editorId}-title`} aria-busy={saving}>
      <header className="section-heading section-heading--between">
        <div>
          <p className="eyebrow">Borrador editable</p>
          <h3 id={`${editorId}-title`}>Corregir puntos mediante CSV</h3>
          <p>Edita la plantilla canónica. La previsualización se actualiza antes de guardar.</p>
        </div>
        <small>
          Clave de edición: <code>{editKey}</code>
        </small>
      </header>

      <div className="field">
        <label htmlFor={`${editorId}-csv`}>CSV corregido</label>
        <textarea
          ref={textareaRef}
          id={`${editorId}-csv`}
          rows={12}
          value={csv}
          onChange={(event) => {
            setCsv(event.target.value);
            setError("");
            setServerIssues([]);
          }}
          spellCheck={false}
        />
      </div>

      <div className="edit-preview-heading">
        <strong>Previsualización en vivo</strong>
        <span role="status" aria-live="polite">
          {preview.validRows.length} filas válidas · {preview.errorCount} errores
        </span>
      </div>

      {preview.globalErrors.length > 0 ? (
        <div className="issue-summary" role="alert">
          <strong>Revisa la cabecera o el contenido</strong>
          <ul>
            {preview.globalErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="edit-preview-grid">
        <div className="table-container">
          <table className="data-table data-table--compact">
            <caption className="sr-only">Previsualización de puntos corregidos</caption>
            <thead>
              <tr>
                <th scope="col">Fila</th>
                <th scope="col">ID externo</th>
                <th scope="col">Dirección</th>
                <th scope="col">Tipo / fuente</th>
                <th scope="col">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr className={row.valid ? undefined : "row-error"} key={row.rowNumber}>
                  <td>{row.rowNumber}</td>
                  <td>
                    <code>{row.externalId || "—"}</code>
                  </td>
                  <td>
                    {row.street || "Calle no informada"} {row.number || "S/N"}
                  </td>
                  <td>
                    {row.pointType || "—"} / {row.source || "—"}
                  </td>
                  <td>
                    {row.valid ? (
                      <span className="valid-label">Válida</span>
                    ) : (
                      <ul className="cell-errors">
                        {row.errors.map((message) => (
                          <li key={message}>{message}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SchematicMap points={mapPoints} title="Previsualización de puntos corregidos" />
      </div>

      {serverIssues.length > 0 ? (
        <div className="issue-summary" role="alert">
          <strong>Errores informados por el servidor</strong>
          <ul>
            {serverIssues.map((issue) => (
              <li
                key={`${issue.row}-${issue.field ?? "row"}-${issue.code ?? "issue"}-${issue.message}`}
              >
                Fila {issue.row}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button
          className="button button--secondary"
          type="button"
          onClick={onCancel}
          disabled={saving}
        >
          Cancelar corrección
        </button>
        <button
          className="button button--primary"
          type="button"
          onClick={() => void save()}
          disabled={!valid || saving}
        >
          {saving ? "Guardando…" : "Guardar puntos corregidos"}
        </button>
      </div>
    </section>
  );
}
