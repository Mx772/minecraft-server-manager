"""Build tiny fake Modrinth (.mrpack) and CurseForge (.zip) packs. Usage: make-packs.py OUTDIR"""
import io
import json
import sys
import zipfile
from pathlib import Path

FABRIC_LOADER = "0.20.1"  # stable per meta.fabricmc.net when this spike was written


def fake_jar(label):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("fake.txt", label + "\n")
    return buf.getvalue()


TOML_V1 = """# Top comment
[general]
    # Radiation toggle
    radiation = true
    # Spawn cap
    spawnCap = 70

[[guilds]]
    guildId = "111"
    channel = "222"
"""


def overrides(v):
    files = {
        "config/spike.toml": f'value = "pack-v{v}"\n',
        "kubejs/server_scripts/spike.js": f"// pack-v{v}\n",
        f"mods/fake-mod-{v}.0.jar": fake_jar(f"fake mod {v}.0"),
    }
    if v == 1:
        toml = TOML_V1
    else:
        toml = (
            TOML_V1.replace("radiation =", "radiationEnabled =")
            .replace("spawnCap = 70", "spawnCap = 80")
            .replace("    spawnCap = 80\n", '    spawnCap = 80\n    newInV2 = "x"\n')
        )
    files["config/patchme-common.toml"] = toml
    files["config/patchme.json"] = '{"limits": {"maxChunks": 10, "list": ["a"]}, "flag": false}\n'
    files["config/patchme.properties"] = "# comment\nfoo=1\nbar=2\n"
    if v == 1:
        files["config/removed-in-v2.toml"] = 'value = "only-in-v1"\n'
    return files


def write_zip(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for v in (1, 2):
        index = {
            "formatVersion": 1,
            "game": "minecraft",
            "versionId": f"{v}.0.0",
            "name": "override-spike",
            "files": [],
            "dependencies": {"minecraft": "1.21.1", "fabric-loader": FABRIC_LOADER},
        }
        entries = {"modrinth.index.json": json.dumps(index, indent=2)}
        entries.update({"overrides/" + k: d for k, d in overrides(v).items()})
        write_zip(out / f"v{v}.mrpack", entries)

        manifest = {
            "minecraft": {
                "version": "1.21.1",
                "modLoaders": [{"id": "neoforge-21.1.172", "primary": True}],
            },
            "manifestType": "minecraftModpack",
            "manifestVersion": 1,
            "name": "override-spike",
            "version": f"{v}.0.0",
            "author": "spike",
            "files": [],
            "overrides": "overrides",
        }
        entries = {"manifest.json": json.dumps(manifest, indent=2)}
        entries.update({"overrides/" + k: d for k, d in overrides(v).items()})
        write_zip(out / f"cf-v{v}.zip", entries)
    print("Wrote packs to", out)


main()
