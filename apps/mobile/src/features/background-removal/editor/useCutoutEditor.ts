import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { notifyJobChanged } from "../jobEvents";
import { CutoutError, type CutoutBlock, type CutoutJob, type CutoutPort, type CutoutVersion, type RefineBackground, type RefineParams, type RefineStroke } from "../model";
import {
  AUTO_APPLY_MS, DEFAULT_PARAMS, INITIAL_EDITOR, addStroke, canRedo, canUndo, clampParams, editorReducer, historyOf, isEditLocked, presentOf, pushVersion,
  redo as redoH, resetToFirst, undo as undoH, type EditorState, type History, type Tool,
} from "./editorModel";

export interface EditorSnapshot { readonly strokes: readonly RefineStroke[]; readonly params: RefineParams }
const EMPTY: EditorSnapshot = { strokes: [], params: DEFAULT_PARAMS };

export interface CutoutEditor {
  readonly job: CutoutJob | null;
  readonly loading: boolean;
  readonly block: CutoutBlock | null;
  readonly editor: EditorState;
  readonly params: RefineParams;
  readonly strokes: readonly RefineStroke[];
  /** Strokes drawn since the last applied derivative (shown as the live overlay). */
  readonly pending: readonly RefineStroke[];
  readonly strokeLimitHit: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  readonly versionCount: number;
  readonly saving: boolean;
  readonly setTool: (t: Tool) => void;
  readonly addStroke: (s: RefineStroke) => void;
  readonly setParams: (p: Partial<RefineParams>) => void;
  readonly setBackdrop: (b: RefineBackground) => void;
  readonly applyNow: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly reset: () => void;
  readonly done: () => Promise<boolean>;
  readonly useOriginal: () => Promise<boolean>;
  readonly reload: () => void;
}

const kindOf = (e: unknown): CutoutBlock => (e instanceof CutoutError ? e.kind : "failed");

/**
 * Editor state over a CutoutPort. Edits are always re-derived from the automatic cutout (version 1) with the full stroke
 * list, so every applied result is a saved version and Undo/Redo is just "restore version N".
 */
export function useCutoutEditor(port: CutoutPort, jobId: string, autoApplyMs: number = AUTO_APPLY_MS): CutoutEditor {
  const [job, setJob] = useState<CutoutJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [block, setBlock] = useState<CutoutBlock | null>(null);
  const [editor, dispatch] = useReducer(editorReducer, INITIAL_EDITOR);
  const [params, setParamsState] = useState<RefineParams>(DEFAULT_PARAMS);
  const [strokes, setStrokes] = useState<readonly RefineStroke[]>([]);
  const [appliedCount, setAppliedCount] = useState(0);
  const [limit, setLimit] = useState(false);
  const [history, setHistory] = useState<History>({ ids: [], cursor: 0 });
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);

  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ strokes, params, history, appliedCount, applying: false, dirty: false, job: null as CutoutJob | null, editor });
  live.current.strokes = strokes; live.current.params = params; live.current.history = history; live.current.appliedCount = appliedCount; live.current.job = job; live.current.editor = editor;
  const snapshots = useRef(new Map<number, EditorSnapshot>());
  const seq = useRef(0);

  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current !== null) clearTimeout(timer.current); }; }, []);

  const fail = useCallback((e: unknown) => {
    const k = kindOf(e);
    setBlock(k);
    if (isEditLocked(k)) dispatch({ type: "lock" });
  }, []);

  // Load the job and its version list.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const j = await port.refresh(jobId);
        let vs: readonly CutoutVersion[] = [];
        try { vs = await port.versions(jobId); } catch { vs = []; }
        if (cancelled || !alive.current) return;
        const ids = vs.length > 0 ? vs.map((v) => v.version) : [j.version ?? 1];
        setJob(j);
        setHistory(historyOf(ids, j.version));
        if (j.version !== undefined) snapshots.current.set(j.version, snapshots.current.get(j.version) ?? EMPTY);
        setBlock(null);
        if (j.status === "FAILED" || j.cutoutUrl === null) dispatch({ type: "lock" });
      } catch (e) {
        if (!cancelled && alive.current) { fail(e); dispatch({ type: "lock" }); }
      } finally {
        if (!cancelled && alive.current) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [port, jobId, nonce, fail]);

  const applyNow = useCallback(async (): Promise<void> => {
    const cur = live.current;
    if (cur.applying || cur.editor.locked || cur.job === null) return;
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    if (!cur.dirty) return;
    cur.applying = true;
    const mine = ++seq.current;
    dispatch({ type: "applyStart" });
    setBlock(null);
    const sent = { strokes: cur.strokes, params: cur.params };
    try {
      const next = await port.refine(jobId, sent.strokes, sent.params);
      let vs: readonly CutoutVersion[] = [];
      try { vs = await port.versions(jobId); } catch { vs = []; }
      if (!alive.current || mine !== seq.current) return;
      const version = next.version ?? (vs.length > 0 ? Math.max(...vs.map((v) => v.version)) : (cur.history.ids[cur.history.ids.length - 1] ?? 1) + 1);
      snapshots.current.set(version, sent);
      setJob(next);
      setHistory((h) => pushVersion(h, version));
      setAppliedCount(sent.strokes.length);
      cur.dirty = !(cur.strokes === sent.strokes && cur.params === sent.params) ? true : false;
      if (cur.dirty) scheduleRef.current();
    } catch (e) {
      if (alive.current) fail(e);
    } finally {
      cur.applying = false;
      if (alive.current) dispatch({ type: "applyDone" });
    }
  }, [port, jobId, fail]);

  const scheduleRef = useRef<() => void>(() => undefined);
  const schedule = useCallback(() => {
    live.current.dirty = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void applyNow(); }, autoApplyMs);
  }, [applyNow, autoApplyMs]);
  scheduleRef.current = schedule;

  const addS = useCallback((s: RefineStroke) => {
    const r = addStroke(live.current.strokes, s);
    if (r.capped) { setLimit(true); return; }
    live.current.strokes = r.strokes;
    setStrokes(r.strokes);
    schedule();
  }, [schedule]);

  const setParams = useCallback((p: Partial<RefineParams>) => {
    const next = clampParams({ ...live.current.params, ...p });
    live.current.params = next;
    setParamsState(next);
    schedule();
  }, [schedule]);

  const setBackdrop = useCallback((b: RefineBackground) => {
    const next = clampParams({ ...live.current.params, background: b });
    live.current.params = next;
    setParamsState(next);
  }, []);

  const goTo = useCallback(async (h: History) => {
    const v = presentOf(h);
    if (v === null || live.current.applying) return;
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    live.current.applying = true;
    dispatch({ type: "applyStart" });
    try {
      const j = await port.restoreVersion(jobId, v);
      if (!alive.current) return;
      const snap = snapshots.current.get(v) ?? EMPTY;
      live.current.strokes = snap.strokes; live.current.params = { ...snap.params, background: live.current.params.background }; live.current.dirty = false;
      setStrokes(snap.strokes);
      setParamsState(live.current.params);
      setAppliedCount(snap.strokes.length);
      setHistory(h);
      setJob(j);
      setLimit(false);
      setBlock(null);
    } catch (e) {
      if (alive.current) fail(e);
    } finally {
      live.current.applying = false;
      if (alive.current) dispatch({ type: "applyDone" });
    }
  }, [port, jobId, fail]);

  const done = useCallback(async (): Promise<boolean> => {
    const cur = live.current;
    if (cur.job === null) return false;
    setSaving(true);
    try {
      if (cur.dirty) {
        // Apply the last unsent edits first so "Done" saves what the seller sees.
        await applyNow();
        if (live.current.dirty) return false;
      }
      const v = presentOf(live.current.history) ?? live.current.job?.version;
      const j = await port.accept(jobId, v ?? undefined);
      if (alive.current) setJob(j);
      notifyJobChanged(jobId);
      return true;
    } catch (e) {
      if (alive.current) fail(e);
      return false;
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [applyNow, port, jobId, fail]);

  const useOriginal = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    try {
      const j = await port.useOriginal(jobId);
      if (alive.current) setJob(j);
      notifyJobChanged(jobId);
      return true;
    } catch (e) {
      if (alive.current) fail(e);
      return false;
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [port, jobId, fail]);

  const h = history;
  return {
    job, loading, block, editor, params, strokes, pending: strokes.slice(appliedCount), strokeLimitHit: limit,
    canUndo: canUndo(h) && !editor.applying, canRedo: canRedo(h) && !editor.applying, dirty: live.current.dirty, versionCount: h.ids.length, saving,
    setTool: (t) => dispatch({ type: "tool", tool: t }), addStroke: addS, setParams, setBackdrop, applyNow: () => { void applyNow(); },
    undo: () => { void goTo(undoH(h)); }, redo: () => { void goTo(redoH(h)); },
    reset: () => { void goTo(resetToFirst(h)); },
    done, useOriginal, reload: () => setNonce((n) => n + 1),
  };
}
