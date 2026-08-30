import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatPointAddress, formatRevisionName, RevisionBadge } from "./Shared";

describe("formatRevisionName", () => {
  it("presenta un DRAFT sin número sin inventar una versión", () => {
    expect(formatRevisionName({ status: "DRAFT", number: null })).toBe("Borrador");
  });

  it("señala como provisional el número que llega para un DRAFT", () => {
    expect(formatRevisionName({ status: "DRAFT", number: 7 })).toBe(
      "Borrador (número provisional 7)",
    );
  });

  it("representa ARCHIVED como estado de solo lectura", () => {
    render(<RevisionBadge status="ARCHIVED" />);

    expect(screen.getByText("Archivada")).toBeVisible();
  });

  it("muestra un fallback cuando el dominio no entrega calle", () => {
    expect(formatPointAddress({ number: "12" })).toBe("Calle no informada 12");
    expect(formatPointAddress({})).toBe("Calle no informada S/N");
  });
});
