import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PointStatePanel } from "./PointStatePanel";
import type { FieldPoint } from "./types";

const point: FieldPoint = {
  displayOrder: 0,
  externalId: "synthetic/dwelling/001",
  id: "point-1",
  latitude: 0.0012,
  longitude: 0.0024,
  number: "101",
  pointType: "DWELLING",
  state: "SIN_VISITAR",
  street: "Pasaje Horizonte",
  version: 0,
};

afterEach(cleanup);

describe("PointStatePanel", () => {
  it("permite elegir los seis estados en el contexto de la vivienda", async () => {
    const onSetState = vi.fn();
    const user = userEvent.setup();
    render(
      <PointStatePanel
        className="map-point-panel"
        online
        onClose={vi.fn()}
        onSetState={onSetState}
        point={point}
      />,
    );

    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-modal");
    expect(screen.getByRole("group", { name: "Cambiar estado de la vivienda" })).toBeVisible();
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Sin visitar", pressed: true })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Aportó", pressed: false }));
    expect(onSetState).toHaveBeenCalledWith(point, "APORTO");
  });

  it("mantiene el resultado y permite cerrar con Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <PointStatePanel
        className="map-point-panel"
        feedback={{ kind: "success", message: "Guardado: Aportó.", pointId: point.id }}
        online
        onClose={onClose}
        onSetState={vi.fn()}
        point={{ ...point, state: "APORTO", version: 1 }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Guardado: Aportó.");
    expect(screen.getByRole("button", { name: "Aportó", pressed: true })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("explica que no puede guardar cuando está sin conexión", () => {
    render(
      <PointStatePanel
        className="map-point-panel"
        online={false}
        onClose={vi.fn()}
        onSetState={vi.fn()}
        point={point}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Sin conexión");
    expect(
      screen
        .getAllByRole("button", { pressed: false })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });
});
