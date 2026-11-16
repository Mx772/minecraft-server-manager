#!/usr/bin/env bash
# Usage: make-packs.sh OUTDIR
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -I "$here/make-packs.py" "${1:?output dir}"
