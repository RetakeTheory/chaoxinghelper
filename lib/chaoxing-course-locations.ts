import { normalizeChaoxingLocation, type ChaoxingLocation, type ChaoxingLocationConfig } from "./chaoxing-location.ts";

export type ChaoxingCourseLocation = ChaoxingLocationConfig & {
  courseId: string;
  classId: string;
  updatedAt: number;
};

type LocationRow = {
  course_id: string;
  class_id: string;
  latitude: number;
  longitude: number;
  address: string;
  updated_at: number;
  metadata_json: string;
};

const schemaReady = new WeakMap<D1Database, Promise<void>>();

async function ensureSchema(db: D1Database) {
  let ready = schemaReady.get(db);
  if (!ready) {
    ready = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS chaoxing_course_locations (
      uid TEXT NOT NULL,
      course_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (uid, course_id, class_id)
      )`).run();
      const columns = await db.prepare("PRAGMA table_info(chaoxing_course_locations)").all<{ name: string }>();
      if (!columns.results.some((column) => column.name === "metadata_json")) {
        try {
          await db.prepare("ALTER TABLE chaoxing_course_locations ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'").run();
        } catch (error) {
          // Another isolate can finish the same additive migration first.
          const after = await db.prepare("PRAGMA table_info(chaoxing_course_locations)").all<{ name: string }>();
          if (!after.results.some((column) => column.name === "metadata_json")) throw error;
        }
      }
    })().catch((error: unknown) => {
      schemaReady.delete(db);
      throw error;
    });
    schemaReady.set(db, ready);
  }
  await ready;
}

function fromRow(row: LocationRow): ChaoxingCourseLocation {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch { /* Existing rows keep their original coordinates. */ }
  return {
    ...normalizeChaoxingLocation({ ...metadata, latitude: row.latitude, longitude: row.longitude, address: row.address }),
    courseId: row.course_id,
    classId: row.class_id,
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address,
    updatedAt: row.updated_at,
  };
}

export async function listChaoxingCourseLocations(db: D1Database, uid: string) {
  await ensureSchema(db);
  const rows = await db.prepare(`SELECT course_id, class_id, latitude, longitude, address, updated_at, metadata_json
    FROM chaoxing_course_locations WHERE uid = ? ORDER BY updated_at DESC`)
    .bind(uid).all<LocationRow>();
  return (rows.results || []).map(fromRow);
}

export async function getChaoxingCourseLocation(db: D1Database, uid: string, courseId: string, classId: string) {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT course_id, class_id, latitude, longitude, address, updated_at, metadata_json
    FROM chaoxing_course_locations WHERE uid = ? AND course_id = ? AND class_id = ? LIMIT 1`)
    .bind(uid, courseId, classId).first<LocationRow>();
  return row ? fromRow(row) : null;
}

export async function saveChaoxingCourseLocation(
  db: D1Database, uid: string, location: ChaoxingLocation & { courseId: string; classId: string },
) {
  const normalized = normalizeChaoxingLocation(location);
  await ensureSchema(db);
  const updatedAt = Date.now();
  const { latitude, longitude, address, ...metadata } = normalized;
  await db.prepare(`INSERT INTO chaoxing_course_locations
    (uid, course_id, class_id, latitude, longitude, address, updated_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid, course_id, class_id) DO UPDATE SET
      latitude = excluded.latitude, longitude = excluded.longitude,
      address = excluded.address, updated_at = excluded.updated_at, metadata_json = excluded.metadata_json`)
    .bind(uid, location.courseId, location.classId, latitude, longitude, address, updatedAt, JSON.stringify(metadata)).run();
  return { courseId: location.courseId, classId: location.classId, ...normalized, updatedAt };
}

export async function deleteChaoxingCourseLocation(db: D1Database, uid: string, courseId: string, classId: string) {
  await ensureSchema(db);
  await db.prepare("DELETE FROM chaoxing_course_locations WHERE uid = ? AND course_id = ? AND class_id = ?")
    .bind(uid, courseId, classId).run();
}

export async function deleteAllChaoxingCourseLocations(db: D1Database, uid: string) {
  await ensureSchema(db);
  await db.prepare("DELETE FROM chaoxing_course_locations WHERE uid = ?").bind(uid).run();
}
