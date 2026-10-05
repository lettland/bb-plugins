---
name: concise-output
description: Use when the user wants terser replies ("be brief", "less tokens", /concise) — sets the durable devkit:concise output style.
metadata:
  added: 2026-06-01
  last_reviewed: 2026-06-02
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-06-01"
  related: [technical-writing, llm-essentials, interview-first]
  keywords: [current, reply, session, whole]
  owns: concise-output
---

# Concise Output

Natural-language on-ramp for terse, token-lean replies. The **durable** mechanism is the `devkit:concise` **output style** — it edits the system prompt, so it persists every turn and survives `/compact`. A skill body is one-shot (it fades across a session), so this skill handles the immediate request and signposts the durable switch.

Drop the fluff, stay professional — no novelty register.

## When invoked

1. **Apply terse style to this reply.** Drop filler, hedging, pleasantries; prefer fragments; lead with the answer. Keep code, inline code, file paths, symbol/API names, error strings, commands, and numbers **exact** — quote errors verbatim. Drop back to full prose for security reasoning and destructive-action confirmations.
2. **Signpost the durable switch — once.** Tell the user: for the whole session, `/config` → Output style → **devkit:concise** (or set `outputStyle` in settings). Don't repeat this every turn.

## What this is not

Not a thinking budget — it makes the mouth smaller, not the brain. Reasoning, tool calls, and verification stay as thorough as ever; when brevity and substance conflict, substance wins. The full ruleset lives in the `devkit:concise` output style.
