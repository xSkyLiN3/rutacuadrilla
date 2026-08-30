import { createHash, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const issuer = "rutacuadrilla-api";
const audience = "rutacuadrilla-admin";

export type IssuedToken = {
  expiresAt: string;
  jti: string;
  token: string;
};

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function tokenIdentifierHash(jti: string): string {
  return createHash("sha256").update(jti).digest("hex");
}

export async function issueSessionToken(options: {
  secret: string;
  ttlMinutes: number;
  userId: string;
}): Promise<IssuedToken> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + options.ttlMinutes * 60_000);
  const token = await new SignJWT({ purpose: "admin-session" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(options.userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(signingKey(options.secret));
  return { expiresAt: expiresAt.toISOString(), jti, token };
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<{ jti: string; userId: string }> {
  const verified = await jwtVerify(token, signingKey(secret), { audience, issuer });
  if (
    verified.payload.purpose !== "admin-session" ||
    !verified.payload.sub ||
    !verified.payload.jti
  ) {
    throw new Error("INVALID_SESSION_TOKEN");
  }
  return { jti: verified.payload.jti, userId: verified.payload.sub };
}
