import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { WorkSessionServicePort } from "./port.js";

const campaignRouteParametersSchema = z.object({
  campaignRouteId: z.uuid(),
  crewId: z.uuid(),
});
const workSessionParametersSchema = z.object({
  crewId: z.uuid(),
  workSessionId: z.uuid(),
});
const startSchema = z
  .object({
    deviceId: z.uuid(),
    operationId: z.uuid(),
  })
  .strict();
const joinSchema = startSchema;
const finishSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    operationId: z.uuid(),
  })
  .strict();

function authorizationHeader(authorization: string | undefined): string | undefined {
  return authorization;
}

export async function registerWorkSessionRoutes(
  server: FastifyInstance,
  options: { auth: AuthService; workSessionService: WorkSessionServicePort },
): Promise<void> {
  server.post(
    "/api/crews/:crewId/campaign-routes/:campaignRouteId/work-sessions",
    async (request, reply) => {
      const { campaignRouteId, crewId } = campaignRouteParametersSchema.parse(request.params);
      const input = startSchema.parse(request.body);
      const user = await options.auth.authenticate(
        authorizationHeader(request.headers.authorization),
      );
      await options.auth.requireCapability(user.id, crewId, "SESSION_START");
      const result = await options.workSessionService.start({
        actorUserId: user.id,
        campaignRouteId,
        crewId,
        ...input,
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    },
  );

  server.get(
    "/api/crews/:crewId/campaign-routes/:campaignRouteId/work-sessions/current",
    async (request) => {
      const { campaignRouteId, crewId } = campaignRouteParametersSchema.parse(request.params);
      const user = await options.auth.authenticate(
        authorizationHeader(request.headers.authorization),
      );
      await options.auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
      return {
        workSession: await options.workSessionService.getCurrent({
          actorUserId: user.id,
          campaignRouteId,
          crewId,
        }),
      };
    },
  );

  server.get("/api/crews/:crewId/work-sessions/:workSessionId", async (request, reply) => {
    const { crewId, workSessionId } = workSessionParametersSchema.parse(request.params);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
    const workSession = await options.workSessionService.get({
      actorUserId: user.id,
      crewId,
      workSessionId,
    });
    if (!workSession) return reply.code(404).send({ code: "WORK_SESSION_NOT_FOUND" });
    return workSession;
  });

  server.post("/api/crews/:crewId/work-sessions/:workSessionId/join", async (request) => {
    const { crewId, workSessionId } = workSessionParametersSchema.parse(request.params);
    const input = joinSchema.parse(request.body);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "SESSION_JOIN");
    return options.workSessionService.join({
      actorUserId: user.id,
      crewId,
      workSessionId,
      ...input,
    });
  });

  server.post("/api/crews/:crewId/work-sessions/:workSessionId/finish", async (request) => {
    const { crewId, workSessionId } = workSessionParametersSchema.parse(request.params);
    const input = finishSchema.parse(request.body);
    const user = await options.auth.authenticate(
      authorizationHeader(request.headers.authorization),
    );
    await options.auth.requireCapability(user.id, crewId, "SESSION_START");
    return options.workSessionService.finish({
      actorUserId: user.id,
      crewId,
      workSessionId,
      ...input,
    });
  });
}
