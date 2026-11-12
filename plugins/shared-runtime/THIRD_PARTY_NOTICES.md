# Third-party notices

shared-runtime is licensed BSD-2-Clause (see `LICENSE`). The two prebuilt
launcher binaries it ships, `native/prebuilt/linux-amd64/landlock-run` and
`native/prebuilt/linux-arm64/landlock-run`, are compiled from
`native/landlock-run.go` with the Go toolchain below. Each binary statically
links the Go runtime and the Go standard library packages the launcher imports,
so the Go license applies to that part of the binaries.

---

## Go toolchain and standard library (BSD-3-Clause)

- Upstream: <https://go.dev/>, <https://github.com/golang/go>.
- Toolchain: Go 1.27.4, from the official Docker image
  `golang:1.27.4@sha256:5e8afd493a7124a8586e134d9b532731161d4b9becf9dee5a5956b107426f93d`
  (the multi-platform index digest). The same image reference is on the
  `toolchain` line of `native/prebuilt/SHA256SUMS`, which `build/launcher.sh`
  reads.
- Provenance: the license text below is the file `LICENSE` in the toolchain's
  `GOROOT` inside that image (`$(go env GOROOT)/LICENSE`), copied verbatim.
- Copyright: `Copyright 2009 The Go Authors.`

```text
Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
