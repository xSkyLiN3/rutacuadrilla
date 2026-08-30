import { provisionalPointStates } from "@rutacuadrilla/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import {
  etagMatches,
  representRoutePackage,
  routePackageHeaders,
  routePackageNotModifiedHeaders,
} from "../routes/package.js";
import type { PushCommandsInput, SyncServicePort } from "./port.js";

const crewParametersSchema = z.object({ crewId: z.uuid() });
const contextParametersSchema = crewParametersSchema.extend({ contextId: z.uuid() });
const createContextSchema = z
  .object({
    campaignName: z.string().trim().min(1).max(160).optional(),
    routeRevisionId: z.uuid(),
  })
  .strict();
const commandBaseSchema = z.object({
  baseVersion: z.number().int().nonnegative(),
  campaignPointId: z.uuid(),
  dependsOnOperationId: z.uuid().optional(),
  deviceId: z.uuid(),
  occurredAtDevice: z.iso.datetime({ offset: true }).optional(),
  operationId: z.uuid(),
  workSessionId: z.uuid(),
});
const commandSchema = z.discriminatedUnion("type", [
  commandBaseSchema.extend({
    payload: z.object({ state: z.enum(provisionalPointStates) }).strict(),
    type: z.literal("POINT_STATUS_CHANGED"),
  }),
  commandBaseSchema.extend({
    payload: z.object({ revertsOperationId: z.uuid() }).strict(),
    type: z.literal("POINT_STATUS_REVERTED"),
  }),
]);
const batchSchema = z.object({ commands: z.array(commandSchema).min(1).max(100) }).strict();
const changesQuerySchema = z.object({
  after: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function authorizationHeader(authorization: string | undefined): string | undefined {
  return authorization;
}

export async function registerSyncRoutes(
  server: FastifyInstance,
  options: { auth: AuthService; syncService: SyncServicePort },
): Promise<void> {
  server.post("/api/crews/:crewId/sync/contexts", async (request) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const input = createContextSchema.parse(request.body);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "CAMPAIGN_MANAGE");
    return options.syncService.createTechnicalContext({
      actorUserId: user.id,
      crewId,
      routeRevisionId: input.routeRevisionId,
      ...(input.campaignName ? { campaignName: input.campaignName } : {}),
    });
  });

  server.get("/api/crews/:crewId/sync/contexts", async (request) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
    return {
      contexts: await options.syncService.listContexts({ actorUserId: user.id, crewId }),
    };
  });

  server.get("/api/crews/:crewId/sync/contexts/:contextId", async (request, reply) => {
    const { contextId, crewId } = contextParametersSchema.parse(request.params);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
    const context = await options.syncService.getContextPackage({
      actorUserId: user.id,
      contextId,
      crewId,
    });
    if (!context) return reply.code(404).send({ code: "CONTEXT_NOT_FOUND" });
    const representation = representRoutePackage(context);
    if (etagMatches(request.headers["if-none-match"], representation.etag)) {
      return reply.headers(routePackageNotModifiedHeaders(representation)).code(304).send();
    }
    return reply
      .headers({
        ...routePackageHeaders(representation),
        "Content-Type": "application/vnd.rutacuadrilla.field-context+json; version=3",
      })
      .code(200)
      .send(representation.body);
  });

  server.post("/api/crews/:crewId/sync/commands", async (request) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const input = batchSchema.parse(request.body);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "POINT_MARK");
    if (input.commands.some((command) => command.type === "POINT_STATUS_REVERTED")) {
      await options.auth.requireCapability(user.id, crewId, "POINT_CORRECT");
    }
    return options.syncService.pushCommands({
      actorUserId: user.id,
      commands: input.commands as PushCommandsInput["commands"],
      crewId,
    });
  });

  server.get("/api/crews/:crewId/sync/changes", async (request) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const query = changesQuerySchema.parse(request.query);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
    return options.syncService.pullChanges({
      actorUserId: user.id,
      crewId,
      ...(query.after ? { cursor: query.after } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
  });
}
