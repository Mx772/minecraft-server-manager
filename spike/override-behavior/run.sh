#!/usr/bin/env bash
# Usage: run.sh PACKS_DIR OUT_DIR
# Runs the override-behavior scenarios against itzg/minecraft-server in SETUP_ONLY mode.
# Exits non-zero only on infrastructure failure (container exit != 0, expected files missing).
set -u
PACKS="$(cd "${1:?packs dir}" && pwd)"
mkdir -p "${2:?out dir}"
OUT="$(cd "$2" && pwd)"
IMAGE="${IMAGE:-itzg/minecraft-server:latest}"
RESULTS="$OUT/results.tsv"
INFRA_FAIL=0
: > "$RESULTS"

rec() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RESULTS"; }

# Customization source files shared by the scenarios that use them.
CUSTOM="$OUT/customizations"
mkdir -p "$CUSTOM/config" "$CUSTOM/kubejs/server_scripts"
printf 'value = "custom"\n' > "$CUSTOM/config/spike.toml"
printf '// custom\n' > "$CUSTOM/kubejs/server_scripts/spike.js"
chmod -R a+rX "$CUSTOM"

exists() { if [ -e "$1" ]; then echo present; else echo absent; fi; }
content() {
  if [ -f "$1" ]; then tr -d '\r' < "$1" | head -c 200 | tr '\n\t' '  ' | sed 's/ *$//'; else echo absent; fi
}
mtime() { if [ -f "$1" ]; then stat -c %.9Y "$1"; else echo absent; fi; }

snapshot() { # scenario step datadir
  local s=$1 st=$2 d=$3
  rec "$s" "$st" spike_toml "$(content "$d/config/spike.toml")"
  rec "$s" "$st" spike_js "$(content "$d/kubejs/server_scripts/spike.js")"
  rec "$s" "$st" spike_toml_mtime "$(mtime "$d/config/spike.toml")"
  rec "$s" "$st" spike_js_mtime "$(mtime "$d/kubejs/server_scripts/spike.js")"
  rec "$s" "$st" removed_in_v2 "$(exists "$d/config/removed-in-v2.toml")"
  rec "$s" "$st" fake_mod_1 "$(exists "$d/mods/fake-mod-1.0.jar")"
  rec "$s" "$st" fake_mod_2 "$(exists "$d/mods/fake-mod-2.0.jar")"
  rec "$s" "$st" hand_added "$(exists "$d/mods/hand-added.jar")"
  rec "$s" "$st" unrelated "$(exists "$d/config/unrelated.toml")"
  rec "$s" "$st" canary "$(exists "$d/canary.txt")"
}

# run_step scenario step platform pack -- extra docker args...
run_step() {
  local s=$1 st=$2 platform=$3 pack=$4
  shift 5
  local d="$OUT/$s/data" log="$OUT/$s/$st.log"
  local pack_env
  if [ "$platform" = modrinth ]; then
    pack_env=(-e TYPE=MODRINTH -e "MODRINTH_MODPACK=$pack")
  else
    pack_env=(-e TYPE=AUTO_CURSEFORGE -e CF_SLUG=custom -e "CF_MODPACK_ZIP=$pack" -e CF_API_KEY)
  fi
  docker run --rm \
    -e EULA=TRUE -e SETUP_ONLY=true -e UID="$(id -u)" -e GID="$(id -g)" \
    "${pack_env[@]}" "$@" \
    -v "$d:/data" -v "$PACKS:/packs:ro" \
    "$IMAGE" > "$log" 2>&1
  local rc=$?
  rec "$s" "$st" exit_code "$rc"
  local hint
  hint="$(grep -iE 'already|up to date|up-to-date|skipp|install(ing|ed)|extract|override|remov|delet|sync|copy|appl' "$log" | head -8 | tr '\n|' ' /' | cut -c1-400)"
  rec "$s" "$st" log_hint "${hint:-none}"
  if [ "$rc" -ne 0 ]; then
    INFRA_FAIL=1
    rec "$s" "$st" note "container exited $rc"
    echo "::error::$s/$st: container exited $rc. Last 60 log lines follow."
    tail -n 60 "$log"
    tail -n 60 "$log" > "$OUT/$s/$st.fail-tail.log"
  fi
  snapshot "$s" "$st" "$d"
  return "$rc"
}

user_edit() { # scenario
  local s=$1 d="$OUT/$1/data"
  sleep 1.1 # make sure edit mtimes differ from install mtimes
  printf 'value = "user-edit"\n' > "$d/config/spike.toml"
  printf 'value = "unrelated"\n' > "$d/config/unrelated.toml"
  printf 'hand added\n' > "$d/mods/hand-added.jar"
  printf 'canary\n' > "$d/canary.txt"
  sleep 1.1
  snapshot "$s" edit "$d"
}

# scenario name, platform, then extra docker args
scenario() {
  local s=$1 platform=$2
  shift 2
  local v1 v2
  if [ "$platform" = modrinth ]; then
    v1=/packs/v1.mrpack
    v2=/packs/v2.mrpack
  else
    v1=/packs/cf-v1.zip
    v2=/packs/cf-v2.zip
  fi
  echo "=== scenario: $s"
  mkdir -p "$OUT/$s/data"
  chmod 777 "$OUT/$s/data"
  run_step "$s" install1 "$platform" "$v1" -- "$@" || return 0
  if [ ! -f "$OUT/$s/data/config/spike.toml" ]; then
    INFRA_FAIL=1
    rec "$s" install1 note "config/spike.toml missing after install"
    echo "::error::$s: config/spike.toml missing after install"
    return 0
  fi
  user_edit "$s"
  run_step "$s" restart "$platform" "$v1" -- "$@" || return 0
  run_step "$s" upgrade "$platform" "$v2" -- "$@" || return 0
}

EXTRA_FILES='config/spike.toml</customizations/config/spike.toml,kubejs/server_scripts/spike.js</customizations/kubejs/server_scripts/spike.js'
CUSTOM_MOUNT=(-v "$CUSTOM:/customizations:ro")

docker pull "$IMAGE" > /dev/null || { echo "::error::docker pull failed"; exit 1; }

scenario baseline modrinth
scenario extra-files modrinth "${CUSTOM_MOUNT[@]}" -e "APPLY_EXTRA_FILES=$EXTRA_FILES"
scenario sync-default modrinth "${CUSTOM_MOUNT[@]}" -e COPY_CONFIG_SRC=/customizations -e COPY_CONFIG_DEST=/data
scenario sync-no-skip-newer modrinth "${CUSTOM_MOUNT[@]}" -e COPY_CONFIG_SRC=/customizations -e COPY_CONFIG_DEST=/data -e SYNC_SKIP_NEWER_IN_DESTINATION=false

# Best-effort CurseForge scenarios (need an API key).
if [ -n "${CF_API_KEY:-}" ]; then
  export CF_API_KEY
  scenario curseforge-baseline curseforge
  scenario curseforge-extra-files curseforge "${CUSTOM_MOUNT[@]}" -e "APPLY_EXTRA_FILES=$EXTRA_FILES"
else
  echo "CF_API_KEY not set; skipping CurseForge scenarios."
  rec curseforge-zip meta note "skipped: no CF_API_KEY"
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -I "$here/summarize.py" "$RESULTS" | tee "$OUT/summary.md"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$OUT/summary.md" >> "$GITHUB_STEP_SUMMARY"; fi
exit "$INFRA_FAIL"
