import { describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { type AuthenticationError, AuthService } from "../src/auth/service.js";
import type { QueryResult, SqlDatabase } from "../src/database.js";

type SessionRecord = {
  expiresAt: string;
  id: string;
  revoked: boolean;
  tokenHash: string;
  userId: string;
};

class MemoryAuthDatabase implements SqlDatabase {
  failMembershipLookup = false;
  readonly sessions: SessionRecord[] = [];
  passwordHash = "";

  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<QueryResult<Row>> {
    if (sql.includes("FROM app_user")) {
      const email = String(parameters[0]).toLowerCase();
      const rows =
        email === "admin@demo.local"
          ? [
              {
                display_name: "Admin Demo",
                email: "admin@demo.local",
                id: "user-admin",
                password_hash: this.passwordHash,
                status: "ACTIVE",
              },
            ]
          : [];
      return { rows: rows as unknown as Row[] };
    }

    if (sql.includes("INSERT INTO auth_session")) {
      this.sessions.push({
        expiresAt: String(parameters[3]),
        id: String(parameters[0]),
        revoked: false,
        tokenHash: String(parameters[2]),
        userId: String(parameters[1]),
      });
      return { rows: [] };
    }

    if (sql.includes("FROM auth_session")) {
      const session = this.sessions.find(
        (candidate) =>
          candidate.tokenHash === parameters[0] &&
          candidate.userId === parameters[1] &&
          !candidate.revoked &&
          new Date(candidate.expiresAt).getTime() > Date.now(),
      );
      const rows = session
        ? [
            {
              display_name: "Admin Demo",
              email: "admin@demo.local",
              expires_at: session.expiresAt,
              id: session.id,
              password_hash: this.passwordHash,
              status: "ACTIVE",
              user_id: session.userId,
            },
          ]
        : [];
      return { rows: rows as unknown as Row[] };
    }

    if (sql.includes("FROM crew_membership")) {
      if (this.failMembershipLookup) throw new Error("MEMBERSHIP_LOOKUP_FAILED");
      const rows =
        parameters[0] === "user-admin"
          ? [
              {
                capabilities: ["ROUTE_VIEW", "ROUTE_DRAFT_EDIT", "ROUTE_PUBLISH"],
                crew_id: "crew-a",
                crew_name: "Tripulación A",
                membership_id: "membership-admin",
                role: "ADMIN",
              },
            ]
          : [];
      return { rows: rows as unknown as Row[] };
    }

    if (sql.includes("UPDATE auth_session")) {
      const session = this.sessions.find((candidate) => candidate.id === parameters[0]);
      if (session) session.revoked = true;
      return { rows: [] };
    }

    throw new Error(`SQL no implementado por el fake: ${sql}`);
  }
}

const options = {
  secret: "test-only-secret-with-more-than-32-characters",
  ttlMinutes: 30,
};

describe("AuthService", () => {
  it("creates, authorizes and revokes a server-checked session", async () => {
    const database = new MemoryAuthDatabase();
    database.passwordHash = await hashPassword("Correcta-Demo-2026!");
    const service = new AuthService(database, options);

    const login = await service.login("admin@demo.local", "Correcta-Demo-2026!");
    expect(login.memberships).toHaveLength(1);
    expect(login.memberships[0]?.crewId).toBe("crew-a");

    const user = await service.authenticate(`Bearer ${login.token}`);
    await expect(
      service.requireCapability(user.id, "crew-a", "ROUTE_PUBLISH"),
    ).resolves.toMatchObject({
      crewId: "crew-a",
      membershipId: "membership-admin",
    });
    await expect(service.requireCapability(user.id, "crew-b", "ROUTE_VIEW")).rejects.toMatchObject({
      message: "FORBIDDEN",
      statusCode: 403,
    });

    await service.logout(user.sessionId);
    await expect(service.authenticate(`Bearer ${login.token}`)).rejects.toThrow(
      "SESSION_REVOKED_OR_EXPIRED",
    );
  });

  it("does not disclose whether email or password was wrong", async () => {
    const database = new MemoryAuthDatabase();
    database.passwordHash = await hashPassword("Correcta-Demo-2026!");
    const service = new AuthService(database, options);

    const attempts: Array<[string, string]> = [
      ["missing@demo.local", "Correcta-Demo-2026!"],
      ["admin@demo.local", "Contraseña-Incorrecta"],
    ];
    for (const [email, password] of attempts) {
      await expect(service.login(email, password)).rejects.toEqual(
        expect.objectContaining<Partial<AuthenticationError>>({ message: "INVALID_CREDENTIALS" }),
      );
    }
  });

  it("does not leave an auth session when membership hydration fails", async () => {
    const database = new MemoryAuthDatabase();
    database.passwordHash = await hashPassword("Correcta-Demo-2026!");
    database.failMembershipLookup = true;
    const service = new AuthService(database, options);

    await expect(service.login("admin@demo.local", "Correcta-Demo-2026!")).rejects.toThrow(
      "MEMBERSHIP_LOOKUP_FAILED",
    );
    expect(database.sessions).toEqual([]);
  });
});
