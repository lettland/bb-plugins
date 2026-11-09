# bb-plugin-typesafe

Typed decisions for bb agents from [TypeSafe](https://docs.typesafe.ai)'s Jev
model. The plugin ships two things:

- A `typesafe_decide` agent tool: the agent asks 1–8 typed questions (Choice
  between named options, Noul yes/no probability, or Score on a 2–10-level
  scale) about some `state` text and gets calibrated, clamped numbers back.
- Opening-request triage: on a top-level thread's first user message, the
  plugin classifies the request with Jev (within a 1.5 s budget) and adds one
  advisory line to the thread's instructions, e.g.

  > TypeSafe triage of this thread's opening request (advisory): heavy_change
  > (p=0.75, conf 0.83); plan first p=0.90. Later decisions: call
  > typesafe_decide.

Everything is advisory: explicit user or brief requirements, and repository
rules, always win over a TypeSafe answer. The hook always lets the message
proceed — a slow or failed call changes nothing but the missing advice. One
exception: the `planApproval` RPC (below) feeds auto-review's missing-plan
gate, so its answer can lift that gate. It only lifts it; no answer, or an
answer below auto-review's threshold, leaves the gate as it was.

## What is sent to api.typesafe.ai

- For triage: the thread's opening request text (redacted, truncated to 8000
  characters) and the two fixed triage questions.
- For `typesafe_decide`: the agent-supplied `state` text or JSON object
  (serialized, at most 16000 characters) and its questions.
- For the `planApproval` RPC: the text of a user's typed reply after a plan was
  presented (redacted, truncated to 4000 characters) and one fixed question.
  The call is made once per reply that TypeSafe answers; a reply it gave no
  answer for (timeout, HTTP error, bad response) is sent again at the next
  review.

Both go through one redaction pass first: common token shapes (GitHub, Slack,
AWS, OpenAI-style `sk-` tokens, `Bearer` headers, PEM key blocks, URL
userinfo, and `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=` values) are replaced with
`REDACTED`. Redaction is best-effort — do not paste secrets into `state` in
the first place.

## Privacy

Per TypeSafe's published terms: TypeSafe does not train or fine-tune on
Input; personal data is retained only as long as reasonably necessary; the
service is hosted and processed in the United States; and Input is not
disclosed to third parties other than service providers. Each call is billed:
input tokens are billable, output tokens are currently free. The triage call
fires once per top-level thread; tool calls fire only when an agent chooses to
ask; the `planApproval` call fires once per reply that TypeSafe answers; a reply
it gave no answer for (timeout, HTTP error, bad response) is sent again at the
next review.

## The `planApproval` RPC

`planApproval({ projectId, text })` returns `{ approves: number | null }`: the
Noul probability that `text` approves the plan the agent just presented.
auto-review calls it to credit an approval typed in chat. `approves` is `null`
when TypeSafe gives no answer (no key, an HTTP error, a timeout, a bad
response) and for a project matched by `skipProjects`, in which case nothing
is sent. Any installed plugin can call this RPC, and every call spends your
TypeSafe key.

## Settings

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `apiKey` | string (secret) | — | TypeSafe API key. Falls back to the `TYPESAFE_API_KEY` environment variable when unset. |
| `model` | string | `jev-1.14.0` | Pinned Jev model id, so classification does not drift. |
| `triage` | boolean | on | Classify each top-level thread's opening request and add the advisory line. |
| `skipProjects` | string (JSON) | `[]` | JSON array of project-name globs that get neither triage nor the tool, e.g. `["sandbox-*"]`. `*` is the only special character. |

Without an effective key the plugin reports "no TypeSafe key: triage and tool
inactive" in its status detail and stays inactive until a key is set.

```sh
bb plugin config typesafe set apiKey "<key>"       # stored as a secret
bb plugin config typesafe set triage false         # turn triage off, keep the tool
bb plugin config typesafe set skipProjects '["sandbox-*", "legacy"]'
```

`skipProjects` also removes the tool in the skipped projects; side chats never
get the tool. An invalid `skipProjects` value is rejected on write; an older
stored value that no longer parses is ignored with a warning.

## Confirming triage is active

`bb plugin list` shows the plugin; its status detail names a missing key.
When a thread's opening request has been triaged, the thread's instructions
contain the "TypeSafe triage of this thread's opening request" line above.

## Constraints

- The tool is advisory only; nothing enforces its answers.
- Triage runs once per thread, only for a top-level thread's first inline user
  message. Re-attempts, child threads, and side chats never trigger it.
- Answers are clamped client-side: confidence, probabilities, and Noul values
  to [0, 1]; Score to [0, 10]. A response that fails validation is reported to
  the agent as "bad response" and the thread carries on.
