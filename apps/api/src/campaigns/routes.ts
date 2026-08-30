import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { CampaignServicePort } from "./port.js";

const crewParametersSchema = z.object({ crewId: z.uuid() });
const campaignParametersSchema = crewParametersSchema.extend({ campaignId: z.uuid() });
const campaignRouteParametersSchema = campaignParametersSchema.extend({
  campaignRouteId: z.uuid(),
});
const vehicleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    registration: z.string().trim().min(1).max(32).optional(),
  })
  .strict();
const campaignSchema = z
  .object({
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/u)
      .optional(),
    endsOn: z.iso.date().optional(),
    name: z.string().trim().min(1).max(160),
    startsOn: z.iso.date().optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine((value) => !value.startsOn || !value.endsOn || value.startsOn <= value.endsOn, {
    message: "startsOn must be before or equal to endsOn",
    path: ["endsOn"],
  });
const routeAssignmentSchema = z
  .object({
    routeRevisionId: z.uuid(),
    vehicleId: z.uuid(),
  })
  .strict();

function authorizationHeader(authorization: string | undefined): string | undefined {
  return authorization;
}

export async function registerCampaignRoutes(
  server: FastifyInstance,
  options: { auth: AuthService; campaignService: CampaignServicePort },
): Promise<void> {
  server.get("/api/crews/:crewId/vehicles", async (request) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
    return options.campaignService.listVehicles({ actorUserId: user.id, crewId });
  });

  server.post("/api/crews/:crewId/vehicles", async (request, reply) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const input = vehicleSchema.parse(request.body);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "CAMPAIGN_MANAGE");
    const vehicle = await options.campaignService.createVehicle({
      actorUserId: user.id,
      crewId,
      name: input.name,
      ...(input.registration ? { registration: input.registration } : {}),
    });
    return reply.code(201).send(vehicle);
  });

  server.get("/api/crews/:crewId/campaigns", async (request) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
    return options.campaignService.listCampaigns({ actorUserId: user.id, crewId });
  });

  server.post("/api/crews/:crewId/campaigns", async (request, reply) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const input = campaignSchema.parse(request.body);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "CAMPAIGN_MANAGE");
    const campaign = await options.campaignService.createCampaign({
      actorUserId: user.id,
      crewId,
      name: input.name,
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.endsOn ? { endsOn: input.endsOn } : {}),
      ...(input.startsOn ? { startsOn: input.startsOn } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });
    return reply.code(201).send(campaign);
  });

  server.get("/api/crews/:crewId/campaigns/:campaignId", async (request, reply) => {
    const { campaignId, crewId } = campaignParametersSchema.parse(request.params);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
    const campaign = await options.campaignService.getCampaign({
      actorUserId: user.id,
      campaignId,
      crewId,
    });
    if (!campaign) return reply.code(404).send({ code: "CAMPAIGN_NOT_FOUND" });
    return campaign;
  });

  server.post("/api/crews/:crewId/campaigns/:campaignId/routes", async (request, reply) => {
    const { campaignId, crewId } = campaignParametersSchema.parse(request.params);
    const input = routeAssignmentSchema.parse(request.body);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "CAMPAIGN_MANAGE");
    const result = await options.campaignService.assignRoute({
      actorUserId: user.id,
      campaignId,
      crewId,
      routeRevisionId: input.routeRevisionId,
      vehicleId: input.vehicleId,
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  server.delete(
    "/api/crews/:crewId/campaigns/:campaignId/routes/:campaignRouteId",
    async (request) => {
      const { campaignId, campaignRouteId, crewId } = campaignRouteParametersSchema.parse(
        request.params,
      );
      const user = await options.auth.authenticate(
        authorizationHeader(request.headers.authorization),
      );
      await options.auth.requireCapability(user.id, crewId, "CAMPAIGN_MANAGE");
      return options.campaignService.removeRoute({
        actorUserId: user.id,
        campaignId,
        campaignRouteId,
        crewId,
      });
    },
  );

  server.post("/api/crews/:crewId/campaigns/:campaignId/activate", async (request) => {
    const { campaignId, crewId } = campaignParametersSchema.parse(request.params);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "CAMPAIGN_MANAGE");
    return options.campaignService.activateCampaign({
      actorUserId: user.id,
      campaignId,
      crewId,
    });
  });
}
