/// <reference types="node" />

import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  calculateLocalIdentityExpiry,
  createIdentityHmacKey,
  persistIdentityKeyExclusively,
  signLocalIdentity,
  verifyLocalIdentity,
} from "./identityVault";

const accountA = {
  memberships: [
    {
      crewId: "crew-1",
      crewName: "Cuadrilla uno",
      membershipId: "membership-a",
      role: "MEMBER" as const,
    },
  ],
  user: { email: "a@example.test", id: "account-a", name: "Cuenta A" },
};

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});

describe("local identity integrity binding", () => {
  it("uses a non-extractable key and rejects a tampered cached identity", async () => {
    const key = await createIdentityHmacKey();
    expect(key.extractable).toBe(false);
    const identity = await signLocalIdentity(key, accountA, "2026-08-13T20:00:00.000Z");
    const envelope = JSON.parse(identity.serialized) as { payloadJson: string };
    envelope.payloadJson = envelope.payloadJson.replace("account-a", "account-b");

    await expect(
      verifyLocalIdentity(key, JSON.stringify(envelope), Date.parse("2026-08-13T10:00:00.000Z")),
    ).resolves.toBeNull();
  });

  it("derives different stable partitions for accounts A and B", async () => {
    const key = await createIdentityHmacKey();
    const expiresAt = "2026-08-13T20:00:00.000Z";
    const firstA = await signLocalIdentity(key, accountA, expiresAt);
    const secondA = await signLocalIdentity(key, accountA, expiresAt);
    const accountB = await signLocalIdentity(
      key,
      { ...accountA, user: { ...accountA.user, id: "account-b" } },
      expiresAt,
    );

    expect(firstA.partitionId).toBe(secondA.partitionId);
    expect(firstA.partitionId).not.toBe(accountB.partitionId);
    expect(firstA.subjectBinding).not.toBe(accountB.subjectBinding);
  });

  it("keeps one winning key when two tabs initialize the vault concurrently", async () => {
    const [firstGenerated, secondGenerated] = await Promise.all([
      createIdentityHmacKey(),
      createIdentityHmacKey(),
    ]);
    let arrivals = 0;
    let winner: CryptoKey | undefined;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const add = async (candidate: CryptoKey) => {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier?.();
      await barrier;
      if (winner) {
        const constraint = new Error("identity key already exists");
        constraint.name = "ConstraintError";
        throw constraint;
      }
      winner = candidate;
    };
    const readWinner = async () => winner;
    const beginAdd = (candidate: CryptoKey) => {
      const transaction = add(candidate);
      return { completed: transaction, request: transaction };
    };

    const [firstResult, secondResult] = await Promise.all([
      persistIdentityKeyExclusively(firstGenerated, beginAdd, readWinner),
      persistIdentityKeyExclusively(secondGenerated, beginAdd, readWinner),
    ]);

    expect(firstResult).toBe(winner);
    expect(secondResult).toBe(winner);
    expect(firstResult.extractable).toBe(false);
  });

  it("does not return a generated key when add succeeds but its transaction aborts later", async () => {
    const generated = await createIdentityHmacKey();
    const lateAbort = new Error("late transaction abort");
    const readWinner = vi.fn();

    await expect(
      persistIdentityKeyExclusively(
        generated,
        () => ({
          completed: Promise.resolve().then(() => {
            throw lateAbort;
          }),
          request: Promise.resolve(),
        }),
        readWinner,
      ),
    ).rejects.toBe(lateAbort);
    expect(readWinner).not.toHaveBeenCalled();
  });

  it("waits for a losing transaction to abort before reading the winning key", async () => {
    const [generated, winner] = await Promise.all([
      createIdentityHmacKey(),
      createIdentityHmacKey(),
    ]);
    const constraint = new Error("identity key already exists");
    constraint.name = "ConstraintError";
    const transactionAbort = new Error("transaction aborted after constraint");
    let rejectTransaction: ((error: Error) => void) | undefined;
    let transactionFinished = false;
    const completed = new Promise<void>((_resolve, reject) => {
      rejectTransaction = reject;
    });
    const readWinner = vi.fn(async () => {
      expect(transactionFinished).toBe(true);
      return winner;
    });

    const persisted = persistIdentityKeyExclusively(
      generated,
      () => ({ completed, request: Promise.reject(constraint) }),
      readWinner,
    );
    await Promise.resolve();
    expect(readWinner).not.toHaveBeenCalled();

    transactionFinished = true;
    rejectTransaction?.(transactionAbort);

    await expect(persisted).resolves.toBe(winner);
    expect(readWinner).toHaveBeenCalledOnce();
  });

  it("rejects expired and unsigned legacy caches until online reauthentication signs them", async () => {
    const key = await createIdentityHmacKey();
    const unsignedLegacy = JSON.stringify({
      auth: accountA,
      expiresAt: "2026-08-13T20:00:00.000Z",
    });
    await expect(
      verifyLocalIdentity(key, unsignedLegacy, Date.parse("2026-08-13T10:00:00.000Z")),
    ).resolves.toBeNull();

    const rebound = await signLocalIdentity(key, accountA, "2026-08-13T20:00:00.000Z");
    await expect(
      verifyLocalIdentity(key, rebound.serialized, Date.parse("2026-08-13T10:00:00.000Z")),
    ).resolves.toMatchObject({ auth: accountA, partitionId: rebound.partitionId });
    await expect(
      verifyLocalIdentity(key, rebound.serialized, Date.parse("2026-08-13T20:00:00.000Z")),
    ).resolves.toBeNull();
  });

  it("rejects a correctly signed legacy identity that lacks membershipId", async () => {
    const key = await createIdentityHmacKey();
    const signed = await signLocalIdentity(key, accountA, "2026-08-13T20:00:00.000Z");
    const envelope = JSON.parse(signed.serialized) as {
      partitionId: string;
      payloadJson: string;
      signature: string;
      subjectBinding: string;
    };
    const payload = JSON.parse(envelope.payloadJson) as {
      auth: { memberships: Array<{ membershipId?: string }> };
    };
    delete payload.auth.memberships[0]?.membershipId;
    envelope.payloadJson = JSON.stringify(payload);
    const signedValue = [
      "identity-cache:v1",
      envelope.partitionId,
      envelope.subjectBinding,
      envelope.payloadJson,
    ].join("\0");
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedValue));
    envelope.signature = Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    await expect(
      verifyLocalIdentity(key, JSON.stringify(envelope), Date.parse("2026-08-13T10:00:00.000Z")),
    ).resolves.toBeNull();
  });

  it("bounds an offline identity by the shorter local or server expiry", () => {
    const now = Date.parse("2026-08-13T10:00:00.000Z");
    expect(calculateLocalIdentityExpiry("2026-08-13T11:00:00.000Z", null, now)).toBe(
      "2026-08-13T11:00:00.000Z",
    );
    expect(calculateLocalIdentityExpiry(undefined, null, now)).toBe("2026-08-13T22:00:00.000Z");
  });
});
