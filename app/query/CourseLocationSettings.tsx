"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { chaoxingLocationIssue, DEFAULT_LOCATION_MAX_ACCURACY_METERS, DEFAULT_LOCATION_MAX_AGE_SECONDS,
  type ChaoxingLocationConfig } from "../../lib/chaoxing-location";
import { QueryApiError, readQueryJson } from "../../lib/query-feedback";
import { useQueryFeedback } from "./QueryFeedback";

type Course = { courseId: string; classId: string; name: string };
type Position = { latitude: number; longitude: number };
type LocatedPosition = Position & Pick<ChaoxingLocationConfig, "source" | "coordinateSystem" | "accuracyMeters" | "capturedAt">;
type SavedLocation = ChaoxingLocationConfig & Pick<Course, "courseId" | "classId"> & { updatedAt: number };
type LocationDraft = { courseKey: string; position: LocatedPosition | null; address: string; maxAgeSeconds: number; maxAccuracyMeters: number };
const SOURCE_LABELS = { map: "地图选点", device: "设备当前位置", manual: "手动输入", legacy: "原有位置配置" };

function positionTime(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) return "待填写有效时间";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
}

const DEFAULT_CENTER: [number, number] = [121.22, 31.05];
const MAP_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

function courseKey(course: Pick<Course, "courseId" | "classId">) {
  return `${course.courseId}:${course.classId}`;
}

function CourseLocationMap({ value, onChange }: { value: Position | null; onChange: (value: Position) => void }) {
  const { reportError } = useQueryFeedback();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const reportedErrorRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const latitude = value?.latitude;
  const longitude = value?.longitude;

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current, style: MAP_STYLE, center: DEFAULT_CENTER, zoom: 15,
      minZoom: 3, attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => setReady(true));
    map.on("error", (event) => {
      if (!event.error) return;
      setError("地图暂时无法加载，请检查网络后重试。");
      if (!reportedErrorRef.current) { reportedErrorRef.current = true; reportError(event.error, { operation: "加载地图" }); }
    });
    map.on("click", (event) => onChangeRef.current({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }));
    mapRef.current = map;
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [reportError]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (latitude === undefined || longitude === undefined) { markerRef.current?.remove(); markerRef.current = null; return; }
    const point: [number, number] = [longitude, latitude];
    if (!markerRef.current) markerRef.current = new maplibregl.Marker({ color: "#4a7dca" }).setLngLat(point).addTo(map);
    else markerRef.current.setLngLat(point);
    map.easeTo({ center: point, zoom: Math.max(map.getZoom(), 16), duration: 300 });
  }, [latitude, longitude, ready]);

  return <div className="cx-query-location-map-wrap">
    <div ref={containerRef} className="cx-query-location-map" aria-label="点击地图选择这门课程的签到位置" />
    {error && <p role="status" className="cx-query-location-error">{error}</p>}
  </div>;
}

export default function CourseLocationSettings({ courses, onUnauthorized }: { courses: Course[]; onUnauthorized: () => void }) {
  const { notify, reportError, confirm } = useQueryFeedback();
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [editing, setEditing] = useState<LocationDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [locationRequest, setLocationRequest] = useState<{ courseKey: string; controller: AbortController } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const geoRequestRef = useRef(0);
  const geoCourseRef = useRef<AbortController | null>(null);
  const selected = courses.find((course) => courseKey(course) === selectedKey) || courses[0];
  const saved = selected && locations.find((location) => courseKey(location) === courseKey(selected));
  const activeKey = selected ? courseKey(selected) : "";
  const locating = locationRequest?.courseKey === activeKey && !locationRequest.controller.signal.aborted;
  const currentEdit = editing?.courseKey === activeKey ? editing : null;
  const draft: LocatedPosition | null = currentEdit ? currentEdit.position : saved ? {
    latitude: saved.latitude, longitude: saved.longitude, source: saved.source || "legacy",
    coordinateSystem: saved.coordinateSystem || "unspecified", accuracyMeters: saved.accuracyMeters ?? null,
    capturedAt: saved.capturedAt ?? null,
  } : null;
  const address = currentEdit ? currentEdit.address : saved?.address === "地图选定位置" ? "" : saved?.address || "";
  const maxAgeSeconds = currentEdit?.maxAgeSeconds ?? saved?.maxAgeSeconds ?? DEFAULT_LOCATION_MAX_AGE_SECONDS;
  const maxAccuracyMeters = currentEdit?.maxAccuracyMeters ?? saved?.maxAccuracyMeters ?? DEFAULT_LOCATION_MAX_ACCURACY_METERS;
  const issue = draft ? chaoxingLocationIssue({ ...draft, address, maxAgeSeconds, maxAccuracyMeters }, now) : null;

  function updateDraft(patch: Partial<Omit<LocationDraft, "courseKey">>) {
    setEditing((current) => ({ courseKey: activeKey, position: draft, address, maxAgeSeconds, maxAccuracyMeters,
      ...(current?.courseKey === activeKey ? current : {}), ...patch }));
  }

  useEffect(() => {
    const controller = new AbortController();
    geoCourseRef.current = controller;
    return () => controller.abort();
  }, [activeKey]);

  useEffect(() => {
    if (draft?.source !== "device") return;
    const interval = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, [draft?.source]);

  function locateDevice() {
    if (!window.isSecureContext || !navigator.geolocation) {
      notify("当前浏览器不支持定位，请使用系统浏览器打开本站", "warning");
      return;
    }
    const requestId = ++geoRequestRef.current;
    const controller = geoCourseRef.current;
    if (!controller || controller.signal.aborted) return;
    setLocationRequest({ courseKey: activeKey, controller });
    navigator.geolocation.getCurrentPosition((position) => {
      if (controller.signal.aborted || geoRequestRef.current !== requestId) return;
      setNow(Date.now());
      updateDraft({ position: { latitude: position.coords.latitude, longitude: position.coords.longitude,
        source: "device", coordinateSystem: "wgs84", accuracyMeters: position.coords.accuracy,
        capturedAt: position.timestamp } });
      setLocationRequest(null);
      notify("已获取当前位置，请保存", "done");
    }, (error) => {
      if (controller.signal.aborted || geoRequestRef.current !== requestId) return;
      setLocationRequest(null);
      const message = error.code === 1 ? "定位权限未开启，请在浏览器的本站权限中允许位置访问后重试。"
        : error.code === 3 ? "获取位置超时，请移至信号较好的位置后重试。" : "设备暂时无法定位，请检查系统定位服务后重试。";
      reportError(new Error(`${message}（定位错误代码：${error.code}）`), { operation: "设备定位" });
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/query/locations", { credentials: "include", cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onUnauthorized(); return; }
        const result = await readQueryJson<{ locations?: SavedLocation[]; error?: string }>(response);
        if (controller.signal.aborted) return;
        if (!response.ok || !result.locations) throw new QueryApiError(result.error || "位置读取失败", response);
        setLocations(result.locations);
      } catch (error) {
        if (!controller.signal.aborted) reportError(error, { operation: "读取签到位置", endpoint: "/api/query/locations" });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [onUnauthorized, reportError]);

  async function save() {
    if (!selected || !draft) { notify("请先在地图上点选位置", "warning"); return; }
    const problem = chaoxingLocationIssue({ ...draft, address, maxAgeSeconds, maxAccuracyMeters });
    if (problem) { notify(problem, "warning"); return; }
    const requestedKey = activeKey;
    setBusy(true);
    try {
      const response = await fetch("/api/query/locations", {
        method: "PUT", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ courseId: selected.courseId, classId: selected.classId,
          ...draft, address: address.trim(), maxAgeSeconds, maxAccuracyMeters }),
      });
      const result = await readQueryJson<{ location?: SavedLocation; error?: string }>(response);
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok || !result.location) throw new QueryApiError(result.error || "位置保存失败", response);
      setLocations((current) => [...current.filter((item) => courseKey(item) !== courseKey(result.location!)), result.location!]);
      setEditing((current) => current?.courseKey === requestedKey ? null : current);
      notify("已保存该课程签到位置", "done");
    } catch (error) { reportError(error, { operation: "保存签到位置", endpoint: "/api/query/locations", method: "PUT" }); }
    finally { setBusy(false); }
  }

  async function clear() {
    if (!selected) return;
    if (!await confirm({ title: "清除签到位置", message: `要清除“${selected.name}”的签到位置吗？`, confirmLabel: "确认清除", destructive: true })) return;
    const requestedKey = activeKey;
    setBusy(true);
    try {
      const response = await fetch("/api/query/locations", {
        method: "DELETE", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ courseId: selected.courseId, classId: selected.classId }),
      });
      const result = await readQueryJson<{ error?: string }>(response);
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new QueryApiError(result.error || "位置清除失败", response);
      setLocations((current) => current.filter((item) => courseKey(item) !== courseKey(selected)));
      setEditing((current) => current?.courseKey === requestedKey ? null : current);
      notify("已清除该课程签到位置", "cancellation");
    } catch (error) { reportError(error, { operation: "清除签到位置", endpoint: "/api/query/locations", method: "DELETE" }); }
    finally { setBusy(false); }
  }

  return <section className="cx-query-card cx-query-location">
    <h2><span className="cx-query-mark" />签到位置</h2>
    {courses.length ? <>
      <label className="cx-query-location-select">选择课程
        <select disabled={busy} value={activeKey} onChange={(event) => { setSelectedKey(event.target.value); setEditing(null); setLocationRequest(null); }}>
          {courses.map((course) => <option key={courseKey(course)} value={courseKey(course)}>{course.name}（班级 {course.classId}）</option>)}
        </select>
      </label>
      <div className="cx-query-location-actions">
        <button type="button" onClick={locateDevice} disabled={busy || loading || locating}>{locating ? "正在获取位置…" : "使用设备当前位置"}</button>
      </div>
      <CourseLocationMap value={draft} onChange={(position) => {
        if (busy || loading) return;
        geoRequestRef.current++; setLocationRequest(null); setNow(Date.now());
        updateDraft({ position: { ...position, source: "map", coordinateSystem: "wgs84", accuracyMeters: null, capturedAt: Date.now() } });
      }} />
      <label className="cx-query-location-select">位置名称 / 地址
        <input disabled={busy || loading} value={address} required maxLength={160} placeholder="例如松江校区教学楼 1301 门口" onChange={(event) => updateDraft({ address: event.target.value })} />
      </label>
      {draft && <div className="cx-query-location-quality" aria-label="定位信息">
        <p><strong>{SOURCE_LABELS[draft.source]}</strong><span>经度 {draft.longitude.toFixed(7)} · 纬度 {draft.latitude.toFixed(7)}</span></p>
        {draft.source === "device" && <>
          <p>设备测得误差：约 {Math.ceil(draft.accuracyMeters!)} 米 · 采集于 {positionTime(draft.capturedAt!)}</p>
          <div className="cx-query-location-limits">
            <label>允许最大定位误差（米）<input disabled={busy || loading} type="number" min={10} max={5000} step={1} value={maxAccuracyMeters} onChange={(event) => updateDraft({ maxAccuracyMeters: Number(event.target.value) })} /></label>
            <label>本次定位有效期（分钟）<input disabled={busy || loading} type="number" min={1} max={60} step={1} value={maxAgeSeconds / 60} onChange={(event) => updateDraft({ maxAgeSeconds: Number(event.target.value) * 60 })} /></label>
          </div>
          <p>有效至 {positionTime(draft.capturedAt! + maxAgeSeconds * 1000)}</p>
        </>}
        {issue && <p className="cx-query-location-validation" role="status">{issue}</p>}
      </div>}
      <div className="cx-query-location-actions">
        <button type="button" onClick={() => void save()} disabled={busy || loading || locating || !draft || !!issue}>{busy ? "处理中…" : "保存该课程位置"}</button>
        {saved && <button type="button" className="quiet" onClick={() => void clear()} disabled={busy}>清除位置</button>}
        {saved && <span>已保存：{saved.address}</span>}
      </div>
    </> : <p className="cx-query-empty">暂无课程，请刷新课程列表</p>}
  </section>;
}
