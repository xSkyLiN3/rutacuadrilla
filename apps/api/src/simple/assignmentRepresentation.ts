import { createHash } from "node:crypto";

export interface SimpleAssignmentRepresentation {
  body: string;
  byteLength: number;
  etag: string;
}

export function representSimpleAssignment(assignment: unknown): SimpleAssignmentRepresentation {
  const body = JSON.stringify({ assignment });
  const bytes = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    body,
    byteLength: bytes.byteLength,
    etag: `"sha256-${sha256}"`,
  };
}

export function simpleAssignmentHeaders(
  representation: SimpleAssignmentRepresentation,
): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "Content-Length": String(representation.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    ETag: representation.etag,
    Vary: "Authorization",
  };
}

export function simpleAssignmentNotModifiedHeaders(
  representation: SimpleAssignmentRepresentation,
): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    ETag: representation.etag,
    Vary: "Authorization",
  };
}
