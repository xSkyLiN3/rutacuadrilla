import type { Capability } from "../constants.js";
import type { DomainDatabase, SqlExecutor } from "../database/types.js";
import { verifyPassword } from "./password.js";

type UserRow = {
  display_name: string;
  email: string;
  id: string;
  password_hash: string;
  status: string;
};

type MembershipCapabilityRow = {
  capability_code: Capability | null;
  crew_id: string;
  crew_name: string;
  id: string;
  role: "ADMIN" | "MEMBER";
  status: string;
  user_id: string;
};

export type AuthenticatedUser = {
  displayName: string;
  email: string;
  id: string;
};

export type CrewMembership = {
  capabilities: Capability[];
  crewId: string;
  crewName: string;
  id: string;
  role: "ADMIN" | "MEMBER";
  status: string;
  userId: string;
};

export async function authenticateUser(
  database: SqlExecutor,
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const result = await database.query<UserRow>(
    `SELECT id, email, display_name, password_hash, status
     FROM app_user
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email],
  );
  const user = result.rows[0];
  if (user?.status !== "ACTIVE" || !(await verifyPassword(password, user.password_hash))) {
    return null;
  }
  return {
    displayName: user.display_name,
    email: user.email,
    id: user.id,
  };
}

export async function getMembershipsForUser(
  database: SqlExecutor,
  userId: string,
): Promise<CrewMembership[]> {
  const result = await database.query<MembershipCapabilityRow>(
    `SELECT m.id, m.crew_id, m.user_id, m.role, m.status,
            c.name AS crew_name, mc.capability_code
     FROM crew_membership m
     JOIN crew c ON c.id = m.crew_id
     LEFT JOIN membership_capability mc
       ON mc.crew_id = m.crew_id AND mc.membership_id = m.id
     WHERE m.user_id = $1
       AND m.status = 'ACTIVE'
       AND c.status = 'ACTIVE'
     ORDER BY c.name, mc.capability_code`,
    [userId],
  );

  const memberships = new Map<string, CrewMembership>();
  for (const row of result.rows) {
    const key = `${row.crew_id}:${row.id}`;
    const membership = memberships.get(key) ?? {
      capabilities: [],
      crewId: row.crew_id,
      crewName: row.crew_name,
      id: row.id,
      role: row.role,
      status: row.status,
      userId: row.user_id,
    };
    if (row.capability_code) {
      membership.capabilities.push(row.capability_code);
    }
    memberships.set(key, membership);
  }
  return [...memberships.values()];
}

export async function getMembershipForCrew(
  database: SqlExecutor,
  userId: string,
  crewId: string,
): Promise<CrewMembership | null> {
  const memberships = await getMembershipsForUser(database, userId);
  return memberships.find((membership) => membership.crewId === crewId) ?? null;
}

export async function revokeSession(database: DomainDatabase, sessionId: string): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    `UPDATE auth_session
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [sessionId],
  );
  return result.rows.length === 1;
}
