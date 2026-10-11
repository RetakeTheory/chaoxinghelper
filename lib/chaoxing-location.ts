export type ChaoxingLocationSource = "map" | "device" | "manual" | "legacy";
export type ChaoxingLocation = {
  latitude: number;
  longitude: number;
  address: string;
  source?: ChaoxingLocationSource;
  coordinateSystem?: "wgs84" | "unspecified";
  accuracyMeters?: number | null;
  capturedAt?: number | null;
  maxAgeSeconds?: number;
  maxAccuracyMeters?: number;
};

export type ChaoxingLocationConfig = Required<ChaoxingLocation>;
export const DEFAULT_LOCATION_MAX_AGE_SECONDS = 300;
export const DEFAULT_LOCATION_MAX_ACCURACY_METERS = 100;

export class ChaoxingLocationError extends Error {
  constructor(message: string) { super(message); this.name = "ChaoxingLocationError"; }
}

function numberInRange(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ChaoxingLocationError(message);
  }
  return value;
}

export function normalizeChaoxingLocation(value: unknown, now = Date.now()): ChaoxingLocationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChaoxingLocationError("请先设置签到位置");
  const input = value as Record<string, unknown>;
  const latitude = numberInRange(input.latitude, -90, 90, "纬度无效，请重新选择位置");
  const longitude = numberInRange(input.longitude, -180, 180, "经度无效，请重新选择位置");
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!address || address.length > 160 || Array.from(address).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new ChaoxingLocationError("请填写 1～160 字的位置名称或地址");
  }
  const source = input.source ?? "legacy";
  if (typeof source !== "string" || !["map", "device", "manual", "legacy"].includes(source)) throw new ChaoxingLocationError("定位来源无效");
  const coordinateSystem = input.coordinateSystem ?? (source === "map" || source === "device" ? "wgs84" : "unspecified");
  if (typeof coordinateSystem !== "string" || !["wgs84", "unspecified"].includes(coordinateSystem) ||
      ((source === "map" || source === "device") && coordinateSystem !== "wgs84")) {
    throw new ChaoxingLocationError("地图与设备定位须使用 WGS84 坐标");
  }
  const maxAgeSeconds = numberInRange(input.maxAgeSeconds ?? DEFAULT_LOCATION_MAX_AGE_SECONDS, 60, 3600, "定位有效期须为 1～60 分钟");
  if (!Number.isInteger(maxAgeSeconds)) throw new ChaoxingLocationError("定位有效期须为整数秒");
  const maxAccuracyMeters = numberInRange(input.maxAccuracyMeters ?? DEFAULT_LOCATION_MAX_ACCURACY_METERS, 10, 5000, "允许定位误差须为 10～5000 米");
  const accuracyMeters = input.accuracyMeters == null ? null
    : numberInRange(input.accuracyMeters, 0, 10_000_000, "设备定位精度无效");
  const capturedAt = input.capturedAt == null ? null
    : numberInRange(input.capturedAt, 1, now + 60_000, "定位采集时间无效，请重新定位");
  if (source === "device" && (accuracyMeters === null || capturedAt === null)) {
    throw new ChaoxingLocationError("设备定位缺少采集时间或测得精度，请重新定位");
  }
  if (source !== "device" && accuracyMeters !== null) throw new ChaoxingLocationError("地图选点不能填写设备定位精度");
  return { latitude, longitude, address, source: source as ChaoxingLocationSource,
    coordinateSystem: coordinateSystem as ChaoxingLocationConfig["coordinateSystem"],
    accuracyMeters, capturedAt, maxAgeSeconds, maxAccuracyMeters };
}

export function chaoxingLocationIssue(value: unknown, now = Date.now()): string | null {
  try {
    const location = normalizeChaoxingLocation(value, now);
    if (location.source === "device") {
      if (now - location.capturedAt! > location.maxAgeSeconds * 1000) return "设备定位已过期，请在查询页重新获取当前位置";
      if (location.accuracyMeters! > location.maxAccuracyMeters) {
        return `当前定位误差 ${Math.ceil(location.accuracyMeters!)} 米，超过允许的 ${location.maxAccuracyMeters} 米，请重新定位`;
      }
    }
    return null;
  } catch (error) {
    return error instanceof ChaoxingLocationError ? error.message : "位置配置无效，请重新保存";
  }
}

export function locationCoordinate(value: number) {
  return value.toFixed(7).replace(/\.?0+$/, "").replace(/^-0$/, "0");
}
