#!/bin/sh
# Build from a clean server checkout; keep data/config in the existing installation.
set -eu
[ "$#" -eq 1 ] || { echo 'Usage: sh scripts/git-release.sh /absolute/installation'; exit 2; }
installation=$(CDPATH= cd -- "$1" && pwd)
source_root=$(git rev-parse --show-toplevel)
cd "$source_root"
git diff --quiet && git diff --cached --quiet || { echo 'Checkout has uncommitted changes'; exit 2; }
[ -z "$(git ls-files --others --exclude-standard)" ] || { echo 'Checkout has untracked files'; exit 2; }
[ -f "$installation/deployment/secrets/.env" ] && [ -f "$installation/scripts/deploy.mjs" ] || { echo 'Existing installation required'; exit 2; }
# Recovery snapshots can exceed a small system /tmp tmpfs; use the installation disk.
TMPDIR="$installation/deployment/tmp"
mkdir -p "$TMPDIR"
chmod 700 "$TMPDIR"
export TMPDIR
revision=$(git rev-parse HEAD)
release="$installation/deployment/git-releases/$revision"
mkdir -p "$release"
chmod 700 "$release"
printf '%s\n' "$revision" > "$release/commit.txt"
docker build --label "org.opencontainers.image.revision=$revision" -t "axima-commerce:git-$revision" .
image=$(docker image inspect --format '{{.Id}}' "axima-commerce:git-$revision")
printf '%s\n' "$image" > "$release/image.txt"
# Validate runtime readability before stopping any writers (checkout may use umask 077).
docker run --rm --network none --entrypoint node "$image" -e 'const fs=require("fs");function check(p){const d=fs.statSync(p).isDirectory();fs.accessSync(p,fs.constants.R_OK|(d?fs.constants.X_OK:0));if(d)for(const f of fs.readdirSync(p))check(p+"/"+f)}for(const p of ["/app/public","/app/prisma","/app/scripts","/app/packages/license-core"])check(p);console.log("PASS: runtime source files readable")'
# Use the reviewed migration policy delivered by this Git revision.
cp "$installation/scripts/deployment-lib.mjs" "$release/previous-deployment-lib.mjs"
cp "$source_root/scripts/deployment-lib.mjs" "$installation/scripts/deployment-lib.mjs"
cd "$installation"
node scripts/deploy.mjs update --image "$image"
cp deployment/last-operation.json "$release/update-operation.json"
node scripts/deploy.mjs verify
cp deployment/last-operation.json "$release/verify-operation.json"
printf 'GIT_RELEASE_PASS commit=%s image=%s\n' "$revision" "$image"
