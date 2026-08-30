import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { issueSessionToken, tokenIdentifierHash, verifySessionToken } from "../src/auth/token.js";

const secret = "test-only-secret-with-more-than-32-characters";

describe("password hashing", () => {
  it("stores a salted scrypt hash and verifies the matching password", async () => {
    const password = "Correcta-Demo-2026!";
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).not.toBe(second);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword("incorrecta", first)).resolves.toBe(false);
    expect(first).not.toContain(password);
  });

  it("rejects passwords shorter than the local policy", async () => {
    await expect(hashPassword("short")).rejects.toThrow("PASSWORD_TOO_SHORT");
  });
});

describe("session tokens", () => {
  it("signs a scoped token and recovers only user and token identifiers", async () => {
    const issued = await issueSessionToken({ secret, ttlMinutes: 30, userId: "user-1" });
    const claims = await verifySessionToken(issued.token, secret);

    expect(claims.userId).toBe("user-1");
    expect(claims.jti).toBe(issued.jti);
    expect(tokenIdentifierHash(claims.jti)).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.token).not.toContain("crew");
  });

  it("rejects a token signed with another secret", async () => {
    const issued = await issueSessionToken({ secret, ttlMinutes: 30, userId: "user-1" });
    await expect(
      verifySessionToken(issued.token, "another-test-secret-with-more-than-32-characters"),
    ).rejects.toThrow();
  });
});
