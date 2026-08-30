import { afterEach, describe, expect, it, vi } from "vitest";
import { SimpleFieldApi, type SimpleFieldAssignment } from "./simpleApi";

const assignment: SimpleFieldAssignment = {
  crew: { id: "crew-1", name: "Cuadrilla Centro" },
  id: "assignment-1",
  points: [
    {
      displayOrder: 0,
      externalId: "casa-001",
      id: "point-1",
      latitude: -0.4489,
      longitude: -0.6693,
      pointType: "DWELLING",
      state: "SIN_VISITAR",
      version: 0,
    },
  ],
  progress: {
    assignmentId: "assignment-1",
    routeId: "route-1",
    routeName: "Ruta Norte",
    states: {
      SIN_VISITAR: 1,
      SOBRE_ENTREGADO: 0,
      VOLVER: 0,
      SIN_RESPUESTA: 0,
      APORTO: 0,
      NO_PARTICIPA: 0,
    },
    total: 1,
    updatedAt: "2026-08-27T00:00:00.000Z",
    user: { id: "user-1", name: "Persona Uno" },
    visited: 0,
  },
  route: { id: "route-1", name: "Ruta Norte", revisionId: "revision-1" },
  segments: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SimpleFieldApi assignment revalidation", () => {
  it("envía If-None-Match y reutiliza exactamente la asignación en memoria ante 304", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ assignment }), {
          headers: { "Content-Type": "application/json", ETag: '"sha256-first"' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { headers: { ETag: '"sha256-first"' }, status: 304 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new SimpleFieldApi();
    api.setToken("token-a");

    const first = await api.assignment();
    const second = await api.assignment();

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(fetchMock.mock.calls[1]?.[1]?.cache).toBe("no-store");
    expect(firstHeaders.has("If-None-Match")).toBe(false);
    expect(secondHeaders.get("If-None-Match")).toBe('"sha256-first"');
    expect(secondHeaders.get("Authorization")).toBe("Bearer token-a");
  });

  it("reemplaza la referencia si cambia el ETag y borra el validador al cambiar de sesión", async () => {
    const firstPoint = assignment.points[0];
    if (!firstPoint) throw new Error("Expected assignment point");
    const changedAssignment: SimpleFieldAssignment = {
      ...assignment,
      points: [{ ...firstPoint, state: "APORTO", version: 1 }],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ assignment }), {
          headers: { ETag: '"sha256-first"' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ assignment: changedAssignment }), {
          headers: { ETag: '"sha256-second"' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ assignment: changedAssignment }), {
          headers: { ETag: '"sha256-second"' },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new SimpleFieldApi();
    api.setToken("token-a");

    const first = await api.assignment();
    const changed = await api.assignment();
    expect(changed).not.toBe(first);
    expect(changed?.points[0]).toMatchObject({ state: "APORTO", version: 1 });

    api.setToken("token-b");
    await api.assignment();
    const thirdHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
    expect(thirdHeaders.has("If-None-Match")).toBe(false);
    expect(thirdHeaders.get("Authorization")).toBe("Bearer token-b");
  });
});
