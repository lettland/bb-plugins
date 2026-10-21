---
name: typesafe
description: "Usage of the typesafe_decide tool (typed Choice/Noul/Score decisions from TypeSafe's Jev model), the triage line it adds to opening requests, and the plugin's settings."
---

# TypeSafe decisions

The `typesafe` plugin gives bb agents typed decisions from TypeSafe's Jev
model. Everything it produces is advisory: explicit user or brief
requirements, and repository rules, always win.

## The typesafe_decide tool

Use `typesafe_decide` when a judgment call is genuinely uncertain and
material — choosing between viable options, sizing work before delegating, or
a proportionality check on a non-trivial change. Do not use it for exact
rules, lookups, math, or anything code or tests can check deterministically.
Never put secrets, credentials, or `.env` contents in `state`; they are sent
to api.typesafe.ai (US-hosted) after a best-effort redaction pass.

Act on a confident answer (confidence >= ~0.6, or a Noul clearly away from
0.5). Below that, use your own judgment and say you did.

## The triage line

On a top-level thread's first user message the plugin classifies the request
and adds one line to the thread's instructions:

> TypeSafe triage of this thread's opening request (advisory): heavy_change
> (p=0.75, conf 0.83); plan first p=0.90. Later decisions: call
> typesafe_decide.

`question` / `small_change` / `heavy_change` is the request kind with its
probability, and the Noul number is how much the request needs a plan first.
Treat the line as context, not an order.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `apiKey` | — | TypeSafe API key (secret). Falls back to the `TYPESAFE_API_KEY` environment variable. |
| `model` | `jev-1.13.0` | Pinned Jev model id. |
| `triage` | on | Opening-request triage. |
| `skipProjects` | `[]` | JSON array of project-name globs with neither triage nor the tool. |

Disable triage or skip projects without touching the tool:

```sh
bb plugin config typesafe set triage false
bb plugin config typesafe set skipProjects '["sandbox-*"]'
```

Without any key the plugin is inactive and reports it in its status detail
(see `bb plugin list`).
