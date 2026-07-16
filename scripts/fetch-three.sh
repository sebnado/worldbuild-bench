#!/bin/bash
# fetch-three.sh — populate scaffold/lib/ with the bundled runtime libraries:
#   lib/three/   Three.js ES-module build + the full examples/jsm addons tree
#   lib/rapier/  @dimforge/rapier3d-compat ESM build (optional physics engine;
#                the -compat build inlines the WASM as base64, so it runs
#                offline with no separate .wasm fetch)
#
# npm-installs each package into a temp dir, copies the runtime files, and
# writes a VERSION sentinel per lib. scaffold/lib/ is gitignored; every
# workspace seeded by `wb run` gets a copy of these libraries.
#
# Usage: bash scripts/fetch-three.sh [--force] [three@version] [@dimforge/rapier3d-compat@version]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
THREE_LIB="$SCRIPT_DIR/../scaffold/lib/three"
RAPIER_LIB="$SCRIPT_DIR/../scaffold/lib/rapier"
FORCE=0
THREE_PKG="three"
RAPIER_PKG="@dimforge/rapier3d-compat@0.19.3"  # pinned exact version

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    three@*) THREE_PKG="$arg" ;;
    @dimforge/rapier3d-compat@*) RAPIER_PKG="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fetch_three() {
  if [[ -f "$THREE_LIB/VERSION" && "$FORCE" != "1" ]]; then
    echo "Three.js r$(cat "$THREE_LIB/VERSION") already present at scaffold/lib/three (use --force to refresh)"
    return 0
  fi

  echo "Installing $THREE_PKG into a temp dir..."
  mkdir -p "$TMP_DIR/three"
  cd "$TMP_DIR/three"
  npm init -y --silent >/dev/null 2>&1
  npm install "$THREE_PKG" --silent

  echo "Copying build files + examples/jsm..."
  rm -rf "$THREE_LIB"
  mkdir -p "$THREE_LIB/build" "$THREE_LIB/examples"

  cp node_modules/three/build/*.js "$THREE_LIB/build/"
  cp -r node_modules/three/examples/jsm "$THREE_LIB/examples/jsm"

  local version
  version=$(node -p "JSON.parse(require('fs').readFileSync('node_modules/three/package.json','utf8')).version")
  echo "$version" > "$THREE_LIB/VERSION"

  echo "Done — Three.js r$version copied to scaffold/lib/three"
  echo "  build/three.module.min.js  (ES module entry — used by the import map)"
  echo "  examples/jsm/              (full addons tree: controls, loaders, postprocessing, ...)"
}

fetch_rapier() {
  local pinned="${RAPIER_PKG##*@}"
  if [[ -f "$RAPIER_LIB/VERSION" && "$(cat "$RAPIER_LIB/VERSION")" == "$pinned" && "$FORCE" != "1" ]]; then
    echo "Rapier $pinned already present at scaffold/lib/rapier (use --force to refresh)"
    return 0
  fi

  echo "Installing $RAPIER_PKG into a temp dir..."
  mkdir -p "$TMP_DIR/rapier"
  cd "$TMP_DIR/rapier"
  npm init -y --silent >/dev/null 2>&1
  npm install "$RAPIER_PKG" --silent

  echo "Copying ESM build (WASM inlined)..."
  rm -rf "$RAPIER_LIB"
  mkdir -p "$RAPIER_LIB"

  cp node_modules/@dimforge/rapier3d-compat/rapier.mjs "$RAPIER_LIB/"

  # The npm package does not ship its LICENSE file; fetch it from upstream (Apache-2.0).
  if [[ -f node_modules/@dimforge/rapier3d-compat/LICENSE ]]; then
    cp node_modules/@dimforge/rapier3d-compat/LICENSE "$RAPIER_LIB/LICENSE"
  else
    curl -fsSL https://raw.githubusercontent.com/dimforge/rapier.js/master/LICENSE -o "$RAPIER_LIB/LICENSE" \
      || echo "Apache-2.0 — see https://github.com/dimforge/rapier.js" > "$RAPIER_LIB/LICENSE"
  fi

  local version
  version=$(node -p "JSON.parse(require('fs').readFileSync('node_modules/@dimforge/rapier3d-compat/package.json','utf8')).version")
  echo "$version" > "$RAPIER_LIB/VERSION"

  echo "Done — @dimforge/rapier3d-compat $version copied to scaffold/lib/rapier"
  echo "  rapier.mjs  (self-contained ES module, WASM inlined — used by the import map)"
}

fetch_three
fetch_rapier
