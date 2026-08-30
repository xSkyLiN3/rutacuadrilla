import { describe, expect, it } from "vitest";
import {
  representSimpleAssignment,
  simpleAssignmentHeaders,
  simpleAssignmentNotModifiedHeaders,
} from "../src/simple/assignmentRepresentation.js";

describe("simple assignment representation", () => {
  it("produce un ETag fuerte y estable para el cuerpo exacto", () => {
    const first = representSimpleAssignment({ id: "assignment-1", points: [{ version: 0 }] });
    const same = representSimpleAssignment({ id: "assignment-1", points: [{ version: 0 }] });
    const changed = representSimpleAssignment({ id: "assignment-1", points: [{ version: 1 }] });

    expect(first.body).toBe('{"assignment":{"id":"assignment-1","points":[{"version":0}]}}');
    expect(first.etag).toMatch(/^"sha256-[a-f0-9]{64}"$/u);
    expect(same.etag).toBe(first.etag);
    expect(changed.etag).not.toBe(first.etag);
    expect(first.byteLength).toBe(Buffer.byteLength(first.body, "utf8"));
  });

  it("exige revalidación privada y conserva el validador en 200 y 304", () => {
    const representation = representSimpleAssignment(null);
    expect(simpleAssignmentHeaders(representation)).toMatchObject({
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      ETag: representation.etag,
      Vary: "Authorization",
    });
    expect(simpleAssignmentNotModifiedHeaders(representation)).toEqual({
      "Cache-Control": "private, no-store",
      ETag: representation.etag,
      Vary: "Authorization",
    });
  });
});
