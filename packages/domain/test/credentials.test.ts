import { describe, expect, it } from "vitest";
import { accountEmailSchema, loginPasswordSchema, newAccountPasswordSchema } from "../src/index.js";

describe("authentication credential contract", () => {
  it("uses one email contract for account creation and login", () => {
    expect(accountEmailSchema.safeParse("admin@example.com").success).toBe(true);
    expect(accountEmailSchema.safeParse("a@b..com").success).toBe(false);
  });

  it("keeps provisioned passwords within the login input boundary", () => {
    expect(newAccountPasswordSchema.safeParse("A".repeat(12)).success).toBe(true);
    expect(newAccountPasswordSchema.safeParse("A".repeat(256)).success).toBe(true);
    expect(newAccountPasswordSchema.safeParse("A".repeat(257)).success).toBe(false);
    expect(loginPasswordSchema.safeParse("A".repeat(256)).success).toBe(true);
    expect(loginPasswordSchema.safeParse("A".repeat(257)).success).toBe(false);
  });
});
