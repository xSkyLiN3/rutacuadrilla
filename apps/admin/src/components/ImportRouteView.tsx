import { useMemo, useState } from "react";
import { ApiError } from "../api/client";
import type { AdminApi, ImportIssue, Membership } from "../api/types";
import { parseRouteCsv } from "../lib/csv";
import { SchematicMap } from "./Shared";

interface ImportRouteViewProps {
  api: AdminApi;
  membership: Membership;
  demoMode: boolean;
  onCancel: () => void;
  onCreated: (routeId: string) => void;
  onUnauthorized: () => void;
}

const DEMO_CSV = [
  "external_id,street,number,latitude,longitude,point_type,source",
  "home-c-001,Los Aromos,120,-0.45120,-0.66210,DWELLING,CSV",
  "home-c-002,Los Aromos,126,-0.45170,-0.66140,DWELLING,CSV",
  "entrance-c-003,Las Flores,45,-0.45230,-0.66060,BUILDING_ENTRANCE,CSV",
  "access-c-004,Pasaje Central,S/N,-0.45290,-0.65990,COMPLEX_ACCESS,CSV",
].join("\n");

function createImportKey(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `import-${Date.now().toString(36)}`;
}

export function ImportRouteView({
  api,
  membership,
  demoMode,
  onCancel,
  onCreated,
  onUnauthorized,
}: ImportRouteViewProps) {
  const [routeName, setRouteName] = useState("");
  const [sectorName, setSectorName] = useState("");
  const [importKey, setImportKey] = useState(createImportKey);
  const [csv, setCsv] = useState("");
  const [previewVisible, setPreviewVisible] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fileError, setFileError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [serverIssues, setServerIssues] = useState<ImportIssue[]>([]);

  const preview = useMemo(() => parseRouteCsv(csv), [csv]);
  const canCreate =
    previewVisible &&
    routeName.trim() !== "" &&
    sectorName.trim() !== "" &&
    importKey.trim() !== "" &&
    preview.globalErrors.length === 0 &&
    preview.errorCount === 0 &&
    preview.validRows.length > 0 &&
    !submitting;

  async function handleFile(file?: File) {
    if (!file) {
      return;
    }
    setReadingFile(true);
    setFileError("");
    try {
      const content = await file.text();
      setCsv(content);
      setPreviewVisible(true);
    } catch {
      setFileError("No fue posible leer el archivo seleccionado.");
    } finally {
      setReadingFile(false);
    }
  }

  function loadDemoCsv() {
    setRouteName("Ruta Sector C");
    setSectorName("Sector C");
    setCsv(DEMO_CSV);
    setPreviewVisible(true);
    setSubmitError("");
    setServerIssues([]);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreviewVisible(true);
    setSubmitError("");
    setServerIssues([]);
    if (!canCreate) {
      setSubmitError("Corrige los campos y las filas marcadas antes de crear el borrador.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await api.importRoute(membership.crewId, {
        routeName: routeName.trim(),
        sectorName: sectorName.trim(),
        importKey: importKey.trim(),
        csv,
      });
      if (response.errors && response.errors.length > 0) {
        setServerIssues(response.errors);
        setSubmitError("El servidor informó errores por fila.");
        return;
      }
      onCreated(response.route.id);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 401) {
          onUnauthorized();
          return;
        }
        setSubmitError(caught.message);
        if (Array.isArray(caught.details)) {
          setServerIssues(caught.details as ImportIssue[]);
        }
      } else {
        setSubmitError("No fue posible crear la revisión en borrador.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const mapPoints = preview.validRows.map((row) => ({
    id: `preview-${row.externalId}`,
    street: row.street || undefined,
    number: row.number,
    latitude: row.latitude as number,
    longitude: row.longitude as number,
  }));

  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">{membership.crewName}</p>
        <h1>Nueva ruta desde CSV</h1>
        <p>Revisa nombres, coordenadas y errores antes de crear una revisión editable.</p>
      </header>

      <form className="import-layout" onSubmit={handleSubmit} noValidate>
        <section className="form-section" aria-labelledby="route-data-title">
          <div className="section-heading">
            <span className="section-number" aria-hidden="true">
              1
            </span>
            <div>
              <h2 id="route-data-title">Datos de la ruta</h2>
              <p>La clave evita duplicar una importación al reintentar.</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="route-name">Nombre de ruta</label>
              <input
                id="route-name"
                name="routeName"
                required
                value={routeName}
                onChange={(event) => setRouteName(event.target.value)}
                placeholder="Ej. Ruta Sector A"
              />
            </div>
            <div className="field">
              <label htmlFor="sector-name">Sector</label>
              <input
                id="sector-name"
                name="sectorName"
                required
                value={sectorName}
                onChange={(event) => setSectorName(event.target.value)}
                placeholder="Ej. Sector A"
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="import-key">Clave de importación</label>
            <input
              id="import-key"
              name="importKey"
              required
              value={importKey}
              onChange={(event) => setImportKey(event.target.value)}
              aria-describedby="import-key-help"
            />
            <small id="import-key-help">
              Reutiliza esta clave si debes reenviar exactamente el mismo lote.
            </small>
          </div>
        </section>

        <section className="form-section" aria-labelledby="csv-title">
          <div className="section-heading">
            <span className="section-number" aria-hidden="true">
              2
            </span>
            <div>
              <h2 id="csv-title">Archivo y contenido</h2>
              <p>Usa la plantilla canónica; los nombres y el orden son obligatorios.</p>
            </div>
          </div>

          <div className="file-row">
            <div className="field">
              <label htmlFor="csv-file">Cargar archivo CSV</label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void handleFile(event.target.files?.[0])}
                disabled={readingFile}
              />
            </div>
            {demoMode ? (
              <button className="button button--secondary" type="button" onClick={loadDemoCsv}>
                Cargar ejemplo demo
              </button>
            ) : null}
          </div>
          {fileError ? (
            <p className="form-error" role="alert">
              {fileError}
            </p>
          ) : null}

          <div className="field">
            <label htmlFor="csv-content">Contenido CSV</label>
            <textarea
              id="csv-content"
              name="csv"
              rows={10}
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
                if (previewVisible) {
                  setSubmitError("");
                }
              }}
              placeholder={
                "external_id,street,number,latitude,longitude,point_type,source\n" +
                "home-001,Los Aromos,120,-0.4512,-0.6621,DWELLING,CSV"
              }
              spellCheck={false}
            />
            <small>
              Cabecera requerida: external_id, street, number, latitude, longitude, point_type,
              source. La calle y el número pueden quedar vacíos.
            </small>
          </div>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setPreviewVisible(true)}
            disabled={!csv.trim()}
          >
            Previsualizar
          </button>
        </section>

        {previewVisible ? (
          <section className="form-section form-section--wide" aria-labelledby="preview-title">
            <div className="section-heading">
              <span className="section-number" aria-hidden="true">
                3
              </span>
              <div>
                <h2 id="preview-title">Previsualización</h2>
                <p aria-live="polite">
                  {preview.validRows.length} filas válidas · {preview.errorCount} errores
                </p>
              </div>
            </div>

            {preview.globalErrors.length > 0 ? (
              <div className="issue-summary" role="alert">
                <strong>Revisa el formato</strong>
                <ul>
                  {preview.globalErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="preview-grid">
              <div className="table-container">
                <table className="data-table data-table--compact">
                  <caption className="sr-only">Filas importadas y errores</caption>
                  <thead>
                    <tr>
                      <th scope="col">Fila</th>
                      <th scope="col">ID externo</th>
                      <th scope="col">Dirección</th>
                      <th scope="col">Tipo</th>
                      <th scope="col">Fuente</th>
                      <th scope="col">Latitud</th>
                      <th scope="col">Longitud</th>
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
                        <td>{row.pointType || "—"}</td>
                        <td>{row.source || "—"}</td>
                        <td>{row.latitude ?? "—"}</td>
                        <td>{row.longitude ?? "—"}</td>
                        <td>
                          {row.valid ? (
                            <span className="valid-label">Válida</span>
                          ) : (
                            <ul className="cell-errors">
                              {row.errors.map((error) => (
                                <li key={error}>{error}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <SchematicMap points={mapPoints} title="Vista previa de coordenadas CSV" />
            </div>
          </section>
        ) : null}

        {serverIssues.length > 0 ? (
          <section
            className="issue-summary form-section--wide"
            aria-labelledby="server-errors-title"
          >
            <h2 id="server-errors-title">Errores informados por el servidor</h2>
            <ul>
              {serverIssues.map((issue) => (
                <li key={`${issue.row}-${issue.code ?? issue.field ?? "row"}-${issue.message}`}>
                  Fila {issue.row}: {issue.message}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {submitError ? (
          <p className="form-error form-section--wide" role="alert">
            {submitError}
          </p>
        ) : null}

        <div className="form-actions form-section--wide">
          <button className="button button--secondary" type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button className="button button--primary" type="submit" disabled={!canCreate}>
            {submitting ? "Creando borrador…" : "Crear revisión en borrador"}
          </button>
        </div>
      </form>
    </>
  );
}
