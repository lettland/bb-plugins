The sidebar thread list, as a plugin.

## What you get

- **Pinned** and **Threads** sections, plus the custom sections you create.
- **Spaces**: each Space bb provides is a top-level group in every organization (by project, by machine, and Custom). A thread in a Space appears only in its Space group, nested like any other group. Create a Space from a header menu's New Space…, then rename it, edit its brief, start a thread in it, or archive and unarchive it from its header. An archived Space keeps its threads, shows " (archived)" after its name, and offers no new thread. The thread menu's core Move to Space action moves threads. The Space directory, the allowed projects, and the archive state are also managed in Settings → Valksor → Spaces.
- Organize by project, by machine, or chronologically, with independent thread and project sorting.
- Named, collapsible project groups that keep related projects together.
- Nested child threads, worktree grouping, drag to reorder, pin, nest, and move between sections.
- Inline rename, keyboard jump shortcuts, and the same status glyphs bb draws elsewhere.
- Agent provider icons before thread titles, controlled by Organize → Rows → Provider icons.
- A metadata line under thread titles where plugins show details such as the pull request number, controlled by Organize → Rows → Metadata while the Thread row metadata experiment is on.
- Unread threads listed above read ones, controlled by Organize → Groups → By read status.

## How it works

The plugin reads bb's live thread view through the plugin SDK and stores your layout choices (organization, sort, section order, project groups, collapsed groups) in its own storage, synced to every open window. Sections and thread moves go through bb's public API, so `bb thread section` and this list always agree.

The sidebar's project order (groups, custom or alphabetical sort) is also written to bb's project order, so Settings → Projects, the project pickers and `bb project list` follow it. Activity sort is not written.

Spaces come from bb's Spaces feature (`bb space`). The list shows them when the host provides them and renders as before when it does not. A new Space starts right after Pinned. Pinned threads in a Space stay under Pinned, as pinned project threads do. Deleting a Space sends its threads back to their projects; its directory and files stay on disk.

Disable the plugin to hide the list; another thread-list plugin can take its place under Settings → Appearance.
