import { normalizeChaoxingLocation, locationCoordinate, type ChaoxingLocation } from "./chaoxing-location.ts";

const MOBILE = "https://mobilelearn.chaoxing.com";
type Activity = { id: string; courseId: string; classId: string };

function numericId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{1,24}$/.test(value)) throw new Error(`${label}标识无效`);
  return value;
}

export function chaoxingSignContext(activity: Activity, cookies: Record<string, string>) {
  const activeId = numericId(activity.id, "签到活动");
  const courseId = numericId(activity.courseId, "课程");
  const classId = numericId(activity.classId, "班级");
  const uid = numericId(cookies._uid, "登录账号");
  const fid = cookies.fid || "0";
  if (!/^-?\d{1,24}$/.test(fid)) throw new Error("学校标识无效");
  const preSignUrl = `${MOBILE}/newsign/preSign?` + new URLSearchParams({
    courseId, classId, activePrimaryId: activeId, general: "1", sys: "1", ls: "1", appType: "15", uid, ut: "s",
  });
  return { activeId, uid, fid, preSignUrl };
}

export function chaoxingSignRequest(context: ReturnType<typeof chaoxingSignContext>, location?: ChaoxingLocation) {
  const params = new URLSearchParams({ activeId: context.activeId, uid: context.uid,
    clientip: "", appType: "15", fid: context.fid });
  if (location) {
    const normalized = normalizeChaoxingLocation(location);
    params.set("latitude", locationCoordinate(normalized.latitude));
    params.set("longitude", locationCoordinate(normalized.longitude));
    params.set("address", normalized.address);
    params.set("ifTiJiao", "1");
  }
  // The existing endpoint accepts URL-encoded GET parameters. Keep that
  // contract; capture metadata is validated locally, not invented upstream.
  return { url: `${MOBILE}/pptSign/stuSignajax?${params}`, init: {
    method: "GET", headers: { Referer: context.preSignUrl, Accept: "text/plain, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
  } satisfies RequestInit };
}
