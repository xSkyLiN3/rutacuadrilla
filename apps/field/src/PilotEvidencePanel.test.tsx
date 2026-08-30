import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { H40RunSummary } from "./local/protocol";
import { PilotEvidencePanel } from "./PilotEvidencePanel";
import type { PilotDiagnosticsReport } from "./pilotDiagnostics";

const diagnostics: PilotDiagnosticsReport = {
  blockedCodes: [],
  buildId: "h40-a",
  contractVersion: "h40-pilot-diagnostics-v1",
  crossOriginIsolated: true,
  databasePersistent: true,
  expectedLocalSchemaVersion: 8,
  identityCurrent: true,
  isSecureContext: true,
  localSchemaVersion: 8,
  online: true,
  opfsSupported: true,
  randomUUIDSupported: true,
  serviceWorkerActivated: true,
  serviceWorkerControlled: true,
  serviceWorkerSupported: true,
  shellVersion: "h40-a",
  status: "READY",
  storagePersisted: true,
  storageQuotaMiB: 1_024,
  storageUsageMiB: 20,
  webCryptoSupported: true,
};

const run: H40RunSummary = {
  actionCount: 30,
  buildId: "h40-a",
  completedActionCount: 30,
  deviceAlias: "A",
  lastMetricSequence: 4,
  markCount: 29,
  metricCount: 4,
  persistMs: { count: 30, max: 20, p50: 8, p95: 15 },
  runId: "run-internal",
  startedAt: "2026-08-21T12:00:00.000Z",
  status: "RUNNING",
  undoCount: 1,
  visualMs: { count: 30, max: 180, p50: 50, p95: 120 },
};

afterEach(cleanup);

function props() {
  return {
    busy: false,
    canStart: true,
    diagnostics,
    onAbort: vi.fn(),
    onExport: vi.fn(),
    onFinish: vi.fn(),
    onRefreshDiagnostics: vi.fn(),
    onStart: vi.fn(),
    run: null,
  };
}

describe("PilotEvidencePanel", () => {
  it("bloquea el inicio hasta que el diagnóstico sea apto", () => {
    const handlers = props();
    render(
      <PilotEvidencePanel
        {...handlers}
        diagnostics={{ ...diagnostics, blockedCodes: ["OPFS_UNAVAILABLE"], status: "BLOCKED" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Iniciar medición" })).toBeDisabled();
    expect(screen.getByText("OPFS_UNAVAILABLE")).toBeInTheDocument();
  });

  it("inicia con el alias elegido sin solicitar identidad", () => {
    const handlers = props();
    render(<PilotEvidencePanel {...handlers} />);
    expect(screen.getByRole("button", { name: "Iniciar medición" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Alias del teléfono"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar medición" }));
    expect(handlers.onStart).toHaveBeenCalledWith("B");
  });

  it("bloquea el inicio sin jornada operativa", () => {
    const handlers = props();
    const { rerender } = render(<PilotEvidencePanel {...handlers} canStart={false} />);
    expect(screen.getByRole("button", { name: "Iniciar medición" })).toBeDisabled();

    rerender(<PilotEvidencePanel {...handlers} canStart />);
    fireEvent.change(screen.getByLabelText("Alias del teléfono"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar medición" }));
    expect(handlers.onStart).toHaveBeenCalledWith("B");
  });

  it("muestra 30 muestras, p95 y permite finalizar una corrida activa", () => {
    const handlers = props();
    render(<PilotEvidencePanel {...handlers} run={run} />);
    expect(screen.getByText("30/30 acciones con medición")).toBeInTheDocument();
    expect(screen.getByText("120.0 ms")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar medición" }));
    expect(handlers.onFinish).toHaveBeenCalledOnce();
  });

  it("solo ofrece exportar cuando la corrida terminó", () => {
    const handlers = props();
    render(<PilotEvidencePanel {...handlers} run={{ ...run, status: "FINISHED" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Exportar evidencia segura" }));
    expect(handlers.onExport).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Cerrar medición" })).not.toBeInTheDocument();
  });
});
