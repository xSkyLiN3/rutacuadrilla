import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdminApi } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpAdminApi", () => {
  it("envía Bearer token y codifica identificadores de rutas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpAdminApi("https://api.example.test/");
    api.setToken("token-seguro");

    await api.listRoutes("crew con espacio");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/crews/crew%20con%20espacio/routes");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer token-seguro");
    expect((init.headers as Headers).get("Accept")).toBe("application/json");
  });

  it("implementa el payload exacto de login", async () => {
    const response = {
      token: "abc",
      expiresAt: "2026-08-12T00:00:00Z",
      user: { id: "u1", name: "Camila", email: "camila@example.test" },
      memberships: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpAdminApi("");

    await api.login("camila@example.test", "secreto");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "camila@example.test",
      password: "secreto",
    });
  });

  it("conserva la geografía inicial opcional al importar una ruta simple", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ route: { id: "route-1", revisions: [] } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpAdminApi("/backend");
    api.setToken("token");
    const area = {
      coordinates: [
        [
          [
            [-0.1, -0.1] as [number, number],
            [0.1, -0.1] as [number, number],
            [0.1, 0.1] as [number, number],
            [-0.1, -0.1] as [number, number],
          ],
        ],
      ],
      type: "MultiPolygon" as const,
    };
    const segments = [
      {
        externalId: "synthetic/segment/001",
        geometry: {
          coordinates: [[[-0.1, 0] as [number, number], [0.1, 0] as [number, number]]],
          type: "MultiLineString" as const,
        },
        serviceSide: "BOTH" as const,
        source: "GEOJSON" as const,
      },
    ];

    await api.importSimpleRoute("crew-1", {
      area,
      csv: "external_id,street,number,latitude,longitude,point_type,source\nsynthetic/1,A,1,0,0,DWELLING,GEOJSON",
      operationId: "44444444-4444-4444-8444-444444444444",
      routeName: "Ruta demo",
      sectorName: "Sector demo",
      segments,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/backend/api/simple/admin/crews/crew-1/routes/import");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ area, segments });
  });

  it("traduce códigos de error de la API a mensajes seguros", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "INVALID_CREDENTIALS" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpAdminApi("");

    await expect(api.login("nadie@example.test", "incorrecta")).rejects.toMatchObject({
      status: 401,
      code: "INVALID_CREDENTIALS",
      message: "Correo o contraseña incorrectos.",
    });
  });

  it("consume los contratos directos de detalle, importación, edición y publicación", async () => {
    const route = {
      id: "route-1",
      crewId: "crew-1",
      name: "Centro",
      sectorName: "Centro norte",
      revisions: [],
      updatedAt: "2026-08-11T00:00:00Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(route), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ route, revision: { id: "revision-1" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ route, revision: { id: "revision-1" }, errors: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(route), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpAdminApi("/backend");
    api.setToken("token");

    await expect(api.getRoute("crew-1", "route-1")).resolves.toEqual(route);
    await api.importRoute("crew-1", {
      routeName: "Centro",
      sectorName: "Centro norte",
      importKey: "lote-1",
      csv:
        "external_id,street,number,latitude,longitude,point_type,source\n" +
        "home-001,A,1,-33,-70,DWELLING,CSV",
    });
    await api.editRevisionPoints("crew-1", "route-1", "revision-1", {
      editKey: "edit-1",
      csv:
        "external_id,street,number,latitude,longitude,point_type,source\n" +
        "home-001,A,2,-33,-70,DWELLING,CSV",
    });
    await expect(api.publishRevision("crew-1", "route-1", "revision-1")).resolves.toEqual(route);

    const [detailUrl, detailInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [importUrl, importInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const [editUrl, editInit] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    const [publishUrl, publishInit] = fetchMock.mock.calls[3] as unknown as [string, RequestInit];
    expect(detailUrl).toBe("/backend/api/crews/crew-1/routes/route-1");
    expect(detailInit.method).toBeUndefined();
    expect(importUrl).toBe("/backend/api/crews/crew-1/routes/import");
    expect(importInit.method).toBe("POST");
    expect(JSON.parse(importInit.body as string)).toMatchObject({ importKey: "lote-1" });
    expect(editUrl).toBe("/backend/api/crews/crew-1/routes/route-1/revisions/revision-1/points");
    expect(editInit.method).toBe("PUT");
    expect(JSON.parse(editInit.body as string)).toMatchObject({ editKey: "edit-1" });
    expect(publishUrl).toBe(
      "/backend/api/crews/crew-1/routes/route-1/revisions/revision-1/publish",
    );
    expect(publishInit.method).toBe("POST");
  });

  it("descarga el paquete con la sesión privada sin convertirlo prematuramente a JSON", async () => {
    const body = JSON.stringify({ kind: "ROUTE_REVISION_PACKAGE", schemaVersion: 1 });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: {
          "Content-Length": String(new TextEncoder().encode(body).byteLength),
          "Content-Type": "application/vnd.rutacuadrilla.route-package+json; version=1",
          ETag: '"sha256-package"',
          "X-Package-SHA256": "a".repeat(64),
        },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpAdminApi("/backend");
    api.setToken("token");

    await expect(
      api.downloadRoutePackage("crew-1", "route-1", "revision-1"),
    ).resolves.toMatchObject({
      download: { body, sha256: "a".repeat(64) },
      status: "DOWNLOADED",
    });
  });

  it("consume el contrato de vehículos y campañas, incluido DELETE de una asignación", async () => {
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const vehicle = {
      id: "vehicle-1",
      name: "Camión Norte",
      status: "ACTIVE",
      createdAt: "2026-08-13T00:00:00Z",
    };
    const campaign = {
      id: "campaign-1",
      name: "Primavera",
      status: "DRAFT",
      currency: "CLP",
      timezone: "America/Santiago",
      pointCount: 0,
      routeCount: 0,
      routes: [],
      createdAt: "2026-08-13T00:00:00Z",
      updatedAt: "2026-08-13T00:00:00Z",
    };
    const assignment = {
      id: "campaign-route-1",
      routeId: "route-1",
      routeName: "Ruta Norte",
      routeRevisionId: "revision-1",
      routeContentHash: "sha256:one",
      pointCount: 10,
      segmentSideClaimCount: 2,
      status: "ACTIVE",
      vehicle,
      createdAt: "2026-08-13T00:00:00Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json([vehicle]))
      .mockResolvedValueOnce(json(vehicle, 201))
      .mockResolvedValueOnce(json([campaign]))
      .mockResolvedValueOnce(json(campaign))
      .mockResolvedValueOnce(json(campaign, 201))
      .mockResolvedValueOnce(json({ assignment, created: true }, 201))
      .mockResolvedValueOnce(json(campaign))
      .mockResolvedValueOnce(json({ ...campaign, status: "ACTIVE" }))
      .mockResolvedValueOnce(json({ workSession: null }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpAdminApi("/backend");
    api.setToken("token");

    await api.listVehicles("crew 1");
    await api.createVehicle("crew 1", { name: "Camión Norte" });
    await api.listCampaigns("crew 1");
    await api.getCampaign("crew 1", "campaign 1");
    await api.createCampaign("crew 1", {
      name: "Primavera",
      timezone: "America/Santiago",
      currency: "CLP",
    });
    await api.assignCampaignRoute("crew 1", "campaign 1", {
      routeRevisionId: "revision-1",
      vehicleId: "vehicle-1",
    });
    await api.removeCampaignRoute("crew 1", "campaign 1", "campaign route 1");
    await api.activateCampaign("crew 1", "campaign 1");
    await api.getCurrentWorkSession("crew 1", "campaign route 1");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/backend/api/crews/crew%201/vehicles",
      "/backend/api/crews/crew%201/vehicles",
      "/backend/api/crews/crew%201/campaigns",
      "/backend/api/crews/crew%201/campaigns/campaign%201",
      "/backend/api/crews/crew%201/campaigns",
      "/backend/api/crews/crew%201/campaigns/campaign%201/routes",
      "/backend/api/crews/crew%201/campaigns/campaign%201/routes/campaign%20route%201",
      "/backend/api/crews/crew%201/campaigns/campaign%201/activate",
      "/backend/api/crews/crew%201/campaign-routes/campaign%20route%201/work-sessions/current",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual([
      undefined,
      "POST",
      undefined,
      undefined,
      "POST",
      "POST",
      "DELETE",
      "POST",
      undefined,
    ]);
  });

  it("conserva detalles tipados de un conflicto de cobertura sin usar el mensaje remoto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "CAMPAIGN_POINT_DUPLICATE",
          message: "mensaje remoto no confiable",
          details: { conflictCount: 2, conflicts: [] },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpAdminApi("");

    await expect(
      api.assignCampaignRoute("crew-1", "campaign-1", {
        routeRevisionId: "revision-1",
        vehicleId: "vehicle-1",
      }),
    ).rejects.toMatchObject({
      code: "CAMPAIGN_POINT_DUPLICATE",
      details: { conflictCount: 2 },
      message:
        "Un punto con el mismo identificador estable ya pertenece a otra ruta de la campaña.",
    });
  });
});
