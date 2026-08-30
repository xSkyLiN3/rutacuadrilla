import type { FieldLiveLocation } from "./fieldLocation";

const EARTH_RADIUS_METERS = 6_378_137;
const MINIMUM_EFFECTIVE_ACCURACY_METERS = 1;

/**
 * Ajustes conservadores para una cuadrilla que puede caminar o desplazarse en
 * vehículo. El objetivo es ocultar el ruido del GPS sin dejar la marca
 * visiblemente atrasada respecto de la persona.
 */
export interface LocationMotionConfig {
  /** Parte de la precisión declarada que se considera ruido de la medición. */
  jitterAccuracyRatio: number;
  maximumAccuracyAllowanceMeters: number;
  maximumJitterMeters: number;
  maximumSpeedMetersPerSecond: number;
  maximumTransitionMs: number;
  minimumJitterMeters: number;
  minimumTransitionMs: number;
  /** Margen fijo antes de limitar un salto, además de velocidad y precisión. */
  jumpAllowanceMeters: number;
  /** Después de una pausa larga se vuelve a adquirir la posición sin limitarla. */
  reacquireAfterMs: number;
  /** Fracción del intervalo GPS dedicada a animar el cambio. */
  transitionIntervalRatio: number;
}

export const DEFAULT_LOCATION_MOTION_CONFIG: Readonly<LocationMotionConfig> = Object.freeze({
  jitterAccuracyRatio: 0.18,
  maximumAccuracyAllowanceMeters: 20,
  maximumJitterMeters: 7,
  maximumSpeedMetersPerSecond: 25,
  maximumTransitionMs: 850,
  minimumJitterMeters: 1.75,
  minimumTransitionMs: 220,
  jumpAllowanceMeters: 8,
  reacquireAfterMs: 20_000,
  transitionIntervalRatio: 0.78,
});

export interface LocationMotionState {
  readonly from: FieldLiveLocation;
  readonly lastMeasurement: FieldLiveLocation;
  readonly lastMeasurementReceivedAt: number;
  readonly target: FieldLiveLocation;
  readonly transitionDurationMs: number;
  readonly transitionStartedAt: number;
}

export interface LocationMotionSample {
  readonly location: FieldLiveLocation;
  readonly progress: number;
  readonly settled: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validLocation(location: FieldLiveLocation): boolean {
  return (
    Number.isFinite(location.accuracy) &&
    location.accuracy >= 0 &&
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180 &&
    Number.isFinite(location.timestamp) &&
    location.timestamp >= 0
  );
}

function copyLocation(location: FieldLiveLocation): FieldLiveLocation {
  return {
    accuracy: location.accuracy,
    latitude: location.latitude,
    longitude: location.longitude,
    timestamp: location.timestamp,
  };
}

function effectiveAccuracy(accuracy: number): number {
  return Math.max(MINIMUM_EFFECTIVE_ACCURACY_METERS, accuracy);
}

function normalizedLongitudeDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function normalizeLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

export function locationDistanceMeters(
  from: Pick<FieldLiveLocation, "latitude" | "longitude">,
  to: Pick<FieldLiveLocation, "latitude" | "longitude">,
): number {
  const fromLatitude = (from.latitude * Math.PI) / 180;
  const toLatitude = (to.latitude * Math.PI) / 180;
  const latitudeDelta = toLatitude - fromLatitude;
  const longitudeDelta = (normalizedLongitudeDelta(from.longitude, to.longitude) * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function interpolateLocation(
  from: FieldLiveLocation,
  to: FieldLiveLocation,
  progress: number,
): FieldLiveLocation {
  const boundedProgress = clamp(progress, 0, 1);
  if (boundedProgress <= 0) return copyLocation(from);
  if (boundedProgress >= 1) return copyLocation(to);
  return {
    accuracy: from.accuracy + (to.accuracy - from.accuracy) * boundedProgress,
    latitude: from.latitude + (to.latitude - from.latitude) * boundedProgress,
    longitude: normalizeLongitude(
      from.longitude + normalizedLongitudeDelta(from.longitude, to.longitude) * boundedProgress,
    ),
    timestamp: Math.round(from.timestamp + (to.timestamp - from.timestamp) * boundedProgress),
  };
}

/** Curva sin aceleraciones bruscas en el inicio ni al detenerse. */
export function smoothLocationProgress(progress: number): number {
  const boundedProgress = clamp(progress, 0, 1);
  return boundedProgress * boundedProgress * (3 - 2 * boundedProgress);
}

export function sampleLocationMotion(
  state: LocationMotionState,
  nowMs: number,
): LocationMotionSample {
  if (!Number.isFinite(nowMs) || state.transitionDurationMs <= 0) {
    return { location: copyLocation(state.target), progress: 1, settled: true };
  }

  const linearProgress = clamp(
    (nowMs - state.transitionStartedAt) / state.transitionDurationMs,
    0,
    1,
  );
  if (linearProgress >= 1) {
    return { location: copyLocation(state.target), progress: 1, settled: true };
  }

  return {
    location: interpolateLocation(state.from, state.target, smoothLocationProgress(linearProgress)),
    progress: linearProgress,
    settled: false,
  };
}

function resolvedConfig(overrides: Partial<LocationMotionConfig>): LocationMotionConfig {
  return { ...DEFAULT_LOCATION_MOTION_CONFIG, ...overrides };
}

function initialMotionState(
  measurement: FieldLiveLocation,
  receivedAtMs: number,
): LocationMotionState {
  const location = copyLocation(measurement);
  return {
    from: location,
    lastMeasurement: copyLocation(measurement),
    lastMeasurementReceivedAt: receivedAtMs,
    target: location,
    transitionDurationMs: 0,
    transitionStartedAt: receivedAtMs,
  };
}

function jitterThresholdMeters(
  previous: FieldLiveLocation,
  measurement: FieldLiveLocation,
  config: LocationMotionConfig,
): number {
  const accuracyThreshold =
    Math.min(effectiveAccuracy(previous.accuracy), effectiveAccuracy(measurement.accuracy)) *
    config.jitterAccuracyRatio;
  return clamp(accuracyThreshold, config.minimumJitterMeters, config.maximumJitterMeters);
}

function limitedTarget(
  previous: FieldLiveLocation,
  measurement: FieldLiveLocation,
  elapsedMeasurementMs: number,
  config: LocationMotionConfig,
): FieldLiveLocation {
  const distance = locationDistanceMeters(previous, measurement);
  const jitterThreshold = jitterThresholdMeters(previous, measurement, config);

  if (distance <= jitterThreshold) {
    return {
      accuracy: measurement.accuracy,
      latitude: previous.latitude,
      longitude: previous.longitude,
      timestamp: measurement.timestamp,
    };
  }

  const reacquiring = elapsedMeasurementMs >= config.reacquireAfterMs;
  let allowedRatio = 1;
  if (!reacquiring) {
    const elapsedSeconds = Math.max(0.25, elapsedMeasurementMs / 1_000);
    const accuracyAllowance = Math.min(
      config.maximumAccuracyAllowanceMeters,
      Math.max(effectiveAccuracy(previous.accuracy), effectiveAccuracy(measurement.accuracy)) *
        config.jitterAccuracyRatio,
    );
    const maximumDistance =
      config.jumpAllowanceMeters +
      config.maximumSpeedMetersPerSecond * elapsedSeconds +
      accuracyAllowance;
    allowedRatio = Math.min(1, maximumDistance / distance);

    // Una lectura menos precisa tira menos del punto actual; una lectura igual
    // o mejor conserva respuesta inmediata.
    if (measurement.accuracy > previous.accuracy) {
      allowedRatio *= clamp(
        effectiveAccuracy(previous.accuracy) / effectiveAccuracy(measurement.accuracy),
        0.25,
        1,
      );
    }
  }

  const limited = interpolateLocation(previous, measurement, allowedRatio);
  return {
    ...limited,
    // La precisión y el tiempo siempre describen la última lectura real, aunque
    // sus coordenadas hayan sido estabilizadas.
    accuracy: measurement.accuracy,
    timestamp: measurement.timestamp,
  };
}

/**
 * Incorpora una lectura GPS sin mutar el estado previo. `receivedAtMs` debe usar
 * el mismo reloj monotónico que se pasará luego a `sampleLocationMotion`
 * (normalmente `performance.now()`). Las lecturas inválidas o fuera de orden se
 * descartan devolviendo exactamente el estado anterior.
 */
export function updateLocationMotion(
  state: LocationMotionState | null,
  measurement: FieldLiveLocation,
  receivedAtMs: number,
  overrides: Partial<LocationMotionConfig> = {},
): LocationMotionState | null {
  if (!validLocation(measurement) || !Number.isFinite(receivedAtMs)) return state;
  if (!state) return initialMotionState(measurement, receivedAtMs);
  if (measurement.timestamp <= state.lastMeasurement.timestamp) return state;

  const config = resolvedConfig(overrides);
  const elapsedMeasurementMs = measurement.timestamp - state.lastMeasurement.timestamp;
  const current = sampleLocationMotion(state, receivedAtMs).location;
  const target = limitedTarget(state.target, measurement, elapsedMeasurementMs, config);
  const arrivalIntervalMs = Math.max(0, receivedAtMs - state.lastMeasurementReceivedAt);
  const targetDistance = locationDistanceMeters(current, target);
  const distanceDurationMs = Math.min(180, targetDistance * 5);
  const transitionDurationMs = clamp(
    arrivalIntervalMs * config.transitionIntervalRatio + distanceDurationMs,
    config.minimumTransitionMs,
    config.maximumTransitionMs,
  );

  return {
    from: current,
    lastMeasurement: copyLocation(measurement),
    lastMeasurementReceivedAt: receivedAtMs,
    target,
    transitionDurationMs,
    transitionStartedAt: receivedAtMs,
  };
}
