import { randomUUID } from "node:crypto";
import { capabilityCodes, type Capability } from "@rutacuadrilla/domain";
import type { SqlDatabase } from "../database.js";
import { hashPassword, verifyPassword } from "./password.js";
import { issueSessionToken, tokenIdentifierHash, verifySessionToken } from "./token.js";

export const capabilities = capabilityCodes;
export type { Capability };

type UserRow = {
  display_name: string;
  email: string;
  id: string;
  password_hash: string;
  status: string;
};

type MembershipRow = {
  capabilities: unknown;
  crew_id: string;
  crew_name: string;
  membership_id: string;
  role: string;
};

type SessionRow = {
  display_name: string;
  email: string;
  expires_at: string | Date;
  id: string;
  status: string;
  user_id: string;
};

export type AuthenticatedUser = {
  displayName: string;
  email: string;
  id: string;
  sessionId: string;
};

export type Membership = {
  capabilities: Capability[];
  crewId: string;
  crewName: string;
  membershipId: string;
  role: string;
};

export class AuthenticationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = statusCode;
  }
}

function parseCapabilities(value: unknown): Capability[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((candidate): candidate is Capability =>
    capabilities.includes(candidate as Capability),
  );
}

function mapMembership(row: MembershipRow): Membership {
  return {
    capabilities: parseCapabilities(row.capabilities),
    crewId: row.crew_id,
    crewName: row.crew_name,
    membershipId: row.membership_id,
    role: row.role,
  };
}

export class AuthService {
  private readonly dummyPasswordHash = hashPassword("Dummy-Password-Not-For-Login-2026!");

  constructor(
    private readonly database: SqlDatabase,
    private readonly options: { secret: string; ttlMinutes: number },
  ) {}

  async login(email: string, password: string) {
    const result = await this.database.query<UserRow>(
      `SELECT id, email, display_name, password_hash, status
       FROM app_user
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email],
    );
    const user = result.rows[0];
    const passwordHash = user?.password_hash ?? (await this.dummyPasswordHash);
    const passwordMatches = await verifyPassword(password, passwordHash);
    if (user?.status !== "ACTIVE" || !passwordMatches) {
      throw new AuthenticationError("INVALID_CREDENTIALS");
    }

    // Do not persist a bearer session if membership hydration cannot complete.
    const memberships = await this.memberships(user.id);
    const issued = await issueSessionToken({
      secret: this.options.secret,
      ttlMinutes: this.options.ttlMinutes,
      userId: user.id,
    });
    const sessionId = randomUUID();
    await this.database.query(
      `INSERT INTO auth_session (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, user.id, tokenIdentifierHash(issued.jti), issued.expiresAt],
    );

    return {
      expiresAt: issued.expiresAt,
      memberships,
      token: issued.token,
      user: { email: user.email, id: user.id, name: user.display_name },
    };
  }

  async authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    const token = this.readBearer(authorization);
    let claims: { jti: string; userId: string };
    try {
      claims = await verifySessionToken(token, this.options.secret);
    } catch {
      throw new AuthenticationError("INVALID_SESSION");
    }

    const sessionResult = await this.database.query<SessionRow>(
      `SELECT s.id, s.user_id, s.expires_at, u.email, u.display_name, u.status
       FROM auth_session s
       JOIN app_user u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.user_id = $2
         AND s.revoked_at IS NULL
         AND s.expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
      [tokenIdentifierHash(claims.jti), claims.userId],
    );
    const session = sessionResult.rows[0];
    if (session?.status !== "ACTIVE") {
      throw new AuthenticationError("SESSION_REVOKED_OR_EXPIRED");
    }
    return {
      displayName: session.display_name,
      email: session.email,
      id: session.user_id,
      sessionId: session.id,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.database.query(
      `UPDATE auth_session SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  async memberships(userId: string): Promise<Membership[]> {
    const result = await this.database.query<MembershipRow>(
      `SELECT m.crew_id,
              m.id AS membership_id,
              c.name AS crew_name,
              m.role,
              COALESCE(
                json_agg(mc.capability_code ORDER BY mc.capability_code)
                  FILTER (WHERE mc.capability_code IS NOT NULL),
                '[]'::json
              ) AS capabilities
       FROM crew_membership m
       JOIN crew c ON c.id = m.crew_id
       LEFT JOIN membership_capability mc
         ON mc.crew_id = m.crew_id AND mc.membership_id = m.id
       WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND c.status = 'ACTIVE'
       GROUP BY m.crew_id, m.id, c.name, m.role
       ORDER BY c.name`,
      [userId],
    );
    return result.rows.map(mapMembership);
  }

  async requireCapability(
    userId: string,
    crewId: string,
    capability: Capability,
  ): Promise<Membership> {
    const memberships = await this.memberships(userId);
    const membership = memberships.find((candidate) => candidate.crewId === crewId);
    if (!membership?.capabilities.includes(capability)) {
      throw new AuthenticationError("FORBIDDEN", 403);
    }
    return membership;
  }

  private readBearer(authorization: string | undefined): string {
    const [scheme, token] = authorization?.split(" ") ?? [];
    if (scheme !== "Bearer" || !token) throw new AuthenticationError("MISSING_SESSION");
    return token;
  }
}
