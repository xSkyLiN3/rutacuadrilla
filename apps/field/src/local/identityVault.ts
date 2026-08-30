import type { FieldMembership, FieldUser } from "../types";

const VAULT_DATABASE = "rutacuadrilla-field-identity-v1";
const VAULT_STORE = "keys";
const IDENTITY_KEY = "local-identity-hmac-v1";
const ENVELOPE_VERSION = 1 as const;
const VAULT_TIMEOUT_MS = 15_000;

export interface LocalIdentityAuth {
  memberships: FieldMembership[];
  user: FieldUser;
}

interface IdentityPayload {
  auth: LocalIdentityAuth;
  expiresAt: string;
}

interface SignedIdentityEnvelope {
  partitionId: string;
  payloadJson: string;
  signature: string;
  subjectBinding: string;
  version: typeof ENVELOPE_VERSION;
}

export interface BoundLocalIdentity extends IdentityPayload {
  partitionId: string;
  serialized: string;
  subjectBinding: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error("LOCAL_IDENTITY_VAULT_TIMEOUT"))),
      VAULT_TIMEOUT_MS,
    );
    request.addEventListener("success", () => finish(() => resolve(request.result)), {
      once: true,
    });
    request.addEventListener(
      "error",
      () => finish(() => reject(request.error ?? new Error("LOCAL_IDENTITY_VAULT_REQUEST_FAILED"))),
      { once: true },
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let transactionError: unknown;
    let timedOut = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        transaction.abort();
      } catch {
        // La transacción ya puede haber terminado sin que el evento llegara a este contexto.
      }
      finish(() => reject(new Error("LOCAL_IDENTITY_VAULT_TIMEOUT")));
    }, VAULT_TIMEOUT_MS);
    transaction.addEventListener("error", () => {
      transactionError = transaction.error;
    });
    transaction.addEventListener("complete", () => finish(resolve), { once: true });
    transaction.addEventListener(
      "abort",
      () =>
        finish(() =>
          reject(
            timedOut
              ? new Error("LOCAL_IDENTITY_VAULT_TIMEOUT")
              : (transaction.error ??
                  transactionError ??
                  new Error("LOCAL_IDENTITY_VAULT_ABORTED")),
          ),
        ),
      { once: true },
    );
  });
}

async function outcome<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { error: unknown; ok: false }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { error, ok: false };
  }
}

async function readIdentityKey(vault: IDBDatabase): Promise<unknown> {
  const transaction = vault.transaction(VAULT_STORE, "readonly");
  const completed = transactionDone(transaction);
  const request = requestResult(transaction.objectStore(VAULT_STORE).get(IDENTITY_KEY));
  const [requestOutcome, transactionOutcome] = await Promise.all([
    outcome(request),
    outcome(completed),
  ]);
  if (!transactionOutcome.ok) throw transactionOutcome.error;
  if (!requestOutcome.ok) throw requestOutcome.error;
  return requestOutcome.value;
}

function openVault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(VAULT_DATABASE, 1);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error("LOCAL_IDENTITY_VAULT_TIMEOUT"))),
      VAULT_TIMEOUT_MS,
    );
    request.addEventListener(
      "upgradeneeded",
      () => {
        if (!request.result.objectStoreNames.contains(VAULT_STORE)) {
          request.result.createObjectStore(VAULT_STORE);
        }
      },
      { once: true },
    );
    request.addEventListener(
      "success",
      () => {
        if (settled) request.result.close();
        else finish(() => resolve(request.result));
      },
      { once: true },
    );
    request.addEventListener(
      "error",
      () => finish(() => reject(request.error ?? new Error("LOCAL_IDENTITY_VAULT_OPEN_FAILED"))),
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () => finish(() => reject(new Error("LOCAL_IDENTITY_VAULT_BLOCKED"))),
      { once: true },
    );
  });
}

async function storedIdentityKey(create: boolean): Promise<CryptoKey | null> {
  if (typeof indexedDB === "undefined" || !crypto.subtle) {
    throw new Error("LOCAL_IDENTITY_VAULT_UNAVAILABLE");
  }
  const vault = await openVault();
  try {
    const existing = await readIdentityKey(vault);
    if (existing instanceof CryptoKey) return existing;
    if (!create) return null;
    const generated = await createIdentityHmacKey();
    return persistIdentityKeyExclusively(
      generated,
      (candidate) => {
        const transaction = vault.transaction(VAULT_STORE, "readwrite");
        const completed = transactionDone(transaction);
        const request = requestResult(
          transaction.objectStore(VAULT_STORE).add(candidate, IDENTITY_KEY),
        ).then(() => undefined);
        return { completed, request };
      },
      () => readIdentityKey(vault),
    );
  } finally {
    vault.close();
  }
}

export async function persistIdentityKeyExclusively(
  generated: CryptoKey,
  beginAdd: (candidate: CryptoKey) => { completed: Promise<void>; request: Promise<void> },
  readWinner: () => Promise<unknown>,
): Promise<CryptoKey> {
  const attempt = beginAdd(generated);
  const [requestOutcome, transactionOutcome] = await Promise.all([
    outcome(attempt.request),
    outcome(attempt.completed),
  ]);
  if (!requestOutcome.ok) {
    const error = requestOutcome.error;
    if (
      !error ||
      typeof error !== "object" ||
      !("name" in error) ||
      error.name !== "ConstraintError"
    ) {
      throw error;
    }
    if (
      !transactionOutcome.ok &&
      transactionOutcome.error instanceof Error &&
      transactionOutcome.error.message === "LOCAL_IDENTITY_VAULT_TIMEOUT"
    ) {
      throw transactionOutcome.error;
    }
    const winner = await readWinner();
    if (winner instanceof CryptoKey) return winner;
    throw new Error("LOCAL_IDENTITY_KEY_RACE_LOST");
  }
  if (!transactionOutcome.ok) throw transactionOutcome.error;
  return generated;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/u.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function validAuth(value: unknown): value is LocalIdentityAuth {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalIdentityAuth>;
  return (
    Boolean(candidate.user) &&
    typeof candidate.user?.id === "string" &&
    candidate.user.id.length > 0 &&
    typeof candidate.user.email === "string" &&
    typeof candidate.user.name === "string" &&
    Array.isArray(candidate.memberships) &&
    candidate.memberships.every(
      (membership) =>
        membership &&
        typeof membership.crewId === "string" &&
        membership.crewId.length > 0 &&
        typeof membership.crewName === "string" &&
        membership.crewName.length > 0 &&
        typeof membership.membershipId === "string" &&
        membership.membershipId.length > 0 &&
        (membership.role === "ADMIN" || membership.role === "MEMBER"),
    )
  );
}

function parseEnvelope(serialized: string): SignedIdentityEnvelope | null {
  try {
    const envelope = JSON.parse(serialized) as Partial<SignedIdentityEnvelope>;
    if (
      envelope.version !== ENVELOPE_VERSION ||
      typeof envelope.partitionId !== "string" ||
      typeof envelope.payloadJson !== "string" ||
      typeof envelope.signature !== "string" ||
      typeof envelope.subjectBinding !== "string" ||
      !/^[0-9a-f]{64}$/u.test(envelope.partitionId) ||
      !/^[0-9a-f]{64}$/u.test(envelope.subjectBinding) ||
      !/^[0-9a-f]{64}$/u.test(envelope.signature)
    ) {
      return null;
    }
    return envelope as SignedIdentityEnvelope;
  } catch {
    return null;
  }
}

async function identityCoordinates(key: CryptoKey, userId: string) {
  return {
    partitionId: await hmacHex(key, `partition:v1\0${userId}`),
    subjectBinding: await hmacHex(key, `subject:v1\0${userId}`),
  };
}

export function calculateLocalIdentityExpiry(
  serverExpiresAt?: string,
  previousExpiresAt?: number | null,
  now = Date.now(),
): string {
  const localExpiry = now + 12 * 60 * 60 * 1_000;
  const serverExpiry = serverExpiresAt ? Date.parse(serverExpiresAt) : Number.NaN;
  const boundedExpiry = Number.isFinite(serverExpiry) ? serverExpiry : previousExpiresAt;
  return new Date(
    boundedExpiry === null || boundedExpiry === undefined
      ? localExpiry
      : Math.min(localExpiry, boundedExpiry),
  ).toISOString();
}

export function createIdentityHmacKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"]);
}

export async function signLocalIdentity(
  key: CryptoKey,
  auth: LocalIdentityAuth,
  expiresAt: string,
): Promise<BoundLocalIdentity> {
  if (!validAuth(auth) || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("INVALID_LOCAL_IDENTITY");
  }
  const payloadJson = JSON.stringify({ auth, expiresAt } satisfies IdentityPayload);
  const coordinates = await identityCoordinates(key, auth.user.id);
  const signedValue = [
    "identity-cache:v1",
    coordinates.partitionId,
    coordinates.subjectBinding,
    payloadJson,
  ].join("\0");
  const envelope: SignedIdentityEnvelope = {
    ...coordinates,
    payloadJson,
    signature: await hmacHex(key, signedValue),
    version: ENVELOPE_VERSION,
  };
  return {
    auth,
    expiresAt,
    ...coordinates,
    serialized: JSON.stringify(envelope),
  };
}

export async function verifyLocalIdentity(
  key: CryptoKey,
  serialized: string,
  now = Date.now(),
): Promise<BoundLocalIdentity | null> {
  const envelope = parseEnvelope(serialized);
  if (!envelope) return null;
  let payload: IdentityPayload;
  try {
    payload = JSON.parse(envelope.payloadJson) as IdentityPayload;
  } catch {
    return null;
  }
  if (
    !validAuth(payload.auth) ||
    !payload.expiresAt ||
    !Number.isFinite(Date.parse(payload.expiresAt)) ||
    Date.parse(payload.expiresAt) <= now
  ) {
    return null;
  }
  const coordinates = await identityCoordinates(key, payload.auth.user.id);
  if (
    coordinates.partitionId !== envelope.partitionId ||
    coordinates.subjectBinding !== envelope.subjectBinding
  ) {
    return null;
  }
  const signature = hexToBytes(envelope.signature);
  if (!signature) return null;
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(
      [
        "identity-cache:v1",
        envelope.partitionId,
        envelope.subjectBinding,
        envelope.payloadJson,
      ].join("\0"),
    ),
  );
  if (!validSignature) return null;
  return {
    ...payload,
    partitionId: envelope.partitionId,
    serialized,
    subjectBinding: envelope.subjectBinding,
  };
}

export async function createBoundLocalIdentity(
  auth: LocalIdentityAuth,
  expiresAt: string,
): Promise<BoundLocalIdentity> {
  const key = await storedIdentityKey(true);
  if (!key) throw new Error("LOCAL_IDENTITY_KEY_MISSING");
  return signLocalIdentity(key, auth, expiresAt);
}

export async function readBoundLocalIdentity(
  serialized: string | null,
  now = Date.now(),
): Promise<BoundLocalIdentity | null> {
  if (!serialized) return null;
  const envelope = parseEnvelope(serialized);
  if (!envelope) return null;
  const key = await storedIdentityKey(false);
  return key ? verifyLocalIdentity(key, serialized, now) : null;
}
