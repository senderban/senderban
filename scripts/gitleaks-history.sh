#!/bin/sh
# gitleaks over the whole history (incident 2026-10-28). Run by CI (Linux) and scripts/ci-local.mjs (a maintainer's machine).
# 8.30.1 = latest stable on 2026-10-28 (gh release list); the sha256 is the release's checksums file entry, measured that day.
set -eu
VERSION=8.30.1
SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb

if [ "$(uname -s)" = "Linux" ]; then
  dir="${RUNNER_TEMP:-$(mktemp -d)}"
  curl -fsSL -o "$dir/gitleaks.tar.gz" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_x64.tar.gz"
  echo "${SHA256}  $dir/gitleaks.tar.gz" | sha256sum -c -
  tar -xzf "$dir/gitleaks.tar.gz" -C "$dir" gitleaks
  bin="$dir/gitleaks"
else
  # Not Linux: the installed gitleaks, and only the pinned version (a different one may judge differently).
  bin=gitleaks
  if [ "$("$bin" version 2>/dev/null)" != "$VERSION" ]; then
    echo "gitleaks-history: gitleaks $VERSION is required on PATH" >&2
    exit 1
  fi
fi
"$bin" git --redact --no-banner .
