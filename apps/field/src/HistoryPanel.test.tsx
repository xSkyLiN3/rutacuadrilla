import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryPanel } from "./HistoryPanel";
import type { LocalOperation } from "./types";

afterEach(cleanup);

function operation(
  operationId: string,
  state: LocalOperation["state"],
  overrides: Partial<LocalOperation> = {},
): LocalOperation {
  return {
    accountId: "partition-a",
    aggregateId: "point-a",
    baseVersion: 1,
    crewId: "crew-a",
    deviceId: "device-a",
    deviceSequence: 1,
    operationId,
    previousState: "SIN_VISITAR",
    state,
    toState: "VOLVER",
    ...overrides,
  };
}

describe("HistoryPanel", () => {
  it("keeps every attention item visible even when a conflict is older than 12 recent rows", () => {
    const history = [
      ...Array.from({ length: 12 }, (_, index) =>
        operation(`recent-${index}`, "CONFIRMED", { deviceSequence: 20 - index }),
      ),
      operation("old-conflict", "CONFLICT", {
        canonicalState: "SIN_RESPUESTA",
        canonicalVersion: 3,
        deviceSequence: 1,
        toState: "APORTO",
      }),
    ];

    render(
      <HistoryPanel
        busy={false}
        conflictReasons={{}}
        history={history}
        onReasonChange={vi.fn()}
        onResolve={vi.fn()}
      />,
    );

    const attention = screen.getByRole("list", { name: "Operaciones que requieren atención" });
    const recent = screen.getByRole("list", { name: "Operaciones recientes" });
    expect(within(attention).getAllByText("APORTO")).toHaveLength(2);
    expect(attention.children).toHaveLength(1);
    expect(recent.children).toHaveLength(12);
  });

  it("offers another reasoned decision for a rejected resolution retry", () => {
    const onResolve = vi.fn();
    const retry = operation("retry-rejected", "REJECTED", {
      canonicalState: "SIN_RESPUESTA",
      canonicalVersion: 4,
      conflictCode: "INVALID_TRANSITION",
      resolvesOperationId: "original-conflict",
      toState: "APORTO",
    });
    render(
      <HistoryPanel
        busy={false}
        conflictReasons={{ "retry-rejected": "Revisado con la cuadrilla" }}
        history={[retry]}
        onReasonChange={vi.fn()}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Aceptar servidor" }));
    expect(onResolve).toHaveBeenCalledWith(retry, "ACCEPT_SERVER");
    expect(screen.getByRole("button", { name: "Reaplicar mi decisión" })).toBeEnabled();
  });

  it("explains a NO_STATE_CHANGE convergence without offering a duplicate server action", () => {
    render(
      <HistoryPanel
        busy={false}
        conflictReasons={{}}
        history={[
          operation("retry-converged", "SUPERSEDED", {
            canonicalState: "APORTO",
            canonicalVersion: 4,
            resolutionConverged: true,
            resolvesOperationId: "original-conflict",
            toState: "APORTO",
          }),
        ]}
        onReasonChange={vi.fn()}
        onResolve={vi.fn()}
      />,
    );

    expect(screen.getByText(/cadena quedó cerrada como convergida/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reaplicar mi decisión" })).not.toBeInTheDocument();
  });
});
