/**
 * scorm/echocardiographic-windows/src/course.ts
 *
 * Controller for the module: renders the sections, drives the heart engine,
 * runs the knowledge check, and reports everything to the LMS.
 *
 * Content lives in content.ts; the 3D lives in heart-engine.ts. This file is
 * only wiring.
 */

import { HeartEngine, hasWebGL, type Phase, type ViewId } from "./heart-engine";
import { MASTERY, QUESTIONS, SECTIONS, type Block, type Section } from "./content";
import { Scorm, decodeProgress, encodeProgress } from "./scorm";

const CHECK_ID = "check";
const scorm = new Scorm();

let engine: HeartEngine | null = null;
let current = SECTIONS[0].id;
const visited = new Set<string>();
let score: number | null = null;
let answers: Record<string, number> = {};
let submitted = false;
const startedAt = Date.now();

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                    */
/* ------------------------------------------------------------------ */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function renderBlock(b: Block): HTMLElement {
  switch (b.kind) {
    case "h":
      return el("h3", { class: "ec-h3" }, [b.text]);
    case "p":
      return el("p", {}, [b.text]);
    case "list":
      return el(
        "ul",
        { class: "ec-list" },
        b.items.map((i) => el("li", {}, [i]))
      );
    case "defs":
      return el(
        "dl",
        { class: "ec-defs" },
        b.items.flatMap((d) => [el("dt", {}, [d.term]), el("dd", {}, [d.text])])
      );
    case "note":
      return el("aside", { class: "ec-callout ec-callout--note" }, [
        el("b", {}, [b.title]),
        el("span", {}, [b.text]),
      ]);
    case "pitfall":
      return el("aside", { class: "ec-callout ec-callout--pitfall" }, [
        el("b", {}, [b.title]),
        el("span", {}, [b.text]),
      ]);
  }
}

function renderSection(s: Section): HTMLElement {
  return el("article", { class: "ec-section", id: `sec-${s.id}`, "data-section": s.id }, [
    el("p", { class: "ec-kicker" }, [s.nav]),
    el("h2", {}, [s.title]),
    el("p", { class: "ec-lead" }, [s.lead]),
    ...s.blocks.map(renderBlock),
  ]);
}

function renderCheck(): HTMLElement {
  const wrap = el("article", { class: "ec-section", id: `sec-${CHECK_ID}`, "data-section": CHECK_ID }, [
    el("p", { class: "ec-kicker" }, ["Knowledge check"]),
    el("h2", {}, ["Check your understanding"]),
    el("p", { class: "ec-lead" }, [
      `Five questions. ${MASTERY}% or better to pass; your score is reported to the LMS.`,
    ]),
  ]);

  QUESTIONS.forEach((q, qi) => {
    const fieldset = el("fieldset", { class: "ec-q", id: `q-${q.id}` }, [
      el("legend", {}, [`${qi + 1}. ${q.stem}`]),
    ]);
    q.options.forEach((opt, oi) => {
      const id = `${q.id}-${oi}`;
      const input = el("input", { type: "radio", name: q.id, id, value: String(oi) });
      input.addEventListener("change", () => {
        if (submitted) return;
        answers[q.id] = oi;
        updateSubmitState();
      });
      fieldset.append(
        el("label", { class: "ec-opt", for: id }, [input, el("span", {}, [opt])])
      );
    });
    fieldset.append(el("div", { class: "ec-feedback", id: `fb-${q.id}` }));
    wrap.append(fieldset);
  });

  const submit = el("button", { class: "ec-btn ec-btn--primary", id: "ec-submit", disabled: "true" }, [
    "Submit answers",
  ]);
  submit.addEventListener("click", submitCheck);

  const retry = el("button", { class: "ec-btn", id: "ec-retry", hidden: "true" }, ["Try again"]);
  retry.addEventListener("click", resetCheck);

  wrap.append(
    el("div", { class: "ec-result", id: "ec-result" }),
    el("div", { class: "ec-actions" }, [submit, retry])
  );
  return wrap;
}

function renderNav() {
  const nav = $("#ec-nav");
  nav.textContent = "";
  const items = [...SECTIONS.map((s) => ({ id: s.id, label: s.nav })), { id: CHECK_ID, label: "Knowledge check" }];
  items.forEach((item, i) => {
    const btn = el("button", { class: "ec-navitem", "data-nav": item.id }, [
      el("span", { class: "ec-navitem__n" }, [String(i + 1).padStart(2, "0")]),
      el("span", { class: "ec-navitem__label" }, [item.label]),
      el("span", { class: "ec-navitem__tick" }),
    ]);
    btn.addEventListener("click", () => goTo(item.id));
    nav.append(btn);
  });
}

function syncNav() {
  document.querySelectorAll<HTMLElement>(".ec-navitem").forEach((b) => {
    const id = b.dataset.nav as string;
    b.classList.toggle("is-current", id === current);
    b.classList.toggle("is-done", visited.has(id));
  });
  document.querySelectorAll<HTMLElement>(".ec-section").forEach((s) => {
    s.hidden = s.dataset.section !== current;
  });

  const idx = sectionIndex(current);
  const total = SECTIONS.length + 1;
  ($("#ec-prev") as HTMLButtonElement).disabled = idx === 0;
  const next = $("#ec-next") as HTMLButtonElement;
  next.disabled = idx === total - 1;
  next.textContent = idx === total - 2 ? "Knowledge check" : "Next";
  $("#ec-progress-fill").style.width = `${(visited.size / total) * 100}%`;
  $("#ec-progress-text").textContent = `${visited.size} of ${total} complete`;
}

const sectionIds = () => [...SECTIONS.map((s) => s.id), CHECK_ID];
const sectionIndex = (id: string) => sectionIds().indexOf(id);

/* ------------------------------------------------------------------ */
/* Navigation + progress                                                */
/* ------------------------------------------------------------------ */

function goTo(id: string) {
  if (!sectionIds().includes(id)) return;
  current = id;
  visited.add(id);

  const section = SECTIONS.find((s) => s.id === id);
  setView(section ? section.view : "free");

  syncNav();
  $("#ec-scroll").scrollTop = 0;
  save();
}

function step(delta: number) {
  const ids = sectionIds();
  const i = Math.max(0, Math.min(ids.length - 1, sectionIndex(current) + delta));
  goTo(ids[i]);
}

function setView(view: ViewId) {
  engine?.setView(view);
  const def = view === "free" ? null : view;
  $("#ec-viewname").textContent = def
    ? (document.querySelector(`[data-view="${view}"]`)?.textContent ?? view.toUpperCase())
    : "Free rotation";
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.view === view);
  });
}

/* ------------------------------------------------------------------ */
/* Knowledge check                                                      */
/* ------------------------------------------------------------------ */

function updateSubmitState() {
  const ready = QUESTIONS.every((q) => answers[q.id] !== undefined);
  ($("#ec-submit") as HTMLButtonElement).disabled = !ready;
}

function submitCheck() {
  if (submitted) return;
  submitted = true;

  let correct = 0;
  for (const q of QUESTIONS) {
    const chosen = answers[q.id];
    const right = chosen === q.answer;
    if (right) correct++;

    const fb = document.getElementById(`fb-${q.id}`) as HTMLElement;
    fb.className = `ec-feedback is-shown ${right ? "is-right" : "is-wrong"}`;
    fb.textContent = right
      ? `Correct. ${q.explanation}`
      : `Not quite. ${q.explanation}`;

    const field = document.getElementById(`q-${q.id}`) as HTMLElement;
    field.querySelectorAll<HTMLInputElement>("input").forEach((input, oi) => {
      input.disabled = true;
      const label = input.closest(".ec-opt") as HTMLElement;
      if (oi === q.answer) label.classList.add("is-answer");
      else if (oi === chosen) label.classList.add("is-chosen-wrong");
    });
  }

  score = Math.round((correct / QUESTIONS.length) * 100);
  const passed = score >= MASTERY;

  const result = $("#ec-result");
  result.className = `ec-result is-shown ${passed ? "is-pass" : "is-fail"}`;
  result.textContent = passed
    ? `Passed — ${correct} of ${QUESTIONS.length} correct (${score}%).`
    : `${correct} of ${QUESTIONS.length} correct (${score}%). ${MASTERY}% is needed to pass; review the feedback and try again.`;

  ($("#ec-submit") as HTMLButtonElement).hidden = true;
  ($("#ec-retry") as HTMLButtonElement).hidden = false;

  reportScore(score, passed);
}

function resetCheck() {
  submitted = false;
  answers = {};
  score = null;
  for (const q of QUESTIONS) {
    const fb = document.getElementById(`fb-${q.id}`) as HTMLElement;
    fb.className = "ec-feedback";
    fb.textContent = "";
    const field = document.getElementById(`q-${q.id}`) as HTMLElement;
    field.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.disabled = false;
      input.checked = false;
      input.closest(".ec-opt")?.classList.remove("is-answer", "is-chosen-wrong");
    });
  }
  const result = $("#ec-result");
  result.className = "ec-result";
  result.textContent = "";
  ($("#ec-submit") as HTMLButtonElement).hidden = false;
  ($("#ec-submit") as HTMLButtonElement).disabled = true;
  ($("#ec-retry") as HTMLButtonElement).hidden = true;
}

/* ------------------------------------------------------------------ */
/* SCORM reporting                                                      */
/* ------------------------------------------------------------------ */

function reportScore(value: number, passed: boolean) {
  scorm.set("cmi.core.score.min", "0");
  scorm.set("cmi.core.score.max", "100");
  scorm.set("cmi.core.score.raw", String(value));
  scorm.set("cmi.core.lesson_status", passed ? "passed" : "failed");
  save();
}

function save() {
  scorm.set("cmi.core.lesson_location", current);
  scorm.set(
    "cmi.suspend_data",
    encodeProgress({ current, score, visited: [...visited] })
  );
  // Only claim completion once the learner has actually passed; before that
  // the status stays incomplete so a half-finished attempt is visible.
  if (score === null) scorm.set("cmi.core.lesson_status", "incomplete");
  scorm.commit();
}

/** SCORM 1.2 session_time is HHHH:MM:SS.SS. */
function sessionTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.00`;
}

function finish() {
  scorm.set("cmi.core.session_time", sessionTime(Date.now() - startedAt));
  save();
  scorm.finish();
}

/* ------------------------------------------------------------------ */
/* Heart controls                                                       */
/* ------------------------------------------------------------------ */

function wireControls() {
  const play = $("#ec-play") as HTMLButtonElement;
  let playing = true;
  play.addEventListener("click", () => {
    playing = !playing;
    engine?.setPlaying(playing);
    play.textContent = playing ? "Pause" : "Play";
    play.setAttribute("aria-pressed", String(!playing));
    if (playing) (($("#ec-scrub") as HTMLInputElement).value = "-1");
  });

  const rate = $("#ec-rate") as HTMLInputElement;
  rate.addEventListener("input", () => {
    engine?.setRate(Number(rate.value));
    $("#ec-rate-value").textContent = `${rate.value} bpm`;
  });

  const scrub = $("#ec-scrub") as HTMLInputElement;
  scrub.addEventListener("input", () => {
    const v = Number(scrub.value);
    if (v < 0) return;
    engine?.setScrub(v / 1000);
    playing = false;
    play.textContent = "Play";
  });

  const labels = $("#ec-labels") as HTMLInputElement;
  labels.addEventListener("change", () => engine?.setLabels(labels.checked));

  document.querySelectorAll<HTMLElement>("[data-view]").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.view as ViewId));
  });

  $("#ec-prev").addEventListener("click", () => step(-1));
  $("#ec-next").addEventListener("click", () => step(1));
}

function onPhase(p: Phase) {
  $("#ec-phase").textContent = p.name;
  const scrub = $("#ec-scrub") as HTMLInputElement;
  if (document.activeElement !== scrub) scrub.value = String(Math.round(p.t * 1000));
  $("#ec-vent").style.width = `${Math.round(p.ventricle * 100)}%`;
  $("#ec-atr").style.width = `${Math.round(p.atrium * 100)}%`;
}

function onLabels(list: { text: string; x: number; y: number; visible: boolean }[]) {
  const layer = $("#ec-labels-layer");
  // Reuse nodes rather than rebuilding every frame.
  while (layer.children.length < list.length) {
    layer.append(el("span", { class: "ec-label" }));
  }
  while (layer.children.length > list.length) {
    layer.lastElementChild?.remove();
  }
  list.forEach((l, i) => {
    const node = layer.children[i] as HTMLElement;
    node.textContent = l.text;
    node.style.transform = `translate3d(${l.x}px, ${l.y}px, 0)`;
    node.style.opacity = l.visible ? "1" : "0";
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

async function boot() {
  const connected = scorm.initialize();
  $("#ec-lms").textContent = connected ? "LMS connected" : "Standalone preview";
  $("#ec-lms").classList.toggle("is-off", !connected);

  const body = $("#ec-sections");
  SECTIONS.forEach((s) => body.append(renderSection(s)));
  body.append(renderCheck());
  renderNav();
  wireControls();

  // Restore a previous attempt.
  const saved =
    decodeProgress(scorm.get("cmi.suspend_data")) ??
    (scorm.get("cmi.core.lesson_location")
      ? { current: scorm.get("cmi.core.lesson_location"), score: null, visited: [] }
      : null);
  if (saved) {
    saved.visited.forEach((v) => visited.add(v));
    score = saved.score;
    if (sectionIds().includes(saved.current)) current = saved.current;
  }

  const canvas = $("#ec-canvas") as HTMLCanvasElement;
  if (hasWebGL()) {
    engine = new HeartEngine(canvas, { onPhase, onLabels });
    try {
      await engine.init();
    } catch (err) {
      showStageError(err instanceof Error ? err.message : String(err));
    }
  } else {
    showStageError("This browser reports no WebGL support, so the 3D heart cannot be shown.");
  }

  goTo(current);

  window.addEventListener("beforeunload", finish);
  // iOS and some LMS frames never fire beforeunload; pagehide is the reliable
  // signal there, and committing twice is harmless.
  window.addEventListener("pagehide", finish);
}

function showStageError(message: string) {
  const stage = $("#ec-stage");
  stage.classList.add("has-error");
  $("#ec-stage-error").textContent =
    `${message} The written content and the knowledge check still work.`;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  void boot();
}
