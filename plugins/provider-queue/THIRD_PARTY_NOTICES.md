# Third-party notices

provider-queue is licensed MIT (see `LICENSE`). Some of its content is adapted
from the third-party works below, which stay under their own licenses. Each
section names the upstream, the path it was copied through, the provider-queue
files derived from it, and the upstream license text verbatim.

---

## BB component registry components (MIT)

- Upstream: <https://github.com/get-bb/bb>.
- Provenance: copied 2026-10-28 from `plugins/triage/components/ui/` in this
  collection, which itself derived them from the registry items' `content`
  under `packages/plugin-registry/r/*.json` at tag `desktop-v0.36.0` (see
  triage's `THIRD_PARTY_NOTICES.md` for that derivation).
- Derived provider-queue files (modified): `components/ui/badge.tsx` (one
  comment line added; no other change), `components/ui/button.tsx` (one
  comment line added; `asChild` and the Slot import removed; every variant
  and size kept),
  `components/ui/card.tsx` (`CardDescription` and `CardFooter` dropped;
  exports trimmed to `Card`, `CardHeader`, `CardTitle`, `CardContent`),
  `components/ui/icon.tsx` (icon map trimmed to the glyphs this panel draws),
  `lib/utils.ts` (kept `cn` only).
- Derived provider-queue files (unmodified):
  `components/ui/coarse-pointer-sizing.ts`, `components/ui/input.tsx`,
  `components/ui/motion.ts`, `components.json`.
- Copyright: the upstream `LICENSE` at tag `desktop-v0.36.0` reads
  `Copyright (c) 2026 Michael Yong`.

License text (verbatim):

```
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

---

## Triage status dot (MIT)

- Upstream: <https://github.com/MayankBansal12/bb-plugin-triage>, author
  Mayank Bansal, via `plugins/triage/components/ui/status-dot.tsx` and the
  `.bb-status-dot` rules of its `app.css` (copied 2026-10-28).
- Derived provider-queue files (modified):
  `components/ui/status-dot.tsx` (kept `tone` and `pulse` only; the span is
  always `aria-hidden`) and the status-dot rules of `app.css` (trimmed to the
  `ongoing` and `unread` tones; the pulse curve inlined).
- Copyright: `Copyright (c) 2026 Mayank Bansal`, per the upstream `README`
  license line and `package.json` author field, as recorded in triage's
  `THIRD_PARTY_NOTICES.md`.

License text (verbatim):

```
MIT License

Copyright (c) 2026 Mayank Bansal

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
