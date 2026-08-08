"""Version-detection scores per granularity level (Major/Minor/Patch) for
LDC / Aletheia / Debun. For each (site, lib) where GT has a version, count
detections that match at the chosen level and the avg #~versions claimed
per correct detection.
"""
import csv, json, os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GT = ROOT / "src/ground/ground-truth.csv"
DEBUN_SUM = ROOT / "src/data/threshold-sweep/t84/summary.csv"
ALE_JSON = ROOT / "src/data/other-tool/aletheia_results_debun.json"
CDN_LIBS = ROOT / "src/data/fingerprint-cache/cdn-alllibs.json"
WEBHASH_DIR = ROOT / "src/data/allWebHashes"

ALIAS = {
    "react-dom": "react", "angularjs": "angular.js", "backbone": "backbone.js",
    "handlebars": "handlebars.js", "hammerjs": "hammer.js", "ifvisible.js": "ifvisible",
    "jquery-ui": "jqueryui", "jquery.ui": "jqueryui", "lodash": "lodash.js",
    "moment": "moment.js", "requirejs": "require.js", "underscore": "underscore.js",
}
def canon(s): return ALIAS.get(s, s)

def parts(v):
    out = []
    for x in v.split('.')[:3]:
        try: out.append(int(x))
        except: out.append(None)
    while len(out) < 3: out.append(None)
    return out

def match_level(gt_ver, detected_versions, level):
    """level: 'major' | 'minor' | 'patch'. Returns True if any detected v matches GT at level."""
    if not gt_ver or not detected_versions: return False
    gp = parts(gt_ver)
    n = {'major': 1, 'minor': 2, 'patch': 3}[level]
    for v in detected_versions:
        vp = parts(v)
        if all(gp[i] is not None and gp[i] == vp[i] for i in range(n)):
            return True
    return False

eval_sites = {f.replace(".json","") for f in os.listdir(WEBHASH_DIR)
              if f.endswith(".json") and "-cnt" not in f and "-cfg" not in f}

cdn = json.loads(CDN_LIBS.read_text())
lib_versions = {}
for k, info in cdn.items():
    lib_versions.setdefault(k.split("____")[0].lower(), set()).update(info.get("versions") or [])

def expand_prefix(lib, ver):
    if not ver: return set()
    lp = parts(ver); out = set()
    for v in lib_versions.get(lib, set()):
        a, b, c = parts(v)
        if lp[0] is not None and lp[0] != a: continue
        if lp[1] is not None and lp[1] != b: continue
        if lp[2] is not None and lp[2] != c: continue
        out.add(v)
    return out

# ── GT + LDC version ──
gt, ldc_ver = {}, {}
with GT.open() as fh:
    for r in csv.DictReader(fh):
        s = (r.get("url") or "").strip()
        if not s or s not in eval_sites: continue
        gt[s] = {}; ldc_ver[s] = {}
        for tok in (r.get("ground truth") or "").split(","):
            tok = tok.strip()
            if not tok: continue
            at = tok.find("@")
            lib = canon((tok if at < 0 else tok[:at]).strip().lower())
            v = tok[at+1:].strip() if at >= 0 else ""
            if lib: gt[s][lib] = v
        for tok in (r.get("ldc_version") or "").split(","):
            tok = tok.strip()
            if not tok: continue
            at = tok.find("@")
            lib = canon((tok if at < 0 else tok[:at]).strip().lower())
            v = tok[at+1:].strip() if at >= 0 else ""
            if lib: ldc_ver[s][lib] = v

# ── DEBUN strictVersions ──
debun_ver = {}
with DEBUN_SUM.open() as fh:
    for r in csv.DictReader(fh):
        if r.get("detected") != "true": continue
        debun_ver.setdefault(r["site"], {})[canon(r["lib"].lower())] = \
            {x.strip() for x in (r.get("strictVersions") or "").split(";") if x.strip()}

# ── Aletheia (dict shape) ──
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

# ── score: for each detector and level, count matches and avg detected-set size ──
def detected_set_for(detector, site, lib):
    if detector == 'ldc':
        lv = ldc_ver.get(site, {}).get(lib, '')
        if not lv: return set()
        ex = expand_prefix(lib, lv)
        return ex if ex else {lv}
    if detector == 'aletheia':
        return ale_ver.get(site, {}).get(lib, set())
    if detector == 'debun':
        return debun_ver.get(site, {}).get(lib, set())
    return set()

def distinct_at_level(detected, level):
    """Count distinct values at the given level inside the detected set.
    Major: unique major numbers; Minor: unique (major, minor) pairs;
    Patch: unique (major, minor, patch) triples."""
    n = {'major': 1, 'minor': 2, 'patch': 3}[level]
    distinct = set()
    for v in detected:
        vp = parts(v)
        if any(vp[i] is None for i in range(n)): continue
        distinct.add(tuple(vp[i] for i in range(n)))
    return len(distinct)

def score(detector, level):
    cnt = 0; total_size = 0
    for site, gts in gt.items():
        for lib, gv in gts.items():
            if not gv: continue
            det = detected_set_for(detector, site, lib)
            if match_level(gv, det, level):
                cnt += 1
                total_size += distinct_at_level(det, level)
    avg = (total_size / cnt) if cnt else 0
    return cnt, avg

print(f"{'Level':<7} {'LDC':<14} {'Aletheia':<14} {'Debun':<14}")
for level in ('major', 'minor', 'patch'):
    cells = []
    for det in ('ldc', 'aletheia', 'debun'):
        c, a = score(det, level)
        cells.append(f"{c} ({a:.2f})")
    print(f"{level.capitalize():<7} {cells[0]:<14} {cells[1]:<14} {cells[2]:<14}")
