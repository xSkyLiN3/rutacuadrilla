import type { FastifyInstance } from "fastify";
import { accountEmailSchema, newAccountPasswordSchema } from "@rutacuadrilla/domain";
import { z } from "zod";
import { AuthenticationError, type AuthService } from "../auth/service.js";
import { etagMatches } from "../routes/package.js";
import type { RouteServicePort } from "../routes/port.js";
import {
  representSimpleAssignment,
  simpleAssignmentHeaders,
  simpleAssignmentNotModifiedHeaders,
} from "./assignmentRepresentation.js";
import { SimpleApplicationError, type SimpleService, simplePointStates } from "./service.js";

const crewParametersSchema = z.object({ crewId: z.uuid() });
const userParametersSchema = crewParametersSchema.extend({ userId: z.uuid() });
const pointParametersSchema = z.object({ pointId: z.uuid() });
const createUserSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: accountEmailSchema,
  password: newAccountPasswordSchema,
});
const assignmentSchema = z.object({ routeId: z.uuid() });
const initialSegmentSchema = z.object({
  attribution: z.string().trim().max(500).optional(),
  externalId: z.string().trim().min(1).max(160),
  geometry: z.unknown(),
  name: z.string().trim().max(200).optional(),
  serviceSide: z.enum(["LEFT", "RIGHT", "BOTH"]).default("BOTH"),
  source: z.enum(["MANUAL", "OSM", "GEOJSON"]),
  sourceVersion: z.string().trim().max(120).optional(),
});
const importSchema = z.object({
  area: z.unknown().nullable().optional(),
  csv: z.string().min(1).max(5_000_000),
  operationId: z.uuid(),
  routeName: z.string().trim().min(1).max(120),
  sectorName: z.string().trim().min(1).max(120),
  segments: z.array(initialSegmentSchema).max(10_000).optional(),
});
const updatePointSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  operationId: z.uuid(),
  state: z.enum(simplePointStates),
});

async function requireAdministrator(
  auth: AuthService,
  authorization: string | undefined,
  crewId: string,
) {
  const user = await auth.authenticate(authorization);
  const membership = (await auth.memberships(user.id)).find(
    (candidate) => candidate.crewId === crewId,
  );
  if (membership?.role !== "ADMIN") {
    throw new AuthenticationError("FORBIDDEN", 403);
  }
  return { membership, user };
}

export async function registerSimpleRoutes(
  server: FastifyInstance,
  dependencies: {
    auth: AuthService;
    routeService: RouteServicePort;
    simpleService: SimpleService;
  },
): Promise<void> {
  server.get("/api/simple/admin/crews/:crewId/overview", async (request) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    await requireAdministrator(dependencies.auth, request.headers.authorization, crewId);
    return dependencies.simpleService.overview(crewId);
  });

  server.post("/api/simple/admin/crews/:crewId/users", async (request, reply) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const input = createUserSchema.parse(request.body);
    const { membership } = await requireAdministrator(
      dependencies.auth,
      request.headers.authorization,
      crewId,
    );
    const user = await dependencies.simpleService.createUser({
      actorMembershipId: membership.membershipId,
      crewId,
      ...input,
    });
    return reply.code(201).send(user);
  });

  server.put("/api/simple/admin/crews/:crewId/users/:userId/assignment", async (request) => {
    const { crewId, userId } = userParametersSchema.parse(request.params);
    const input = assignmentSchema.parse(request.body);
    const { membership } = await requireAdministrator(
      dependencies.auth,
      request.headers.authorization,
      crewId,
    );
    return dependencies.simpleService.assignRoute({
      actorMembershipId: membership.membershipId,
      crewId,
      routeId: input.routeId,
      userId,
    });
  });

  server.delete(
    "/api/simple/admin/crews/:crewId/users/:userId/assignment",
    async (request, reply) => {
      const { crewId, userId } = userParametersSchema.parse(request.params);
      const { membership } = await requireAdministrator(
        dependencies.auth,
        request.headers.authorization,
        crewId,
      );
      await dependencies.simpleService.unassignRoute({
        actorMembershipId: membership.membershipId,
        crewId,
        userId,
      });
      return reply.code(204).send();
    },
  );

  server.post("/api/simple/admin/crews/:crewId/routes/import", async (request, reply) => {
    const { crewId } = crewParametersSchema.parse(request.params);
    const input = importSchema.parse(request.body);
    const { user } = await requireAdministrator(
      dependencies.auth,
      request.headers.authorization,
      crewId,
    );
    const imported = await dependencies.routeService.importRoute({
      actorUserId: user.id,
      ...(input.area === undefined ? {} : { area: input.area }),
      crewId,
      csv: input.csv,
      importKey: `simple-${input.operationId}`,
      routeName: input.routeName,
      sectorName: input.sectorName,
      ...(input.segments === undefined ? {} : { segments: input.segments }),
    });
    if (imported.errors.length > 0) {
      return reply.code(422).send({ code: "CSV_VALIDATION_FAILED", errors: imported.errors });
    }
    if (!imported.route || !imported.revision) {
      throw new SimpleApplicationError("ROUTE_IMPORT_INCOMPLETE", 500);
    }
    const route =
      imported.revision.status === "DRAFT"
        ? await dependencies.routeService.publishRevision({
            actorUserId: user.id,
            crewId,
            revisionId: imported.revision.id,
            routeId: imported.route.id,
          })
        : imported.route;
    return reply.code(imported.created ? 201 : 200).send({ route });
  });

  server.get("/api/simple/field/assignment", async (request, reply) => {
    const user = await dependencies.auth.authenticate(request.headers.authorization);
    const representation = representSimpleAssignment(
      await dependencies.simpleService.myAssignment(user.id),
    );
    if (etagMatches(request.headers["if-none-match"], representation.etag)) {
      return reply.headers(simpleAssignmentNotModifiedHeaders(representation)).code(304).send();
    }
    return reply.headers(simpleAssignmentHeaders(representation)).send(representation.body);
  });

  server.put("/api/simple/field/assignment/points/:pointId", async (request) => {
    const { pointId } = pointParametersSchema.parse(request.params);
    const input = updatePointSchema.parse(request.body);
    const user = await dependencies.auth.authenticate(request.headers.authorization);
    return dependencies.simpleService.updatePoint({ pointId, userId: user.id, ...input });
  });
}
