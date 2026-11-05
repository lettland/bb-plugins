# Third-party notices

thread-list-fork is licensed MIT (see `LICENSE`). It is a derivative of the built-in `thread-list` plugin of bb, and it vendors files from bb's component registry. Both stay under their own license, which is the MIT license quoted verbatim below. Each section names the upstream, the commit or tag it derives from, the thread-list-fork files derived from it, and the license text.

---

## bb built-in `thread-list` plugin (MIT)

- Upstream: <https://github.com/get-bb/bb>, directory `plugins/thread-list`.
- Upstream copy base: commit `dbb247c60f` of `get-bb/bb`, the upstream commit the fork was last rebased onto.
- Fork ref: this copy was taken from the Lettland fork of bb, which carries modifications to the upstream plugin on top of that base. The fork source is recorded as the annotated tag `fork-copy-thread-list-fork-20261103` in the fork repository, tree hash `9d29b4f4513e866a9c1c66fdffc1d045ba3b248d`. The modifications are the difference between `plugins/thread-list` at `dbb247c60f` and at that tag.
- Derived thread-list-fork files (modified): every source file of the plugin, including the fork's modifications; plus these changes made for this collection:
  - `package.json` (package name `@lettland/bb-plugin-thread-list-fork`, repository, homepage, bugs, and `publishConfig` point at this collection; `@get-bb/plugin-sdk` and every dependency pinned exactly; `@bb/shared-ui` replaced by the registry items' packages; `build` and `test` scripts adapted; `private` removed),
  - `package-lock.json` (added),
  - `tsconfig.json` (`@/*` mapped onto the plugin directory, as `pnpm check:plugin-forks` writes it),
  - `vitest.config.ts` (coverage block added),
  - `fork-sdk-types.ts` (added: structural declarations of the fork-only thread indicator kinds `waiting-for-plan-approval` and `waiting-for-answer`, absent from the published `@get-bb/plugin-sdk` types), and the files that import it: `app/model/fixtures.ts` and `app/model/thread-status.ts` (added: a local copy of the SDK's `experimental_resolveThreadStatus`, ported from `@get-bb/plugin-sdk` 0.6.112 (`dist/internal/thread-status.js`, built from `packages/plugin-sdk` of the same `get-bb/bb` repository and under the same MIT license), which also returns those two indicators, and which the published SDK resolver does not; `app/model/thread-status.test.ts` checks the copy against the installed SDK resolver). `app/rows/ThreadRow.tsx` and `app/list/groupRollups.ts` call that copy instead of the SDK export, because the stable bb that the release workflow installs (0.48.1, SDK 0.6.104) does not export `experimental_resolveThreadStatus` to `bb plugin build`. `app/model/thread-activity.ts` and `app/model/thread-activity.test.ts` are deleted, as upstream deleted them
  - the plugin id of this copy is `thread-list-fork`, so two things that the in-tree plugin derives from the literal id `thread-list` changed here: `server.ts` registers the CLI under the fixed name `thread-list` (upstream names it after the plugin id), and the host action keys `<plugin id>/move` and `<plugin id>/customizeRowActions` are built from the plugin id the SDK supplies at runtime (upstream hardcodes `thread-list/move` and `thread-list/customizeRowActions`). The preference parsers in `shared/preferences.ts` (`parsePreferenceValue`, `parseStoredPreferenceValue`, `describePreference`) therefore take the plugin id, `app/preferences/preferences-sync.ts` and `app/rows/ThreadRow.tsx` pass it, `skills/thread-list/SKILL.md` names the action key `thread-list-fork/move`, and the tests were changed or added to match (`server.test.ts`, `app/rows/ThreadRow.test.tsx`, `app/model/project-groups.test.ts`),
  - `LICENSE` and `THIRD_PARTY_NOTICES.md` (this file), added.
- Copyright: the upstream `LICENSE` reads `Copyright (c) 2026 Michael Yong`.

License text: [`LICENSE`](LICENSE) in this directory (kept verbatim from upstream).

---

## BB component registry items (MIT)

- Upstream: <https://github.com/get-bb/bb>, `packages/plugin-registry`.
- Provenance: registry items as built from the fork source at tag `fork-copy-thread-list-fork-20261103` (upstream copy base `dbb247c60f`), written into this directory by `scripts/lib/plugin-fork.mjs`. Items: action-menu-items, button, checkbox, chrome-style-tokens, coarse-pointer-sizing, compact-long-press-menu, confirm-delete-dialog, context-menu, context-selection, dialog, dropdown-menu, empty-state, icon, inline-rename, inline-rename-editor, inline-rename-presentation-cases, input, menu-item-hover, motion, overlay-anchor, overlay-trigger, portal-scope, rename-dialog, rename-session-dialog, responsive-overlay, shortcut-pill, sidebar-customize-panel, sidebar-hover-actions, sidebar-row-classes, sidebar-visibility-customize, skeleton, sortable-motion, split-pane-mini-map, thread-list-empty-state, tooltip, use-browser-dimming-modal, use-compact-viewport, use-dialog-state, use-drag-click-suppression, use-media-query, use-pointer-coarse, use-reorder-dnd, use-sidebar-reorder-dnd, utils.
- Derived thread-list-fork files (modified): `components/ui/inline-rename.tsx`, `components/ui/sidebar-row-classes.ts` (the fork's changes to these registry items).
- Derived thread-list-fork files (verbatim): `components/ui/action-menu-items.tsx`, `components/ui/button.tsx`, `components/ui/checkbox.tsx`, `components/ui/chrome-style-tokens.ts`, `components/ui/coarse-pointer-sizing.ts`, `components/ui/compact-long-press-menu.tsx`, `components/ui/confirm-delete-dialog.tsx`, `components/ui/context-menu.tsx`, `components/ui/context-selection.ts`, `components/ui/dialog.tsx`, `components/ui/dropdown-menu.tsx`, `components/ui/empty-state.tsx`, `components/ui/hooks/use-compact-viewport.tsx`, `components/ui/hooks/use-media-query.ts`, `components/ui/hooks/use-pointer-coarse.ts`, `components/ui/icon.tsx`, `components/ui/inline-rename-editor.tsx`, `components/ui/inline-rename-presentation-cases.ts`, `components/ui/input.tsx`, `components/ui/menu-item-hover.tsx`, `components/ui/motion.ts`, `components/ui/overlay-anchor.ts`, `components/ui/overlay-trigger.ts`, `components/ui/rename-dialog.tsx`, `components/ui/rename-session-dialog.tsx`, `components/ui/responsive-overlay.tsx`, `components/ui/shortcut-pill.tsx`, `components/ui/sidebar-customize-panel.tsx`, `components/ui/sidebar-hover-actions.ts`, `components/ui/sidebar-visibility-customize.tsx`, `components/ui/skeleton.tsx`, `components/ui/sortable-motion.ts`, `components/ui/split-pane-mini-map.tsx`, `components/ui/thread-list-empty-state.tsx`, `components/ui/tooltip.tsx`, `components/ui/use-dialog-state.ts`, `components/ui/use-drag-click-suppression.ts`, `components/ui/use-reorder-dnd.ts`, `components/ui/use-sidebar-reorder-dnd.ts`, `hooks/useBrowserDimmingModal.ts`, `lib/portal-scope.ts`, `lib/utils.ts`.
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
