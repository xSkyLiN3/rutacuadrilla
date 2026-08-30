import { describe, expect, it } from "vitest";
import type { FieldLiveLocation } from "./fieldLocation";
import {
  type LocationMotionState,
  locationDistanceMeters,
  sampleLocationMotion,
  smoothLocationProgress,
  updateLocationMotion,
} from "./locationMotion";

const BASE_LOCATION: FieldLiveLocation = {
  accuracy: 6,
  latitude: 0.001,
  longitude: 0.002,
  timestamp: 1_000,
};

function offsetNorth(location: FieldLiveLocation, meters: number, timestamp: number) {
  return {
    ...location,
    latitude: location.latitude + meters / 111_320,
    timestamp,
  };
}

function requireState(state: LocationMotionState | null): LocationMotionState {
  expect(state).not.toBeNull();
  if (!state) throw new Error("Se esperaba un estado de movimiento válido");
  return state;
}

describe("locationMotion", () => {
  it("ofrece la misma curva acotada para animar el punto y la cámara", () => {
    expect(smoothLocationProgress(-1)).toBe(0);
    expect(smoothLocationProgress(0.5)).toBe(0.5);
    expect(smoothLocationProgress(2)).toBe(1);
  });

  it("publica la primera medición de inmediato", () => {
    const state = updateLocationMotion(null, BASE_LOCATION, 50);

    expect(sampleLocationMotion(requireState(state), 50)).toEqual({
      location: BASE_LOCATION,
      progress: 1,
      settled: true,
    });
  });

  it("interpola de forma continua y termina exactamente en el objetivo", () => {
    const initial = requireState(updateLocationMotion(null, BASE_LOCATION, 0));
    const nextMeasurement = offsetNorth(BASE_LOCATION, 12, 2_000);
    const moving = requireState(updateLocationMotion(initial, nextMeasurement, 1_000));
    const halfway = sampleLocationMotion(
      moving,
      moving.transitionStartedAt + moving.transitionDurationMs / 2,
    );
    const finished = sampleLocationMotion(
      moving,
      moving.transitionStartedAt + moving.transitionDurationMs,
    );

    expect(halfway.settled).toBe(false);
    expect(locationDistanceMeters(BASE_LOCATION, halfway.location)).toBeCloseTo(6, 0);
    expect(finished).toEqual({ location: nextMeasurement, progress: 1, settled: true });
  });

  it("mantiene estable el punto ante jitter pequeño pero conserva precisión y timestamp nuevos", () => {
    const initial = requireState(updateLocationMotion(null, { ...BASE_LOCATION, accuracy: 15 }, 0));
    const jitter = {
      ...offsetNorth(BASE_LOCATION, 1.5, 2_000),
      accuracy: 9,
    };
    const updated = requireState(updateLocationMotion(initial, jitter, 1_000));

    expect(updated.target.latitude).toBe(BASE_LOCATION.latitude);
    expect(updated.target.longitude).toBe(BASE_LOCATION.longitude);
    expect(updated.target.accuracy).toBe(9);
    expect(updated.target.timestamp).toBe(2_000);
  });

  it("ignora mediciones inválidas, duplicadas o fuera de orden", () => {
    const initial = requireState(updateLocationMotion(null, BASE_LOCATION, 0));

    expect(updateLocationMotion(initial, { ...BASE_LOCATION, timestamp: 999 }, 1_000)).toBe(
      initial,
    );
    expect(updateLocationMotion(initial, BASE_LOCATION, 1_000)).toBe(initial);
    expect(updateLocationMotion(initial, { ...BASE_LOCATION, latitude: Number.NaN }, 1_000)).toBe(
      initial,
    );
  });

  it("limita saltos irreales de una lectura reciente", () => {
    const initial = requireState(updateLocationMotion(null, BASE_LOCATION, 0));
    const outlier = offsetNorth(BASE_LOCATION, 250, 2_000);
    const updated = requireState(
      updateLocationMotion(initial, outlier, 1_000, {
        jitterAccuracyRatio: 0,
        jumpAllowanceMeters: 5,
        maximumAccuracyAllowanceMeters: 0,
        maximumSpeedMetersPerSecond: 10,
      }),
    );
    const displacement = locationDistanceMeters(BASE_LOCATION, updated.target);

    expect(displacement).toBeGreaterThan(14);
    expect(displacement).toBeLessThanOrEqual(15.1);
  });

  it("acepta movimiento plausible sin añadir deriva espacial", () => {
    const initial = requireState(updateLocationMotion(null, BASE_LOCATION, 0));
    const nextMeasurement = offsetNorth(BASE_LOCATION, 18, 2_000);
    const updated = requireState(updateLocationMotion(initial, nextMeasurement, 1_000));

    expect(updated.target.latitude).toBe(nextMeasurement.latitude);
    expect(updated.target.longitude).toBe(nextMeasurement.longitude);
  });

  it("reduce la influencia de una lectura considerablemente menos precisa", () => {
    const initial = requireState(updateLocationMotion(null, BASE_LOCATION, 0));
    const imprecise = {
      ...offsetNorth(BASE_LOCATION, 20, 2_000),
      accuracy: 60,
    };
    const updated = requireState(updateLocationMotion(initial, imprecise, 1_000));
    const displacement = locationDistanceMeters(BASE_LOCATION, updated.target);

    expect(displacement).toBeGreaterThan(4.5);
    expect(displacement).toBeLessThan(5.5);
    expect(updated.target.accuracy).toBe(60);
  });

  it("reacomoda un objetivo durante una transición sin mover el punto de golpe", () => {
    const initial = requireState(updateLocationMotion(null, BASE_LOCATION, 0));
    const firstTarget = offsetNorth(BASE_LOCATION, 16, 2_000);
    const moving = requireState(updateLocationMotion(initial, firstTarget, 1_000));
    const updateAt = moving.transitionStartedAt + moving.transitionDurationMs / 2;
    const beforeUpdate = sampleLocationMotion(moving, updateAt).location;
    const secondTarget = offsetNorth(firstTarget, 8, 3_000);
    const redirected = requireState(updateLocationMotion(moving, secondTarget, updateAt));

    expect(redirected.from.latitude).toBeCloseTo(beforeUpdate.latitude, 12);
    expect(redirected.from.longitude).toBeCloseTo(beforeUpdate.longitude, 12);
    expect(sampleLocationMotion(redirected, updateAt).location.latitude).toBeCloseTo(
      beforeUpdate.latitude,
      12,
    );
  });

  it("vuelve a adquirir la ubicación real tras una pausa prolongada", () => {
    const initial = requireState(updateLocationMotion(null, BASE_LOCATION, 0));
    const relocated = offsetNorth(BASE_LOCATION, 500, 31_000);
    const updated = requireState(
      updateLocationMotion(initial, relocated, 30_000, {
        reacquireAfterMs: 20_000,
      }),
    );

    expect(updated.target.latitude).toBe(relocated.latitude);
    expect(updated.target.longitude).toBe(relocated.longitude);
  });
});
