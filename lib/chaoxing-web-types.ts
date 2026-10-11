export type ChaoxingCourse = { courseId: string; classId: string; name?: string; cpi?: string };
export type ChaoxingAuthenticatedSession = {
  cookies: Record<string, string>; courses: ChaoxingCourse[]; courseRefreshPending?: boolean;
};
export type ChaoxingWebControl = {
  action: "mount" | "enqueue" | "dequeue" | "cancel" | "pause" | "resume" | "refresh";
  courseId?: string; classId?: string; replace?: boolean;
};
export function parseChaoxingWebControl(value: unknown): ChaoxingWebControl | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.action !== "string" || !["mount", "enqueue", "dequeue", "cancel", "pause", "resume", "refresh"].includes(body.action)) return null;
  if (body.replace !== undefined && typeof body.replace !== "boolean") return null;
  const courseAction = ["mount", "enqueue", "dequeue"].includes(body.action);
  if (courseAction && (typeof body.courseId !== "string" || !/^\d{1,24}$/.test(body.courseId) ||
    typeof body.classId !== "string" || !/^\d{1,24}$/.test(body.classId))) return null;
  return { action: body.action as ChaoxingWebControl["action"],
    ...(courseAction ? { courseId: body.courseId as string, classId: body.classId as string,
      ...(body.action === "mount" ? { replace: body.replace === true } : {}) } : {}) };
}

export function webChaoxingScope(uid: string) {
  if (!/^\d{1,24}$/.test(uid)) throw new Error("账号标识无效");
  return `web:${uid}`;
}
