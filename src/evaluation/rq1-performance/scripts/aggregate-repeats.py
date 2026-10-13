"""Roll up the N passes of repeat-rq1.sh into Table 1 with a spread.

Two kinds of variation get reported, because they answer different questions:

  between passes   the same site measured again. This is the measurement's own repeatability,
                   and it is what "how many runs did you do?" asks for.
  between sites    the spread Table 1's mean already hides. Table 1 reports a mean over the
                   sites, so this is the dispersion of the number in the table.

Warm-up rows are dropped here rather than in the harnesses, which are left untouched: the
DEBUN pass measures its warm-up site twice and the first row goes, and the runtime pass
carries a warm-up site that is not in the measured set at all.

  python3 aggregate-repeats.py --dir <work/repeat-n3> --repeats 3
"""
import argparse
import csv
import json
import os
import statistics as st

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True)
ap.add_argument("--repeats", type=int, default=3)
ap.add_argument("--crawl-repeats", type=int, default=1,
                help="how many times Setup (the crawl) was measured; the Detection stages "
                     "read one corpus however often its cost was timed")
args = ap.parse_args()
D, N, CN = args.dir, args.repeats, args.crawl_repeats

sites = json.load(open(os.path.join(D, "sites.json")))
site_set = set(sites)


def present(name):
    return os.path.exists(os.path.join(D, name))


def spread(xs):
    """mean, median, sd, cv% — sd is the sample sd, undefined below two points."""
    if not xs:
        return None
    m = st.mean(xs)
    sd = st.stdev(xs) if len(xs) > 1 else 0.0
    return dict(n=len(xs), mean=m, median=st.median(xs), sd=sd, cv=(sd / m * 100 if m else 0.0))


PHASE_COLS = ["parseMs", "scMs", "collectorMs", "pogMs", "hashMs",
              "lookupMs", "assembleMs", "filterMs", "hashTotalMs", "detectTotalMs", "totalMs"]

# ── collect: cell[tool][row] = [per-pass mean over sites], and the per-site values of pass 1 ──
# raw keeps every measurement behind those means — one line per (tool, site, pass, phase) —
# because the table is a summary and the summary is not the evidence. phases keeps DEBUN's
# eight-phase breakdown, which is what Figure 14 is drawn from.
cells, persite, raw, phases = {}, {}, [], []


def put(tool, row, pass_idx, values_by_site):
    vals = [v for s, v in values_by_site.items() if s in site_set and v is not None]
    if not vals:
        return
    for site, v in values_by_site.items():
        if site in site_set and v is not None:
            raw.append((tool, site, pass_idx, row, v))
    cells.setdefault(tool, {}).setdefault(row, {})[pass_idx] = st.mean(vals)
    if pass_idx == 1:
        persite.setdefault(tool, {})[row] = vals


for r in range(1, N + 1):
    # Setup, static tools: one crawl, shared by all three. Table 1 excludes a crawl that
    # returned no file — its duration measures the failure, not the cost.
    f = f"crawl-r{r}.json"
    if present(f):
        rows = json.load(open(os.path.join(D, f)))["rows"]
        v = {x["site"]: x.get("crawlMs") for x in rows if x.get("files", 0) > 0}
        for tool in ("D-Bundlr", "Aletheia", "DEBUN"):
            put(tool, "Setup", r, v)

    # Detection, DEBUN. Row 0 is the warm-up repetition of the first site.
    f = f"debun-r{r}.csv"
    if present(f):
        rows = list(csv.DictReader(open(os.path.join(D, f))))[1:]
        put("DEBUN", "Detection", r, {x["site"]: float(x["totalMs"]) for x in rows})
        for x in rows:
            if x["site"] in site_set:
                phases.append([x["site"], r] + [x[k] for k in PHASE_COLS])

    # Setup + Detection, runtime tools. Row 0 is a warm-up site outside the measured set, so
    # put() would drop it anyway; the slice makes the intent explicit.
    f = f"stage3c-r{r}.json"
    if present(f):
        rows = json.load(open(os.path.join(D, f)))["rows"][1:]
        for tool, key in (("LDC", "ldc"), ("PTdetector", "ptdetector"), ("PTV", "ptv")):
            put(tool, "Setup", r, {x["site"]: x[key]["pageLoadMs"] for x in rows if key in x})
            put(tool, "Detection", r, {x["site"]: x[key]["computeMs"] for x in rows if key in x})

    # Detection, the learning-based pair. Their warm-up is a discarded run, not a dropped row.
    f = f"stage2-r{r}.json"
    if present(f):
        rows = json.load(open(os.path.join(D, f)))["rows"]
        put("D-Bundlr", "Detection", r, {x["site"]: x.get("dbundlrMs") for x in rows})
        put("Aletheia", "Detection", r, {x["site"]: x.get("aletheiaMs") for x in rows})

# ── raw measurements, written next to the summary ───────────────────────────────────────────
with open(os.path.join(D, "raw-timings.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["tool", "site", "pass", "phase", "ms"])
    w.writerows(sorted(raw, key=lambda t: (t[0], t[3], t[1], t[2])))
with open(os.path.join(D, "raw-debun-phases.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["site", "pass"] + PHASE_COLS)
    w.writerows(sorted(phases, key=lambda t: (t[0], t[1])))
print(f"raw: {len(raw)} timings -> {D}/raw-timings.csv"
      f"  |  {len(phases)} DEBUN phase rows -> {D}/raw-debun-phases.csv")

TOOLS = ["LDC", "PTdetector", "PTV", "D-Bundlr", "Aletheia", "DEBUN"]
print(f"\nTable 1 over {len(sites)} sites, {N} passes  (ms -> s)\n")

# ── Table 1, one line per pass, then the between-pass spread ────────────────────────────────
hdr = f"{'':16s}" + "".join(f"{t:>14s}" for t in TOOLS)
for row in ("Setup", "Detection", "Total"):
    print(hdr if row == "Setup" else "")
    print(f"  {row}")
    for r in range(1, N + 1):
        line = f"    pass {r:<10d}"
        for t in TOOLS:
            c = cells.get(t, {})
            if row == "Total":
                # Setup is measured once by default, so every pass's Total is that one crawl
                # plus that pass's Detection. The note under the table says so.
                setup = c.get("Setup", {})
                a = setup.get(r, setup.get(1))
                b = c.get("Detection", {}).get(r)
                v = (a + b) if (a is not None and b is not None) else None
            else:
                v = c.get(row, {}).get(r)
            line += f"{v/1000:>14.2f}" if v is not None else f"{'-':>14s}"
        print(line)
    for label, fn in (("mean", "mean"), ("sd", "sd"), ("cv", "cv")):
        line = f"    {label:<15s}"
        for t in TOOLS:
            c = cells.get(t, {})
            if row == "Total":
                s_, d_ = c.get("Setup", {}), c.get("Detection", {})
                xs = [s_.get(r, s_.get(1)) + d_[r]
                      for r in range(1, N + 1) if r in d_ and (r in s_ or 1 in s_)]
            else:
                xs = [v for _, v in sorted(c.get(row, {}).items())]
            sp = spread(xs)
            if not sp:
                line += f"{'-':>14s}"
            elif fn == "cv":
                line += f"{sp['cv']:>13.1f}%"
            else:
                line += f"{sp[fn]/1000:>14.2f}"
        print(line)

# ── the spread Table 1's mean hides: across sites, within one pass ──────────────────────────
print("\n\nBetween sites, pass 1 (the dispersion behind each mean above)\n")
print(f"{'':24s}{'n':>6s}{'mean':>12s}{'median':>12s}{'sd':>12s}{'cv':>10s}")
for t in TOOLS:
    for row in ("Setup", "Detection"):
        sp = spread(persite.get(t, {}).get(row, []))
        if not sp:
            continue
        print(f"{t + ' ' + row:24s}{sp['n']:>6d}{sp['mean']/1000:>12.3f}"
              f"{sp['median']/1000:>12.3f}{sp['sd']/1000:>12.3f}{sp['cv']:>9.1f}%")

if CN < N:
    print(f"\n  Setup was measured {CN}x, not {N}x: one crawl, {len(sites)} sites. Each pass's"
          f" Total is that crawl plus that pass's Detection, so the Total spread is"
          f" Detection's.")

missing = [f for r in range(1, N + 1)
           for f in (f"debun-r{r}.csv", f"stage3c-r{r}.json", f"stage2-r{r}.json")
           if not present(f)] + [f"crawl-r{r}.json" for r in range(1, CN + 1)
                                 if not present(f"crawl-r{r}.json")]
if missing:
    print("\nnot measured yet: " + ", ".join(missing))
