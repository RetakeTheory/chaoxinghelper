import { env } from "cloudflare:workers";
import { getD1 } from "../../../../db/runtime";
import { sameOrigin } from "../../../../lib/admin-email-auth";
import { readChaoxingQuerySession } from "../../../../lib/chaoxing-query-auth";
import { chaoxingQueryBackend } from "../../../../lib/chaoxing-query-backend";
import { ChaoxingLocationError, chaoxingLocationIssue, normalizeChaoxingLocation } from "../../../../lib/chaoxing-location";
import {
  deleteChaoxingCourseLocation, listChaoxingCourseLocations, saveChaoxingCourseLocation,
} from "../../../../lib/chaoxing-course-locations";

const headers = { "Cache-Control": "no-store" };
type CourseKey = { courseId?: unknown; classId?: unknown };

async function authorizedCourse(request: Request, body: CourseKey) {
  const session = await readChaoxingQuerySession(request);
  if (!session) return { error: "请先登录", status: 401 } as const;
  const courseId = typeof body.courseId === "string" ? body.courseId : "";
  const classId = typeof body.classId === "string" ? body.classId : "";
  if (!/^\d{1,24}$/.test(courseId) || !/^\d{1,24}$/.test(classId)) {
    return { error: "课程标识无效", status: 400 } as const;
  }
  const snapshot = await chaoxingQueryBackend(env, session).queryChaoxingByUid(session.uid);
  if (!snapshot?.courses?.some((course: { courseId: string; classId: string }) =>
    course.courseId === courseId && course.classId === classId)) {
    return { error: "该课程不在当前账号的课程列表中", status: 404 } as const;
  }
  return { session, courseId, classId };
}

async function wakeAccount(uid: string, botId: string) {
  return chaoxingQueryBackend(env, { uid, bot_id: botId }).chaoxingLocationChangedByUid(uid, botId);
}

export async function GET(request: Request) {
  const session = await readChaoxingQuerySession(request);
  if (!session) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const locations = await listChaoxingCourseLocations(await getD1(), session.uid);
    return Response.json({ locations }, { headers });
  } catch {
    return Response.json({ error: "位置读取失败，请稍后重试" }, { status: 503, headers });
  }
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403, headers });
  if (Number(request.headers.get("content-length") || 0) > 2048) {
    return Response.json({ error: "请求内容过大" }, { status: 413, headers });
  }
  const body = await request.json().catch(() => ({})) as CourseKey & {
    latitude?: unknown; longitude?: unknown; address?: unknown; source?: unknown;
    coordinateSystem?: unknown; accuracyMeters?: unknown; capturedAt?: unknown;
    maxAgeSeconds?: unknown; maxAccuracyMeters?: unknown;
  };
  try {
    const course = await authorizedCourse(request, body);
    if ("error" in course) return Response.json({ error: course.error }, { status: course.status, headers });
    const config = normalizeChaoxingLocation(body);
    const issue = chaoxingLocationIssue(config);
    if (issue) return Response.json({ error: issue }, { status: 400, headers });
    const location = await saveChaoxingCourseLocation(await getD1(), course.session.uid, {
      courseId: course.courseId, classId: course.classId, ...config,
    });
    const woken = await wakeAccount(course.session.uid, course.session.bot_id);
    if (!woken) return Response.json({ error: "位置已保存，但监听账号已变化，请重新登录" }, { status: 409, headers });
    return Response.json({ location }, { headers });
  } catch (error) {
    if (error instanceof ChaoxingLocationError) return Response.json({ error: error.message }, { status: 400, headers });
    return Response.json({ error: "位置保存或签到任务唤醒失败，请重试保存" }, { status: 503, headers });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403, headers });
  const body = await request.json().catch(() => ({})) as CourseKey;
  try {
    const course = await authorizedCourse(request, body);
    if ("error" in course) return Response.json({ error: course.error }, { status: course.status, headers });
    await deleteChaoxingCourseLocation(await getD1(), course.session.uid, course.courseId, course.classId);
    await wakeAccount(course.session.uid, course.session.bot_id);
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ error: "位置清除失败，请稍后重试" }, { status: 503, headers });
  }
}
