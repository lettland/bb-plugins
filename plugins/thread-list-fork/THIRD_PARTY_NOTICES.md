# Third-party notices

thread-list-fork is licensed MIT (see `LICENSE`). It is a derivative of the built-in `thread-list` plugin of bb, and it vendors files from bb's component registry. Both stay under their own license, which is the MIT license quoted verbatim below. Each section names the upstream, the commit or tag it derives from, the thread-list-fork files derived from it, and the license text.

---

## bb built-in `thread-list` plugin (MIT)

- Upstream: <https://github.com/get-bb/bb>, directory `plugins/thread-list`.
- Upstream copy base: commit `916d684ac2` of `get-bb/bb`, the upstream commit the fork was last rebased onto.
- Fork ref: this copy was taken from the Lettland fork of bb, which carries modifications to the upstream plugin on top of that base. The fork source is recorded as the annotated tag `fork-copy-thread-list-fork-20261102` in the fork repository, tree hash `750026e092bff8d4fefca48ac49f8619451e8af9`. The modifications are the difference between `plugins/thread-list` at `916d684ac2` and at that tag.
- Derived thread-list-fork files (modified): every source file of the plugin, including the fork's modifications; plus these changes made for this collection:
  - `package.json` (package name `@lettland/bb-plugin-thread-list-fork`, repository, homepage, bugs, and `publishConfig` point at this collection; `@get-bb/plugin-sdk` and every dependency pinned exactly; `@bb/shared-ui` replaced by the registry items' packages; `build` and `test` scripts adapted; `private` removed),
  - `package-lock.json` (added),
  - `tsconfig.json` (`@/*` mapped onto the plugin directory, as `pnpm check:plugin-forks` writes it),
  - `vitest.config.ts` (coverage block added),
  - `fork-sdk-types.ts` (added: structural declarations of the fork-only thread indicator kinds `waiting-for-plan-approval` and `waiting-for-answer`, absent from the published `@get-bb/plugin-sdk` types), and the three files that import it: `app/model/thread-activity.ts`, `app/model/fixtures.ts`, `app/rows/ThreadRow.tsx` (plus the tests `app/model/thread-activity.test.ts` and `app/rows/ThreadRow.test.tsx`)
  - `LICENSE` and `THIRD_PARTY_NOTICES.md` (this file), added.
- Copyright: the upstream `LICENSE` reads `Copyright (c) 2026 Michael Yong`.

License text: [`LICENSE`](LICENSE) in this directory (kept verbatim from upstream).

---

## BB component registry items (MIT)

- Upstream: <https://github.com/get-bb/bb>, `packages/plugin-registry`.
- Provenance: registry items as built from the fork source at tag `fork-copy-thread-list-fork-20261102` (upstream copy base `916d684ac2`), written into this directory by `scripts/lib/plugin-fork.mjs`. Items: action-menu-items, button, checkbox, chrome-style-tokens, coarse-pointer-sizing, compact-long-press-menu, confirm-delete-dialog, context-menu, context-selection, dialog, dropdown-menu, empty-state, icon, inline-rename, inline-rename-editor, input, menu-item-hover, motion, overlay-anchor, overlay-trigger, portal-scope, rename-dialog, responsive-overlay, shortcut-pill, sidebar-customize-panel, sidebar-hover-actions, sidebar-row-classes, sidebar-visibility-customize, skeleton, sortable-motion, split-pane-mini-map, thread-list-empty-state, tooltip, use-browser-dimming-modal, use-compact-viewport, use-dialog-state, use-drag-click-suppression, use-media-query, use-pointer-coarse, use-reorder-dnd, use-sidebar-reorder-dnd, utils.
- Derived thread-list-fork files (modified): `components/ui/inline-rename.tsx`, `components/ui/sidebar-row-classes.ts` (the fork's changes to these registry items).
- Derived thread-list-fork files (verbatim): `components/ui/action-menu-items.tsx`, `components/ui/button.tsx`, `components/ui/checkbox.tsx`, `components/ui/chrome-style-tokens.ts`, `components/ui/coarse-pointer-sizing.ts`, `components/ui/compact-long-press-menu.tsx`, `components/ui/confirm-delete-dialog.tsx`, `components/ui/context-menu.tsx`, `components/ui/context-selection.ts`, `components/ui/dialog.tsx`, `components/ui/dropdown-menu.tsx`, `components/ui/empty-state.tsx`, `components/ui/hooks/use-compact-viewport.tsx`, `components/ui/hooks/use-media-query.ts`, `components/ui/hooks/use-pointer-coarse.ts`, `components/ui/icon.tsx`, `components/ui/inline-rename-editor.tsx`, `components/ui/input.tsx`, `components/ui/menu-item-hover.tsx`, `components/ui/motion.ts`, `components/ui/overlay-anchor.ts`, `components/ui/overlay-trigger.ts`, `components/ui/rename-dialog.tsx`, `components/ui/responsive-overlay.tsx`, `components/ui/shortcut-pill.tsx`, `components/ui/sidebar-customize-panel.tsx`, `components/ui/sidebar-hover-actions.ts`, `components/ui/sidebar-visibility-customize.tsx`, `components/ui/skeleton.tsx`, `components/ui/sortable-motion.ts`, `components/ui/split-pane-mini-map.tsx`, `components/ui/thread-list-empty-state.tsx`, `components/ui/tooltip.tsx`, `components/ui/use-dialog-state.ts`, `components/ui/use-drag-click-suppression.ts`, `components/ui/use-reorder-dnd.ts`, `components/ui/use-sidebar-reorder-dnd.ts`, `hooks/useBrowserDimmingModal.ts`, `lib/portal-scope.ts`, `lib/utils.ts`.
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
