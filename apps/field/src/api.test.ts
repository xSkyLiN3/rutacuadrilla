import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldApi, type FieldApiError, sha256Hex } from "./api";

function contextBody() {
  return JSON.stringify({
    contractVersion: "p0-provisional-v3",
    context: {
      campaignId: "campaign-1",
      campaignName: "Campaña técnica",
      contentHash: "a".repeat(64),
      id: "context-1",
      pointCount: 1,
      routeId: "route-1",
      routeName: "Ruta uno",
      routeRevisionId: "revision-1",
      segmentCount: 1,
      vehicleId: "vehicle-1",
      vehicleName: "Camión Azul",
    },
    segments: [
      {
        displayOrder: 0,
        externalId: "street-external-1",
        geometry: {
          coordinates: [
            [
              [-0.67, -0.45],
              [-0.66, -0.44],
            ],
          ],
          type: "MultiLineString",
        },
        id: "segment-1",
        name: "Los Aromos",
        serviceSide: "LEFT",
        source: "OSM",
        streetSegmentVersionId: "segment-version-1",
      },
    ],
    points: [
      {
        displayOrder: 0,
        displayState: "SIN_VISITAR",
        externalId: "point-external-1",
        id: "point-1",
        latitude: -0.45,
        longitude: -0.66,
        pointType: "DWELLING",
        version: 0,
      },
    ],
  });
}

function pendingOperation() {
  return {
    accountId: "account-1",
    aggregateId: "point-1",
    baseVersion: 0,
    crewId: "crew-1",
    deviceId: "device-1",
    deviceSequence: 1,
    operationId: "operation-1",
    previousState: "SIN_VISITAR" as const,
    state: "PENDING" as const,
    toState: "VOLVER" as const,
    workSessionId: "work-session-1",
  };
}

function workSession(version = 1) {
  return {
    campaignId: "campaign-1",
    campaignRouteId: "context-1",
    devices: [
      {
        deviceId: "device-1",
        joinedAt: "2026-08-21T10:00:00.000Z",
        membershipId: "membership-1",
      },
    ],
    id: "work-session-1",
    participants: [
      {
        displayName: "Conductora Uno",
        joinedAt: "2026-08-21T10:00:00.000Z",
        membershipId: "membership-1",
        profile: "DRIVER",
      },
    ],
    startedAt: "2026-08-21T10:00:00.000Z",
    startedByDeviceId: "device-1",
    startedByMembershipId: "membership-1",
    status: "ACTIVE",
    version,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FieldApi verified context", () => {
  it("usa los endpoints anidados de jornada y valida sus respuestas exactas", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ created: true, replayed: false, workSession: workSession() }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceJoined: true,
            participantJoined: false,
            replayed: false,
            workSession: workSession(2),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            replayed: false,
            workSession: {
              ...workSession(3),
              finishedAt: "2026-08-21T11:00:00.000Z",
              finishedByMembershipId: "membership-1",
              status: "FINISHED",
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new FieldApi("https://api.test");

    await expect(
      api.startWorkSession("crew-1", "context-1", {
        deviceId: "device-1",
        operationId: "start-1",
      }),
    ).resolves.toMatchObject({ created: true, replayed: false });
    await expect(
      api.joinWorkSession("crew-1", "work-session-1", {
        deviceId: "device-1",
        operationId: "join-1",
      }),
    ).resolves.toMatchObject({ deviceJoined: true, participantJoined: false });
    await expect(
      api.finishWorkSession("crew-1", "work-session-1", {
        expectedVersion: 2,
        operationId: "finish-1",
      }),
    ).resolves.toMatchObject({ workSession: { status: "FINISHED", version: 3 } });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.test/api/crews/crew-1/campaign-routes/context-1/work-sessions",
      "https://api.test/api/crews/crew-1/work-sessions/work-session-1/join",
      "https://api.test/api/crews/crew-1/work-sessions/work-session-1/finish",
    ]);
    const finishRequest = fetchMock.mock.calls[2]?.[1] as RequestInit | undefined;
    if (!finishRequest) throw new Error("TEST_FINISH_REQUEST_MISSING");
    expect(JSON.parse(String(finishRequest.body))).toEqual({
      expectedVersion: 2,
      operationId: "finish-1",
    });
  });

  it("distingue 200 sin jornada de un 404 real", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ workSession: null })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "WORK_SESSION_NOT_FOUND" }), { status: 404 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new FieldApi("https://api.test");

    await expect(api.getCurrentWorkSession("crew-1", "context-1")).resolves.toBeNull();
    await expect(api.getCurrentWorkSession("crew-1", "missing")).rejects.toMatchObject({
      message: "La jornada ya no está disponible.",
      status: 404,
    });
  });

  it("rechaza una identidad de servidor sin membershipId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            expiresAt: "2026-08-21T20:00:00.000Z",
            memberships: [{ crewId: "crew-1", crewName: "Cuadrilla", role: "MEMBER" }],
            token: "token",
            user: { email: "field@example.test", id: "user-1", name: "Field" },
          }),
        ),
      ),
    );

    await expect(
      new FieldApi("https://api.test").login("field@example.test", "secret"),
    ).rejects.toMatchObject({
      message: "Las membresías recibidas no son compatibles.",
      status: 409,
    });
  });

  it("verifies exact response bytes before returning a local package", async () => {
    const body = contextBody();
    const sha256 = await sha256Hex(body);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: {
          "Content-Length": String(new TextEncoder().encode(body).byteLength),
          ETag: `"sha256-${sha256}"`,
          "X-Package-SHA256": sha256,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = new FieldApi("https://api.test");
    api.setToken("test-token");
    const result = await api.downloadContext("crew-1", "context-1");

    expect(result.transportSha256).toBe(sha256);
    expect(result.rawBody).toBe(body);
    expect(result.points[0]).toMatchObject({ displayOrder: 0, id: "point-1" });
    expect(result.segments[0]).toMatchObject({
      id: "segment-1",
      serviceSide: "LEFT",
    });
    expect(result).toMatchObject({ vehicleId: "vehicle-1", vehicleName: "Camión Azul" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/crews/crew-1/sync/contexts/context-1",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("rechaza un contexto anterior sin la colección obligatoria de tramos", async () => {
    const parsed = JSON.parse(contextBody()) as Record<string, unknown>;
    delete parsed.segments;
    const body = JSON.stringify(parsed);
    const sha256 = await sha256Hex(body);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: {
            ETag: `"sha256-${sha256}"`,
            "X-Package-SHA256": sha256,
          },
        }),
      ),
    );

    await expect(
      new FieldApi("https://api.test").downloadContext("crew-1", "context-1"),
    ).rejects.toMatchObject({
      message: "Los tramos del paquete de campo no son compatibles.",
      status: 409,
    });
  });

  it("rechaza un paquete v1 aunque sus bytes y tramos sean válidos", async () => {
    const parsed = JSON.parse(contextBody()) as { contractVersion: string };
    parsed.contractVersion = "p0-provisional-v1";
    const body = JSON.stringify(parsed);
    const sha256 = await sha256Hex(body);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: {
            ETag: `"sha256-${sha256}"`,
            "X-Package-SHA256": sha256,
          },
        }),
      ),
    );

    await expect(
      new FieldApi("https://api.test").downloadContext("crew-1", "context-1"),
    ).rejects.toMatchObject({
      message: "La versión del paquete de campo no es compatible.",
      status: 409,
    });
  });

  it("rechaza listados que omiten el conteo de tramos", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            contexts: [
              {
                campaignId: "campaign-1",
                campaignName: "Campaña técnica",
                contentHash: "a".repeat(64),
                id: "context-1",
                pointCount: 1,
                routeRevisionId: "revision-1",
              },
            ],
          }),
        ),
      ),
    );

    await expect(new FieldApi("https://api.test").listContexts("crew-1")).rejects.toMatchObject({
      message: "La lista de contextos no incluye conteos compatibles.",
      status: 409,
    });
  });

  it("rechaza un lado de calle ajeno al contrato", async () => {
    const parsed = JSON.parse(contextBody()) as {
      segments: Array<{ serviceSide: string }>;
    };
    const firstSegment = parsed.segments[0];
    if (!firstSegment) throw new Error("TEST_SEGMENT_FIXTURE_MISSING");
    firstSegment.serviceSide = "NEAREST";
    const body = JSON.stringify(parsed);
    const sha256 = await sha256Hex(body);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: {
            ETag: `"sha256-${sha256}"`,
            "X-Package-SHA256": sha256,
          },
        }),
      ),
    );

    await expect(
      new FieldApi("https://api.test").downloadContext("crew-1", "context-1"),
    ).rejects.toMatchObject({
      message: "Los tramos del paquete de campo no son compatibles.",
      status: 409,
    });
  });

  it("rejects a body whose digest does not match the response headers", async () => {
    const body = contextBody();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: {
            ETag: `"sha256-${"0".repeat(64)}"`,
            "X-Package-SHA256": "0".repeat(64),
          },
        }),
      ),
    );

    await expect(
      new FieldApi("https://api.test").downloadContext("crew-1", "context-1"),
    ).rejects.toEqual(
      expect.objectContaining<FieldApiError>({
        name: "FieldApiError",
        message: "La copia local no superó la verificación de integridad.",
        status: 409,
      }),
    );
  });

  it("omits an empty cursor when starting a complete pull", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          changes: [],
          contractVersion: "p0-provisional-v3",
          cursor: "cursor-1",
          hasMore: false,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new FieldApi("https://api.test").pullChanges("crew-1", "");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/crews/crew-1/sync/changes?limit=200",
    );
  });

  it("rejects a push response that omits an operation from the sent batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ contractVersion: "p0-provisional-v3", results: [] })),
        ),
    );

    await expect(
      new FieldApi("https://api.test").pushCommands("crew-1", [
        {
          accountId: "account-1",
          aggregateId: "point-1",
          baseVersion: 0,
          crewId: "crew-1",
          deviceId: "device-1",
          deviceSequence: 1,
          operationId: "operation-1",
          previousState: "SIN_VISITAR",
          state: "PENDING",
          toState: "VOLVER",
          workSessionId: "work-session-1",
        },
      ]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    {
      label: "APPLIED without state/version",
      result: { status: "APPLIED" },
    },
    {
      label: "CONFLICT without version",
      result: { state: "SIN_RESPUESTA", status: "CONFLICT" },
    },
    {
      label: "REJECTED without canonical evidence",
      result: { code: "INVALID_TRANSITION", status: "REJECTED" },
    },
    {
      label: "a malformed canonical pair",
      result: {
        canonicalState: "INVALID",
        canonicalVersion: 1,
        state: "VOLVER",
        status: "APPLIED",
        version: 1,
      },
    },
  ])("rejects $label before the local operation can be confirmed", async ({ result }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            contractVersion: "p0-provisional-v3",
            results: [
              {
                campaignPointId: "point-1",
                operationId: "operation-1",
                replayed: false,
                workSessionId: "work-session-1",
                ...result,
              },
            ],
          }),
        ),
      ),
    );

    await expect(
      new FieldApi("https://api.test").pushCommands("crew-1", [pendingOperation()]),
    ).rejects.toMatchObject({
      message: "La respuesta de sincronización no coincide con el lote enviado.",
      status: 409,
    });
  });

  it("allows BLOCKED_DEPENDENCY to omit canonical state while keeping it non-resolvable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            contractVersion: "p0-provisional-v3",
            results: [
              {
                campaignPointId: "point-1",
                code: "DEPENDENCY_NOT_CONFIRMED",
                operationId: "operation-1",
                replayed: false,
                status: "BLOCKED_DEPENDENCY",
                workSessionId: "work-session-1",
              },
            ],
          }),
        ),
      ),
    );

    await expect(
      new FieldApi("https://api.test").pushCommands("crew-1", [pendingOperation()]),
    ).resolves.toEqual([
      {
        code: "DEPENDENCY_NOT_CONFIRMED",
        operationId: "operation-1",
        replayed: false,
        status: "BLOCKED_DEPENDENCY",
        workSessionId: "work-session-1",
      },
    ]);
  });

  it("envía workSessionId en el lote y exige que el receipt conserve la atribución", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contractVersion: "p0-provisional-v3",
          results: [
            {
              campaignPointId: "point-1",
              operationId: "operation-1",
              replayed: false,
              state: "VOLVER",
              status: "APPLIED",
              version: 1,
              workSessionId: "work-session-1",
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FieldApi("https://api.test").pushCommands("crew-1", [pendingOperation()]),
    ).resolves.toMatchObject([{ status: "APPLIED", workSessionId: "work-session-1" }]);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      commands: [{ operationId: "operation-1", workSessionId: "work-session-1" }],
    });
  });

  it("conserva fail-closed una operación heredada y no hace ninguna llamada de red", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const legacy = pendingOperation();
    delete (legacy as { workSessionId?: string }).workSessionId;

    await expect(
      new FieldApi("https://api.test").pushCommands("crew-1", [legacy]),
    ).rejects.toMatchObject({
      message: "Hay operaciones heredadas conservadas que no pueden atribuirse a esta jornada.",
      status: 409,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a v1 push result before confirming the local operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            contractVersion: "p0-provisional-v1",
            results: [
              {
                campaignPointId: "point-1",
                operationId: "operation-1",
                replayed: false,
                state: "VOLVER",
                status: "APPLIED",
                version: 1,
              },
            ],
          }),
        ),
      ),
    );

    await expect(
      new FieldApi("https://api.test").pushCommands("crew-1", [
        {
          accountId: "account-1",
          aggregateId: "point-1",
          baseVersion: 0,
          crewId: "crew-1",
          deviceId: "device-1",
          deviceSequence: 1,
          operationId: "operation-1",
          previousState: "SIN_VISITAR",
          state: "PENDING",
          toState: "VOLVER",
          workSessionId: "work-session-1",
        },
      ]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an incompatible pull contract before returning changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            changes: [],
            contractVersion: "p0-provisional-v1",
            cursor: "cursor-1",
            hasMore: false,
          }),
        ),
      ),
    );

    await expect(new FieldApi("https://api.test").pullChanges("crew-1", "")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects malformed changes before a cursor can advance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            changes: [{ campaignPointId: "point-1", sequence: 1 }],
            contractVersion: "p0-provisional-v3",
            cursor: "cursor-2",
            hasMore: false,
          }),
        ),
      ),
    );

    await expect(
      new FieldApi("https://api.test").pullChanges("crew-1", "cursor-1"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a paginated pull that makes no progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            changes: [],
            contractVersion: "p0-provisional-v3",
            cursor: "cursor-1",
            hasMore: true,
          }),
        ),
      ),
    );

    await expect(
      new FieldApi("https://api.test").pullChanges("crew-1", "cursor-1"),
    ).rejects.toMatchObject({ status: 409 });
  });
});
