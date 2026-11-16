"""Turn results.tsv into the markdown answer table. Usage: summarize.py results.tsv"""
import csv
import sys
from collections import defaultdict

rows = defaultdict(dict)
scenarios = []
with open(sys.argv[1], newline="") as f:
    for scn, step, key, val in csv.reader(f, delimiter="\t"):
        rows[(scn, step)][key] = val
        if scn not in scenarios:
            scenarios.append(scn)

USER_EDIT = 'value = "user-edit"'
CUSTOM = 'value = "custom"'


def g(scn, step, key):
    return rows.get((scn, step), {}).get(key, "n/a")


def yn(b):
    return "yes" if b else "NO"


out = ["# Override behavior spike results", ""]
out.append("Observations only; 'NO' is a finding, not a failure.")
out.append("")

base = [s for s in scenarios if s in ("baseline", "curseforge-baseline")]
out += [
    "## Q1: restart with the same pack keeps the user edit?",
    "",
    "| scenario | spike.toml after restart | kept? | hand-added.jar | unrelated.toml | log hints |",
    "|---|---|---|---|---|---|",
]
for s in base:
    v = g(s, "restart", "spike_toml")
    out.append(
        f"| {s} | `{v}` | {yn(v == USER_EDIT)} | {g(s,'restart','hand_added')} | "
        f"{g(s,'restart','unrelated')} | {g(s,'restart','log_hint')} |"
    )

out += [
    "",
    "## Q2: upgrade v1 to v2 (baseline)",
    "",
    "| scenario | user edit overwritten? | removed-in-v2.toml deleted? | fake-mod-1.0 removed? | fake-mod-2.0 present? | hand-added.jar survives? | log hints |",
    "|---|---|---|---|---|---|---|",
]
for s in base:
    st = "upgrade"
    out.append(
        f"| {s} | {yn(g(s,st,'spike_toml') != USER_EDIT)} (now `{g(s,st,'spike_toml')}`) | "
        f"{yn(g(s,st,'removed_in_v2') == 'absent')} | {yn(g(s,st,'fake_mod_1') == 'absent')} | "
        f"{yn(g(s,st,'fake_mod_2') == 'present')} | {yn(g(s,st,'hand_added') == 'present')} | "
        f"{g(s,st,'log_hint')} |"
    )

out += [
    "",
    "## Q3: does the customization win after the upgrade boot?",
    "",
    "| scenario | spike.toml | spike.js | wins? |",
    "|---|---|---|---|",
]
for s in scenarios:
    t, j = g(s, "upgrade", "spike_toml"), g(s, "upgrade", "spike_js")
    out.append(f"| {s} | `{t}` | `{j}` | {yn(t == CUSTOM and j == '// custom')} |")

out += [
    "",
    "## Q4: does the sync delete files missing from the source? (safety-critical)",
    "",
    "| scenario | unrelated.toml after upgrade | canary.txt in /data after upgrade | hand-added.jar | fake-mod-2.0 |",
    "|---|---|---|---|---|",
]
for s in scenarios:
    st = "upgrade"
    out.append(
        f"| {s} | {g(s,st,'unrelated')} | {g(s,st,'canary')} | {g(s,st,'hand_added')} | {g(s,st,'fake_mod_2')} |"
    )

out += [
    "",
    "## Q5: rewritten on every start? (mtimes across the restart step)",
    "",
    "| scenario | spike.js mtime before | after | rewritten? | spike.toml rewritten? |",
    "|---|---|---|---|---|",
]
for s in scenarios:
    a, b = g(s, "edit", "spike_js_mtime"), g(s, "restart", "spike_js_mtime")
    ta, tb = g(s, "edit", "spike_toml_mtime"), g(s, "restart", "spike_toml_mtime")
    out.append(f"| {s} | {a} | {b} | {yn(a != b)} | {yn(ta != tb)} |")

env_s = "sync-env-substitution"
out += [
    "",
    "## Q6: are CFG_ placeholders substituted into a synced .toml file?",
    "",
    "| step | live bridge.toml | token substituted? | NOT_PREFIXED left literal? | source copy unchanged? | source copy |",
    "|---|---|---|---|---|---|",
]
for st in ("install1", "upgrade"):
    live, src = g(env_s, st, "bridge_toml"), g(env_s, st, "bridge_src")
    out.append(
        f"| {st} | `{live}` | {yn('spike-secret-123' in live)} | {yn('${NOT_PREFIXED}' in live)} | "
        f"{yn('${CFG_SPIKE_TOKEN}' in src and 'spike-secret-123' not in src)} | `{src}` |"
    )

out += [
    "",
    "## Q7: does the sync preserve the source mtime on the destination?",
    "",
    "| step | file | source mtime | dest mtime | preserved? |",
    "|---|---|---|---|---|",
]
for st in ("install1", "upgrade"):
    for label, k in (("spike.toml", "spike"), ("bridge.toml", "bridge")):
        a, b = g(env_s, st, k + "_mtime_src"), g(env_s, st, k + "_mtime_dst")
        out.append(f"| {st} | {label} | {a} | {b} | {yn(a == b)} |")

out += ["", "## Step status", "", "| scenario | step | exit code | notes |", "|---|---|---|---|"]
for (s, st), d in rows.items():
    if "exit_code" in d:
        out.append(f"| {s} | {st} | {d['exit_code']} | {d.get('note','')} |")
    elif "note" in d:
        out.append(f"| {s} | {st} | | {d['note']} |")
print("\n".join(out))
