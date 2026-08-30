import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { createDemoAdminApi } from "./demo";

describe("createDemoAdminApi", () => {
  it("crea el contexto técnico v3 con sus tramos y lados operativos", async () => {
    const api = createDemoAdminApi({ delayMs: 0 });
    await api.login("admin@demo.cl", "demo1234");

    const result = await api.createTechnicalContext(
      "crew-halcones",
      "revision-a-1",
      "Campaña de prueba",
    );

    expect(result.contractVersion).toBe("p0-provisional-v3");
    expect(result.context).toMatchObject({
      campaignName: "Campaña de prueba",
      pointCount: 3,
      segmentCount: 1,
    });
    expect(result.segments).toEqual([
      expect.objectContaining({
        externalId: "manual/los-aromos-publicada",
        serviceSide: "LEFT",
      }),
    ]);
  });

  it("reproduce el ciclo multirruta, la exclusividad del camión y el bloqueo al activar", async () => {
    const api = createDemoAdminApi({ delayMs: 0 });
    await api.login("admin@demo.cl", "demo1234");
    const firstVehicle = (await api.listVehicles("crew-halcones"))[0];
    const secondVehicle = await api.createVehicle("crew-halcones", {
      name: "Camión Sur",
      registration: "RC-02",
    });
    const campaign = await api.createCampaign("crew-halcones", {
      name: "Campaña multirruta",
      startsOn: "2026-09-01",
      endsOn: "2026-09-30",
    });

    await expect(
      api.assignCampaignRoute("crew-halcones", campaign.id, {
        routeRevisionId: "revision-a-1",
        vehicleId: firstVehicle.id,
      }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      api.assignCampaignRoute("crew-halcones", campaign.id, {
        routeRevisionId: "revision-b-1",
        vehicleId: firstVehicle.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CAMPAIGN_VEHICLE_DUPLICATE" });
    await api.assignCampaignRoute("crew-halcones", campaign.id, {
      routeRevisionId: "revision-b-1",
      vehicleId: secondVehicle.id,
    });

    const active = await api.activateCampaign("crew-halcones", campaign.id);
    expect(active).toMatchObject({ status: "ACTIVE", routeCount: 2, pointCount: 5 });
    expect(active.routes.map((route) => route.segmentSideClaimCount)).toEqual([1, 1]);
    await expect(
      api.getCurrentWorkSession?.("crew-halcones", active.routes[0].id),
    ).resolves.toEqual({ workSession: null });
    const firstAssignment = active.routes[0];
    await expect(
      api.removeCampaignRoute("crew-halcones", campaign.id, firstAssignment.id),
    ).rejects.toMatchObject({ status: 409, code: "CAMPAIGN_INVALID_STATE" });
  });

  it("mantiene 403 para una membresía sin capacidad administrativa", async () => {
    const api = createDemoAdminApi({ delayMs: 0 });
    await api.login("admin@demo.cl", "demo1234");

    await expect(api.listCampaigns("crew-forbidden")).rejects.toBeInstanceOf(ApiError);
    await expect(api.listCampaigns("crew-forbidden")).rejects.toMatchObject({ status: 403 });
  });
});
