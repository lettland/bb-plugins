#!/bin/sh
# Maintainer tool for the prebuilt write-confinement launcher. It does not ship in the npm tarball.
#
#   sh build/launcher.sh build    rebuild native/prebuilt/** and rewrite native/prebuilt/SHA256SUMS
#   sh build/launcher.sh verify   run the Go tests, then rebuild into a temp dir and compare with SHA256SUMS
#                                 and the committed binaries
#
# The Go toolchain is pinned on the `toolchain` line of native/prebuilt/SHA256SUMS (image tag plus
# multi-platform index digest). That line is the only place the Go version is named.
set -eu

here=$(cd "$(dirname "$0")" && pwd -P)
root=$(dirname "$here")
prebuilt=$root/native/prebuilt
sums=$prebuilt/SHA256SUMS
source_file=$root/native/landlock-run.go
test_file=$root/native/landlock-run_test.go
arches="amd64 arm64"
mode=${1:-}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sums_field() {
  # $1 = key on the left of the line ("toolchain" or "source").
  awk -v key="$1" '$1 == key { print $2; exit }' "$sums"
}

sums_binary() {
  # $1 = arch. The binary lines read "<sha256>  linux-<arch>/landlock-run".
  awk -v name="linux-$1/landlock-run" '$2 == name { print $1; exit }' "$sums"
}

require_docker() {
  command -v docker >/dev/null 2>&1 && docker version -f '{{.Server.Arch}}' >/dev/null 2>&1 \
    || fail "Docker is required to $1 the prebuilt launcher"
}

container=
cleanup() {
  [ -z "$container" ] || docker rm -f "$container" >/dev/null 2>&1 || true
  [ -z "${scratch:-}" ] || rm -rf "$scratch"
}
trap cleanup EXIT

# build_into <toolchain image> <output directory>
# The build container has no network and mounts only the source, read-only. It writes the binary
# inside its own writable layer; docker cp copies it out and the container is removed. No
# writable host mount is involved, so nothing depends on a bind mount showing writes in time.
build_into() {
  for arch in $arches; do
    mkdir -p "$2/linux-$arch"
    container=$(docker create --network none --user 65534:65534 \
      -e HOME=/tmp -e GOCACHE=/tmp/go-cache \
      -e CGO_ENABLED=0 -e GOOS=linux -e "GOARCH=$arch" -e GOTOOLCHAIN=local \
      -e GOAMD64=v1 -e GOARM64=v8.0 -e GOFLAGS= \
      --mount "type=bind,source=$source_file,target=/src/landlock-run.go,readonly" \
      "$1" \
      go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
      -o /tmp/landlock-run /src/landlock-run.go)
    docker start -a "$container" >/dev/null
    docker cp "$container:/tmp/landlock-run" "$2/linux-$arch/landlock-run"
    docker rm -f "$container" >/dev/null
    container=
  done
}

# test_in <toolchain image>
# Runs the launcher's Go tests in the pinned image: no network, source and test mounted read-only,
# and the container's native GOARCH. The tests only evaluate the seccomp program for both
# architectures (metadataFilter is pure), so one run covers amd64 and arm64.
test_in() {
  container=$(docker create --network none --user 65534:65534 \
    -e HOME=/tmp -e GOCACHE=/tmp/go-cache \
    -e CGO_ENABLED=0 -e GOOS=linux -e GOTOOLCHAIN=local -e GOFLAGS= \
    --mount "type=bind,source=$source_file,target=/src/landlock-run.go,readonly" \
    --mount "type=bind,source=$test_file,target=/src/landlock-run_test.go,readonly" \
    "$1" \
    go test /src/landlock-run.go /src/landlock-run_test.go)
  if ! test_output=$(docker start -a "$container" 2>&1); then
    printf '%s\n' "$test_output" >&2
    fail "go test failed for native/landlock-run.go; fix the launcher or its tests"
  fi
  docker rm -f "$container" >/dev/null
  container=
}

[ -f "$sums" ] || fail "native/prebuilt/SHA256SUMS is missing; it must at least hold the toolchain line"
toolchain=$(sums_field toolchain)
[ -n "$toolchain" ] || fail "native/prebuilt/SHA256SUMS has no toolchain line (toolchain golang:<version>@sha256:<index digest>)"
# Only the official Docker Hub golang image, pinned by digest: a toolchain line that names another
# registry or repository could build matching binaries with a compiler nobody reviewed.
printf '%s\n' "$toolchain" | grep -Eq '^golang:[0-9]+\.[0-9]+(\.[0-9]+)?@sha256:[0-9a-f]{64}$' \
  || fail "SHA256SUMS toolchain must be golang:<version>@sha256:<64 hex> from the official image, got: $toolchain"

case $mode in
  build)
    require_docker build
    scratch=$(mktemp -d "${TMPDIR:-/tmp}/launcher-build.XXXXXX")
    build_into "$toolchain" "$scratch"
    for arch in $arches; do
      mkdir -p "$prebuilt/linux-$arch"
      cp "$scratch/linux-$arch/landlock-run" "$prebuilt/linux-$arch/landlock-run"
      chmod 0755 "$prebuilt/linux-$arch/landlock-run"
    done
    {
      printf 'toolchain %s\n' "$toolchain"
      printf 'source %s\n' "$(sha256_of "$source_file")"
      for arch in $arches; do
        printf '%s  linux-%s/landlock-run\n' "$(sha256_of "$prebuilt/linux-$arch/landlock-run")" "$arch"
      done
    } >"$sums.tmp"
    mv "$sums.tmp" "$sums"
    printf 'built native/prebuilt with %s\n' "$toolchain"
    ;;
  verify)
    [ -f "$test_file" ] || fail "native/landlock-run_test.go is missing"
    require_docker verify
    test_in "$toolchain"
    recorded_source=$(sums_field source)
    [ "$recorded_source" = "$(sha256_of "$source_file")" ] \
      || fail "SHA256SUMS source line does not match native/landlock-run.go; run build/launcher.sh build"
    for arch in $arches; do
      expected=$(sums_binary "$arch")
      [ -n "$expected" ] || fail "SHA256SUMS has no line for linux-$arch/landlock-run; run build/launcher.sh build"
      [ -f "$prebuilt/linux-$arch/landlock-run" ] \
        || fail "native/prebuilt/linux-$arch/landlock-run is missing; run build/launcher.sh build"
      [ "$(sha256_of "$prebuilt/linux-$arch/landlock-run")" = "$expected" ] \
        || fail "native/prebuilt/linux-$arch/landlock-run does not match SHA256SUMS; run build/launcher.sh build"
    done
    scratch=$(mktemp -d "${TMPDIR:-/tmp}/launcher-verify.XXXXXX")
    build_into "$toolchain" "$scratch"
    for arch in $arches; do
      [ "$(sha256_of "$scratch/linux-$arch/landlock-run")" = "$(sums_binary "$arch")" ] \
        || fail "rebuilt linux-$arch/landlock-run does not match SHA256SUMS; run build/launcher.sh build"
    done
    printf 'prebuilt launcher verified against %s\n' "$toolchain"
    ;;
  *)
    fail "usage: sh build/launcher.sh build|verify"
    ;;
esac
