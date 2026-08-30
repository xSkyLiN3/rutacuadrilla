import { createHash } from "node:crypto";

type RateLimitEntry = {
  blockedUntil: number;
  failures: number[];
  inFlight: number;
};

export type LoginRateLimitAttempt = {
  readonly accountKey: string;
  readonly addressKey: string;
};

export type LoginRateLimiterOptions = {
  blockMs?: number;
  maxAccountFailures?: number;
  maxAddressFailures?: number;
  maxEntries?: number;
  /** Compatibilidad con pruebas/configuración anterior: umbral por cuenta. */
  maxFailures?: number;
  now?: () => number;
  windowMs?: number;
};

export class LoginRateLimiter {
  private readonly accountEntries = new Map<string, RateLimitEntry>();
  private readonly addressEntries = new Map<string, RateLimitEntry>();
  private readonly blockMs: number;
  private readonly maxAccountFailures: number;
  private readonly maxAddressFailures: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.blockMs = options.blockMs ?? 15 * 60_000;
    this.maxAccountFailures = options.maxAccountFailures ?? options.maxFailures ?? 5;
    this.maxAddressFailures = options.maxAddressFailures ?? 25;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? 15 * 60_000;
  }

  assertAllowed(address: string, email: string): void {
    const now = this.now();
    const retryAfter = [
      this.retryAfter(this.addressEntries, this.addressKey(address), now),
      this.retryAfter(this.accountEntries, this.accountKey(email), now),
    ].reduce((maximum, value) => Math.max(maximum, value), 0);
    if (retryAfter > 0) {
      throw new LoginRateLimitError(Math.ceil(retryAfter / 1_000));
    }
  }

  beginAttempt(address: string, email: string): LoginRateLimitAttempt {
    const now = this.now();
    this.assertAllowed(address, email);
    const addressKey = this.addressKey(address);
    const accountKey = this.accountKey(email);
    const addressEntry = this.entry(this.addressEntries, addressKey, now);
    const accountEntry = this.entry(this.accountEntries, accountKey, now);
    if (
      addressEntry.failures.length + addressEntry.inFlight >= this.maxAddressFailures ||
      accountEntry.failures.length + accountEntry.inFlight >= this.maxAccountFailures
    ) {
      throw new LoginRateLimitError(1);
    }
    addressEntry.inFlight += 1;
    accountEntry.inFlight += 1;
    this.touch(this.addressEntries, addressKey, addressEntry);
    this.touch(this.accountEntries, accountKey, accountEntry);
    this.pruneCapacity(this.addressEntries, now);
    this.pruneCapacity(this.accountEntries, now);
    return { accountKey, addressKey };
  }

  completeFailure(attempt: LoginRateLimitAttempt): void {
    const now = this.now();
    this.finishAttempt(this.addressEntries, attempt.addressKey, this.maxAddressFailures, now, true);
    this.finishAttempt(this.accountEntries, attempt.accountKey, this.maxAccountFailures, now, true);
  }

  completeSuccess(attempt: LoginRateLimitAttempt): void {
    const now = this.now();
    this.finishAttempt(
      this.addressEntries,
      attempt.addressKey,
      this.maxAddressFailures,
      now,
      false,
    );
    const accountEntry = this.accountEntries.get(attempt.accountKey);
    if (accountEntry) {
      accountEntry.inFlight = Math.max(0, accountEntry.inFlight - 1);
      accountEntry.failures = [];
      accountEntry.blockedUntil = 0;
      if (accountEntry.inFlight === 0) this.accountEntries.delete(attempt.accountKey);
      else this.touch(this.accountEntries, attempt.accountKey, accountEntry);
    }
  }

  cancelAttempt(attempt: LoginRateLimitAttempt): void {
    const now = this.now();
    this.finishAttempt(
      this.addressEntries,
      attempt.addressKey,
      this.maxAddressFailures,
      now,
      false,
    );
    this.finishAttempt(
      this.accountEntries,
      attempt.accountKey,
      this.maxAccountFailures,
      now,
      false,
    );
  }

  recordFailure(address: string, email: string): void {
    this.completeFailure(this.beginAttempt(address, email));
  }

  recordSuccess(_address: string, email: string): void {
    // Una credencial correcta rehabilita la cuenta, pero no borra el historial
    // agregado de la IP: eso impediría detectar password spraying tras acertar
    // una de las cuentas atacadas.
    const accountKey = this.accountKey(email);
    const accountEntry = this.accountEntries.get(accountKey);
    if (!accountEntry) return;
    accountEntry.failures = [];
    accountEntry.blockedUntil = 0;
    if (accountEntry.inFlight === 0) this.accountEntries.delete(accountKey);
    else this.touch(this.accountEntries, accountKey, accountEntry);
  }

  private entry(entries: Map<string, RateLimitEntry>, key: string, now: number): RateLimitEntry {
    const entry = entries.get(key) ?? { blockedUntil: 0, failures: [], inFlight: 0 };
    this.pruneEntry(entry, now);
    return entry;
  }

  private finishAttempt(
    entries: Map<string, RateLimitEntry>,
    key: string,
    threshold: number,
    now: number,
    failed: boolean,
  ): void {
    const entry = entries.get(key);
    if (!entry) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    this.pruneEntry(entry, now);
    if (failed) entry.failures.push(now);
    if (entry.failures.length >= threshold) entry.blockedUntil = now + this.blockMs;
    if (entry.inFlight === 0 && entry.failures.length === 0 && entry.blockedUntil === 0) {
      entries.delete(key);
      return;
    }
    this.touch(entries, key, entry);
  }

  private touch(entries: Map<string, RateLimitEntry>, key: string, entry: RateLimitEntry): void {
    entries.delete(key);
    entries.set(key, entry);
  }

  private addressKey(address: string): string {
    return address.trim().toLocaleLowerCase("en-US");
  }

  private accountKey(email: string): string {
    const normalizedEmail = email.trim().toLocaleLowerCase("en-US");
    return createHash("sha256").update(normalizedEmail).digest("hex");
  }

  private pruneEntry(entry: RateLimitEntry, now: number): void {
    const cutoff = now - this.windowMs;
    entry.failures = entry.failures.filter((failure) => failure > cutoff);
    if (entry.blockedUntil <= now) entry.blockedUntil = 0;
  }

  private pruneCapacity(entries: Map<string, RateLimitEntry>, now: number): void {
    for (const [key, entry] of entries) {
      this.pruneEntry(entry, now);
      if (entry.failures.length === 0 && entry.blockedUntil === 0 && entry.inFlight === 0) {
        entries.delete(key);
      }
    }
    if (entries.size <= this.maxEntries) return;
    for (const [key, entry] of entries) {
      if (entries.size <= this.maxEntries) return;
      // Nunca se degrada un bloqueo activo para respetar el límite de memoria.
      // Si todos los buckets están bloqueados, se permite crecer temporalmente
      // hasta que la poda por tiempo pueda retirarlos.
      if (entry.blockedUntil <= now && entry.inFlight === 0) entries.delete(key);
    }
  }

  private retryAfter(entries: Map<string, RateLimitEntry>, key: string, now: number): number {
    const entry = entries.get(key);
    if (!entry) return 0;
    this.pruneEntry(entry, now);
    if (entry.failures.length === 0 && entry.blockedUntil === 0 && entry.inFlight === 0) {
      entries.delete(key);
    }
    return Math.max(0, entry.blockedUntil - now);
  }
}

export class LoginRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  readonly statusCode = 429;
  readonly code = "LOGIN_RATE_LIMITED";

  constructor(retryAfterSeconds: number) {
    super("LOGIN_RATE_LIMITED");
    this.name = "LoginRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
