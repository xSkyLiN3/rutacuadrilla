import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const algorithm = "scrypt-v1";
const keyLength = 64;
const cost = 16_384;
const blockSize = 8;
const parallelization = 1;
const maxmem = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      keyLength,
      { N: cost, r: blockSize, p: parallelization, maxmem },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("PASSWORD_TOO_SHORT");
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt);
  return [
    algorithm,
    String(cost),
    String(blockSize),
    String(parallelization),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [storedAlgorithm, storedCost, storedBlockSize, storedParallelization, saltText, hashText] =
    encoded.split("$");
  if (
    storedAlgorithm !== algorithm ||
    Number(storedCost) !== cost ||
    Number(storedBlockSize) !== blockSize ||
    Number(storedParallelization) !== parallelization ||
    !saltText ||
    !hashText
  ) {
    return false;
  }

  const expected = Buffer.from(hashText, "base64url");
  if (expected.length !== keyLength) return false;
  const actual = await scrypt(password, Buffer.from(saltText, "base64url"));
  return timingSafeEqual(actual, expected);
}
