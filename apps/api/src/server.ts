import cors from "@fastify/cors";
import {
  accountEmailSchema,
  type DomainDatabase,
  loginPasswordSchema,
} from "@rutacuadrilla/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import {
  type LoginRateLimitAttempt,
  LoginRateLimitError,
  LoginRateLimiter,
} from "./auth/rateLimiter.js";
import { AuthenticationError, AuthService } from "./auth/service.js";
import type { CampaignServicePort } from "./campaigns/port.js";
import { registerCampaignRoutes } from "./campaigns/routes.js";
import type { ApiConfig } from "./config.js";
import {
  etagMatches,
  representRoutePackage,
  routePackageHeaders,
  routePackageNotModifiedHeaders,
} from "./routes/package.js";
import type { RouteServicePort } from "./routes/port.js";
import { registerSimpleRoutes } from "./simple/routes.js";
import { SimpleService } from "./simple/service.js";
import type { SyncServicePort } from "./sync/port.js";
import { registerSyncRoutes } from "./sync/routes.js";
import type { WorkSessionServicePort } from "./work-sessions/port.js";
import { registerWorkSessionRoutes } from "./work-sessions/routes.js";

const credentialsSchema = z.object({
  email: accountEmailSchema,
  password: loginPasswordSchema,
});
const crewParametersSchema = z.object({ crewId: z.uuid() });
const routeParametersSchema = z.object({ crewId: z.uuid(), routeId: z.uuid() });
const publishParametersSchema = routeParametersSchema.extend({ revisionId: z.uuid() });
const importSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  importKey: z.string().trim().min(8).max(120),
  routeName: z.string().trim().min(1).max(120),
  sectorName: z.string().trim().min(1).max(120),
});
const correctDraftPointsSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  editKey: z.string().trim().min(8).max(120),
});
const revisionChangeSchema = z.object({
  baseDraftVersion: z.number().int().positive(),
  change: z.unknown(),
  operationId: z.uuid(),
});
const osmPreviewSchema = z.object({ export: z.unknown() });

type ErrorWithStatus = Error & { code?: string; details?: unknown; statusCode?: number };

const safeDetailErrorCodes = new Set([
  "CAMPAIGN_POINT_DUPLICATE",
  "CAMPAIGN_ROUTE_DUPLICATE",
  "CAMPAIGN_SEGMENT_SIDE_DUPLICATE",
  "CAMPAIGN_SEGMENT_VERSION_AMBIGUOUS",
  "CAMPAIGN_VEHICLE_DUPLICATE",
  "POINT_VERSION_CONFLICT",
  "ROUTE_POINT_OVERLAP",
  "ROUTE_SEGMENT_SIDE_OVERLAP",
  "ROUTE_SEGMENT_VERSION_AMBIGUOUS",
  "VEHICLE_DUPLICATE",
  "WORK_SESSION_ALREADY_OPEN",
  "WORK_SESSION_DEVICE_CONFLICT",
  "WORK_SESSION_NOT_ACTIVE",
  "WORK_SESSION_SCOPE_MISMATCH",
  "WORK_SESSION_VERSION_CONFLICT",
]);

function requestAuthorization(authorization: string | undefined): string | undefined {
  return authorization;
}

export async function buildServer(options: {
  config: ApiConfig;
  database: DomainDatabase;
  campaignService: CampaignServicePort;
  routeService: RouteServicePort;
  syncService: SyncServicePort;
  workSessionService: WorkSessionServicePort;
}): Promise<FastifyInstance> {
  const server = Fastify({
    bodyLimit: 12_000_000,
    logger:
      options.config.environment === "test"
        ? false
        : {
            redact: {
              censor: "[REDACTED]",
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.body.password",
                "res.headers.set-cookie",
              ],
            },
          },
    trustProxy: options.config.trustProxy,
  });
  const auth = new AuthService(options.database, {
    secret: options.config.sessionSecret,
    ttlMinutes: options.config.sessionTtlMinutes,
  });
  const loginRateLimiter = new LoginRateLimiter();

  await server.register(cors, {
    allowedHeaders: ["Authorization", "Content-Type", "If-None-Match"],
    credentials: false,
    exposedHeaders: ["ETag", "X-Package-SHA256", "Content-Length"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    origin: options.config.corsOrigins,
  });

  server.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
    reply.header("Cross-Origin-Resource-Policy", "same-site");
    reply.header("X-Permitted-Cross-Domain-Policies", "none");
    if (request.url.startsWith("/api/")) {
      if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  if (options.config.appProfile === "full") {
    await registerSyncRoutes(server, { auth, syncService: options.syncService });
    await registerCampaignRoutes(server, { auth, campaignService: options.campaignService });
    await registerWorkSessionRoutes(server, {
      auth,
      workSessionService: options.workSessionService,
    });
  }
  await registerSimpleRoutes(server, {
    auth,
    routeService: options.routeService,
    simpleService: new SimpleService(options.database),
  });

  server.get("/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { service: "rutacuadrilla-api", status: "ok" };
  });

  server.get("/ready", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const databaseProbe = await options.database.query<{ ok: number }>("SELECT 1 AS ok");
      const migration = await options.database.query<{ name: string }>(
        "SELECT name FROM schema_migration WHERE name = $1 LIMIT 1",
        ["010_simple_online.sql"],
      );
      if (databaseProbe.rows[0]?.ok !== 1 || migration.rows[0]?.name !== "010_simple_online.sql") {
        return reply.code(503).send({ service: "rutacuadrilla-api", status: "not_ready" });
      }
      return reply.code(200).send({ service: "rutacuadrilla-api", status: "ready" });
    } catch (error) {
      server.log.warn({ err: error }, "API readiness probe failed");
      return reply.code(503).send({ service: "rutacuadrilla-api", status: "not_ready" });
    }
  });

  server.post("/api/auth/login", async (request, reply) => {
    const input = credentialsSchema.parse(request.body);
    let attempt: LoginRateLimitAttempt;
    try {
      attempt = loginRateLimiter.beginAttempt(request.ip, input.email);
    } catch (error) {
      if (error instanceof LoginRateLimitError) {
        reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
    try {
      const result = await auth.login(input.email, input.password);
      loginRateLimiter.completeSuccess(attempt);
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof AuthenticationError && error.message === "INVALID_CREDENTIALS") {
        loginRateLimiter.completeFailure(attempt);
      } else {
        loginRateLimiter.cancelAttempt(attempt);
      }
      throw error;
    }
  });

  server.get("/api/me", async (request) => {
    const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
    return {
      memberships: await auth.memberships(user.id),
      user: { email: user.email, id: user.id, name: user.displayName },
    };
  });

  server.post("/api/auth/logout", async (request, reply) => {
    const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
    await auth.logout(user.sessionId);
    return reply.code(204).send();
  });

  if (options.config.appProfile === "full") {
    server.get("/api/crews/:crewId/routes", async (request) => {
      const { crewId } = crewParametersSchema.parse(request.params);
      const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
      await auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
      return options.routeService.listRoutes(crewId);
    });

    server.get("/api/crews/:crewId/routes/:routeId", async (request, reply) => {
      const { crewId, routeId } = routeParametersSchema.parse(request.params);
      const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
      await auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
      const route = await options.routeService.getRoute(crewId, routeId);
      if (!route) return reply.code(404).send({ code: "ROUTE_NOT_FOUND" });
      return route;
    });

    server.post("/api/crews/:crewId/routes/import", async (request, reply) => {
      const { crewId } = crewParametersSchema.parse(request.params);
      const input = importSchema.parse(request.body);
      const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
      await auth.requireCapability(user.id, crewId, "ROUTE_DRAFT_EDIT");
      const result = await options.routeService.importRoute({
        actorUserId: user.id,
        crewId,
        ...input,
      });
      if (result.errors.length > 0) {
        return reply.code(422).send({ code: "CSV_VALIDATION_FAILED", errors: result.errors });
      }
      return reply.code(result.created ? 201 : 200).send({
        route: result.route,
        revision: result.revision,
      });
    });

    server.post(
      "/api/crews/:crewId/routes/:routeId/revisions/:revisionId/publish",
      async (request) => {
        const { crewId, revisionId, routeId } = publishParametersSchema.parse(request.params);
        const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
        await auth.requireCapability(user.id, crewId, "ROUTE_PUBLISH");
        return options.routeService.publishRevision({
          actorUserId: user.id,
          crewId,
          revisionId,
          routeId,
        });
      },
    );

    server.get(
      "/api/crews/:crewId/routes/:routeId/revisions/:revisionId/features",
      async (request, reply) => {
        const { crewId, revisionId, routeId } = publishParametersSchema.parse(request.params);
        const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
        await auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
        const features = await options.routeService.getRevisionFeatures(
          crewId,
          routeId,
          revisionId,
        );
        if (!features) return reply.code(404).send({ code: "REVISION_NOT_FOUND" });
        reply.header(
          "ETag",
          features.contentHash
            ? `"${features.contentHash}"`
            : `W/"${features.revisionId}-${features.draftVersion}"`,
        );
        return features;
      },
    );

    server.get(
      "/api/crews/:crewId/routes/:routeId/revisions/:revisionId/package",
      async (request, reply) => {
        const { crewId, revisionId, routeId } = publishParametersSchema.parse(request.params);
        const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
        await auth.requireCapability(user.id, crewId, "ROUTE_VIEW");
        const routePackage = await options.routeService.getRoutePackage(
          crewId,
          routeId,
          revisionId,
        );
        const representation = representRoutePackage(routePackage);

        if (etagMatches(request.headers["if-none-match"], representation.etag)) {
          return reply.headers(routePackageNotModifiedHeaders(representation)).code(304).send();
        }
        return reply
          .headers(routePackageHeaders(representation))
          .code(200)
          .send(representation.body);
      },
    );

    server.post(
      "/api/crews/:crewId/routes/:routeId/revisions/:revisionId/changes",
      async (request) => {
        const { crewId, revisionId, routeId } = publishParametersSchema.parse(request.params);
        const input = revisionChangeSchema.parse(request.body);
        const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
        await auth.requireCapability(user.id, crewId, "ROUTE_DRAFT_EDIT");
        return options.routeService.applyRevisionChange({
          actorUserId: user.id,
          baseDraftVersion: input.baseDraftVersion,
          change: input.change as Parameters<RouteServicePort["applyRevisionChange"]>[0]["change"],
          crewId,
          operationId: input.operationId,
          revisionId,
          routeId,
        });
      },
    );

    server.post(
      "/api/crews/:crewId/routes/:routeId/revisions/:revisionId/osm-preview",
      async (request, reply) => {
        const { crewId, revisionId, routeId } = publishParametersSchema.parse(request.params);
        const input = osmPreviewSchema.parse(request.body);
        const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
        await auth.requireCapability(user.id, crewId, "ROUTE_DRAFT_EDIT");
        const revision = await options.database.query<{ status: string }>(
          `SELECT status FROM route_revision
         WHERE crew_id = $1 AND route_id = $2 AND id = $3
         LIMIT 1`,
          [crewId, routeId, revisionId],
        );
        if (!revision.rows[0]) {
          return reply.code(404).send({ code: "REVISION_NOT_FOUND" });
        }
        if (revision.rows[0].status !== "DRAFT") {
          const error = new Error("INVALID_REVISION_STATE") as ErrorWithStatus;
          error.statusCode = 409;
          throw error;
        }
        return options.routeService.previewOsmExport(input.export);
      },
    );

    server.put(
      "/api/crews/:crewId/routes/:routeId/revisions/:revisionId/points",
      async (request, reply) => {
        const { crewId, revisionId, routeId } = publishParametersSchema.parse(request.params);
        const input = correctDraftPointsSchema.parse(request.body);
        const user = await auth.authenticate(requestAuthorization(request.headers.authorization));
        await auth.requireCapability(user.id, crewId, "ROUTE_DRAFT_EDIT");
        const result = await options.routeService.correctDraftPoints({
          actorUserId: user.id,
          crewId,
          revisionId,
          routeId,
          ...input,
        });
        return reply.code(result.errors.length > 0 ? 422 : 200).send(result);
      },
    );
  }

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        issues: error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
      });
    }
    if (error instanceof AuthenticationError) {
      return reply.code(error.statusCode).send({ code: error.message });
    }

    const typedError = error as ErrorWithStatus;
    const statusCode =
      typedError.statusCode && typedError.statusCode >= 400 && typedError.statusCode < 500
        ? typedError.statusCode
        : 500;
    if (statusCode === 500) server.log.error(error);
    const code = statusCode === 500 ? "INTERNAL_ERROR" : (typedError.code ?? typedError.message);
    return reply.code(statusCode).send({
      code,
      ...(safeDetailErrorCodes.has(code) && typedError.details !== undefined
        ? { details: typedError.details }
        : {}),
    });
  });

  return server;
}
