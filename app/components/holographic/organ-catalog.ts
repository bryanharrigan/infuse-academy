/**
 * app/components/holographic/organ-catalog.ts
 *
 * Organ metadata plus the catalog-matching logic that decides which real
 * Absorb courses belong to which organ.
 *
 * Pure data + string matching, no THREE and no DOM, so the route, the engine
 * and any test can all share it.
 */

import type { StructureId } from "./anatomy";

export type OrganId =
  | "brain"
  | "heart"
  | "lungs"
  | "liver"
  | "kidneys"
  | "digestive"
  | "vascular"
  | "muscular"
  | "eyes"
  | "skeleton";

/** Shape returned by GET /api/psbi/catalog — see app/.server/my-courses.resource.ts. */
export type CatalogCourse = {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  courseType: "OnlineCourse" | "InstructorLedCourse" | "Curriculum";
  enrollmentStatus: string | null;
};

export type Organ = {
  id: OrganId;
  /**
   * Which mesh in public/anatomy the particle cloud is scattered over. Almost
   * always the organ's own id; kept explicit so a discipline can point at a
   * structure that is named differently in the anatomical source.
   */
  structure: StructureId;
  /**
   * True for organs that come as a left and a right. They get a hit sphere
   * each, because a single sphere over the pair puts its centre in the gap
   * between them and a click down the midline selects nothing.
   */
  paired: boolean;
  /** Short label on the 3D anchor. */
  label: string;
  /** Clinical discipline, shown under the label. */
  specialty: string;
  /** Two-letter code for the periodic-table style tiles. */
  symbol: string;
  blurb: string;
  /** Accent colour for this organ's HUD, as a CSS hex string. */
  accent: string;
  /**
   * Patterns used to pull matching courses out of the live catalog. Ordered
   * strongest-first; a hit in the course *name* scores higher than one in the
   * description, so "Cardiac Ultrasound" outranks a course that merely
   * mentions the heart in passing.
   */
  keywords: RegExp[];
  /**
   * Shown when the live catalog has nothing matching. Keeps the demo
   * presentable on a tenant whose catalog is all compliance training.
   */
  demoCourses: { name: string; description: string; duration: string }[];
  /**
   * How tightly the camera closes in. The skeleton is a whole-body structure,
   * so it pulls back rather than diving in.
   */
  framing: "organ" | "body";
  /**
   * Which side of its 3D anchor the floating label sits on. Alternating sides
   * is what stops six labels from stacking into an unreadable column over the
   * torso.
   */
  labelSide: "left" | "right";
};

export const ORGANS: Organ[] = [
  {
    id: "brain",
    structure: "brain",
    paired: false,
    label: "Cerebrum",
    specialty: "Neuroimaging",
    symbol: "Nr",
    blurb:
      "Cross-sectional neuroanatomy, stroke protocols and the sequence selection behind MR and CT brain studies.",
    accent: "#8ab4ff",
    keywords: [
      /neuro|brain|cerebr|cranial|intracranial|stroke|\bcva\b|seizure|epilep/i,
      /(mri|\bmr\b|\bct\b|perfusion|angiograph)[\s\w-]*(brain|head|cranial|neuro)|(brain|head|cranial|neuro)[\s\w-]*(mri|\bmr\b|\bct\b|perfusion|angiograph)/i,
      /cognit|dementia|concussion|haemorrhage|hemorrhage/i,
    ],
    demoCourses: [
      { name: "Cross-Sectional Neuroanatomy", description: "Identify midline, ventricular and vascular structures on axial, coronal and sagittal planes.", duration: "45 min" },
      { name: "Acute Stroke CT Protocol", description: "Non-contrast CT, CTA and perfusion sequencing against the door-to-needle clock.", duration: "60 min" },
      { name: "MR Sequence Selection", description: "When T1, T2, FLAIR, DWI and SWI each earn their place in a brain study.", duration: "50 min" },
      { name: "Recognising Intracranial Haemorrhage", description: "Distinguishing epidural, subdural and subarachnoid patterns under time pressure.", duration: "35 min" },
      { name: "Paediatric Neuro Dose Optimisation", description: "ALARA applied to the developing brain.", duration: "40 min" },
    ],
    framing: "organ",
    labelSide: "right",
  },
  {
    id: "heart",
    structure: "heart",
    paired: false,
    label: "Myocardium",
    specialty: "Cardiac Diagnostics",
    symbol: "Cd",
    blurb:
      "Rhythm interpretation, echocardiographic windows and the haemodynamics that explain what the trace is telling you.",
    accent: "#ff8a7a",
    keywords: [
      /cardi|heart|coronary|myocard|aort|valvular|atrial|ventric|\becg\b|\bekg\b|electrocardio|echocardio/i,
      /arrhythm|rhythm strip|telemetry|defib|haemodynam|hemodynam|calcium scoring/i,
      /\bacls\b|\bbls\b|\bcpr\b|stress test|catheteri|\bdoppler\b/i,
    ],
    demoCourses: [
      { name: "12-Lead ECG Interpretation", description: "Axis, intervals and the infarct patterns that must never be missed.", duration: "75 min" },
      { name: "Echocardiographic Windows", description: "Parasternal, apical and subcostal views, and how to recover a poor window.", duration: "55 min" },
      { name: "Coronary Anatomy & Territories", description: "Mapping a lesion to the wall it will stun.", duration: "40 min" },
      { name: "Haemodynamics of Valvular Disease", description: "Pressure gradients, regurgitant fractions and when numbers mislead.", duration: "50 min" },
      { name: "Arrhythmia Recognition Lab", description: "Timed strip-reading drills across 40 rhythms.", duration: "65 min" },
      { name: "Cardiac CT Calcium Scoring", description: "Acquisition, Agatston scoring and reporting thresholds.", duration: "35 min" },
    ],
    framing: "organ",
    labelSide: "left",
  },
  {
    id: "lungs",
    structure: "lungs",
    paired: true,
    label: "Pulmonary",
    specialty: "Thoracic Imaging",
    symbol: "Pu",
    blurb:
      "Chest radiography, ventilation mechanics and the interstitial patterns that separate oedema from fibrosis.",
    accent: "#6fe8d0",
    keywords: [
      /pulmon|lung|respir|thorac|chest|bronch|pleur|airway|interstitial/i,
      /ventilat|spirometr|asthma|\bcopd\b|pneumon|embol|oxygenat/i,
      /intubat|tracheostom|\babg\b|blood gas/i,
    ],
    demoCourses: [
      { name: "Systematic Chest Radiograph Review", description: "An order of inspection that survives a 200-film day.", duration: "45 min" },
      { name: "Interstitial Patterns", description: "Reticular, nodular and ground-glass — and what each narrows to.", duration: "55 min" },
      { name: "CT Pulmonary Angiography", description: "Timing the bolus and reading for embolus.", duration: "50 min" },
      { name: "Ventilation Mechanics", description: "Compliance, resistance and the pressure-volume loop at the bedside.", duration: "60 min" },
      { name: "Arterial Blood Gas Interpretation", description: "Four steps from pH to compensation.", duration: "30 min" },
    ],
    framing: "organ",
    labelSide: "right",
  },
  {
    id: "liver",
    structure: "liver",
    paired: false,
    label: "Hepatic",
    specialty: "Abdominal Imaging",
    symbol: "Hp",
    blurb:
      "Segmental anatomy, multiphase contrast timing and the lesion characterisation that follows from both.",
    accent: "#ffc46b",
    keywords: [
      /hepat|liver|biliar|gallbladder|cirrho|couinaud|portal venous|pancrea/i,
      /abdom|gastro|\bgi\b|bowel|splenic|ascites/i,
      /elastograph|multiphase|contrast timing/i,
    ],
    demoCourses: [
      { name: "Couinaud Segmental Anatomy", description: "The eight segments, and why the surgeon cares which one.", duration: "40 min" },
      { name: "Multiphase Contrast Timing", description: "Arterial, portal venous and delayed — matching phase to question.", duration: "45 min" },
      { name: "Focal Lesion Characterisation", description: "Haemangioma, FNH, adenoma and HCC on their enhancement signatures.", duration: "60 min" },
      { name: "Hepatic Ultrasound Technique", description: "Probe selection, patient positioning and getting under the ribs.", duration: "35 min" },
      { name: "Focal Lesion Characterisation", description: "Haemangioma, FNH, adenoma and metastasis — the features that separate them across phases.", duration: "50 min" },
    ],
    framing: "organ",
    labelSide: "right",
  },
  {
    id: "kidneys",
    structure: "kidneys",
    paired: true,
    label: "Renal",
    specialty: "Genitourinary",
    symbol: "Rn",
    blurb:
      "Renal function, contrast safety and the urinary tract imaging decisions that hinge on both.",
    accent: "#b79bff",
    keywords: [
      /renal|kidney|nephr|urinar|urograph|ureter|bladder|urolog|calculi/i,
      /dialys|creatinine|\begfr\b|hydronephro|split-?bolus|excretory/i,
      /contrast (safety|induced|nephropathy)|\bci-aki\b/i,
    ],
    demoCourses: [
      { name: "Renal Function & Contrast Safety", description: "eGFR thresholds, risk stratification and the hydration protocol.", duration: "40 min" },
      { name: "CT Urography Protocol", description: "Split-bolus technique and the excretory phase.", duration: "45 min" },
      { name: "Renal Calculi Detection", description: "Low-dose CT, Hounsfield composition and reporting the obstructing stone.", duration: "35 min" },
      { name: "Renal Ultrasound & Doppler", description: "Resistive indices, cortical thickness and transplant surveillance.", duration: "50 min" },
      { name: "Renal Doppler Technique", description: "Resistive index, segmental sampling and the pitfalls of a poor angle.", duration: "45 min" },
    ],
    framing: "organ",
    labelSide: "left",
  },
  {
    id: "digestive",
    structure: "digestive",
    paired: false,
    label: "Digestive",
    specialty: "Abdominal Imaging",
    symbol: "Gi",
    blurb:
      "Luminal contrast studies, bowel wall assessment and the abdominal series that separates obstruction from ileus.",
    accent: "#f2a65a",
    keywords: [
      /gastro|gastric|stomach|bowel|intestin|colon|duoden|oesophag|esophag|pancrea|biliary|gallbladder|rectal/i,
      /(barium|contrast|fluoroscop|endoscop)[\s\w-]*(swallow|meal|enema|study|gi)|abdominal (series|radiograph|ultrasound|\bct\b)/i,
      /obstruction|perforation|\bileus\b|coeliac|celiac|crohn|colitis|diverticul/i,
    ],
    demoCourses: [
      { name: "The Acute Abdominal Series", description: "Erect, supine and decubitus films, and the free-air sign that changes the plan.", duration: "45 min" },
      { name: "Barium Swallow & Meal Technique", description: "Patient positioning, timing and the mucosal phase that makes or breaks the study.", duration: "55 min" },
      { name: "Bowel Obstruction vs Ileus", description: "Calibre, valvulae and transition points under time pressure.", duration: "40 min" },
      { name: "Hepatobiliary Ultrasound", description: "Gallbladder wall, duct calibre and the sonographic Murphy sign.", duration: "50 min" },
      { name: "CT Enterography Protocols", description: "Neutral oral contrast, phase timing and dose in young patients with Crohn's.", duration: "45 min" },
    ],
    framing: "organ",
    labelSide: "right",
  },
  {
    id: "vascular",
    structure: "vascular",
    paired: false,
    label: "Vascular",
    specialty: "Vascular Ultrasound",
    symbol: "Va",
    blurb:
      "Duplex technique, waveform analysis and the stenosis criteria behind an arterial or venous report.",
    accent: "#ff6fa5",
    keywords: [
      /vascular|vein|venous|arter|aneurysm|stenosis|thrombo|\bdvt\b|varicose|carotid|aortic/i,
      /duplex|colour flow|color flow|waveform|\babi\b|ankle.?brachial|venous reflux|peripheral arterial/i,
      /embol|ischaem|ischem|claudicat|angioplast|\bstent\b/i,
    ],
    demoCourses: [
      { name: "Carotid Duplex Technique", description: "Window, angle correction and the velocity criteria for grading stenosis.", duration: "60 min" },
      { name: "Lower Limb Venous Reflux", description: "Augmentation manoeuvres, reflux timing and mapping before intervention.", duration: "50 min" },
      { name: "DVT Scanning Protocol", description: "Compression sequence from femoral to calf, and the pitfalls that cause misses.", duration: "45 min" },
      { name: "Arterial Waveform Analysis", description: "Triphasic to monophasic, and what the change localises.", duration: "40 min" },
      { name: "AAA Surveillance Measurement", description: "Reproducible calibre measurement and the thresholds that trigger referral.", duration: "35 min" },
    ],
    framing: "body",
    labelSide: "left",
  },
  {
    id: "muscular",
    structure: "muscular",
    paired: false,
    label: "Musculoskeletal",
    specialty: "MSK Imaging",
    symbol: "Ms",
    blurb:
      "Soft-tissue sonography, tendon and muscle injury grading, and the MR sequences that show oedema.",
    accent: "#7ee787",
    keywords: [
      /muscul|muscle|tendon|ligament|soft.?tissue|\bmsk\b|sports injur|rotator cuff|achilles/i,
      /(ultrasound|\bmri\b|\bmr\b)[\s\w-]*(shoulder|knee|hip|ankle|tendon|muscle|msk)/i,
      /strain|tear|tendinop|bursit|myositis|rehabilitat/i,
    ],
    demoCourses: [
      { name: "Rotator Cuff Ultrasound", description: "Dynamic assessment, anisotropy artefact and grading a partial tear.", duration: "55 min" },
      { name: "Muscle Injury Grading on MR", description: "Fluid-sensitive sequences and the grade that changes return-to-play.", duration: "45 min" },
      { name: "Achilles & Patellar Tendon Imaging", description: "Neovascularity on power Doppler and correlating it with symptoms.", duration: "40 min" },
      { name: "Soft-Tissue Mass Characterisation", description: "When the imaging features are enough and when they are not.", duration: "50 min" },
      { name: "Positioning for MSK Radiography", description: "Standard and stress views across the major joints.", duration: "35 min" },
    ],
    framing: "body",
    labelSide: "right",
  },
  {
    id: "eyes",
    structure: "eyes",
    paired: true,
    label: "Ocular",
    specialty: "Ophthalmic Imaging",
    symbol: "Oc",
    blurb:
      "B-scan ultrasound, orbital cross-sectional anatomy and the retinal imaging behind an ophthalmic report.",
    accent: "#ffd166",
    keywords: [
      /ophthalm|ocular|orbit|retina|cornea|vitreous|intraocular|\buveal\b|macula|glaucoma/i,
      /(\bb.?scan\b|\boct\b|fundus|fluorescein)[\s\w-]*(eye|retina|orbit|ocular)?|optical coherence/i,
      /detachment|foreign body in eye|papilloedema|papilledema|optic nerve/i,
    ],
    demoCourses: [
      { name: "Ocular B-Scan Ultrasound", description: "Probe technique, gain settings and distinguishing detachment from haemorrhage.", duration: "50 min" },
      { name: "Orbital Cross-Sectional Anatomy", description: "Cones, muscles and the apex, on CT and MR.", duration: "45 min" },
      { name: "OCT Interpretation Basics", description: "Retinal layers, thickness maps and common artefacts.", duration: "40 min" },
      { name: "Intraocular Foreign Body Protocol", description: "Imaging sequence, MR safety screening and reporting priorities.", duration: "35 min" },
      { name: "Fundus Photography Technique", description: "Field definitions, focus and getting a usable image through a small pupil.", duration: "30 min" },
    ],
    framing: "organ",
    labelSide: "left",
  },
  {
    id: "skeleton",
    structure: "skeleton",
    paired: false,
    label: "Skeletal",
    specialty: "Musculoskeletal Radiography",
    symbol: "Ms",
    blurb:
      "Positioning, projection geometry and the fracture patterns that a single degree of obliquity will hide.",
    accent: "#9fd8ff",
    keywords: [
      /skelet|bone|ortho|fractur|musculoskelet|\bmsk\b|joint|spine|spinal|vertebr/i,
      /radiographic positioning|projection geometry|trauma series|salter|weber/i,
      /arthr|osteo|ligament|tendon|\bx-?ray\b/i,
    ],
    demoCourses: [
      { name: "Radiographic Positioning Fundamentals", description: "Central ray, part and receptor — the three alignments that decide the film.", duration: "55 min" },
      { name: "Fracture Pattern Recognition", description: "Salter-Harris, Weber and the subtle cortical break.", duration: "60 min" },
      { name: "Spine Imaging & Alignment", description: "The three lines, and the views that confirm stability.", duration: "45 min" },
      { name: "Trauma Series Protocols", description: "Sequencing a polytrauma patient without repeating an exposure.", duration: "50 min" },
      { name: "Paediatric Skeletal Survey", description: "Technique, documentation and the non-accidental injury pathway.", duration: "40 min" },
    ],
    framing: "body",
    labelSide: "right",
  },
];

export const ORGAN_IDS = ORGANS.map((o) => o.id);
export const organById = (id: OrganId): Organ =>
  ORGANS.find((o) => o.id === id) as Organ;
/** Numeric index used as the `aOrgan` attribute in the particle shader. */
export const organIndex = (id: OrganId): number =>
  ORGANS.findIndex((o) => o.id === id);

/* ------------------------------------------------------------------ */
/* Catalog matching                                                     */
/* ------------------------------------------------------------------ */

export type MatchedCourse = CatalogCourse & {
  /** Higher is a better match. Used for ordering within an organ. */
  score: number;
  /** True when the card's title came from demoCourses rather than the catalog. */
  isDemo: boolean;
  /**
   * The course the player should actually open. For a live catalog match this
   * is the course's own id. For a sample module it is whatever the portal
   * turned out to have under that title, and failing that the fallback below —
   * so every card on the page launches something real.
   */
  playableId: string;
  /** Where playableId came from, for the badge on the card. */
  resolution: CourseResolution;
  /** Course type of whatever playableId points at. */
  playableType: CatalogCourse["courseType"];
  /** Enrollment status of whatever playableId points at. */
  playableEnrollment: string | null;
};

export type CourseResolution =
  /** The card is a live catalog course; it opens itself. */
  | "catalog"
  /** A sample title that turned out to exist in the portal by name. */
  | "named-match"
  /** Nothing matched by name, so the card opens the default course. */
  | "fallback"
  /** Not even the default is in this portal; the card stays a sample. */
  | "sample";

/**
 * Opened by any card whose title has no counterpart in the portal.
 *
 * Resolved **by name against the live catalog**, not by id. A course id
 * belongs to one portal, and this project talks to two: the id below was
 * correct for the portal the course was first uploaded to and produced
 * `Failed to get player refresh token: 403` on every sample card once the
 * course moved, because Absorb will not mint a player token for a course the
 * learner has no enrolment in. A name survives that; the id is kept only as
 * a hint for a portal that has renamed it.
 */
export const FALLBACK_COURSE_NAME = "Echocardiographic Windows";
export const FALLBACK_COURSE_ID = "05357410-0272-496e-9937-7507abed53dd";

/** The default course as this learner's catalog has it, or null. */
export function findFallbackCourse(catalog: CatalogCourse[]): CatalogCourse | null {
  return (
    findCourseByName(FALLBACK_COURSE_NAME, catalog) ??
    catalog.find((c) => c.id === FALLBACK_COURSE_ID) ??
    null
  );
}

/** Title comparison key: case, punctuation and filler words all discarded. */
function titleKey(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|and|for|of|in|to|a|an|with|on|intro|introduction)\b/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Significant tokens of a title, for the near-match pass. */
function titleTokens(name: string): Set<string> {
  return new Set(titleKey(name).split(" ").filter((t) => t.length > 2));
}

/**
 * Finds the catalog entry that goes by a given title.
 *
 * Two passes. An exact match on the normalised key is taken outright. Beyond
 * that, titles are compared by how much of their significant vocabulary they
 * share (Sørensen–Dice over the token sets), which tolerates the wording
 * drift real portals have — "Echocardiographic Windows" against "Echo-
 * cardiographic Windows & Views" — without letting two unrelated clinical
 * titles collapse onto each other. 0.7 is deliberately strict: a wrong course
 * opening is worse in a demo than a sample module opening the default.
 */
export function findCourseByName(
  name: string,
  catalog: CatalogCourse[],
  threshold = 0.7
): CatalogCourse | null {
  const key = titleKey(name);
  if (!key) return null;

  const exact = catalog.find((c) => titleKey(c.name) === key);
  if (exact) return exact;

  const want = titleTokens(name);
  if (want.size === 0) return null;

  let best: CatalogCourse | null = null;
  let bestScore = threshold;
  for (const c of catalog) {
    const have = titleTokens(c.name);
    if (have.size === 0) continue;
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const dice = (2 * shared) / (want.size + have.size);
    // Curricula edge out plain courses on an otherwise equal title.
    const score = dice + (c.courseType === "Curriculum" ? 0.01 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * Scores one course against one organ.
 *
 * A name hit is worth more than a description hit, and an earlier (stronger)
 * keyword group is worth more than a later one — so a course called "Cardiac
 * CT" lands on the heart rather than being tugged toward whatever else
 * mentions CT.
 */
function scoreCourse(course: CatalogCourse, organ: Organ): number {
  const name = course.name ?? "";
  const description = course.description ?? "";
  let score = 0;

  organ.keywords.forEach((re, tier) => {
    const tierWeight = organ.keywords.length - tier; // 3, 2, 1
    if (re.test(name)) score += 10 * tierWeight;
    if (re.test(description)) score += 3 * tierWeight;
  });

  // Curricula are the natural shape of a learning path, so nudge them up.
  if (score > 0 && course.courseType === "Curriculum") score += 6;
  return score;
}

/**
 * Assigns every catalog course to its single best-matching organ.
 *
 * Exclusive assignment matters: without it a course called "Cardiothoracic
 * Imaging" shows up under both Heart and Lungs, and the demo looks like it is
 * padding. Each course goes where it scores highest; ties break toward the
 * organ declared first.
 *
 * Organs left with nothing fall back to their demo courses so the UI never
 * presents an empty learning path.
 */
export function matchCatalogToOrgans(
  courses: CatalogCourse[],
  options: { minScore?: number; maxPerOrgan?: number; minPerOrgan?: number } = {}
): Record<OrganId, MatchedCourse[]> {
  const { minScore = 10, maxPerOrgan = 14, minPerOrgan = 5 } = options;

  const result = {} as Record<OrganId, MatchedCourse[]>;
  for (const organ of ORGANS) result[organ.id] = [];

  for (const course of courses) {
    let bestOrgan: Organ | null = null;
    let bestScore = 0;

    for (const organ of ORGANS) {
      const score = scoreCourse(course, organ);
      if (score > bestScore) {
        bestScore = score;
        bestOrgan = organ;
      }
    }

    if (bestOrgan && bestScore >= minScore) {
      result[bestOrgan.id].push({
        ...course,
        score: bestScore,
        isDemo: false,
        playableId: course.id,
        resolution: "catalog",
        playableType: course.courseType,
        playableEnrollment: course.enrollmentStatus,
      });
    }
  }

  // The default course as this portal has it. Looked up by name, so it keeps
  // working when the course is re-uploaded and its id changes.
  const fallback = findFallbackCourse(courses);

  for (const organ of ORGANS) {
    const matched = result[organ.id];
    matched.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    result[organ.id] = matched.slice(0, maxPerOrgan);

    // Top up to a presentable path.
    //
    // This used to fire only when a discipline matched nothing at all, which
    // meant one live course suppressed it entirely — Myocardium matched the
    // single real Echocardiographic Windows course and showed one card while
    // every other discipline showed five. A learning path of one module does
    // not read as a learning path.
    if (result[organ.id].length < minPerOrgan) {
      // Deduplicate on title: the heart's sample list contains the very
      // course the portal now carries, and showing both would be absurd.
      const present = new Set(result[organ.id].map((c) => titleKey(c.name)));
      const topUp = organ.demoCourses
        .filter((d) => !present.has(titleKey(d.name)))
        .slice(0, minPerOrgan - result[organ.id].length)
        .map((d, i) => {
          // A sample title may exist in the portal under the same name — look
          // across the whole catalog, not just this discipline's matches,
          // since the keyword pass is what failed us here.
          const live = findCourseByName(d.name, courses);
          const target = live ?? fallback;
          return {
            id: `demo:${organ.id}:${i}`,
            name: d.name,
            description: `${d.description} · ${d.duration}`,
            imageUrl: live?.imageUrl ?? "",
            enrollmentStatus: live?.enrollmentStatus ?? null,
            courseType: "OnlineCourse" as const,
            score: 0,
            isDemo: true,
            // No target means not even the default is in this portal. The
            // card stays a sample module rather than launching a course id
            // that will 403 — a dead card is better than an error screen.
            playableId: target?.id ?? `demo:${organ.id}:${i}`,
            resolution: live
              ? ("named-match" as const)
              : target
                ? ("fallback" as const)
                : ("sample" as const),
            playableType: target?.courseType ?? ("OnlineCourse" as const),
            playableEnrollment: target?.enrollmentStatus ?? null,
          };
        });
      result[organ.id] = [...result[organ.id], ...topUp];
    }
  }

  return result;
}

/** True for the placeholder ids produced above — these have no real player. */
export const isDemoCourseId = (id: string) => id.startsWith("demo:");

/**
 * Two-letter symbol for a periodic-table tile. Prefers the initials of the
 * first two significant words, falling back to the first two letters.
 */
export function courseSymbol(name: string): string {
  const words = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(the|and|for|of|in|to|a|an|with|on)$/i.test(w));
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const flat = name.replace(/[^A-Za-z]/g, "");
  return (flat.slice(0, 2) || "??").replace(/^./, (c) => c.toUpperCase());
}
