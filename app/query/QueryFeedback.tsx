"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { queryFailure, redactQueryLog, type QueryFailureContext, type QueryToastKind } from "../../lib/query-feedback";

type Toast = { id: number; kind: QueryToastKind; message: string; leaving: boolean };
type Confirmation = { title: string; message: string; confirmLabel?: string; destructive?: boolean };
type Dialog = ({ kind: "confirm" } & Confirmation) | { kind: "error"; title: string; message: string; log: string };
type DialogState = { id: number; content: Dialog; leaving: boolean };
type Feedback = {
  notify: (message: string, kind?: QueryToastKind) => void;
  reportError: (error: unknown, context: QueryFailureContext) => void;
  confirm: (options: Confirmation) => Promise<boolean>;
};
const FeedbackContext = createContext<Feedback | null>(null);

export function useQueryFeedback() {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("QueryFeedbackProvider is required");
  return value;
}

function exitDelay() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200;
}

function ToastItem({ toast, dismiss, remove }: { toast: Toast; dismiss: (id: number) => void; remove: (id: number) => void }) {
  useEffect(() => {
    if (toast.leaving) return;
    const timer = window.setTimeout(() => dismiss(toast.id), 3000);
    return () => window.clearTimeout(timer);
  }, [dismiss, toast.id, toast.leaving]);
  useEffect(() => {
    if (!toast.leaving) return;
    // The fallback also finishes an exit when animations are disabled or interrupted.
    const timer = window.setTimeout(() => remove(toast.id), exitDelay());
    return () => window.clearTimeout(timer);
  }, [remove, toast.id, toast.leaving]);
  return <div className={`cx-query-toast-slot${toast.leaving ? " leaving" : ""}`} aria-hidden={toast.leaving || undefined}>
    <div className="cx-query-toast-clip"><div className={`cx-query-toast ${toast.kind}${toast.leaving ? " leaving" : ""}`}
      role={toast.kind === "error" ? "alert" : "status"}>
    <span className="cx-query-toast-symbol" aria-hidden="true">{({ info: "i", done: "✓", warning: "!", error: "!", cancellation: "×" })[toast.kind]}</span>
    <span>{toast.message}</span>
    <button type="button" disabled={toast.leaving} onClick={() => dismiss(toast.id)} aria-label="关闭提示">×</button>
  </div></div></div>;
}

function FeedbackDialog({ state, close, exited, notify }: { state: DialogState; close: (accepted: boolean) => void; exited: (id: number) => void; notify: Feedback["notify"] }) {
  const { content: dialog, leaving } = state;
  const titleId = useId(), descriptionId = useId(), logId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const [log, setLog] = useState(dialog.kind === "error" ? dialog.log : "");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const panel = panelRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Start at the safe, non-destructive button when asking for confirmation.
    panel?.querySelector<HTMLButtonElement>("[data-initial-focus]")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(false); return; }
      if (event.key !== "Tab" || !panel) return;
      const controls = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, input, [tabindex='0']")];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [close]);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => exited(state.id), exitDelay());
    return () => window.clearTimeout(timer);
  }, [exited, leaving, state.id]);

  async function copy() {
    const safe = redactQueryLog(log);
    setLog(safe);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(safe);
      setCopied(true); notify("日志已复制，请粘贴发送给管理员", "done");
    } catch {
      window.requestAnimationFrame(() => { logRef.current?.focus(); logRef.current?.select(); });
      notify("浏览器未允许复制，请长按或选中日志后手动复制", "warning");
    }
  }
  return <div className={`cx-query-dialog-backdrop${leaving ? " leaving" : ""}`}><div ref={panelRef} className={`cx-query-dialog ${dialog.kind === "error" ? "error" : dialog.destructive ? "cancellation" : "warning"}${leaving ? " leaving" : ""}`}
    role={dialog.kind === "error" ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <header><h2 id={titleId}>{dialog.title}</h2>
      {dialog.kind === "error" && <button className="cx-query-copy-log" type="button" disabled={leaving} onClick={() => void copy()} aria-label="复制错误日志">{copied ? "✓ 已复制" : "复制日志"}</button>}
    </header>
    <p id={descriptionId} className="cx-query-dialog-message">{dialog.message}</p>
    {dialog.kind === "error" && <>
      <label htmlFor={logId}>运行日志</label>
      <textarea id={logId} ref={logRef} value={log} readOnly={leaving} maxLength={16000} onChange={(event) => { setLog(event.target.value); setCopied(false); }} spellCheck={false} />
      <p className="cx-query-dialog-hint">可补充粘贴日志；复制后请发送给管理员，勿附带账号密码。</p>
    </>}
    <footer>{dialog.kind === "confirm" ? <>
      <button data-initial-focus type="button" disabled={leaving} className="quiet" onClick={() => close(false)}>取消</button>
      <button type="button" disabled={leaving} className={dialog.destructive ? "danger" : ""} onClick={() => close(true)}>{dialog.confirmLabel || "确认"}</button>
    </> : <button data-initial-focus type="button" disabled={leaving} onClick={() => close(false)}>关闭</button>}</footer>
  </div></div>;
}

export function QueryFeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const nextId = useRef(0);
  const closingRef = useRef(false);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const notify = useCallback((message: string, kind: QueryToastKind = "info") => {
    const id = ++nextId.current;
    setToasts((current) => {
      const next = [...current, { id, kind, message, leaving: false }];
      const overflow = new Set(next.filter((toast) => !toast.leaving).slice(0, -3).map((toast) => toast.id));
      return next.map((toast) => overflow.has(toast.id) ? { ...toast, leaving: true } : toast);
    });
  }, []);
  const dismiss = useCallback((id: number) => setToasts((current) => current.map((toast) => toast.id === id && !toast.leaving ? { ...toast, leaving: true } : toast)), []);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const close = useCallback((accepted: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (resolver.current) {
      resolver.current(accepted); resolver.current = null;
      if (!accepted) notify("已取消操作", "cancellation");
    }
    setDialog((current) => current ? { ...current, leaving: true } : null);
  }, [notify]);
  const exited = useCallback((id: number) => {
    // An older closing dialog must never remove a newer error or confirmation.
    setDialog((current) => current?.id === id && current.leaving ? null : current);
  }, []);
  const reportError = useCallback((error: unknown, context: QueryFailureContext) => {
    resolver.current?.(false); resolver.current = null;
    closingRef.current = false;
    setDialog({ id: ++nextId.current, leaving: false, content: { kind: "error", title: `${context.operation}失败`, ...queryFailure(error, context) } });
  }, []);
  const confirm = useCallback((options: Confirmation) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    closingRef.current = false;
    setDialog({ id: ++nextId.current, leaving: false, content: { kind: "confirm", ...options } });
  }), []);
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  const feedback = useMemo(() => ({ notify, reportError, confirm }), [notify, reportError, confirm]);
  return <FeedbackContext.Provider value={feedback}>
    <div inert={!!dialog}>{children}</div>
    <div className="cx-query-toasts" aria-label="操作反馈">{toasts.map((toast) => <ToastItem key={toast.id} toast={toast} dismiss={dismiss} remove={remove} />)}</div>
    {dialog && <FeedbackDialog key={dialog.id} state={dialog} close={close} exited={exited} notify={notify} />}
  </FeedbackContext.Provider>;
}
