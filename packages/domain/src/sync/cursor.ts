import { z } from "zod";
import { DomainError } from "../errors.js";

const cursorPayloadSchema = z.object({
  crewId: z.string().uuid(),
  sequence: z.string().regex(/^\d+$/u),
  version: z.literal(1),
});

export function encodeSyncCursor(crewId: string, sequence: number): string {
  return Buffer.from(
    JSON.stringify({ crewId, sequence: String(sequence), version: 1 }),
    "utf8",
  ).toString("base64url");
}

export function decodeSyncCursor(cursor: string | undefined, crewId: string): number {
  if (!cursor) return 0;
  try {
    const payload = cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (payload.crewId !== crewId) {
      throw new DomainError("CURSOR_SCOPE_MISMATCH", { statusCode: 400 });
    }
    const sequence = Number(payload.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new DomainError("CURSOR_INVALID", { statusCode: 400 });
    }
    return sequence;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("CURSOR_INVALID", { cause: error, statusCode: 400 });
  }
}
