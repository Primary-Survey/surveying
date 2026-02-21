export type RoverFixQuality =
  | 'no-fix'
  | 'gps'
  | 'dgps'
  | 'rtk-float'
  | 'rtk-fixed'
  | 'dead-reckoning'
  | 'unknown';

export type RoverFix = {
  timestamp_utc: string;
  lat: number;
  lng: number;
  quality: RoverFixQuality;
  alt_m: number | null;
  accuracy_m: number | null;
  hdop: number | null;
  satellites: number | null;
  correction_age_s: number | null;
};

export type RoverStatus = {
  device_id: string;
  gnss_connected: boolean;
  lora_connected: boolean;
  bluetooth_connected: boolean;
  bluetooth_client: string | null;
  lora_bytes_rx: number;
  last_correction_utc: string | null;
};

export type RoverTelemetryMessage = {
  type: 'rover.telemetry.v1';
  timestamp_utc: string;
  rover: RoverStatus;
  fix: RoverFix | null;
  warnings: string[];
  error: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function unwrapTelemetryPayload(input: unknown): Record<string, unknown> | null {
  let current: unknown = input;

  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === 'string') {
      const trimmed = current.trim();
      if (!trimmed) return null;
      try {
        current = JSON.parse(trimmed);
      } catch {
        return null;
      }
      continue;
    }

    if (!isRecord(current)) return null;

    if (current.type === 'rover.telemetry.v1') {
      return current;
    }

    if (Object.prototype.hasOwnProperty.call(current, 'data')) {
      current = current.data;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(current, 'message')) {
      current = current.message;
      continue;
    }

    return null;
  }

  return null;
}

function parseFix(value: unknown): RoverFix | null {
  if (!isRecord(value)) return null;
  const lat = toNumber(value.lat);
  const lng = toNumber(value.lng);
  const quality = typeof value.quality === 'string' ? value.quality : 'unknown';
  if (lat === null || lng === null) return null;
  return {
    timestamp_utc: toStringOrNull(value.timestamp_utc) ?? new Date().toISOString(),
    lat,
    lng,
    quality: quality as RoverFixQuality,
    alt_m: toNumber(value.alt_m),
    accuracy_m: toNumber(value.accuracy_m),
    hdop: toNumber(value.hdop),
    satellites: toNumber(value.satellites),
    correction_age_s: toNumber(value.correction_age_s),
  };
}

function parseStatus(value: unknown): RoverStatus | null {
  if (!isRecord(value)) return null;
  if (typeof value.device_id !== 'string') return null;
  return {
    device_id: value.device_id,
    gnss_connected: Boolean(value.gnss_connected),
    lora_connected: Boolean(value.lora_connected),
    bluetooth_connected: Boolean(value.bluetooth_connected),
    bluetooth_client: toStringOrNull(value.bluetooth_client),
    lora_bytes_rx: toNumber(value.lora_bytes_rx) ?? 0,
    last_correction_utc: toStringOrNull(value.last_correction_utc),
  };
}

export function parseRoverTelemetryLine(line: string): RoverTelemetryMessage | null {
  const payload = unwrapTelemetryPayload(line);
  if (!payload) return null;
  const status = parseStatus(payload.rover);
  if (!status) return null;
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  return {
    type: 'rover.telemetry.v1',
    timestamp_utc: toStringOrNull(payload.timestamp_utc) ?? new Date().toISOString(),
    rover: status,
    fix: parseFix(payload.fix),
    warnings,
    error: toStringOrNull(payload.error),
  };
}
