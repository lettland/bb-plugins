# AGENTS.md

Applies to every plugin under `plugins/`. Also follow `~/.bb/AGENTS.md` where it does not conflict.

- A new env var is a last resort: put knobs in the plugin's config, resolved in one place as env > file > default. Env only for secrets, per-process channels, host-side posture, path relocation, or third-party conventions, and document every env var you add.
- Don't invent new config shapes for local convenience; map the change onto the plugin's existing config system or propose the shape first.
- Every upstream quirk a plugin discovers (an API rejecting a shape, a provider oddity) becomes a permanent regression test citing where it was learned; that ledger only grows.
- Versions are owned by the release bot: never hand-edit a `package.json` version; before changing a plugin's update or install mechanism, prove the existing path still works end-to-end with a no-op update first.
- Every change runs the plugin's own tests; CI gates coverage floors per plugin.
