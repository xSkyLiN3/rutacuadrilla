import { randomUUID } from "node:crypto";
import { hashPassword, type DomainDatabase, type SqlExecutor } from "@rutacuadrilla/domain";

export const simplePointStates = [
  "SIN_VISITAR",
  "SOBRE_ENTREGADO",
  "VOLVER",
  "SIN_RESPUESTA",
  "APORTO",
  "NO_PARTICIPA",
] as const;

export type SimplePointState = (typeof simplePointStates)[number];

export class SimpleApplicationError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, details?: unknown) {
    super(code);
    this.name = "SimpleApplicationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

type Temporal = Date | string;

type UserRow = {
  assignment_id: string | null;
  display_name: string;
  email: string;
  id: string;
  route_id: string | null;
  route_name: string | null;
  route_revision_id: string | null;
  status: string;
};

type RouteRow = {
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  id: string;
  point_count: number | null;
  revision_id: string | null;
  sector_name: string;
  name: string;
  updated_at: Temporal;
};

type ProgressRow = {
  assignment_id: string;
  route_id: string;
  route_name: string;
  user_id: string;
  user_name: string;
  total: number;
  sin_visitar: number;
  sobre_entregado: number;
  volver: number;
  sin_respuesta: number;
  aporto: number;
  no_participa: number;
  updated_at: Temporal;
};

type AssignmentRow = {
  assignment_id: string;
  crew_id: string;
  crew_name: string;
  route_id: string;
  route_name: string;
  route_revision_id: string;
  user_id: string;
};

type PointRow = {
  display_order: number;
  external_id: string;
  house_number: string | null;
  latitude: number;
  longitude: number;
  point_type: string;
  service_point_id: string;
  state: SimplePointState;
  street: string | null;
  version: number;
};

type SegmentRow = {
  attribution: string | null;
  display_order: number;
  external_id: string;
  geometry_geojson: unknown;
  name: string | null;
  service_side: "BOTH" | "LEFT" | "RIGHT";
  source: "GEOJSON" | "MANUAL" | "OSM";
  source_version: string | null;
  street_segment_id: string;
  street_segment_version_id: string;
};

type PointStateRow = {
  assignment_id: string;
  crew_id: string;
  state: SimplePointState;
  version: number;
};

function iso(value: Temporal): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function parseGeometry(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SimpleApplicationError("INVALID_ROUTE_GEOMETRY", 500);
  }
}

function number(value: number): number {
  return Number(value);
}

function progressFromRow(row: ProgressRow) {
  const states: Record<SimplePointState, number> = {
    SIN_VISITAR: number(row.sin_visitar),
    SOBRE_ENTREGADO: number(row.sobre_entregado),
    VOLVER: number(row.volver),
    SIN_RESPUESTA: number(row.sin_respuesta),
    APORTO: number(row.aporto),
    NO_PARTICIPA: number(row.no_participa),
  };
  const total = number(row.total);
  return {
    assignmentId: row.assignment_id,
    routeId: row.route_id,
    routeName: row.route_name,
    states,
    total,
    updatedAt: iso(row.updated_at),
    user: { id: row.user_id, name: row.user_name },
    visited: total - states.SIN_VISITAR,
  };
}

function progressSql(extraWhere = ""): string {
  return `
  SELECT a.id AS assignment_id, a.route_id, r.name AS route_name,
         a.user_id, u.display_name AS user_name,
         COUNT(s.service_point_id)::integer AS total,
         COUNT(*) FILTER (WHERE s.state = 'SIN_VISITAR')::integer AS sin_visitar,
         COUNT(*) FILTER (WHERE s.state = 'SOBRE_ENTREGADO')::integer AS sobre_entregado,
         COUNT(*) FILTER (WHERE s.state = 'VOLVER')::integer AS volver,
         COUNT(*) FILTER (WHERE s.state = 'SIN_RESPUESTA')::integer AS sin_respuesta,
         COUNT(*) FILTER (WHERE s.state = 'APORTO')::integer AS aporto,
         COUNT(*) FILTER (WHERE s.state = 'NO_PARTICIPA')::integer AS no_participa,
         COALESCE(MAX(s.updated_at), a.updated_at) AS updated_at
  FROM simple_route_assignment a
  JOIN route r ON r.crew_id = a.crew_id AND r.id = a.route_id
  JOIN app_user u ON u.id = a.user_id
  LEFT JOIN simple_route_point_state s
    ON s.crew_id = a.crew_id AND s.assignment_id = a.id
  WHERE a.crew_id = $1 AND a.status = 'ACTIVE' ${extraWhere}
  GROUP BY a.id, a.route_id, r.name, a.user_id, u.display_name, a.updated_at
`;
}

export class SimpleService {
  constructor(private readonly database: DomainDatabase) {}

  async overview(crewId: string) {
    const [usersResult, routesResult, progressResult] = await Promise.all([
      this.database.query<UserRow>(
        `SELECT u.id, u.email, u.display_name, u.status,
                a.id AS assignment_id, a.route_id, a.route_revision_id,
                r.name AS route_name
         FROM crew_membership m
         JOIN app_user u ON u.id = m.user_id
         LEFT JOIN simple_route_assignment a
           ON a.crew_id = m.crew_id AND a.user_id = m.user_id AND a.status = 'ACTIVE'
         LEFT JOIN route r ON r.crew_id = a.crew_id AND r.id = a.route_id
         WHERE m.crew_id = $1 AND m.role = 'MEMBER' AND m.status = 'ACTIVE'
         ORDER BY u.display_name, u.email`,
        [crewId],
      ),
      this.database.query<RouteRow>(
        `SELECT r.id, r.name, sector.name AS sector_name, r.updated_at,
                rr.id AS revision_id, rr.point_count,
                a.user_id AS assigned_user_id,
                u.display_name AS assigned_user_name
         FROM route r
         JOIN sector ON sector.crew_id = r.crew_id AND sector.id = r.sector_id
         LEFT JOIN route_revision rr
           ON rr.crew_id = r.crew_id AND rr.id = r.current_published_revision_id
         LEFT JOIN simple_route_assignment a
           ON a.crew_id = r.crew_id AND a.route_id = r.id AND a.status = 'ACTIVE'
         LEFT JOIN app_user u ON u.id = a.user_id
         WHERE r.crew_id = $1 AND r.status = 'ACTIVE'
         ORDER BY r.name`,
        [crewId],
      ),
      this.database.query<ProgressRow>(`${progressSql()} ORDER BY r.name, u.display_name`, [
        crewId,
      ]),
    ]);

    return {
      progress: progressResult.rows.map(progressFromRow),
      routes: routesResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        pointCount: row.point_count === null ? 0 : number(row.point_count),
        publishedRevisionId: row.revision_id,
        sectorName: row.sector_name,
        updatedAt: iso(row.updated_at),
        ...(row.assigned_user_id && row.assigned_user_name
          ? { assignedUser: { id: row.assigned_user_id, name: row.assigned_user_name } }
          : {}),
      })),
      users: usersResult.rows.map((row) => ({
        email: row.email,
        id: row.id,
        name: row.display_name,
        status: row.status,
        ...(row.assignment_id && row.route_id && row.route_name && row.route_revision_id
          ? {
              assignment: {
                id: row.assignment_id,
                routeId: row.route_id,
                routeName: row.route_name,
                routeRevisionId: row.route_revision_id,
              },
            }
          : {}),
      })),
    };
  }

  async createUser(input: {
    actorMembershipId: string;
    crewId: string;
    displayName: string;
    email: string;
    password: string;
  }) {
    const passwordHash = await hashPassword(input.password);
    const userId = randomUUID();
    const membershipId = randomUUID();
    try {
      await this.database.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO app_user (id, email, display_name, password_hash)
           VALUES ($1, lower($2), $3, $4)`,
          [userId, input.email, input.displayName, passwordHash],
        );
        await transaction.query(
          `INSERT INTO crew_membership (crew_id, id, user_id, role, profile, status)
           VALUES ($1, $2, $3, 'MEMBER', 'OTHER', 'ACTIVE')`,
          [input.crewId, membershipId, userId],
        );
        await transaction.query(
          `INSERT INTO audit_event (
             crew_id, id, actor_membership_id, action, aggregate_type, aggregate_id, metadata
           ) VALUES ($1, $2, $3, 'SIMPLE_USER_CREATED', 'app_user', $4, $5::jsonb)`,
          [
            input.crewId,
            randomUUID(),
            input.actorMembershipId,
            userId,
            JSON.stringify({ email: input.email.toLowerCase() }),
          ],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new SimpleApplicationError("USER_EMAIL_IN_USE", 409);
      }
      throw error;
    }
    return {
      email: input.email.toLowerCase(),
      id: userId,
      name: input.displayName,
      status: "ACTIVE",
    };
  }

  async assignRoute(input: {
    actorMembershipId: string;
    crewId: string;
    routeId: string;
    userId: string;
  }) {
    return this.database.transaction(async (transaction) => {
      await transaction.query("SELECT id FROM crew WHERE id = $1 FOR UPDATE", [input.crewId]);
      const userResult = await transaction.query<{ id: string }>(
        `SELECT u.id
         FROM crew_membership m
         JOIN app_user u ON u.id = m.user_id AND u.status = 'ACTIVE'
         WHERE m.crew_id = $1 AND m.user_id = $2
           AND m.role = 'MEMBER' AND m.status = 'ACTIVE'
         LIMIT 1`,
        [input.crewId, input.userId],
      );
      if (!userResult.rows[0]) throw new SimpleApplicationError("SIMPLE_USER_NOT_FOUND", 404);

      const routeResult = await transaction.query<{ revision_id: string }>(
        `SELECT rr.id AS revision_id
         FROM route r
         JOIN route_revision rr
           ON rr.crew_id = r.crew_id
          AND rr.route_id = r.id
          AND rr.id = r.current_published_revision_id
          AND rr.status = 'PUBLISHED'
         WHERE r.crew_id = $1 AND r.id = $2 AND r.status = 'ACTIVE'
         LIMIT 1
         FOR UPDATE OF r`,
        [input.crewId, input.routeId],
      );
      const revisionId = routeResult.rows[0]?.revision_id;
      if (!revisionId) throw new SimpleApplicationError("ROUTE_NOT_PUBLISHED", 409);

      const occupied = await transaction.query<{ user_id: string }>(
        `SELECT user_id
         FROM simple_route_assignment
         WHERE crew_id = $1 AND route_id = $2 AND status = 'ACTIVE'
         LIMIT 1
         FOR UPDATE`,
        [input.crewId, input.routeId],
      );
      if (occupied.rows[0] && occupied.rows[0].user_id !== input.userId) {
        throw new SimpleApplicationError("ROUTE_ALREADY_ASSIGNED", 409);
      }

      const current = await transaction.query<{
        id: string;
        route_id: string;
        route_revision_id: string;
      }>(
        `SELECT id, route_id, route_revision_id
         FROM simple_route_assignment
         WHERE crew_id = $1 AND user_id = $2 AND status = 'ACTIVE'
         LIMIT 1
         FOR UPDATE`,
        [input.crewId, input.userId],
      );
      if (
        current.rows[0]?.route_id === input.routeId &&
        current.rows[0]?.route_revision_id === revisionId
      ) {
        return { assignmentId: current.rows[0].id, replayed: true };
      }

      await this.assertNoActiveOverlap(transaction, input.crewId, input.userId, revisionId);

      if (current.rows[0]) {
        await transaction.query(
          `UPDATE simple_route_assignment
           SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP
           WHERE crew_id = $1 AND id = $2`,
          [input.crewId, current.rows[0].id],
        );
      }

      const assignmentId = randomUUID();
      await transaction.query(
        `INSERT INTO simple_route_assignment (
           crew_id, id, user_id, route_id, route_revision_id, assigned_by_membership_id
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.crewId,
          assignmentId,
          input.userId,
          input.routeId,
          revisionId,
          input.actorMembershipId,
        ],
      );
      await transaction.query(
        `INSERT INTO simple_route_point_state (crew_id, assignment_id, service_point_id)
         SELECT crew_id, $3, service_point_id
         FROM route_revision_point
         WHERE crew_id = $1 AND route_revision_id = $2`,
        [input.crewId, revisionId, assignmentId],
      );
      await transaction.query(
        `INSERT INTO audit_event (
           crew_id, id, actor_membership_id, action, aggregate_type, aggregate_id, metadata
         ) VALUES ($1, $2, $3, 'SIMPLE_ROUTE_ASSIGNED', 'simple_route_assignment', $4, $5::jsonb)`,
        [
          input.crewId,
          randomUUID(),
          input.actorMembershipId,
          assignmentId,
          JSON.stringify({ routeId: input.routeId, userId: input.userId }),
        ],
      );
      return { assignmentId, replayed: false };
    });
  }

  async unassignRoute(input: {
    actorMembershipId: string;
    crewId: string;
    userId: string;
  }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const current = await transaction.query<{ id: string }>(
        `SELECT id FROM simple_route_assignment
         WHERE crew_id = $1 AND user_id = $2 AND status = 'ACTIVE'
         LIMIT 1 FOR UPDATE`,
        [input.crewId, input.userId],
      );
      if (!current.rows[0]) return false;
      await transaction.query(
        `UPDATE simple_route_assignment
         SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND id = $2`,
        [input.crewId, current.rows[0].id],
      );
      await transaction.query(
        `INSERT INTO audit_event (
           crew_id, id, actor_membership_id, action, aggregate_type, aggregate_id
         ) VALUES ($1, $2, $3, 'SIMPLE_ROUTE_UNASSIGNED', 'simple_route_assignment', $4)`,
        [input.crewId, randomUUID(), input.actorMembershipId, current.rows[0].id],
      );
      return true;
    });
  }

  async myAssignment(userId: string) {
    return this.database.transaction(async (transaction) => {
      const assignmentResult = await transaction.query<AssignmentRow>(
        `SELECT a.id AS assignment_id, a.crew_id, crew.name AS crew_name,
              a.user_id, a.route_id, route.name AS route_name,
              a.route_revision_id
       FROM simple_route_assignment a
       JOIN crew ON crew.id = a.crew_id AND crew.status = 'ACTIVE'
       JOIN route ON route.crew_id = a.crew_id AND route.id = a.route_id
       JOIN crew_membership membership
         ON membership.crew_id = a.crew_id AND membership.user_id = a.user_id
        AND membership.status = 'ACTIVE'
       WHERE a.user_id = $1 AND a.status = 'ACTIVE'
       ORDER BY a.created_at DESC
       LIMIT 2
       FOR SHARE OF a`,
        [userId],
      );
      if (assignmentResult.rows.length === 0) return null;
      if (assignmentResult.rows.length > 1) {
        throw new SimpleApplicationError("MULTIPLE_ACTIVE_ASSIGNMENTS", 409);
      }
      const assignment = assignmentResult.rows[0];
      if (!assignment) return null;

      const pointsResult = await transaction.query<PointRow>(
        `SELECT state.service_point_id, state.state, state.version,
                point.display_order, service.external_id,
                version.latitude, version.longitude, version.street,
                version.house_number, version.point_type
         FROM simple_route_point_state state
         JOIN route_revision_point point
           ON point.crew_id = state.crew_id
          AND point.route_revision_id = $2
          AND point.service_point_id = state.service_point_id
         JOIN service_point service
           ON service.crew_id = point.crew_id AND service.id = point.service_point_id
         JOIN service_point_version version
           ON version.crew_id = point.crew_id
          AND version.service_point_id = point.service_point_id
          AND version.id = point.service_point_version_id
         WHERE state.crew_id = $1 AND state.assignment_id = $3
         ORDER BY point.display_order, service.id`,
        [assignment.crew_id, assignment.route_revision_id, assignment.assignment_id],
      );
      const segmentsResult = await transaction.query<SegmentRow>(
        `SELECT segment.id AS street_segment_id, segment.external_id,
                version.id AS street_segment_version_id, version.name,
                version.geometry_geojson, version.source, version.source_version,
                version.attribution, link.display_order, link.service_side
         FROM route_revision_segment link
         JOIN route_street_segment segment
           ON segment.crew_id = link.crew_id AND segment.id = link.street_segment_id
         JOIN route_street_segment_version version
           ON version.crew_id = link.crew_id
          AND version.street_segment_id = link.street_segment_id
          AND version.id = link.street_segment_version_id
         WHERE link.crew_id = $1 AND link.route_revision_id = $2
         ORDER BY link.display_order, segment.id`,
        [assignment.crew_id, assignment.route_revision_id],
      );
      const ownProgress = await this.progressForAssignment(
        transaction,
        assignment.crew_id,
        assignment.assignment_id,
      );

      return {
        id: assignment.assignment_id,
        crew: { id: assignment.crew_id, name: assignment.crew_name },
        points: pointsResult.rows.map((row) => ({
          displayOrder: number(row.display_order),
          externalId: row.external_id,
          id: row.service_point_id,
          latitude: number(row.latitude),
          longitude: number(row.longitude),
          pointType: row.point_type,
          state: row.state,
          version: number(row.version),
          ...(row.house_number === null ? {} : { number: row.house_number }),
          ...(row.street === null ? {} : { street: row.street }),
        })),
        progress: ownProgress,
        route: {
          id: assignment.route_id,
          name: assignment.route_name,
          revisionId: assignment.route_revision_id,
        },
        segments: segmentsResult.rows.map((row) => ({
          displayOrder: number(row.display_order),
          externalId: row.external_id,
          geometry: parseGeometry(row.geometry_geojson),
          id: row.street_segment_id,
          serviceSide: row.service_side,
          source: row.source,
          streetSegmentVersionId: row.street_segment_version_id,
          ...(row.attribution === null ? {} : { attribution: row.attribution }),
          ...(row.name === null ? {} : { name: row.name }),
          ...(row.source_version === null ? {} : { sourceVersion: row.source_version }),
        })),
      };
    });
  }

  async updatePoint(input: {
    expectedVersion: number;
    operationId: string;
    pointId: string;
    state: SimplePointState;
    userId: string;
  }) {
    return this.database.transaction(async (transaction) => {
      const assignmentResult = await transaction.query<{ crew_id: string; id: string }>(
        `SELECT assignment.crew_id, assignment.id
         FROM simple_route_assignment assignment
         JOIN crew_membership membership
           ON membership.crew_id = assignment.crew_id
          AND membership.user_id = assignment.user_id
          AND membership.status = 'ACTIVE'
         WHERE assignment.user_id = $1 AND assignment.status = 'ACTIVE'
         LIMIT 1
         FOR UPDATE OF assignment`,
        [input.userId],
      );
      const assignment = assignmentResult.rows[0];
      if (!assignment) throw new SimpleApplicationError("ASSIGNMENT_POINT_NOT_FOUND", 404);

      const replay = await transaction.query<{
        assignment_id: string;
        crew_id: string;
        service_point_id: string;
        state: SimplePointState;
        version: number;
      }>(
        `SELECT event.crew_id, event.assignment_id, event.service_point_id,
                event.state, event.version
         FROM simple_route_point_event event
         JOIN simple_route_assignment assignment
           ON assignment.crew_id = event.crew_id AND assignment.id = event.assignment_id
         WHERE event.crew_id = $1 AND event.assignment_id = $2
           AND event.operation_id = $3 AND assignment.user_id = $4
         LIMIT 1`,
        [assignment.crew_id, assignment.id, input.operationId, input.userId],
      );
      if (replay.rows[0]) {
        if (
          replay.rows[0].service_point_id !== input.pointId ||
          replay.rows[0].state !== input.state ||
          number(replay.rows[0].version) - 1 !== input.expectedVersion
        ) {
          throw new SimpleApplicationError("IDEMPOTENCY_KEY_REUSE", 409);
        }
        return {
          point: {
            id: replay.rows[0].service_point_id,
            state: replay.rows[0].state,
            version: number(replay.rows[0].version),
          },
          progress: await this.progressForAssignment(
            transaction,
            replay.rows[0].crew_id,
            replay.rows[0].assignment_id,
          ),
          replayed: true,
        };
      }

      const currentResult = await transaction.query<PointStateRow>(
        `SELECT state.crew_id, state.assignment_id, state.state, state.version
         FROM simple_route_point_state state
         WHERE state.crew_id = $1 AND state.assignment_id = $2
           AND state.service_point_id = $3
         LIMIT 1
         FOR UPDATE OF state`,
        [assignment.crew_id, assignment.id, input.pointId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new SimpleApplicationError("ASSIGNMENT_POINT_NOT_FOUND", 404);
      if (number(current.version) !== input.expectedVersion) {
        throw new SimpleApplicationError("POINT_VERSION_CONFLICT", 409, {
          state: current.state,
          version: number(current.version),
        });
      }

      const nextVersion = input.expectedVersion + 1;
      await transaction.query(
        `UPDATE simple_route_point_state
         SET state = $4, version = $5, updated_by_user_id = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND assignment_id = $2 AND service_point_id = $6`,
        [
          current.crew_id,
          current.assignment_id,
          input.userId,
          input.state,
          nextVersion,
          input.pointId,
        ],
      );
      await transaction.query(
        `INSERT INTO simple_route_point_event (
           crew_id, id, assignment_id, service_point_id, operation_id,
           actor_user_id, previous_state, state, version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          current.crew_id,
          randomUUID(),
          current.assignment_id,
          input.pointId,
          input.operationId,
          input.userId,
          current.state,
          input.state,
          nextVersion,
        ],
      );
      return {
        point: { id: input.pointId, state: input.state, version: nextVersion },
        progress: await this.progressForAssignment(
          transaction,
          current.crew_id,
          current.assignment_id,
        ),
        replayed: false,
      };
    });
  }

  private async assertNoActiveOverlap(
    transaction: SqlExecutor,
    crewId: string,
    userId: string,
    revisionId: string,
  ): Promise<void> {
    const duplicatePoint = await transaction.query<{ external_id: string }>(
      `SELECT point.external_id
       FROM route_revision_point target
       JOIN service_point point
         ON point.crew_id = target.crew_id AND point.id = target.service_point_id
       JOIN route_revision_point other
         ON other.crew_id = target.crew_id
        AND other.service_point_id = target.service_point_id
       JOIN simple_route_assignment assignment
         ON assignment.crew_id = other.crew_id
        AND assignment.route_revision_id = other.route_revision_id
        AND assignment.status = 'ACTIVE'
        AND assignment.user_id <> $3
       WHERE target.crew_id = $1 AND target.route_revision_id = $2
       LIMIT 1`,
      [crewId, revisionId, userId],
    );
    if (duplicatePoint.rows[0]) {
      throw new SimpleApplicationError("ROUTE_POINT_OVERLAP", 409, {
        externalId: duplicatePoint.rows[0].external_id,
      });
    }

    const duplicateSide = await transaction.query<{
      external_id: string;
      other_side: string;
      service_side: string;
      version_mismatch: boolean;
    }>(
      `SELECT segment.external_id, target.service_side,
              other.service_side AS other_side,
              (target.street_segment_version_id <> other.street_segment_version_id)
                AS version_mismatch
       FROM route_revision_segment target
       JOIN route_street_segment segment
         ON segment.crew_id = target.crew_id AND segment.id = target.street_segment_id
       JOIN route_revision_segment other
         ON other.crew_id = target.crew_id
        AND other.street_segment_id = target.street_segment_id
       JOIN simple_route_assignment assignment
         ON assignment.crew_id = other.crew_id
        AND assignment.route_revision_id = other.route_revision_id
        AND assignment.status = 'ACTIVE'
        AND assignment.user_id <> $3
       WHERE target.crew_id = $1 AND target.route_revision_id = $2
         AND (
           target.street_segment_version_id <> other.street_segment_version_id
           OR target.service_side = 'BOTH'
           OR other.service_side = 'BOTH'
           OR target.service_side = other.service_side
         )
       LIMIT 1`,
      [crewId, revisionId, userId],
    );
    if (duplicateSide.rows[0]) {
      throw new SimpleApplicationError(
        duplicateSide.rows[0].version_mismatch
          ? "ROUTE_SEGMENT_VERSION_AMBIGUOUS"
          : "ROUTE_SEGMENT_SIDE_OVERLAP",
        409,
        {
          externalId: duplicateSide.rows[0].external_id,
          otherSide: duplicateSide.rows[0].other_side,
          serviceSide: duplicateSide.rows[0].service_side,
        },
      );
    }
  }

  private async progressForAssignment(executor: SqlExecutor, crewId: string, assignmentId: string) {
    const result = await executor.query<ProgressRow>(progressSql("AND a.id = $2"), [
      crewId,
      assignmentId,
    ]);
    const row = result.rows[0];
    if (!row) throw new SimpleApplicationError("ASSIGNMENT_PROGRESS_MISSING", 500);
    return progressFromRow(row);
  }
}
