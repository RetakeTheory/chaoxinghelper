"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChaoxingWebControl } from "../../lib/chaoxing-web-types";
import { QueryApiError, queryControlFeedback, readQueryJson } from "../../lib/query-feedback";
import { QueryFeedbackProvider, useQueryFeedback } from "./QueryFeedback";
import { verifyQueryLoginSession } from "../../lib/query-login-session";
import { sealQueryLogin, type LoginChallenge } from "../../lib/query-login-crypto";
import "./query.css";

const CourseLocationSettings = lazy(() => import("./CourseLocationSettings"));

type Snapshot = {
  enabled: boolean; courseCount: number; lastStatus: string;
  courses: { courseId: string; classId: string; name: string }[];
  courseQueue?: { courseId: string; classId: string; name: string }[];
  locationConfigured?: boolean;
  source?: "web" | "qq";
  notices?: { id: string; text: string; createdAt: number }[];
  mount: null | { courseId: string; classId: string; courseName: string; status: string; total: number; completed: number; scanning: boolean;
    current: null | { name: string; playingTime: number; duration: number } };
  signIns: { activityId: string; courseName: string; activityName: string; result: string; checkedAt: number }[];
};
function clock(seconds: number) {
  const value = Math.max(0, Math.floor(seconds)), h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function time(value: number) {
  return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(value) : "历史记录";
}
export default function QueryPage() {
  return <QueryFeedbackProvider><QueryScreen /></QueryFeedbackProvider>;
}
function QueryScreen() {
  const { notify, reportError, confirm } = useQueryFeedback();
  const [view, setView] = useState<"loading" | "login" | "dashboard">("loading");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<ChaoxingWebControl["action"] | "status" | "login" | "verify" | "logout" | "repair" | null>(null);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [selectedCourseKey, setSelectedCourseKey] = useState("");
  const mutationRef = useRef(false);
  const manualRefreshRef = useRef(false);
  const requestRef = useRef(0);
  const lastRefreshError = useRef("");
  const authenticatedRef = useRef(false);
  const loginCheckFailedRef = useRef(false);
  const expireSession = useCallback(() => {
    requestRef.current++;
    loginCheckFailedRef.current = true;
    authenticatedRef.current = false;
    lastRefreshError.current = "";
    setSnapshot(null); setView("login"); setSelectedCourseKey(""); setChallenge(null);
    setBusy(false); setPendingAction(null); manualRefreshRef.current = false;
    notify("本站登录状态已失效，请重新登录；后台任务不会因此停止", "warning");
  }, [notify]);
  const refresh = useCallback(async (quiet = false) => {
    if (mutationRef.current || (quiet && (manualRefreshRef.current || loginCheckFailedRef.current))) return;
    const requestId = ++requestRef.current;
    if (!quiet) { manualRefreshRef.current = true; setBusy(true); setPendingAction("status"); }
    try {
      const response = await fetch("/api/query/status", { cache: "no-store", credentials: "include" });
      if (requestId !== requestRef.current) return;
      if (response.status === 401) {
        if (authenticatedRef.current) notify("登录已过期，请重新登录", "warning");
        authenticatedRef.current = false; setSnapshot(null); setView("login"); return;
      }
      const result = await readQueryJson<{ snapshot?: Snapshot; error?: string }>(response);
      if (requestId !== requestRef.current) return;
      if (!response.ok || !result.snapshot) throw new QueryApiError(result.error || "查询失败，请稍后重试", response);
      authenticatedRef.current = true; lastRefreshError.current = "";
      setSnapshot(result.snapshot); setRefreshedAt(Date.now()); setView("dashboard");
      if (!quiet) notify("已刷新任务进度", "done");
    } catch (error) {
      if (requestId === requestRef.current) {
        const fingerprint = error instanceof Error ? error.message : String(error);
        if (!quiet || fingerprint !== lastRefreshError.current) reportError(error, { operation: "读取任务进度", endpoint: "/api/query/status" });
        lastRefreshError.current = fingerprint;
        setView((previous) => previous === "loading" ? "login" : previous);
      }
    }
    finally {
      if (!quiet) {
        manualRefreshRef.current = false;
        if (requestId === requestRef.current) { setBusy(false); setPendingAction(null); }
      }
    }
  }, [notify, reportError]);
  useEffect(() => {
    document.body.classList.add("cx-query-body");
    const initial = window.setTimeout(() => void refresh(true), 0);
    const polling = window.setInterval(() => void refresh(true), 30_000);
    return () => { document.body.classList.remove("cx-query-body"); window.clearTimeout(initial); window.clearInterval(polling); };
  }, [refresh]);
  useEffect(() => {
    if (!challenge) return;
    const expiry = window.setTimeout(() => setChallenge(null), Math.max(0, challenge.expiresAt - Date.now()));
    return () => window.clearTimeout(expiry);
  }, [challenge]);
  async function verifyLogin() {
    if (mutationRef.current) return;
    mutationRef.current = true; setBusy(true); setPendingAction("verify");
    try {
      if (!window.isSecureContext || !crypto.subtle) throw new Error("请使用支持安全加密的系统浏览器，通过 HTTPS 打开本站");
      const response = await fetch("/api/query/challenge", { method: "POST", credentials: "include", cache: "no-store",
        headers: { "content-type": "application/json" }, body: "{}" });
      const result = await readQueryJson<{ challenge?: LoginChallenge; error?: string }>(response);
      if (!response.ok || !result.challenge) throw new QueryApiError(result.error || "验证未通过", response);
      setChallenge(result.challenge);
      notify("验证就绪，可以登录了", "done");
    } catch (error) {
      setChallenge(null); reportError(error, { operation: "登录验证", endpoint: "/api/query/challenge", method: "POST" });
    } finally { mutationRef.current = false; setBusy(false); setPendingAction(null); }
  }
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (mutationRef.current) return;
    if (!account.trim() || !password) { notify("请填写学习通账号和密码", "warning"); return; }
    if (!challenge || challenge.expiresAt <= Date.now()) { setChallenge(null); notify("请先点击验证", "warning"); return; }
    setBusy(true); setPendingAction("login");
    mutationRef.current = true; const requestId = ++requestRef.current;
    loginCheckFailedRef.current = true;
    let verifying = false;
    try {
      const sealed = await sealQueryLogin(challenge, account, password, window.location.origin);
      setChallenge(null);
      const response = await fetch("/api/query/login", { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(sealed) });
      const result = await readQueryJson<{ snapshot?: Snapshot; error?: string; sessionConfirmation?: string }>(response);
      if (!response.ok || !result.snapshot) throw new QueryApiError(result.error || "登录失败", response);
      verifying = true;
      loginCheckFailedRef.current = true;
      await verifyQueryLoginSession(result.sessionConfirmation);
      if (requestId !== requestRef.current) return;
      loginCheckFailedRef.current = false;
      authenticatedRef.current = true; lastRefreshError.current = "";
      setPassword(""); setSnapshot(result.snapshot); setRefreshedAt(Date.now()); setView("dashboard");
      notify("登录成功，今日任务就绪！", "done");
    } catch (error) {
      if (requestId !== requestRef.current) return;
      if (verifying) { authenticatedRef.current = false; setSnapshot(null); setView("login"); }
      reportError(error, { operation: verifying ? "校验本站登录会话" : "登录", endpoint: verifying ? "/api/query/session" : "/api/query/login", method: "POST", secrets: [account, password] });
    }
    finally { setChallenge(null); setPassword(""); setBusy(false); setPendingAction(null); mutationRef.current = false; }
  }
  async function logout() {
    if (mutationRef.current) return;
    mutationRef.current = true; requestRef.current++; setBusy(true); setPendingAction("logout");
    try {
      const response = await fetch("/api/query/logout", { method: "POST", credentials: "include" });
      if (!response.ok) throw new QueryApiError("退出失败，请重试", response);
      authenticatedRef.current = false;
      setSnapshot(null); setView("login"); setSelectedCourseKey(""); setChallenge(null);
      notify("已退出登录", "info");
    } catch (error) { reportError(error, { operation: "退出登录", endpoint: "/api/query/logout", method: "POST" }); }
    finally { setBusy(false); setPendingAction(null); mutationRef.current = false; }
  }
  async function control(payload: ChaoxingWebControl) {
    if (mutationRef.current) return;
    mutationRef.current = true; const requestId = ++requestRef.current; setBusy(true); setPendingAction(payload.action);
    try {
      const response = await fetch("/api/query/control", { method: "POST", credentials: "include",
        headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (requestId !== requestRef.current) return;
      if (response.status === 401) { expireSession(); return; }
      const result = await readQueryJson<{ snapshot?: Snapshot; message?: string; error?: string }>(response);
      if (requestId !== requestRef.current) return;
      if (result.snapshot) { setSnapshot(result.snapshot); setRefreshedAt(Date.now()); }
      if (!response.ok) throw new QueryApiError(result.error || "操作失败，请刷新状态后重试", response);
      const feedback = queryControlFeedback(payload.action);
      notify(feedback.message, feedback.kind);
    } catch (error) { if (requestId === requestRef.current) reportError(error, { operation: ({ mount: "开始挂载", enqueue: "加入课程队列", dequeue: "移除排队课程", cancel: "取消挂载", pause: "暂停挂载", resume: "恢复挂载", refresh: "刷新课程" })[payload.action], endpoint: "/api/query/control", method: "POST" }); }
    finally { setBusy(false); setPendingAction(null); mutationRef.current = false; }
  }
  async function repair() {
    if (mutationRef.current) return;
    mutationRef.current = true; const requestId = ++requestRef.current;
    setBusy(true); setPendingAction("repair");
    try {
      const response = await fetch("/api/query/repair", { method: "POST", credentials: "include" });
      if (requestId !== requestRef.current) return;
      if (response.status === 401) { expireSession(); return; }
      const result = await readQueryJson<{ snapshot?: Snapshot; message?: string; error?: string }>(response);
      if (requestId !== requestRef.current) return;
      if (result.snapshot) { setSnapshot(result.snapshot); setRefreshedAt(Date.now()); }
      if (!response.ok) throw new QueryApiError(result.error || "自助修复提交失败", response);
      notify("已提交修复请求", "info");
    } catch (error) { if (requestId === requestRef.current) reportError(error, { operation: "自助修复", endpoint: "/api/query/repair", method: "POST" }); }
    finally { setBusy(false); setPendingAction(null); mutationRef.current = false; }
  }
  const nodes = useMemo(() => {
    const mount = snapshot?.mount;
    return mount?.total ? Array.from({ length: Math.min(mount.total, 80) }, (_, index) => index < mount.completed ? "done" : index === mount.completed && mount.current ? snapshot?.enabled ? "active" : "failed" : "waiting") : [];
  }, [snapshot]);
  if (view === "loading") return <main key="loading" className="cx-query-page"><section className="cx-query-login cx-query-loading"><div className="cx-query-mark" /><p><span className="cx-query-spinner" aria-hidden="true" />加载中，启动准备！</p></section></main>;
  if (view === "login") return <main key="login" className="cx-query-page"><section className="cx-query-login">
    <header><div className="cx-query-mark" /><div><small>CHAOXING HELPER</small><h1>学习补给站</h1></div></header>
    <form onSubmit={login} aria-busy={busy} noValidate>
      <label><span>学习通账号</span><input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" maxLength={100} required /></label>
      <label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={128} required /></label>
      <button type="button" className={`cx-query-login-verify ${challenge ? "verified" : ""}`} disabled={busy || Boolean(challenge)} onClick={() => void verifyLogin()}>{pendingAction === "verify" && <span className="cx-query-spinner" aria-hidden="true" />}{challenge ? "✓ 已验证" : pendingAction === "verify" ? "验证中…" : "点击验证"}</button>
      <button type="submit" disabled={busy || !challenge}>{pendingAction === "login" && <span className="cx-query-spinner" aria-hidden="true" />}{pendingAction === "login" ? "登录中…" : "登录，开始今日任务"}</button>
    </form>
  </section></main>;
  if (!snapshot) return null;
  const mount = snapshot.mount;
  const selectedCourse = snapshot.courses.find((course) => `${course.courseId}:${course.classId}` === selectedCourseKey)
    || snapshot.courses.find((course) => course.courseId === mount?.courseId && course.classId === mount?.classId) || snapshot.courses[0];
  const activeCourseKey = selectedCourse ? `${selectedCourse.courseId}:${selectedCourse.classId}` : "";
  const sameCourse = Boolean(mount && selectedCourse && mount.courseId === selectedCourse.courseId && mount.classId === selectedCourse.classId);
  const queued = snapshot.courseQueue || [];
  const alreadyQueued = queued.some(course => course.courseId === selectedCourse?.courseId && course.classId === selectedCourse?.classId);
  const isMountingVideo = snapshot.enabled && Boolean(mount?.current);
  const currentProgress = mount?.current?.duration ? Math.min(100, mount.current.playingTime / mount.current.duration * 100) : 0;
  const totalProgress = mount?.total ? Math.min(100, mount.completed / mount.total * 100) : 0;
  return <main key="dashboard" className="cx-query-page"><div className="cx-query-shell">
    <header className="cx-query-top"><div><span className="cx-query-mark" /><div><small>STUDY QUEST</small><h1>今日任务看板</h1></div></div>
      <div className="cx-query-actions"><span>{refreshedAt ? `刷新于 ${time(refreshedAt)}` : ""}</span>
        <button type="button" className="repair" onClick={() => void repair()} disabled={busy || !mount}>{pendingAction === "repair" && <span className="cx-query-spinner" aria-hidden="true" />}{pendingAction === "repair" ? "处理中…" : "自助修复"}</button>
        <button type="button" onClick={() => void refresh()} disabled={busy}>{pendingAction === "status" && <span className="cx-query-spinner" aria-hidden="true" />}{pendingAction === "status" ? "刷新中…" : "刷新"}</button>
        <button type="button" className="quiet" onClick={() => void logout()} disabled={busy}>{pendingAction === "logout" && <span className="cx-query-spinner" aria-hidden="true" />}退出登录</button>
      </div></header>
    <section className="cx-query-card cx-query-course-controls">
      <h2><span className="cx-query-mark" />课程任务</h2>
      <label className="cx-query-location-select">选择课程
        <select value={activeCourseKey} disabled={busy || !selectedCourse} onChange={(event) => setSelectedCourseKey(event.target.value)}>
          {!selectedCourse && <option value="">暂无课程，请刷新课程列表</option>}
          {snapshot.courses.map((course, index) => <option key={`${course.courseId}:${course.classId}`} value={`${course.courseId}:${course.classId}`}>{index + 1}. {course.name}</option>)}
        </select>
      </label>
      <div className="cx-query-location-actions">
        <button type="button" disabled={busy || !selectedCourse || (sameCourse && snapshot.enabled)} onClick={async () => {
          if (!selectedCourse) return;
          const replace = Boolean(mount && !sameCourse);
          if (replace && !await confirm({ title: "切换课程", message: `将停止“${mount!.courseName}”的挂载并切换到“${selectedCourse.name}”，是否继续？`, confirmLabel: "切换并挂载" })) return;
          void control({ action: "mount", courseId: selectedCourse.courseId, classId: selectedCourse.classId, replace });
        }}>{pendingAction === "mount" && <span className="cx-query-spinner" aria-hidden="true" />}{sameCourse ? snapshot.enabled ? "已挂载当前课程" : "继续当前课程" : "挂载所选课程"}</button>
        <button type="button" className="quiet" disabled={busy || !selectedCourse || sameCourse || alreadyQueued || queued.length >= 10} onClick={() => selectedCourse && void control({ action: "enqueue", courseId: selectedCourse.courseId, classId: selectedCourse.classId })}>{pendingAction === "enqueue" && <span className="cx-query-spinner" aria-hidden="true" />}{alreadyQueued ? "已在课程队列" : "加入课程队列"}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => void control({ action: "refresh" })}>{pendingAction === "refresh" && <span className="cx-query-spinner" aria-hidden="true" />}刷新课程列表</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => void control({ action: snapshot.enabled ? "pause" : "resume" })}>{(pendingAction === "pause" || pendingAction === "resume") && <span className="cx-query-spinner" aria-hidden="true" />}{snapshot.enabled ? "暂停监听与挂载" : "继续监听与挂载"}</button>
        {(mount || queued.length > 0) && <button type="button" className="quiet" disabled={busy} onClick={async () => {
          if (await confirm({ title: "取消视频挂载", message: "要取消当前及所有排队课程的视频挂载吗？", confirmLabel: "确认取消挂载", destructive: true })) void control({ action: "cancel" });
        }}>{pendingAction === "cancel" && <span className="cx-query-spinner" aria-hidden="true" />}取消视频挂载</button>}
      </div>
      {queued.length > 0 && <ol className="cx-query-course-queue" aria-label="排队课程">{queued.map(course => <li key={`${course.courseId}:${course.classId}`}><span>{course.name}</span><button type="button" disabled={busy} onClick={() => void control({ action: "dequeue", courseId: course.courseId, classId: course.classId })} aria-label={`移除排队课程 ${course.name}`}>移除</button></li>)}</ol>}
      <p className="cx-query-status">{snapshot.lastStatus || "后台已就绪"}</p>
    </section>
    <section className="cx-query-card"><div className="cx-query-section-title"><span>课程</span><strong>{mount?.courseName || "当前没有挂载课程"}</strong><em className={`cx-query-pill ${isMountingVideo ? "online" : "paused"}`}>{isMountingVideo ? "正在挂载" : "待挂载"}</em></div>
      <div className="cx-query-stats"><div><span>视频任务点</span><b>{mount?.total || 0}</b></div><div><span>已完成</span><b>{mount?.completed || 0}</b></div><div><span>课程数量</span><b>{snapshot.courseCount}</b></div></div>
      {nodes.length > 0 && <><div className="cx-query-nodes" aria-label={`已完成 ${mount?.completed || 0}，总数 ${mount?.total || 0}`}>{nodes.map((state, index) => <i key={index} className={state} />)}</div>
        <div className="cx-query-legend"><span><i className="done" />已完成</span><span><i className="active" />正在挂载</span><span><i className="waiting" />等待挂载</span><span><i className="failed" />已暂停</span></div></>}
      <div className="cx-query-total"><span>{mount?.scanning ? "任务点总进度（扫描中）" : "任务点总进度"}<b>{mount?.completed || 0}/{mount?.total || 0}</b></span><div role="progressbar" aria-label="任务点总进度" aria-valuenow={Math.floor(totalProgress)} aria-valuemin={0} aria-valuemax={100}><i key={`${mount?.courseId}:${mount?.classId}`} style={{ transform: `scaleX(${totalProgress / 100})` }} /></div></div>
    </section>
    {Boolean(snapshot.notices?.length) && <section className="cx-query-card cx-query-web-notices"><h2><span className="cx-query-mark" />任务日志</h2>
      {snapshot.notices!.slice(0, 10).map((notice) => <article key={notice.id}><p>{notice.text}</p><time>{time(notice.createdAt)}</time></article>)}
    </section>}
    <section className="cx-query-card cx-query-current"><h2><span className="cx-query-mark" />挂载明细</h2>
      {mount?.current ? <><div className="cx-query-current-row"><span>当前播放</span><strong key={`${mount.courseId}:${mount.current.name}`}>{mount.current.name}</strong></div><div className="cx-query-time"><span>播放进度</span><b>{clock(mount.current.playingTime)} / {clock(mount.current.duration)}</b></div><div className="cx-query-progress" role="progressbar" aria-label="当前视频播放进度" aria-valuenow={Math.floor(currentProgress)} aria-valuemin={0} aria-valuemax={100}><i key={`${mount.courseId}:${mount.classId}:${mount.current.name}`} style={{ transform: `scaleX(${currentProgress / 100})` }} /></div></> : <p className="cx-query-empty">{mount?.status || "暂无播放任务"}</p>}
      {mount && <p className="cx-query-status">{mount.status}</p>}
      {mount && <button type="button" className="cx-query-repair-mobile" onClick={() => void repair()} disabled={busy}>{pendingAction === "repair" && <span className="cx-query-spinner" aria-hidden="true" />}{pendingAction === "repair" ? "处理中…" : "自助修复"}</button>}
    </section>
    <Suspense fallback={<section className="cx-query-card"><p className="cx-query-empty">地图加载中…</p></section>}>
      <CourseLocationSettings courses={snapshot.courses || []} onUnauthorized={expireSession} />
    </Suspense>
    <section className="cx-query-card cx-query-signins"><h2><span className="cx-query-mark" />签到记录<em className={`cx-query-pill ${snapshot.enabled ? "online" : "paused"}`}>{snapshot.enabled ? "正在监听" : "已暂停"}</em></h2>
      {snapshot.signIns.length ? <div className="cx-query-records">{snapshot.signIns.map((item) => <article key={`${item.activityId}-${item.checkedAt}`}><div><strong>{item.activityName}</strong><span>{item.courseName}</span></div><em className={/成功|已签到/.test(item.result) ? "success" : "notice"}>{item.result}</em><time>{time(item.checkedAt)}</time></article>)}</div> : <p className="cx-query-empty">暂无签到记录</p>}
    </section>
  </div></main>;
}
