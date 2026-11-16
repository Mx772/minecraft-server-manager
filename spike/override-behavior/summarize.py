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

import re


def cell(v):
    return v.replace("|", "\\|")


def has(text, pattern):
    return re.search(pattern, text) is not None


def toml_checks(t):
    return [
        ("bool", has(t, r"radiation\s*=\s*false")),
        ("int", has(t, r"spawnCap\s*=\s*40(\\n|$)")),
        ("guilds[0]", has(t, r'channel\s*=\s*"333"')),
    ]


def json_checks(j):
    return [
        ("set", has(j, r'"maxChunks"\s*:\s*25')),
        ("add", has(j, r'"a"\s*,\s*"b"')),
        ("put", has(j, r'"extra"\s*:\s*"y"')),
    ]


def props_checks(p):
    return [
        ("set", has(p, r"foo\s*[=:]\s*9(\\n|$)")),
        ("placeholder", has(p, r"bar\s*[=:]\s*fromenv")),
    ]


PH = "patch-happy"
PM = "patch-missing-path"
PR = "patch-renamed-after-upgrade"
STEPS = ("install1", "restart", "upgrade")

out += [
    "",
    "## Q8: do TOML/JSON/properties patches apply? (patch-happy)",
    "",
    "Restart re-runs the same patch on an already-patched file (idempotency; `$add` may append twice). "
    "The upgrade boot gets v2 files where `radiation` was renamed.",
    "",
    "| step | exit | toml $set bool | toml $set int (value-type) | toml `$.guilds[0]` | json $set | json $add appends | json $put adds key | props $set | props placeholder |",
    "|---|---|---|---|---|---|---|---|---|---|",
]
for st in STEPS:
    t, j, pr = g(PH, st, "patch_toml"), g(PH, st, "patch_json"), g(PH, st, "patch_props")
    cs = [yn(v) for _, v in toml_checks(t) + json_checks(j) + props_checks(pr)]
    out.append(f"| {st} | {g(PH, st, 'exit_code')} | " + " | ".join(cs) + " |")
out += ["", "Raw file contents (newlines escaped):", "", "| step | toml | json | properties |", "|---|---|---|---|"]
for st in STEPS:
    out.append(
        f"| {st} | `{cell(g(PH, st, 'patch_toml'))}` | `{cell(g(PH, st, 'patch_json'))}` | `{cell(g(PH, st, 'patch_props'))}` |"
    )

NL = chr(92) + "n"
T_BEFORE = '# Top comment\\n[general]\\n    # Radiation toggle\\n    radiation = true\\n    # Spawn cap\\n    spawnCap = 70\\n\\n[[guilds]]\\n    guildId = "111"\\n    channel = "222"\\n'
J_BEFORE = '{"limits": {"maxChunks": 10, "list": ["a"]}, "flag": false}\\n'
P_BEFORE = "# comment\\nfoo=1\\nbar=2\\n"
t1, j1, p1 = g(PH, "install1", "patch_toml"), g(PH, "install1", "patch_json"), g(PH, "install1", "patch_props")
out += [
    "",
    "## Q9: are comments, blank lines and indentation preserved? (patch-happy, install1)",
    "",
    "| format | comments kept? | blank line kept? | indentation kept? | before | after |",
    "|---|---|---|---|---|---|",
    f"| toml | {yn('# Top comment' in t1 and '# Radiation toggle' in t1 and '# Spawn cap' in t1)} | "
    f"{yn(NL + NL + '[[guilds]]' in t1)} | {yn(NL + '    spawnCap' in t1 and NL + '    channel' in t1)} | "
    f"`{cell(T_BEFORE)}` | `{cell(t1)}` |",
    f"| json | n/a | n/a | n/a (compact original; reformatted: {yn(j1 != J_BEFORE and ': ' not in j1)}) | "
    f"`{cell(J_BEFORE)}` | `{cell(j1)}` |",
    f"| properties | {yn('# comment' in p1)} | n/a | n/a | `{cell(P_BEFORE)}` | `{cell(p1)}` |",
    "",
    "Key order in toml (radiation before spawnCap before guilds): "
    + yn(has(t1, r"radiation.*spawnCap.*\[\[guilds\]\]")),
]

out += [
    "",
    "## Q10: patch definition for a missing target file (patch-happy, `/data/config/not-there.toml`)",
    "",
    "| step | exit | file created? | patch log lines |",
    "|---|---|---|---|",
]
for st in STEPS:
    out.append(f"| {st} | {g(PH, st, 'exit_code')} | {g(PH, st, 'not_there')} | {cell(g(PH, st, 'patch_log'))} |")

out += [
    "",
    "## Q11: `$set` on a missing path (patch-missing-path)",
    "",
    "The bad op sits between the first and second toml ops; json and properties patches follow it.",
    "",
    "| step | exit | toml op before bad (bool) | toml op after bad (int) | json $set | props $set | patch log lines |",
    "|---|---|---|---|---|---|---|",
]
for st in STEPS:
    t, j, pr = g(PM, st, "patch_toml"), g(PM, st, "patch_json"), g(PM, st, "patch_props")
    out.append(
        f"| {st} | {g(PM, st, 'exit_code')} | {yn(toml_checks(t)[0][1])} | {yn(toml_checks(t)[1][1])} | "
        f"{yn(json_checks(j)[0][1])} | {yn(props_checks(pr)[0][1])} | {cell(g(PM, st, 'patch_log'))} |"
    )
out += ["", "| step | toml | json | properties |", "|---|---|---|---|"]
for st in STEPS:
    out.append(
        f"| {st} | `{cell(g(PM, st, 'patch_toml'))}` | `{cell(g(PM, st, 'patch_json'))}` | `{cell(g(PM, st, 'patch_props'))}` |"
    )

out += [
    "",
    "## Q12: upgrade renames a patched key (patch-renamed-after-upgrade)",
    "",
    "| step | exit | toml | patch log lines |",
    "|---|---|---|---|",
]
for st in STEPS:
    out.append(
        f"| {st} | {g(PR, st, 'exit_code')} | `{cell(g(PR, st, 'patch_toml'))}` | {cell(g(PR, st, 'patch_log'))} |"
    )

out += ["", "## Step status", "", "| scenario | step | exit code | notes |", "|---|---|---|---|"]
for (s, st), d in rows.items():
    if "exit_code" in d:
        out.append(f"| {s} | {st} | {d['exit_code']} | {d.get('note','')} |")
    elif "note" in d:
        out.append(f"| {s} | {st} | | {d['note']} |")
print("\n".join(out))
