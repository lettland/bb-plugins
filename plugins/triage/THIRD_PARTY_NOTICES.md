# Third-party notices

triage is licensed MIT (see `LICENSE`). Some of its content is adapted from the
third-party works below, which stay under their own licenses. Each section
names the upstream, the commit or tag it was fetched at (fetched 2026-10-21),
the triage files derived from it, and the upstream license text verbatim.

---

## Triage (MIT)

- Upstream: <https://github.com/MayankBansal12/bb-plugin-triage>, author Mayank Bansal.
- Provenance: commit `5e74ed686c03a853c5ff3bf33883b91e75c16c2f` (upstream release 0.1.0), fetched 2026-10-21. The whole plugin derives from it; the upstream `LICENSE` is kept verbatim in this directory.
- Derived triage files (modified): `package.json` (package name, repository, homepage, bugs, and `publishConfig` point at this collection; `engines.bbPluginSdk` widened to `>=0.4.47`; `test` script runs `tsc --noEmit` before the test suite), `package-lock.json` (root package name and engines to match), and `README.md` (installation and development docs for this collection). The upstream `.github/` workflows and `.gitignore` are dropped, and `THIRD_PARTY_NOTICES.md` (this file) is added.
- Copyright: `Copyright (c) 2026 Mayank Bansal`, per the upstream `README` license line and `package.json` author field.

License text: [`LICENSE`](LICENSE) in this directory (kept verbatim from upstream).

---

## BB component registry and Plugin SDK types (MIT)

- Upstream: <https://github.com/get-bb/bb>.
- Provenance: registry tag `desktop-v0.36.0` (the tag `components.json` references), fetched 2026-10-21. Files were compared against the registry items' `content` under `packages/plugin-registry/r/*.json` at that tag.
- Derived triage files (modified): `components/ui/badge.tsx`, `components/ui/button.tsx`, `components/ui/drawer.tsx`, `components/ui/dropdown-menu.tsx`, `components/ui/icon.tsx`, `components/ui/motion.ts`, `components/ui/popover.tsx`, `lib/portal-scope.ts`, `components/ui/select.tsx`, `components/ui/skeleton.tsx`, `components/ui/textarea.tsx`.
- Derived triage files (verbatim): `components/ui/alert-dialog.tsx`, `components/ui/calendar.tsx`, `components/ui/card.tsx`, `components/ui/coarse-pointer-sizing.ts`, `components/ui/dialog.tsx`, `components/ui/input.tsx`, `components/ui/menu-item-hover.tsx`, `components/ui/overlay-trigger.ts`, `components/ui/responsive-overlay.tsx`, `components/ui/hooks/use-compact-viewport.tsx`, `components/ui/hooks/use-media-query.ts`, `components/ui/hooks/use-pointer-coarse.ts`, `hooks/useBrowserDimmingModal.ts`, `lib/utils.ts`.
- Also derived from the same upstream: `types/bb-plugin-sdk.d.ts` and `types/bb-plugin-sdk-app.d.ts`, generated `@get-bb/plugin-sdk` type declarations (portable declarations for the Plugin SDK from get-bb/bb).
- Copyright: the upstream `LICENSE` at tag `desktop-v0.36.0` reads `Copyright (c) 2026 Michael Yong`.

License text (verbatim):

```text
MIT License

Copyright (c) 2026 Michael Yong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
