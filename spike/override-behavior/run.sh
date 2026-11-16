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

# Separate source tree for the env-substitution scenario (adds config/bridge.toml, fixed old mtimes).
CUSTOM_ENV="$OUT/customizations-env"
mkdir -p "$CUSTOM_ENV"
cp -a "$CUSTOM/." "$CUSTOM_ENV/"
printf '[bot]\ndiscordBotToken = "${CFG_SPIKE_TOKEN}"\nuntouched = "${NOT_PREFIXED}"\n' > "$CUSTOM_ENV/config/bridge.toml"
chmod -R a+rX "$CUSTOM_ENV"
touch -d '2020-01-02 03:04:05.123456789' "$CUSTOM_ENV/config/spike.toml" "$CUSTOM_ENV/config/bridge.toml"

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

# Extra records for the env-substitution scenario: live vs source content and mtimes.
snapshot_env() { # scenario step datadir
  local s=$1 st=$2 d=$3
  rec "$s" "$st" bridge_toml "$(content "$d/config/bridge.toml")"
  rec "$s" "$st" bridge_src "$(content "$CUSTOM_ENV/config/bridge.toml")"
  rec "$s" "$st" bridge_mtime_dst "$(mtime "$d/config/bridge.toml")"
  rec "$s" "$st" bridge_mtime_src "$(mtime "$CUSTOM_ENV/config/bridge.toml")"
  rec "$s" "$st" spike_mtime_dst "$(mtime "$d/config/spike.toml")"
  rec "$s" "$st" spike_mtime_src "$(mtime "$CUSTOM_ENV/config/spike.toml")"
}

# Full file contents with newlines/tabs escaped, so comments, blank lines and indentation are visible.
esc_file() {
  if [ -f "$1" ]; then tr -d '\r' < "$1" | head -c 1500 | awk 'BEGIN{ORS=""} {gsub(/\t/,"\\t"); print $0 "\\n"}'; else echo absent; fi
}

snapshot_patch() { # scenario step datadir logfile
  local s=$1 st=$2 d=$3 log=$4
  rec "$s" "$st" patch_toml "$(esc_file "$d/config/patchme-common.toml")"
  rec "$s" "$st" patch_json "$(esc_file "$d/config/patchme.json")"
  rec "$s" "$st" patch_props "$(esc_file "$d/config/patchme.properties")"
  rec "$s" "$st" not_there "$(exists "$d/config/not-there.toml")"
  rec "$s" "$st" patch_log "$(grep -i patch "$log" | cut -c1-300 | head -30 | awk 'BEGIN{ORS=" ## "} {print}')"
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
  if [ "$rc" -ne 0 ] && [ "${ALLOW_FAIL:-0}" = 1 ]; then
    rec "$s" "$st" note "container exited $rc (allowed for this scenario)"
    tail -n 60 "$log" > "$OUT/$s/$st.fail-tail.log"
  elif [ "$rc" -ne 0 ]; then
    INFRA_FAIL=1
    rec "$s" "$st" note "container exited $rc"
    echo "::error::$s/$st: container exited $rc. Last 60 log lines follow."
    tail -n 60 "$log"
    tail -n 60 "$log" > "$OUT/$s/$st.fail-tail.log"
  fi
  snapshot "$s" "$st" "$d"
  if [ "$s" = sync-env-substitution ]; then snapshot_env "$s" "$st" "$d"; fi
  case "$s" in patch-*) snapshot_patch "$s" "$st" "$d" "$log" ;; esac
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

# PATCH_DEFINITIONS scenarios: a patch set file mounted read-only at /patches/set.json.
PATCHDIR="$OUT/patches"
mkdir -p "$PATCHDIR"
write_patchset() { # name, include bad-path op (0/1)
  local bad=''
  if [ "$2" = 1 ]; then bad='{"$set": {"path": "$.general.doesNotExist", "value": 1}},'; fi
  cat > "$PATCHDIR/$1.json" <<EOF
{"patches": [
 {"file": "/data/config/patchme-common.toml", "ops": [
   {"\$set": {"path": "\$.general.radiation", "value": false, "value-type": "bool"}},
   $bad
   {"\$set": {"path": "\$.general.spawnCap", "value": "40", "value-type": "int"}},
   {"\$set": {"path": "\$.guilds[0].channel", "value": "333"}}
 ]},
 {"file": "/data/config/patchme.json", "ops": [
   {"\$set": {"path": "\$.limits.maxChunks", "value": 25}},
   {"\$add": {"path": "\$.limits.list", "value": "b"}},
   {"\$put": {"path": "\$.limits", "key": "extra", "value": "y"}}
 ]},
 {"file": "/data/config/patchme.properties", "ops": [
   {"\$set": {"path": "\$.foo", "value": "9"}},
   {"\$set": {"path": "\$.bar", "value": "\${CFG_PATCH_VAL}"}}
 ]},
 {"file": "/data/config/not-there.toml", "ops": [
   {"\$set": {"path": "\$.a", "value": 1}}
 ]}
]}
EOF
}
write_patchset happy 0
write_patchset missing 1
cat > "$PATCHDIR/renamed.json" <<'EOF'
{"patches": [
 {"file": "/data/config/patchme-common.toml", "ops": [
   {"$set": {"path": "$.general.radiation", "value": false, "value-type": "bool"}}
 ]}
]}
EOF
chmod -R a+rX "$PATCHDIR"

# patch_scenario name patchset [extra docker args]: install v1, restart v1, upgrade v2; failures are data.
patch_scenario() {
  local s=$1 set=$2
  shift 2
  echo "=== scenario: $s"
  mkdir -p "$OUT/$s/data"
  chmod 777 "$OUT/$s/data"
  export ALLOW_FAIL=1
  local args=(-v "$PATCHDIR/$set.json:/patches/set.json:ro" -e PATCH_DEFINITIONS=/patches/set.json "$@")
  run_step "$s" install1 modrinth /packs/v1.mrpack -- "${args[@]}"
  run_step "$s" restart modrinth /packs/v1.mrpack -- "${args[@]}"
  run_step "$s" upgrade modrinth /packs/v2.mrpack -- "${args[@]}"
  unset ALLOW_FAIL
}

EXTRA_FILES='config/spike.toml</customizations/config/spike.toml,kubejs/server_scripts/spike.js</customizations/kubejs/server_scripts/spike.js'
CUSTOM_MOUNT=(-v "$CUSTOM:/customizations:ro")

docker pull "$IMAGE" > /dev/null || { echo "::error::docker pull failed"; exit 1; }

scenario baseline modrinth
scenario extra-files modrinth "${CUSTOM_MOUNT[@]}" -e "APPLY_EXTRA_FILES=$EXTRA_FILES"
scenario sync-default modrinth "${CUSTOM_MOUNT[@]}" -e COPY_CONFIG_SRC=/customizations -e COPY_CONFIG_DEST=/data
scenario sync-no-skip-newer modrinth "${CUSTOM_MOUNT[@]}" -e COPY_CONFIG_SRC=/customizations -e COPY_CONFIG_DEST=/data -e SYNC_SKIP_NEWER_IN_DESTINATION=false
scenario sync-env-substitution modrinth -v "$CUSTOM_ENV:/customizations:ro" -e COPY_CONFIG_SRC=/customizations -e COPY_CONFIG_DEST=/data -e SYNC_SKIP_NEWER_IN_DESTINATION=false -e CFG_SPIKE_TOKEN=spike-secret-123

patch_scenario patch-happy happy -e CFG_PATCH_VAL=fromenv
patch_scenario patch-missing-path missing -e CFG_PATCH_VAL=fromenv
patch_scenario patch-renamed-after-upgrade renamed

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
