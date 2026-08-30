import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StreetLegend } from "./StreetLegend";

describe("StreetLegend", () => {
  it("explica sin depender del color qué marca inicia y termina el sentido", () => {
    render(<StreetLegend />);

    expect(screen.getByText("Inicio del componente")).toBeVisible();
    expect(screen.getByText("Fin del componente")).toBeVisible();
    expect(screen.getByText("Izquierdo")).toBeVisible();
    expect(screen.getByText("Derecho")).toBeVisible();
    expect(screen.getByText("Ambos lados")).toBeVisible();
  });
});
