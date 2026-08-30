import { describe, expect, it } from "vitest";
import { LoginRateLimitError, LoginRateLimiter } from "../src/auth/rateLimiter.js";

describe("login rate limiter", () => {
  it("blocks a repeated account/address pair and reports a bounded retry time", () => {
    let now = 1_000;
    const limiter = new LoginRateLimiter({
      blockMs: 30_000,
      maxFailures: 3,
      now: () => now,
      windowMs: 60_000,
    });

    limiter.recordFailure("127.0.0.1", "ADMIN@EXAMPLE.CL");
    limiter.recordFailure("127.0.0.1", "admin@example.cl");
    limiter.recordFailure("127.0.0.1", " admin@example.cl ");

    expect(() => limiter.assertAllowed("127.0.0.1", "admin@example.cl")).toThrow(
      LoginRateLimitError,
    );
    try {
      limiter.assertAllowed("127.0.0.1", "admin@example.cl");
    } catch (error) {
      expect(error).toMatchObject({ code: "LOGIN_RATE_LIMITED", retryAfterSeconds: 30 });
    }

    now += 30_001;
    expect(() => limiter.assertAllowed("127.0.0.1", "admin@example.cl")).not.toThrow();
  });

  it("blocks distributed attacks against one account and password spraying from one address", () => {
    const accountLimiter = new LoginRateLimiter({
      maxAccountFailures: 3,
      maxAddressFailures: 20,
    });
    accountLimiter.recordFailure("10.0.0.1", "victim@example.cl");
    accountLimiter.recordFailure("10.0.0.2", "victim@example.cl");
    accountLimiter.recordFailure("10.0.0.3", "victim@example.cl");
    expect(() => accountLimiter.assertAllowed("10.0.0.4", "victim@example.cl")).toThrow();

    const addressLimiter = new LoginRateLimiter({
      maxAccountFailures: 20,
      maxAddressFailures: 3,
    });
    addressLimiter.recordFailure("10.0.0.9", "one@example.cl");
    addressLimiter.recordFailure("10.0.0.9", "two@example.cl");
    addressLimiter.recordFailure("10.0.0.9", "three@example.cl");
    expect(() => addressLimiter.assertAllowed("10.0.0.9", "four@example.cl")).toThrow();
  });

  it("does not evict an active account block when the capacity fills", () => {
    const limiter = new LoginRateLimiter({
      maxAccountFailures: 2,
      maxAddressFailures: 100,
      maxEntries: 2,
    });
    limiter.recordFailure("10.0.0.1", "victim@example.cl");
    limiter.recordFailure("10.0.0.2", "victim@example.cl");
    for (let index = 0; index < 20; index += 1) {
      limiter.recordFailure(`10.0.1.${index}`, `spray-${index}@example.cl`);
    }
    expect(() => limiter.assertAllowed("10.0.0.3", "victim@example.cl")).toThrow();
  });

  it("reserves concurrent attempts before authentication completes", () => {
    const limiter = new LoginRateLimiter({
      maxAccountFailures: 3,
      maxAddressFailures: 10,
    });
    const attempts = [
      limiter.beginAttempt("10.0.0.1", "victim@example.cl"),
      limiter.beginAttempt("10.0.0.2", "victim@example.cl"),
      limiter.beginAttempt("10.0.0.3", "victim@example.cl"),
    ];
    expect(() => limiter.beginAttempt("10.0.0.4", "victim@example.cl")).toThrow(
      LoginRateLimitError,
    );
    for (const attempt of attempts) limiter.cancelAttempt(attempt);
    expect(() => limiter.beginAttempt("10.0.0.4", "victim@example.cl")).not.toThrow();
  });

  it("clears the account bucket after success without erasing an address spray block", () => {
    const limiter = new LoginRateLimiter({ maxAccountFailures: 1, maxAddressFailures: 1 });
    limiter.recordFailure("10.0.0.1", "a@example.cl");
    limiter.recordSuccess("10.0.0.1", "a@example.cl");

    expect(() => limiter.assertAllowed("10.0.0.2", "a@example.cl")).not.toThrow();
    expect(() => limiter.assertAllowed("10.0.0.1", "b@example.cl")).toThrow();
  });

  it("preserves concurrent reservations when the legacy success helper clears failures", () => {
    const limiter = new LoginRateLimiter({
      maxAccountFailures: 1,
      maxAddressFailures: 10,
    });
    const activeAttempt = limiter.beginAttempt("10.0.0.1", "a@example.cl");

    limiter.recordSuccess("10.0.0.2", "a@example.cl");

    expect(() => limiter.beginAttempt("10.0.0.3", "a@example.cl")).toThrow(LoginRateLimitError);
    limiter.cancelAttempt(activeAttempt);
    expect(() => limiter.beginAttempt("10.0.0.3", "a@example.cl")).not.toThrow();
  });
});
