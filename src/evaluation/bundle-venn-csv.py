"""Mirror the venn computations of rq1-venn4.py / rq2-venn.py and emit
figures-bundle/{rq1-venn4,rq2-venn}.csv region-count tables."""
import csv, json, os
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[2]
GT = ROOT / "src/ground/ground-truth.csv"
DEBUN_SUM = ROOT / "src/data/threshold-sweep/t84/summary.csv"
DBUN_JSON = ROOT / "src/data/other-tool/dbundlr_results_debun.json"
ALE_JSON = ROOT / "src/data/other-tool/aletheia_results_debun.json"
CDN_LIBS = ROOT / "src/data/fingerprint-cache/cdn-alllibs.json"
WEBHASH_DIR = ROOT / "src/data/allWebHashes"
BUNDLE = ROOT / "figures-bundle"
# Not in the repository, so creating it is this script's job — opening the CSVs for writing
# in a directory that does not exist fails for every reviewer.
BUNDLE.mkdir(parents=True, exist_ok=True)
DBUNDLR_MIN = float(os.environ.get("DBUNDLR_MIN", "0.6"))

ALIAS = {
    "react-dom": "react", "angularjs": "angular.js", "backbone": "backbone.js",
    "handlebars": "handlebars.js", "hammerjs": "hammer.js", "ifvisible.js": "ifvisible",
    "jquery-ui": "jqueryui", "jquery.ui": "jqueryui", "lodash": "lodash.js",
    "moment": "moment.js", "requirejs": "require.js", "underscore": "underscore.js",
    # npm names only D-Bundlr uses; the universe and the ground truth spell these
    # `three.js` and `jquery.isotope`. Without them those detections fall outside the
    # universe and are counted as neither TP nor FP — which is why this Venn showed 99
    # D-Bundlr instances against Table 5's 100. compare-detectors.ts carries both.
    "three": "three.js", "isotope-layout": "jquery.isotope",
}
def canon(s): return ALIAS.get(s, s)

def parts(v):
    out=[]
    for x in v.split('.')[:3]:
        try: out.append(int(x))
        except: out.append(None)
    while len(out)<3: out.append(None)
    return out
def patch_match(g, det):
    if not g or not det: return False
    gp=parts(g); return any(parts(v)==gp for v in det)

eval_sites = {f.replace(".json","") for f in os.listdir(WEBHASH_DIR)
              if f.endswith(".json") and "-cnt" not in f and "-cfg" not in f}

cdn = json.loads(CDN_LIBS.read_text())
lib_versions = {}
for k, info in cdn.items():
    lib_versions.setdefault(k.split("____")[0].lower(), set()).update(info.get("versions") or [])
def expand_prefix(lib, ver):
    if not ver: return set()
    lp=parts(ver); out=set()
    for v in lib_versions.get(lib, set()):
        a,b,c=parts(v)
        if lp[0] is not None and lp[0]!=a: continue
        if lp[1] is not None and lp[1]!=b: continue
        if lp[2] is not None and lp[2]!=c: continue
        out.add(v)
    return out

gt_by_site, ldc_by_site, pt_by_site, ldc_ver_by_site = {}, {}, {}, {}
with GT.open() as fh:
    for r in csv.DictReader(fh):
        site = (r.get("url") or "").strip()
        if not site or site not in eval_sites: continue
        gt_by_site[site] = {}
        ldc_by_site[site] = set()
        pt_by_site[site] = set()
        ldc_ver_by_site[site] = {}
        for tok in (r.get("ground truth") or "").split(","):
            tok = tok.strip()
            if not tok: continue
            at = tok.find("@")
            lib = canon((tok if at < 0 else tok[:at]).strip().lower())
            v = tok[at+1:].strip() if at >= 0 else ""
            if lib: gt_by_site[site][lib] = v
        for tok in (r.get("ldc") or "").split(","):
            tok = tok.strip()
            if not tok: continue
            at = tok.find("@")
            ldc_by_site[site].add(canon((tok if at < 0 else tok[:at]).strip().lower()))
        for tok in (r.get("ptdetector") or "").split(","):
            tok = tok.strip()
            if not tok: continue
            at = tok.find("@")
            pt_by_site[site].add(canon((tok if at < 0 else tok[:at]).strip().lower()))
        for tok in (r.get("ldc_version") or "").split(","):
            tok = tok.strip()
            if not tok: continue
            at = tok.find("@")
            lib = canon((tok if at < 0 else tok[:at]).strip().lower())
            v = tok[at+1:].strip() if at >= 0 else ""
            if lib: ldc_ver_by_site[site][lib] = v

# DEBUN: lib set and strictVersions per (site, lib)
debun_by_site = {}
debun_ver_by_site = {}
with DEBUN_SUM.open() as fh:
    for r in csv.DictReader(fh):
        if r.get("detected") != "true": continue
        site = r["site"]
        lib = canon(r["lib"].lower())
        debun_by_site.setdefault(site, set()).add(lib)
        sv = {s.strip() for s in (r.get("strictVersions") or "").split(";") if s.strip()}
        debun_ver_by_site.setdefault(site, {})[lib] = sv

# dbundler (rq1-venn4.py logic)
db_by_site = {}
_raw = json.loads(DBUN_JSON.read_text())
records = _raw["result"] if isinstance(_raw, dict) else _raw
for r in records:
    urls = r.get("urls") or []
    if not urls: continue
    site = urls[0].strip()
    s = db_by_site.setdefault(site, set())
    for det in r.get("detections", []):
        entries = det.get("dbundlr", []) or []
        if not entries: continue
        mc = max((e.get("confidence", 0) for e in entries), default=0)
        if mc <= DBUNDLR_MIN: continue
        for e in entries:
            if e.get("confidence", 0) != mc: continue
            lib = canon((e.get("function", {}).get("packageName") or "").lower())
            if lib: s.add(lib)

# aletheia (rq2-venn.py logic — dict shape)
ale_ver = {}
for r in json.loads(ALE_JSON.read_text()):
    urls = r.get("urls") or []
    if not urls: continue
    site = urls[0].strip()
    for libRaw, vmap in (r.get("detections") or {}).items():
        if not vmap: continue
        ms = max(vmap.values())
        top = {v for v, s in vmap.items() if s == ms}
        ale_ver.setdefault(site, {}).setdefault(canon(libRaw.lower()), set()).update(top)

# ── rq1-venn4: 4-set TP-pair (site, lib) ──
def tp_libs_set(by_site_libset):
    out = set()
    for site in eval_sites:
        for lib in gt_by_site.get(site, {}):
            if lib in by_site_libset(site): out.add((site, lib))
    return out

tp_ldc   = tp_libs_set(lambda s: ldc_by_site.get(s, set()))
tp_pt    = tp_libs_set(lambda s: pt_by_site.get(s, set()))
tp_db    = tp_libs_set(lambda s: db_by_site.get(s, set()))
tp_debun = tp_libs_set(lambda s: debun_by_site.get(s, set()))

allpairs = tp_ldc | tp_pt | tp_db | tp_debun
counts4 = Counter()
for p in allpairs:
    counts4[(int(p in tp_ldc), int(p in tp_pt), int(p in tp_db), int(p in tp_debun))] += 1
with (BUNDLE / "rq1-venn4.csv").open("w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["ldc", "pt", "dbundlr", "debun", "count"])
    for k in sorted(counts4.keys(), reverse=True):
        w.writerow([*k, counts4[k]])
print(f"[wrote] rq1-venn4.csv  ({len(counts4)} regions, total {sum(counts4.values())})")

# ── rq2-venn: (site, lib) version-correct TP for ldc/debun/aletheia ──
D, L, A = set(), set(), set()
for site, gts in gt_by_site.items():
    for lib, gv in gts.items():
        if not gv: continue
        if patch_match(gv, debun_ver_by_site.get(site, {}).get(lib, set())): D.add((site, lib))
        lv = ldc_ver_by_site.get(site, {}).get(lib, "")
        if lv:
            ex = expand_prefix(lib, lv) or {lv}
            if patch_match(gv, ex): L.add((site, lib))
        if patch_match(gv, ale_ver.get(site, {}).get(lib, set())): A.add((site, lib))

allt = D | L | A
counts3 = Counter()
for p in allt:
    counts3[(int(p in L), int(p in D), int(p in A))] += 1
with (BUNDLE / "rq2-venn.csv").open("w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["ldc", "debun", "aletheia", "count"])
    for k in sorted(counts3.keys(), reverse=True):
        w.writerow([*k, counts3[k]])
print(f"[wrote] rq2-venn.csv  ({len(counts3)} regions, total {sum(counts3.values())})")
print(f"D={len(D)} L={len(L)} A={len(A)} all3={len(D&L&A)}")
