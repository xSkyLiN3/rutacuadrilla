import { randomBytes } from "node:crypto";
import { capabilityCodes, type Capability } from "../constants.js";
import { DomainError } from "../errors.js";
import { hashPassword } from "../auth/password.js";
import type { DomainDatabase, SqlExecutor } from "./types.js";

const demoIds = {
  crews: {
    primary: "10000000-0000-4000-8000-000000000001",
    secondary: "10000000-0000-4000-8000-000000000002",
  },
  memberships: {
    admin: "30000000-0000-4000-8000-000000000001",
    member: "30000000-0000-4000-8000-000000000002",
    outsider: "30000000-0000-4000-8000-000000000003",
  },
  users: {
    admin: "20000000-0000-4000-8000-000000000001",
    member: "20000000-0000-4000-8000-000000000002",
    outsider: "20000000-0000-4000-8000-000000000003",
  },
} as const;

export type SeedDemoDataOptions = {
  adminPassword: string;
  memberPassword?: string;
  outsiderPassword?: string;
};

export type DemoSeedResult = {
  credentials: {
    admin: { email: string; password: string };
    member: { email: string; password: string };
    outsider: { email: string; password: string };
  };
  crewIds: typeof demoIds.crews;
  membershipIds: typeof demoIds.memberships;
  userIds: typeof demoIds.users;
};

const adminCapabilities = [...capabilityCodes];
const memberCapabilities: Capability[] = [
  "ROUTE_VIEW",
  "SESSION_START",
  "SESSION_JOIN",
  "POINT_MARK",
  "POINT_CORRECT",
  "GPS_TRACK",
  "FINANCE_VIEW_OWN",
];

function generatedPassword(): string {
  return `Demo-${randomBytes(18).toString("base64url")}!`;
}

async function upsertUser(
  transaction: SqlExecutor,
  input: {
    displayName: string;
    email: string;
    id: string;
    passwordHash: string;
  },
): Promise<void> {
  await transaction.query(
    `INSERT INTO app_user (id, email, display_name, password_hash, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email,
           display_name = EXCLUDED.display_name,
           password_hash = EXCLUDED.password_hash,
           status = 'ACTIVE',
           updated_at = CURRENT_TIMESTAMP`,
    [input.id, input.email, input.displayName, input.passwordHash],
  );
}

async function grantCapabilities(
  transaction: SqlExecutor,
  crewId: string,
  membershipId: string,
  capabilities: readonly Capability[],
): Promise<void> {
  for (const capability of capabilities) {
    await transaction.query(
      `INSERT INTO membership_capability
         (crew_id, membership_id, capability_code, granted_by_membership_id)
       VALUES ($1, $2, $3, $2)
       ON CONFLICT DO NOTHING`,
      [crewId, membershipId, capability],
    );
  }
}

export async function seedDemoData(
  database: DomainDatabase,
  options: SeedDemoDataOptions,
): Promise<DemoSeedResult> {
  const memberPassword = options.memberPassword ?? generatedPassword();
  const outsiderPassword = options.outsiderPassword ?? generatedPassword();
  const passwords = [options.adminPassword, memberPassword, outsiderPassword] as const;
  if (passwords.some((password) => password.length < 12)) {
    throw new DomainError("SEED_PASSWORD_TOO_SHORT", { statusCode: 400 });
  }
  const [adminHash, memberHash, outsiderHash] = await Promise.all([
    hashPassword(options.adminPassword),
    hashPassword(memberPassword),
    hashPassword(outsiderPassword),
  ]);

  await database.transaction(async (transaction) => {
    await upsertUser(transaction, {
      displayName: "Admin Demo",
      email: "admin@demo.rutacuadrilla.local",
      id: demoIds.users.admin,
      passwordHash: adminHash,
    });
    await upsertUser(transaction, {
      displayName: "Miembro Demo",
      email: "miembro@demo.rutacuadrilla.local",
      id: demoIds.users.member,
      passwordHash: memberHash,
    });
    await upsertUser(transaction, {
      displayName: "Admin Crew Externa",
      email: "externo@demo.rutacuadrilla.local",
      id: demoIds.users.outsider,
      passwordHash: outsiderHash,
    });

    await transaction.query(
      `INSERT INTO crew (id, name, slug)
       VALUES ($1, 'Tripulación Demo Norte', 'demo-norte')
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP`,
      [demoIds.crews.primary],
    );
    await transaction.query(
      `INSERT INTO crew (id, name, slug)
       VALUES ($1, 'Tripulación Demo Sur', 'demo-sur')
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP`,
      [demoIds.crews.secondary],
    );

    const memberships = [
      {
        crewId: demoIds.crews.primary,
        id: demoIds.memberships.admin,
        role: "ADMIN",
        userId: demoIds.users.admin,
      },
      {
        crewId: demoIds.crews.primary,
        id: demoIds.memberships.member,
        role: "MEMBER",
        userId: demoIds.users.member,
      },
      {
        crewId: demoIds.crews.secondary,
        id: demoIds.memberships.outsider,
        role: "ADMIN",
        userId: demoIds.users.outsider,
      },
    ] as const;
    for (const membership of memberships) {
      await transaction.query(
        `INSERT INTO crew_membership
           (crew_id, id, user_id, role, profile, status)
         VALUES ($1, $2, $3, $4, 'OTHER', 'ACTIVE')
         ON CONFLICT (crew_id, id) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               role = EXCLUDED.role,
               status = 'ACTIVE',
               updated_at = CURRENT_TIMESTAMP`,
        [membership.crewId, membership.id, membership.userId, membership.role],
      );
    }

    await grantCapabilities(
      transaction,
      demoIds.crews.primary,
      demoIds.memberships.admin,
      adminCapabilities,
    );
    await grantCapabilities(
      transaction,
      demoIds.crews.primary,
      demoIds.memberships.member,
      memberCapabilities,
    );
    await grantCapabilities(
      transaction,
      demoIds.crews.secondary,
      demoIds.memberships.outsider,
      adminCapabilities,
    );
  });

  return {
    credentials: {
      admin: {
        email: "admin@demo.rutacuadrilla.local",
        password: options.adminPassword,
      },
      member: {
        email: "miembro@demo.rutacuadrilla.local",
        password: memberPassword,
      },
      outsider: {
        email: "externo@demo.rutacuadrilla.local",
        password: outsiderPassword,
      },
    },
    crewIds: demoIds.crews,
    membershipIds: demoIds.memberships,
    userIds: demoIds.users,
  };
}
