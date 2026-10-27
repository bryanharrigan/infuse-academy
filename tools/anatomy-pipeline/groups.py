"""
Which BodyParts3D leaf meshes make up each structure the page displays.

BodyParts3D's part_of set decomposes the body into leaves, so there is no
single "heart" or "lung" mesh to pick up — a structure here is a list of
leaves, selected by matching the English name in each OBJ header.

Matching is on whole words. Substring matching looks fine until "tributary"
turns up under rib and the liver's venous tree lands in the skeleton.
"""
import re

def W(*words):
    """Whole-word alternation, case-insensitive."""
    return re.compile(r"\b(" + "|".join(words) + r")\b", re.I)

# Anything matching these is vasculature, wherever else it might match.
VESSEL = W("artery", "arteries", "vein", "veins", "arteriole", "venule",
           "tributary", "branch", "trunk", "aorta", "arch of aorta")
BILIARY = W("biliary", "bile", "cystic duct", "hepatic duct")

# Deliberately not displayed: the reproductive organs and body hair that the
# dataset also carries. The page is shown to prospects in a sales setting.
EXCLUDE = W("prostate", "testis", "testes", "penis", "scrotum", "vagina",
            "uterus", "ovary", "vulva", "pubic hair", "clitoris", "labium",
            "epididymis", "seminal vesicle", "vas deferens", "ductus deferens",
            "nipple", "areola", "mammary", "breast")

GROUPS = [
    # ---- the body shell -------------------------------------------------
    dict(id="skin", label="Body", match=W("skin"), tris=26000,
         note="The outer surface. This is what makes the figure read as a person.",
         # EXCLUDE removes the reproductive organs, but the skin is one closed
         # mesh and carries the external anatomy with it, so it comes out
         # geometrically instead: resurface_region then smooth_region in
         # build.py. Both regions stay well inside the thighs and lower
         # abdomen so the edges sit on surface that should not move.
         smooth=dict(
             # Project the front of the pelvis onto the body-wall contour,
             # measured off-midline where no genital anatomy exists.
             resurface=dict(half_width=0.060, feather_x=0.032,
                            y_lo=-0.270, y_hi=-0.095, feather_y=0.030,
                            z_top=0.170, z_bot=0.082,
                            z_floor=0.090, feather_z=0.030),
             # Then relax the seam. Smaller and gentler than the pass it
             # replaces: the shape is already right, this only rounds it.
             centre=[0.0, -0.185, 0.105],
             radii=[0.100, 0.120, 0.120],
             iterations=55, rate=0.6)),

    # ---- skeleton -------------------------------------------------------
    dict(id="skeleton", label="Skeleton", tris=34000,
         match=W("bone", "vertebra", "rib", "phalanx", "metacarpal", "metatarsal",
                 "clavicle", "scapula", "femur", "tibia", "fibula", "humerus",
                 "radius", "ulna", "sternum", "sacrum", "patella", "coccyx",
                 "mandible", "maxilla", "skull", "hyoid", "talus", "calcaneus",
                 "cuboid", "navicular", "cuneiform", "capitate", "hamate",
                 "lunate", "pisiform", "scaphoid", "trapezium", "trapezoid",
                 "triquetral", "ilium", "ischium", "pubis", "costal cartilage",
                 "intervertebral disk", "manubrium", "xiphoid", "sesamoid",
                 "atlas", "axis", "ethmoid", "vomer", "palatine",
                 "nasal cartilage", "nasal concha", "alar cartilage",
                 "thyroid cartilage", "cricoid", "arytenoid", "epiglottis"),
         reject=VESSEL),

    # ---- heart ----------------------------------------------------------
    dict(id="heart", label="Heart", tris=16000,
         match=W("ventricle", "atrium", "valve", "cusp", "leaflet",
                 "papillary", "auricle", "chordae", "myocardium",
                 "interventricular septum", "interatrial septum"),
         # "Lateral ventricle" and friends belong to the brain.
         reject=W("lateral ventricle", "third ventricle", "fourth ventricle",
                  "cerebral", "brain", "artery", "vein"),
         extra=W("ascending aorta", "aortic arch", "arch of aorta",
                 "pulmonary trunk", "superior vena cava", "inferior vena cava",
                 "coronary"),
         # The root and arch make the organ legible; the caval run to the
         # pelvis is a pipe hanging off the bottom of it.
         clipRadius=80.0),

    # ---- lungs ----------------------------------------------------------
    # The part_of set has no parenchyma, only the trees that fill it, so the
    # lung surface is reconstructed from them (see hull= below).
    dict(id="lungs", label="Lungs", tris=22000,
         match=W("bronchial tree", "bronchus", "bronchi", "trachea", "carina"),
         extra=W("pulmonary artery", "pulmonary vein", "segmental artery",
                 "segmental vein", "lingular", "basal segmental"),
         reject=W("hepatic", "liver", "portal", "renal", "splenic", "mesenteric",
                  "gastric", "colic", "iliac", "femoral", "carotid", "cerebral",
                  "subclavian", "brachial", "radial", "ulnar", "tibial"),
         # Segment names are reused between lung and liver; the thorax floor
         # is a cheaper discriminator than trying to enumerate the exceptions.
         zmin=1100.0,
         hull=dict(pad=10.0, smooth=13.0, iso=0.22, split_lr=True,
                   grid=112, tris=20000)),

    # ---- brain ----------------------------------------------------------
    dict(id="brain", label="Brain", tris=24000,
         match=W("gyrus", "cerebellum", "cerebral", "cortex", "thalamus",
                 "hypothalamus", "pituitary", "pons", "midbrain",
                 "medulla oblongata", "occipital lobe", "insula", "amygdala",
                 "hippocampus", "caudate nucleus", "putamen", "pallidum",
                 "corpus callosum", "fornix", "lateral ventricle",
                 "internal capsule", "inferior colliculus",
                 "superior colliculus", "tuber cinereum", "habenula",
                 "pineal body", "parietal lobule", "claustrum",
                 "third ventricle", "fourth ventricle", "olfactory",
                 "optic chiasm", "spinal cord"),
         reject=VESSEL),

    # ---- liver ----------------------------------------------------------
    # Couinaud segments II-VIII plus the caudate lobe are the whole organ,
    # so unlike the lungs the liver needs no reconstruction.
    dict(id="liver", label="Liver", tris=16000,
         match=W("liver", "caudate lobe", "quadrate lobe", "hepatovenous segment"),
         extra=re.compile(r"\b(hepatic|portal)\b", re.I),
         reject=W("pulmonary", "renal", "cerebral")),

    # ---- kidneys & urinary ----------------------------------------------
    dict(id="kidneys", label="Renal", tris=12000,
         match=W("kidney", "ureter", "adrenal gland", "suprarenal gland",
                 "urinary bladder", "urethra", "renal pelvis"),
         extra=W("renal artery", "renal vein")),

    # ---- digestive ------------------------------------------------------
    dict(id="digestive", label="Digestive", tris=26000,
         match=W("stomach", "esophagus", "oesophagus", "duodenum", "jejunum",
                 "ileum", "cecum", "caecum", "colon", "rectum", "appendix",
                 "pancreas", "gallbladder", "mesentery", "mesocolon",
                 "mesoappendix", "spleen", "anal canal", "pancreatic duct",
                 "submandibular gland", "parotid gland", "sublingual gland",
                 "tongue", "gingiva", "soft palate", "uvula",
                 "cystic duct", "ileocecal junction", "taenia"),
         reject=VESSEL),

    # ---- musculature ----------------------------------------------------
    dict(id="muscular", label="Muscular", tris=24000,
         match=W("muscle", "musculus", "psoas", "iliacus", "piriformis",
                 "obturator internus", "obturator externus", "pectoralis",
                 "rectus abdominis", "external oblique", "internal oblique",
                 "transversus abdominis", "latissimus dorsi", "trapezius",
                 "deltoid", "biceps", "triceps", "sartorius", "gracilis",
                 "adductor", "gluteus", "quadratus", "erector spinae",
                 "iliotibial tract", "sphincter", "diaphragm", "levator ani",
                 "coccygeus", "tendon", "aponeurosis", "serratus anterior",
                 "subclavius", "transversus thoracis", "anconeus",
                 "levator scapulae", "rhomboid major", "rhomboid minor",
                 "brachialis", "coracobrachialis", "levator veli palatini",
                 "tensor veli palatini", "retinaculum", "supraspinatus",
                 "infraspinatus", "teres major", "teres minor",
                 "subscapularis", "soleus", "gastrocnemius", "tibialis",
                 "peroneus", "fibularis", "semitendinosus",
                 "semimembranosus", "pectineus", "vastus", "rectus femoris"),
         reject=W("papillary", "artery", "vein", "branch")),

    # ---- eyes -----------------------------------------------------------
    dict(id="eyes", label="Ocular", tris=9000,
         match=W("eyeball", "sclera", "cornea", "iris", "lens", "choroid",
                 "vitreous body", "retina", "pupil", "ciliary",
                 "anterior chamber", "posterior chamber", "optic nerve",
                 "lacrimal gland", "lacrimal sac", "lacrimal canaliculus",
                 "lacrimal lake", "nasolacrimal duct", "superior rectus",
                 "inferior rectus", "medial rectus", "lateral rectus",
                 "superior oblique", "inferior oblique",
                 "levator palpebrae superioris", "eyelid", "conjunctiva")),

    # ---- systemic vasculature ------------------------------------------
    dict(id="vascular", label="Vascular", tris=30000,
         match=VESSEL,
         reject=W("pulmonary", "bronchial", "hepatic", "portal", "biliary")),
]


# ---------------------------------------------------------------------------
# Per-triangle region tags.
#
# Only the heart needs them: the cardiac animation contracts the ventricles
# against a nearly static atrial roof, and the renderer cannot tell the two
# apart from geometry. First matching rule wins, so order is significant —
# "Anterior papillary muscle of right ventricle" has to reach the ventricle
# rule before anything else claims it.
# ---------------------------------------------------------------------------
VENTRICLE, ATRIUM, VESSEL_R, CORONARY = 0, 1, 2, 3

REGION_RULES = {
    "heart": [
        (W("coronary"), CORONARY),
        (W("aorta", "aortic arch", "pulmonary trunk", "vena cava"), VESSEL_R),
        (W("atrium", "auricle"), ATRIUM),
        (W("ventricle", "papillary", "interventricular septum",
            "valve", "cusp", "leaflet", "chordae"), VENTRICLE),
    ],
}
