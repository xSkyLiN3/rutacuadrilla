import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AdminApi, Membership, RevisionFeatures } from "../api/types";
import { DraftSpatialEditor } from "./DraftSpatialEditor";

vi.mock("../map/RouteMap", () => ({
  RouteMap: () => <div role="img" aria-label="Mapa simulado" />,
}));

const membership: Membership = {
  crewId: "10000000-0000-4000-8000-000000000001",
  crewName: "Tripulación de prueba",
  role: "ADMIN",
};

const features: RevisionFeatures = {
  area: null,
  bounds: null,
  draftVersion: 1,
  pointCount: 0,
  points: [],
  revisionId: "30000000-0000-4000-8000-000000000003",
  routeId: "20000000-0000-4000-8000-000000000002",
  schemaVersion: 1,
  segmentCount: 0,
  segments: [],
  status: "DRAFT",
};

describe("DraftSpatialEditor", () => {
  it("conserva cada valor del formulario al agregar un punto manual", async () => {
    const applyDraftChange = vi.fn().mockResolvedValue({
      draftVersion: 2,
      pointCount: 1,
      replayed: false,
      revisionId: features.revisionId,
      routeId: features.routeId,
      segmentCount: 0,
    });
    const api = {
      applyDraftChange,
      getRevisionFeatures: vi.fn().mockResolvedValue(features),
    } as unknown as AdminApi;
    const user = userEvent.setup();

    render(
      <DraftSpatialEditor
        api={api}
        membership={membership}
        onChanged={vi.fn()}
        onClose={vi.fn()}
        onUnauthorized={vi.fn()}
        revisionId={features.revisionId}
        routeId={features.routeId}
      />,
    );

    await screen.findByRole("heading", { name: "Agregar punto" });
    await user.clear(screen.getByRole("textbox", { name: "ID externo" }));
    await user.type(screen.getByRole("textbox", { name: "ID externo" }), "manual-001");
    await user.type(screen.getByRole("textbox", { name: "Calle" }), "Pasaje Manual");
    await user.type(screen.getByRole("textbox", { name: "Número" }), "14");
    await user.type(screen.getByRole("textbox", { name: "Latitud" }), "-0.4493");
    await user.type(screen.getByRole("textbox", { name: "Longitud" }), "-0.6687");
    await user.click(screen.getByRole("button", { name: "Agregar punto" }));

    await waitFor(() => expect(applyDraftChange).toHaveBeenCalledTimes(1));
    expect(applyDraftChange).toHaveBeenCalledWith(
      membership.crewId,
      features.routeId,
      features.revisionId,
      expect.objectContaining({
        baseDraftVersion: 1,
        change: {
          type: "ADD_POINT",
          point: {
            externalId: "manual-001",
            latitude: -0.4493,
            longitude: -0.6687,
            number: "14",
            pointType: "DWELLING",
            source: "MANUAL",
            street: "Pasaje Manual",
          },
        },
      }),
    );
  });

  it("guarda el lado atendido relativo al sentido de cada componente del tramo", async () => {
    const featuresWithSegment: RevisionFeatures = {
      ...features,
      segmentCount: 1,
      segments: [
        {
          id: "segment-1",
          streetSegmentVersionId: "segment-version-1",
          displayOrder: 0,
          externalId: "way/101",
          name: "Calle Compartida",
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [-0.67, -0.44],
                [-0.66, -0.45],
              ],
            ],
          },
          serviceSide: "LEFT",
          source: "OSM",
          attribution: "© OpenStreetMap contributors",
        },
      ],
    };
    const applyDraftChange = vi.fn().mockResolvedValue({
      draftVersion: 2,
      pointCount: 0,
      replayed: false,
      revisionId: features.revisionId,
      routeId: features.routeId,
      segmentCount: 1,
    });
    const api = {
      applyDraftChange,
      getRevisionFeatures: vi.fn().mockResolvedValue(featuresWithSegment),
    } as unknown as AdminApi;
    const user = userEvent.setup();

    render(
      <DraftSpatialEditor
        api={api}
        membership={membership}
        onChanged={vi.fn()}
        onClose={vi.fn()}
        onUnauthorized={vi.fn()}
        revisionId={features.revisionId}
        routeId={features.routeId}
      />,
    );

    await screen.findByRole("heading", { name: "Calles y lado atendido" });
    expect(
      screen.getByText(/si se invierte el orden de sus coordenadas, también se intercambian/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Calle Compartida").closest("li")).toHaveTextContent(
      "Componente 1: Inicio -0.440000, -0.670000 → Fin -0.450000, -0.660000",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Lado atendido en Calle Compartida" }),
      "RIGHT",
    );
    await user.click(screen.getByRole("button", { name: "Guardar lados de las calles" }));

    await waitFor(() => expect(applyDraftChange).toHaveBeenCalledTimes(1));
    expect(applyDraftChange).toHaveBeenCalledWith(
      membership.crewId,
      features.routeId,
      features.revisionId,
      expect.objectContaining({
        baseDraftVersion: 1,
        change: {
          type: "REPLACE_SEGMENTS",
          segments: [
            expect.objectContaining({
              externalId: "way/101",
              geometry: featuresWithSegment.segments[0]?.geometry,
              serviceSide: "RIGHT",
              source: "OSM",
            }),
          ],
        },
      }),
    );
  });

  it("permite asignar el lado antes de incorporar una calle OSM", async () => {
    const applyDraftChange = vi.fn().mockResolvedValue({
      draftVersion: 2,
      pointCount: 0,
      replayed: false,
      revisionId: features.revisionId,
      routeId: features.routeId,
      segmentCount: 1,
    });
    const api = {
      applyDraftChange,
      getRevisionFeatures: vi.fn().mockResolvedValue(features),
      previewOsmExport: vi.fn().mockResolvedValue({
        attribution: "© OpenStreetMap contributors",
        points: [],
        segments: [
          {
            externalId: "way/202",
            geometry: {
              type: "LineString",
              coordinates: [
                [-0.67, -0.44],
                [-0.66, -0.45],
              ],
            },
            name: "Calle OSM",
            serviceSide: "BOTH",
            source: "OSM",
          },
        ],
        summary: { candidatePoints: 0, candidateSegments: 1, sourceElements: 1 },
        warnings: [],
      }),
    } as unknown as AdminApi;
    const user = userEvent.setup();

    render(
      <DraftSpatialEditor
        api={api}
        membership={membership}
        onChanged={vi.fn()}
        onClose={vi.fn()}
        onUnauthorized={vi.fn()}
        revisionId={features.revisionId}
        routeId={features.routeId}
      />,
    );

    await screen.findByRole("heading", { name: "Calles y lado atendido" });
    await user.click(screen.getByText("Importación asistida OSM/Overpass"));
    fireEvent.change(screen.getByRole("textbox", { name: "Exportación Overpass JSON" }), {
      target: { value: '{"elements":[]}' },
    });
    await user.click(screen.getByRole("button", { name: "Revisar candidatos" }));
    const candidateSide = await screen.findByRole("combobox", {
      name: "Lado atendido en candidato Calle OSM",
    });
    expect(screen.getByText("Calle OSM").closest(".osm-segment-choice")).toHaveTextContent(
      "Componente 1: Inicio (-0.440000, -0.670000) → Fin (-0.450000, -0.660000)",
    );
    await user.selectOptions(candidateSide, "LEFT");
    const importButton = screen.getByRole("button", { name: "Incorporar selección al borrador" });
    expect(importButton).toBeDisabled();
    expect(
      screen.getByText(/confirma explícitamente el lado de cada calle seleccionada/i),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: "Confirmar lado atendido en candidato Calle OSM",
      }),
    );
    expect(importButton).toBeEnabled();
    await user.click(importButton);

    await waitFor(() => expect(applyDraftChange).toHaveBeenCalledTimes(1));
    expect(applyDraftChange).toHaveBeenCalledWith(
      membership.crewId,
      features.routeId,
      features.revisionId,
      expect.objectContaining({
        change: expect.objectContaining({
          type: "IMPORT_OSM_SELECTION",
          segments: [
            expect.objectContaining({
              externalId: "way/202",
              serviceSide: "LEFT",
            }),
          ],
        }),
      }),
    );
  });
});
