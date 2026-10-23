/**
 * scorm/echocardiographic-windows/src/content.ts
 *
 * All instructional copy and assessment items for the module, kept separate
 * from the controller so the clinical content can be reviewed and edited
 * without reading any application code.
 */

import type { ViewId } from "./heart-engine";

export type Section = {
  id: string;
  nav: string;
  title: string;
  /** Which echo window the heart shows while this section is open. */
  view: ViewId;
  /** Lead paragraph. */
  lead: string;
  /** Body blocks: prose, a labelled list, or a callout. */
  blocks: Block[];
};

export type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "defs"; items: { term: string; text: string }[] }
  | { kind: "note"; title: string; text: string }
  | { kind: "pitfall"; title: string; text: string };

export const SECTIONS: Section[] = [
  {
    id: "orientation",
    nav: "Before you scan",
    title: "Orientation and the probe marker",
    view: "free",
    lead:
      "Every echocardiographic window is defined by three things: where the transducer sits on the chest, which way its orientation marker points, and how the beam is angled through the heart. Get those right and the view appears; get one wrong and you spend the study hunting.",
    blocks: [
      {
        kind: "p",
        text:
          "The heart does not sit squarely in the chest. Its long axis runs from the base, high and to the patient's right, down to the apex, low and to the left and forward. None of the standard views align with the body's sagittal, coronal or axial planes — they are all oblique, which is why echocardiographic anatomy has to be learned on its own terms rather than borrowed from CT.",
      },
      {
        kind: "defs",
        items: [
          {
            term: "Transducer position",
            text:
              "The acoustic window — a gap between ribs or below them where sound can reach the heart without crossing aerated lung or bone.",
          },
          {
            term: "Orientation marker",
            text:
              "The ridge or dot on the probe. By convention it corresponds to the right of the displayed image, so rotating the probe rotates the image in a predictable direction.",
          },
          {
            term: "Angulation and rotation",
            text:
              "Small movements. A few degrees of tilt changes which structures the plane cuts; a 90-degree rotation converts a long-axis view into a short-axis one from the same window.",
          },
        ],
      },
      {
        kind: "note",
        title: "Use the model",
        text:
          "The heart beside this text is live. Drag to rotate it, scroll to zoom. As you move through the sections, the ultrasound sector shows the plane that window actually cuts, and the structures it passes through brighten.",
      },
    ],
  },

  {
    id: "cycle",
    nav: "The cardiac cycle",
    title: "What you are watching move",
    view: "free",
    lead:
      "Before reading views, it helps to be clear about what is contracting and when. Everything you assess on echo — wall motion, valve timing, filling — is read against this sequence.",
    blocks: [
      {
        kind: "p",
        text:
          "Atrial systole tops up ventricular filling and ends before the ventricles contract. Ventricular systole follows: an isovolumetric phase where pressure climbs with every valve shut, then ejection. Relaxation is also isovolumetric at first, then the mitral and tricuspid valves open and the ventricles fill rapidly, slowing into diastasis until the next atrial contraction.",
      },
      {
        kind: "p",
        text:
          "Watch the model and you will see the ventricles do three things at once: the walls thicken inward, the base descends toward the apex, and the whole mass wrings. That twist — the apex and base rotating in opposite directions — is a large part of how the ventricle ejects, and losing it is an early sign of dysfunction.",
      },
      {
        kind: "note",
        title: "Rate changes diastole, not systole",
        text:
          "Push the rate up with the control under the model. Systole barely shortens; diastole collapses. That is why a tachycardic patient fills poorly, and why rate control can improve output in a stiff ventricle.",
      },
    ],
  },

  {
    id: "plax",
    nav: "Parasternal long axis",
    title: "Parasternal long axis (PLAX)",
    view: "plax",
    lead:
      "Usually the first view of a study, and the one that orients everything after it. The plane runs along the long axis of the left ventricle, from the aortic root down to the apex.",
    blocks: [
      {
        kind: "defs",
        items: [
          {
            term: "Position",
            text:
              "Left parasternal, third or fourth intercostal space, immediately left of the sternum. Patient in the left lateral decubitus position.",
          },
          {
            term: "Marker",
            text: "Toward the patient's right shoulder, roughly the 10 o'clock position.",
          },
        ],
      },
      { kind: "h", text: "What the plane cuts" },
      {
        kind: "list",
        items: [
          "Right ventricle, anteriorly and nearest the probe",
          "Interventricular septum, then the left ventricular cavity",
          "Posterior (inferolateral) wall",
          "Mitral valve, with both leaflets in profile",
          "Left atrium, posterior to the mitral valve",
          "Aortic valve and aortic root, continuous with the septum",
          "Descending thoracic aorta in cross-section, behind the left atrium",
        ],
      },
      { kind: "h", text: "What it is for" },
      {
        kind: "p",
        text:
          "Linear measurements of chamber and wall dimensions, aortic root size, and a first assessment of mitral and aortic valve morphology. The descending aorta is a useful landmark for distinguishing a pericardial from a pleural effusion: pericardial fluid tracks anterior to it, pleural fluid passes behind.",
      },
      {
        kind: "pitfall",
        title: "Off-axis measurement",
        text:
          "If the plane is not through the true long axis you will cut the ventricle obliquely and overestimate its diameter. Aim for the largest cavity with the aortic and mitral valves both clearly in plane before you measure.",
      },
    ],
  },

  {
    id: "psax",
    nav: "Parasternal short axis",
    title: "Parasternal short axis (PSAX)",
    view: "psax",
    lead:
      "From the PLAX position, rotate the probe roughly 90 degrees clockwise so the marker points to the patient's left shoulder. The same window now cuts the ventricle in cross-section.",
    blocks: [
      {
        kind: "p",
        text:
          "Short axis is a family of views rather than one. Sweeping the beam from the base toward the apex steps through distinct levels, each answering a different question.",
      },
      {
        kind: "defs",
        items: [
          {
            term: "Aortic valve level",
            text:
              "The three cusps close in the shape that gives the classic Mercedes sign. Around it: right ventricular outflow tract, pulmonary valve, tricuspid valve, and both atria.",
          },
          {
            term: "Mitral valve level",
            text:
              "The leaflets open and close in a fish-mouth. Good for assessing leaflet excursion and for planimetry of the mitral orifice.",
          },
          {
            term: "Papillary muscle level",
            text:
              "The standard level for regional wall motion. The ring of myocardium divides into segments that map onto coronary territories.",
          },
          {
            term: "Apical level",
            text: "A small cavity; useful for apical thrombus and apical hypertrophy.",
          },
        ],
      },
      {
        kind: "p",
        text:
          "At the papillary level the left ventricle should be circular. A D-shaped septum flattened toward the left ventricle indicates right ventricular pressure or volume overload — flattening in systole suggests pressure, in diastole suggests volume.",
      },
      {
        kind: "pitfall",
        title: "Oblique cuts masquerading as dilatation",
        text:
          "A plane angled off true short axis produces an oval cavity that can be read as a dilated or regionally abnormal ventricle. Confirm the cavity is round before judging wall motion.",
      },
    ],
  },

  {
    id: "apical",
    nav: "Apical views",
    title: "Apical four- and five-chamber",
    view: "a4c",
    lead:
      "The apical window looks up the long axis of the heart from below, putting all four chambers in a single plane. It is where most functional and Doppler assessment happens, because the beam runs parallel to flow.",
    blocks: [
      {
        kind: "defs",
        items: [
          {
            term: "Position",
            text:
              "Over the apex beat, usually fifth intercostal space in the midclavicular line, with the patient in left lateral decubitus. The probe points up toward the right shoulder.",
          },
          { term: "Marker", text: "Toward the patient's left, roughly 3 o'clock." },
        ],
      },
      { kind: "h", text: "Four-chamber" },
      {
        kind: "list",
        items: [
          "Both ventricles side by side, so chamber sizes can be compared directly",
          "Both atria, and the interatrial septum",
          "Mitral and tricuspid valves, with the tricuspid annulus slightly more apical",
          "Biventricular function, including TAPSE for the right ventricle",
          "Doppler of mitral and tricuspid inflow, and regurgitant jets",
        ],
      },
      { kind: "h", text: "Five-chamber" },
      {
        kind: "p",
        text:
          "Tilting the beam anteriorly from the four-chamber view brings the left ventricular outflow tract and aortic valve into plane — the so-called fifth chamber. This is the view for outflow tract velocity, stroke volume by velocity-time integral, and aortic gradients, because the beam now lines up with outflow.",
      },
      {
        kind: "pitfall",
        title: "Foreshortening",
        text:
          "The commonest apical error. Sitting too high on the chest cuts across the ventricle rather than through its true apex, producing a short, rounded cavity. Volumes are underestimated and ejection fraction is flattered. Move down and laterally an interspace until the ventricle is at its longest.",
      },
    ],
  },

  {
    id: "subcostal",
    nav: "Subcostal",
    title: "Subcostal",
    view: "subcostal",
    lead:
      "The rescue window. When the chest is unavailable — hyperinflated lungs, positive pressure ventilation, chest wall injury, a patient who cannot roll — the heart can often still be reached from below the ribs, using the liver as an acoustic window.",
    blocks: [
      {
        kind: "defs",
        items: [
          {
            term: "Position",
            text:
              "Just below the xiphoid process, probe held almost flat against the abdomen and angled up toward the left shoulder. Patient supine with knees flexed to relax the abdominal wall.",
          },
          { term: "Marker", text: "Toward the patient's left, roughly 3 o'clock." },
        ],
      },
      {
        kind: "list",
        items: [
          "All four chambers, from a different angle to the apical view",
          "The best view of the interatrial septum, because the beam crosses it perpendicularly",
          "Pericardium along the inferior and free wall of the right ventricle",
          "Inferior vena cava in long axis, by rotating toward the sagittal plane",
        ],
      },
      {
        kind: "p",
        text:
          "This is the first view in a cardiac arrest or trauma assessment. It needs no patient repositioning, keeps the operator clear of the chest during compressions and defibrillation, and answers the two questions that matter immediately: is there a pericardial effusion, and is the heart contracting.",
      },
      {
        kind: "note",
        title: "Volume status",
        text:
          "From the subcostal position, rotating to image the inferior vena cava in long axis allows assessment of its diameter and respiratory variation — a quick, if imperfect, guide to filling.",
      },
    ],
  },

  {
    id: "recovery",
    nav: "Recovering a poor window",
    title: "When the window is poor",
    view: "free",
    lead:
      "A difficult study is usually a positioning problem, not a patient problem. Work through these in order before concluding the heart cannot be imaged.",
    blocks: [
      { kind: "h", text: "Move the patient first" },
      {
        kind: "list",
        items: [
          "Left lateral decubitus brings the heart against the chest wall and displaces lung out of the way. This single change rescues more parasternal and apical studies than anything else.",
          "Left arm above the head widens the intercostal spaces.",
          "For subcostal, supine with knees flexed relaxes the abdominal wall.",
        ],
      },
      { kind: "h", text: "Use the respiratory cycle" },
      {
        kind: "list",
        items: [
          "Hold at end-expiration for parasternal and apical views — less aerated lung between probe and heart.",
          "Hold at inspiration for subcostal — the diaphragm descends and brings the heart toward the probe.",
        ],
      },
      { kind: "h", text: "Then move the probe" },
      {
        kind: "list",
        items: [
          "Try one intercostal space up and one down before abandoning a window. The usable space is often adjacent to the one you started in.",
          "Slide rather than tilt: small translations along the chest wall find the gap between ribs.",
          "Plenty of coupling gel, and enough pressure to maintain contact without deforming the chest wall.",
        ],
      },
      { kind: "h", text: "Then the machine" },
      {
        kind: "list",
        items: [
          "Lower the transmit frequency for penetration in a larger patient, accepting the loss of resolution.",
          "Turn on tissue harmonic imaging — it usually improves endocardial definition.",
          "Set depth so the heart fills the sector, place the focus at the depth of interest, and adjust overall and time-gain compensation before concluding an image is unobtainable.",
        ],
      },
      {
        kind: "note",
        title: "Know when to switch window",
        text:
          "In hyperinflated lungs — COPD, asthma, positive pressure ventilation — the parasternal and apical windows may genuinely be unobtainable however carefully you position. Go subcostal early rather than spending the study on a window that physics has closed.",
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Knowledge check                                                      */
/* ------------------------------------------------------------------ */

export type Question = {
  id: string;
  stem: string;
  options: string[];
  /** Index into options. */
  answer: number;
  explanation: string;
};

export const MASTERY = 80;

export const QUESTIONS: Question[] = [
  {
    id: "q1",
    stem: "Which transducer position and marker orientation produces a parasternal long-axis view?",
    options: [
      "Third or fourth left intercostal space beside the sternum, marker toward the right shoulder",
      "Fifth left intercostal space in the midclavicular line, marker toward the left hip",
      "Below the xiphoid, marker toward the patient's left",
      "Second right intercostal space, marker toward the left shoulder",
    ],
    answer: 0,
    explanation:
      "The parasternal window sits in the third or fourth left intercostal space immediately beside the sternum, with the marker toward the right shoulder so the plane follows the long axis of the left ventricle. The fifth space in the midclavicular line is the apical window, and below the xiphoid is subcostal.",
  },
  {
    id: "q2",
    stem: "A patient is mechanically ventilated with hyperinflated lungs. The parasternal and apical windows are both unobtainable despite careful positioning. Which window is most likely to succeed?",
    options: ["Suprasternal", "Right parasternal", "Subcostal", "Repeat apical at higher gain"],
    answer: 2,
    explanation:
      "Subcostal imaging uses the liver as an acoustic window and approaches the heart from below the ribcage, so it is largely unaffected by hyperinflated lung. It is the standard fallback in COPD, asthma and positive pressure ventilation, and the first view in arrest.",
  },
  {
    id: "q3",
    stem: "Foreshortening of the apical four-chamber view most directly causes which error?",
    options: [
      "Overestimation of left ventricular volumes and underestimation of ejection fraction",
      "Underestimation of left ventricular volumes and overestimation of ejection fraction",
      "Apparent dilatation of the right ventricle",
      "Spurious mitral regurgitation on colour Doppler",
    ],
    answer: 1,
    explanation:
      "Sitting too high cuts across the ventricle instead of through its true apex. The cavity appears shorter, so measured volumes are too small; because the error affects end-systolic volume proportionally more, ejection fraction is flattered. Moving down and laterally an interspace until the ventricle is at its longest corrects it.",
  },
  {
    id: "q4",
    stem: "At the papillary muscle level on parasternal short axis, the interventricular septum appears flattened so the left ventricle is D-shaped. Flattening that is most pronounced in systole suggests:",
    options: [
      "Right ventricular volume overload",
      "Right ventricular pressure overload",
      "Left ventricular systolic failure",
      "Constrictive pericarditis",
    ],
    answer: 1,
    explanation:
      "Septal flattening reflects the pressure difference across the septum. Pressure overload of the right ventricle flattens the septum throughout systole, whereas volume overload flattens it predominantly in diastole when the right ventricle is filling.",
  },
  {
    id: "q5",
    stem: "Which single manoeuvre most reliably improves a poor parasternal window?",
    options: [
      "Increasing overall gain",
      "Raising the transmit frequency",
      "Turning the patient into the left lateral decubitus position and imaging at end-expiration",
      "Increasing depth so more of the chest is displayed",
    ],
    answer: 2,
    explanation:
      "Left lateral decubitus brings the heart against the chest wall and moves aerated lung out of the beam; holding at end-expiration removes more lung still. Gain and depth change how the image is displayed, not how much sound reaches the heart, and raising frequency reduces penetration.",
  },
];
