---
name: margrave
description: Browse the hosted Margrave skill catalog through BB.
---

# Margrave

Open **Margrave** in the BB sidebar to browse the hosted catalog. Search by name, ID, or description, or filter by source. Select **Refresh** to fetch the current catalog.

```sh
bb margrave list
bb margrave list --json
```

BB reads the catalog from the hosted Margrave MCP server. JSON output includes a `sources` array with `id` and `skillCount` fields and a `skills` array with `id`, `name`, `description`, and `source` fields.
