import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldSegment, PointState } from "../types";
import { FieldMap, SYNTHETIC_FIELD_CATALOGS } from "./FieldMap";

const leftSegment: FieldSegment = {
  id: "segment-left",
  externalId: "synthetic/segment/01",
  displayOrder: 0,
  streetSegmentVersionId: "segment-version-10",
  name: "Pasaje Aurora Cero",
  serviceSide: "LEFT",
  source: "GEOJSON",
  geometry: {
    type: "MultiLineString",
    coordinates: [
      [
        [-0.67, -0.45],
        [-0.66, -0.44],
      ],
    ],
  },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FieldMap street-side alternative", () => {
  it("expone por teclado el lado declarado y explica su referencia", () => {
    render(
      <FieldMap
        online
        onClearSelection={vi.fn()}
        onSelect={vi.fn()}
        onSetPointState={vi.fn<(point: never, state: PointState) => void>()}
        points={[]}
        segments={[leftSegment]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Lado operativo por tramo" })).toBeVisible();
    expect(screen.getByLabelText("Buscar tramo o lado asignado")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: /Pasaje Aurora CeroLado oeste · lado izquierdo del trazadoTramo 1/u,
      }),
    ).toBeVisible();
    expect(screen.getByText(/no asigna viviendas por cercanía/u)).toBeVisible();
    expect(screen.getByText(/Mapa base: fondo neutro sin proveedor externo/u)).toBeVisible();
    expect(screen.queryByRole("link", { name: "© OpenStreetMap contributors" })).toBeNull();
  });

  it("declara la ausencia de tramos en paquetes heredados", () => {
    render(
      <FieldMap
        online
        onClearSelection={vi.fn()}
        onSelect={vi.fn()}
        onSetPointState={vi.fn<(point: never, state: PointState) => void>()}
        points={[]}
        segments={[]}
      />,
    );

    const status = screen.getByText(
      "Este contexto no incluye tramos con lado operativo informado.",
    );
    expect(status).toHaveAttribute("role", "status");
  });

  it("carga por defecto únicamente los catálogos públicos sintéticos", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<FieldMap online onSelect={vi.fn()} points={[]} segments={[]} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/demo-parcels.geojson",
      "/demo-dwellings.geojson",
    ]);
    expect(SYNTHETIC_FIELD_CATALOGS.attribution?.label).toMatch(/sintéticos/u);
  });

  it("permite configurar uno de los catálogos u omitirlos por completo", async () => {
    const fetchMock = vi.mocked(fetch);
    const { rerender } = render(
      <FieldMap
        catalogs={{ parcels: "/catalogos/predios-publicos.geojson" }}
        online
        onSelect={vi.fn()}
        points={[]}
        segments={[]}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/catalogos/predios-publicos.geojson",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fetchMock.mockClear();
    rerender(<FieldMap catalogs={null} online onSelect={vi.fn()} points={[]} segments={[]} />);
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
