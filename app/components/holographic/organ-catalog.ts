/**
 * app/components/holographic/organ-catalog.ts
 *
 * Organ metadata plus the catalog-matching logic that decides which real
 * Absorb courses belong to which organ.
 *
 * Pure data + string matching, no THREE and no DOM, so the route, the engine
 * and any test can all share it.
 */

export type OrganId =
  | "brain"
  | "heart"
  | "lungs"
  | "liver"
  | "kidneys"
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
    ],
    framing: "organ",
    labelSide: "right",
  },
  {
    id: "kidneys",
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
    ],
    framing: "organ",
    labelSide: "left",
  },
  {
    id: "skeleton",
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
  /** True when this came from the organ's demoCourses, not the live catalog. */
  isDemo: boolean;
};

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
  options: { minScore?: number; maxPerOrgan?: number } = {}
): Record<OrganId, MatchedCourse[]> {
  const { minScore = 10, maxPerOrgan = 14 } = options;

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
      result[bestOrgan.id].push({ ...course, score: bestScore, isDemo: false });
    }
  }

  for (const organ of ORGANS) {
    const matched = result[organ.id];
    matched.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    result[organ.id] = matched.slice(0, maxPerOrgan);

    if (result[organ.id].length === 0) {
      result[organ.id] = organ.demoCourses.map((d, i) => ({
        id: `demo:${organ.id}:${i}`,
        name: d.name,
        description: `${d.description} · ${d.duration}`,
        imageUrl: "",
        courseType: "OnlineCourse" as const,
        enrollmentStatus: i === 0 ? "In Progress" : null,
        score: 0,
        isDemo: true,
      }));
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
