/**
 * scorm/echocardiographic-windows/src/scorm.ts
 *
 * SCORM 1.2 run-time wrapper.
 *
 * SCORM 1.2 rather than 2004 deliberately: this package may be handed to a
 * prospect's own LMS, and 1.2 is the version everything still supports.
 *
 * The API object is discovered by walking up through window.parent and then
 * window.opener, which is what the ADL reference implementation specifies —
 * an LMS may frame the content at any depth.
 *
 * Everything degrades silently. A SCORM package that throws when opened
 * outside an LMS is impossible to preview, so when no API is found this
 * records to an in-memory store and logs, letting the course run standalone.
 */

type ScormApi = {
  LMSInitialize(arg: string): string;
  LMSFinish(arg: string): string;
  LMSGetValue(key: string): string;
  LMSSetValue(key: string, value: string): string;
  LMSCommit(arg: string): string;
  LMSGetLastError(): string;
  LMSGetErrorString(code: string): string;
  LMSGetDiagnostic(code: string): string;
};

const MAX_DEPTH = 10;

function findApiIn(win: Window | null): ScormApi | null {
  let current = win;
  let depth = 0;
  while (current && depth < MAX_DEPTH) {
    try {
      const candidate = (current as unknown as { API?: ScormApi }).API;
      if (candidate) return candidate;
    } catch {
      // Cross-origin parent: stop climbing this chain rather than throwing.
      return null;
    }
    if (current.parent === current) break;
    current = current.parent;
    depth++;
  }
  return null;
}

function discoverApi(): ScormApi | null {
  return (
    findApiIn(window) ??
    findApiIn(window.opener as Window | null) ??
    null
  );
}

export class Scorm {
  private api: ScormApi | null = null;
  private initialised = false;
  /** Used when no LMS is present so the course still runs standalone. */
  private fallback = new Map<string, string>();

  /** True when a real LMS API was found. The UI surfaces this. */
  get connected(): boolean {
    return this.api !== null;
  }

  initialize(): boolean {
    this.api = discoverApi();
    if (!this.api) {
      // eslint-disable-next-line no-console
      console.info("[scorm] no LMS API found — running standalone, progress will not be reported");
      this.initialised = true;
      return false;
    }
    const ok = this.api.LMSInitialize("") === "true";
    this.initialised = ok;
    if (!ok) this.logError("LMSInitialize");
    // An LMS may deliver the SCO as "not attempted"; move it on so a learner
    // who abandons the module is still recorded as having started it.
    if (ok && this.get("cmi.core.lesson_status") === "not attempted") {
      this.set("cmi.core.lesson_status", "incomplete");
    }
    return ok;
  }

  get(key: string): string {
    if (!this.api) return this.fallback.get(key) ?? "";
    const value = this.api.LMSGetValue(key);
    const err = this.api.LMSGetLastError();
    if (err !== "0") this.logError(`LMSGetValue(${key})`);
    return value;
  }

  set(key: string, value: string): boolean {
    if (!this.api) {
      this.fallback.set(key, value);
      return true;
    }
    const ok = this.api.LMSSetValue(key, value) === "true";
    if (!ok) this.logError(`LMSSetValue(${key}, ${value})`);
    return ok;
  }

  commit(): boolean {
    if (!this.api) return true;
    const ok = this.api.LMSCommit("") === "true";
    if (!ok) this.logError("LMSCommit");
    return ok;
  }

  finish(): boolean {
    if (!this.api || !this.initialised) return true;
    const ok = this.api.LMSFinish("") === "true";
    this.initialised = false;
    return ok;
  }

  private logError(where: string) {
    if (!this.api) return;
    const code = this.api.LMSGetLastError();
    // eslint-disable-next-line no-console
    console.warn(
      `[scorm] ${where} failed: ${code} ${this.api.LMSGetErrorString(code)} — ${this.api.LMSGetDiagnostic(code)}`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Course-level helpers                                                 */
/* ------------------------------------------------------------------ */

export type CourseProgress = {
  /** Section ids the learner has viewed. */
  visited: string[];
  /** Last section id, restored on resume. */
  current: string;
  /** Percentage, or null if the knowledge check has not been submitted. */
  score: number | null;
};

/**
 * suspend_data is capped at 4096 characters in SCORM 1.2, so this stays a
 * compact delimited string rather than JSON.
 */
export function encodeProgress(p: CourseProgress): string {
  return [p.current, p.score === null ? "" : String(p.score), p.visited.join(",")].join("|");
}

export function decodeProgress(raw: string): CourseProgress | null {
  if (!raw) return null;
  const [current, score, visited] = raw.split("|");
  if (!current) return null;
  return {
    current,
    score: score === "" || score === undefined ? null : Number(score),
    visited: visited ? visited.split(",").filter(Boolean) : [],
  };
}
