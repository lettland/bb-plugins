# Third-party notices

tasks-fork is licensed MIT (see `LICENSE`). It is a derivative of the built-in `tasks` plugin of bb, and it vendors files from bb's component registry. Both stay under their own license, which is the MIT license quoted verbatim below. Each section names the upstream, the commit or tag it derives from, the tasks-fork files derived from it, and the license text.

---

## bb built-in `tasks` plugin (MIT)

- Upstream: <https://github.com/get-bb/bb>, directory `plugins/tasks`.
- Upstream copy base: commit `916d684ac2` of `get-bb/bb`, the upstream commit the fork was last rebased onto.
- Fork ref: this copy was taken from the Lettland fork of bb, which carries modifications to the upstream plugin on top of that base. The fork source is recorded as the annotated tag `fork-copy-tasks-fork-20261102` in the fork repository, tree hash `750026e092bff8d4fefca48ac49f8619451e8af9`. The modifications are the difference between `plugins/tasks` at `916d684ac2` and at that tag.
- Derived tasks-fork files (modified): every source file of the plugin, including the fork's modifications; plus these changes made for this collection:
  - `package.json` (package name `@lettland/bb-plugin-tasks-fork`, repository, homepage, bugs, and `publishConfig` point at this collection; `@get-bb/plugin-sdk` and every dependency pinned exactly; `@bb/shared-ui` replaced by the registry items' packages; `build` and `test` scripts adapted; `private` removed),
  - `package-lock.json` (added),
  - `tsconfig.json` (`@/*` mapped onto the plugin directory, as `pnpm check:plugin-forks` writes it),
  - `vitest.config.ts` (coverage block added),
  - `plugin-icon-names.test.ts` and `host-icon-names.ts` (added: a port of the fork's `apps/app/src/components/plugin/tasks-plugin-icon-names.test.ts`, which checks icon names against a snapshot of the host's built-in icon names)
  - `LICENSE` and `THIRD_PARTY_NOTICES.md` (this file), added.
- Copyright: the upstream `LICENSE` reads `Copyright (c) 2026 Michael Yong`.

License text: [`LICENSE`](LICENSE) in this directory (kept verbatim from upstream).

---

## BB component registry items (MIT)

- Upstream: <https://github.com/get-bb/bb>, `packages/plugin-registry`.
- Provenance: registry items as built from the fork source at tag `fork-copy-tasks-fork-20261102` (upstream copy base `916d684ac2`), written into this directory by `scripts/lib/plugin-fork.mjs`. Items: button, coarse-pointer-sizing, command, confirm-delete-dialog, context-menu, delayed-loading, dialog, dropdown-menu, hover-reveal, icon, input, menu-item-hover, motion, overlay-anchor, overlay-trigger, popover, portal-scope, responsive-overlay, select, skeleton, tabs, textarea, tooltip, use-browser-dimming-modal, use-compact-viewport, use-media-query, use-pointer-coarse, utils.
- Derived tasks-fork files (modified): none.
- Derived tasks-fork files (verbatim): `components/ui/button.tsx`, `components/ui/coarse-pointer-sizing.ts`, `components/ui/command.tsx`, `components/ui/confirm-delete-dialog.tsx`, `components/ui/context-menu.tsx`, `components/ui/delayed-loading.tsx`, `components/ui/dialog.tsx`, `components/ui/dropdown-menu.tsx`, `components/ui/hooks/use-compact-viewport.tsx`, `components/ui/hooks/use-media-query.ts`, `components/ui/hooks/use-pointer-coarse.ts`, `components/ui/hover-reveal.ts`, `components/ui/icon.tsx`, `components/ui/input.tsx`, `components/ui/menu-item-hover.tsx`, `components/ui/motion.ts`, `components/ui/overlay-anchor.ts`, `components/ui/overlay-trigger.ts`, `components/ui/popover.tsx`, `components/ui/responsive-overlay.tsx`, `components/ui/select.tsx`, `components/ui/skeleton.tsx`, `components/ui/tabs.tsx`, `components/ui/textarea.tsx`, `components/ui/tooltip.tsx`, `hooks/useBrowserDimmingModal.ts`, `lib/portal-scope.ts`, `lib/utils.ts`.
- Copyright: `Copyright (c) 2026 Michael Yong`.

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
