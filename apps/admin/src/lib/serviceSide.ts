import type { ServiceSide } from "../api/types";

export const SERVICE_SIDE_OPTIONS: ReadonlyArray<{
  label: string;
  value: ServiceSide;
}> = [
  { value: "BOTH", label: "Ambos lados del tramo" },
  { value: "LEFT", label: "Solo lado izquierdo según el sentido del tramo" },
  { value: "RIGHT", label: "Solo lado derecho según el sentido del tramo" },
];

export function normalizeServiceSide(value: ServiceSide | undefined): ServiceSide {
  return value ?? "BOTH";
}

export function formatServiceSide(value: ServiceSide | undefined): string {
  return (
    SERVICE_SIDE_OPTIONS.find((option) => option.value === normalizeServiceSide(value))?.label ??
    "Ambos lados del tramo"
  );
}
