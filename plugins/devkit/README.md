# bb-plugin-devkit

devkit's skill library as a provider-neutral bb plugin. Agents locate the guidance they
need on demand instead of carrying every skill in context, and get devkit's calibrated
multi-perspective review and command workflows.

## Agent tools

| Tool | Purpose |
|---|---|
| `devkit_find_skills` | Rank library skills against a topic; returns slugs and descriptions |
| `devkit_load_skill` | Load one skill body by `slug`, or a shared reference file by `reference` |
| `devkit_docs` | Look up current library/framework documentation through Context7 (`query` or `libraryId`) |

The plugin also contributes a short instruction telling agents to look a topic up before
answering from memory.

## Skill tiers

- **Library** (`content/skills/`): the full skill set, searchable through
  `devkit_find_skills` and loaded with `devkit_load_skill`. Includes the `review-code`
  review workflow and the `cmd-*` command workflows. Shared references live in
  `content/references/`.
- **Always on** (`skills/`): `using-devkit` and `honest-completion`, surfaced as native
  skills in every thread.
- **Essentials** (`skills-generated/`): a small curated set (`debugging`, `go-essentials`,
  `python-essentials`, `security`, `testing-strategy`, `typescript`) copied from the
  library at build time and surfaced as native skills, except in side-chat forks. The list
  is `ESSENTIALS` in `src/select-skills.mjs`.

## GRC framework skills

Nine `grc-*` skills (`grc-gdpr`, `grc-soc2`, `grc-nis2`, `grc-eu-ai-act`, `grc-eu-cra`,
`grc-dora`, `grc-pci-dss`, `grc-hipaa`, `grc-ccpa`) and their 29 references are a generated, pinned
vendor copy of
[Sushegaad/Claude-Skills-Governance-Risk-and-Compliance](https://github.com/Sushegaad/Claude-Skills-Governance-Risk-and-Compliance)
(MIT; see `THIRD_PARTY_NOTICES.md`). They are knowledge packs for the compliance reviewer, which
loads them itself for each framework it rates **applies** (`content/references/reviewer-compliance.md`),
and they are ordinary `devkit_find_skills` results under neutral descriptions. They are not legal
advice, and the files carry a "do not edit" header. `content/grc-upstream.json` records the pinned
commit.

Re-sync from a local clone you fetched yourself (the script makes no network calls and reads the
commit object, never the working tree), then rebuild the index:

```sh
node scripts/sync-grc.mjs <path-to-upstream-clone> <full-40-hex-commit-sha>
node scripts/build-index.mjs
```

- Before bumping the SHA, a human reads the upstream diff between the old and the new commit.
  Upstream updates monthly.
- Update the matching section in `THIRD_PARTY_NOTICES.md` (heading, full SHA, fetch date) first; the
  sync fails if the notice does not name the commit.
- The sync fails, and writes nothing, on a symlink, an unexpected upstream file, an HTML comment, an
  invisible or bidi character, a dangling `references/<name>.md` citation, a malformed previous
  manifest, or a target file the previous manifest does not list.
- If a framework fails a gate, drop it from `FRAMEWORKS` in `scripts/sync-grc.mjs` and from the slug
  list in `reviewer-compliance.md` (a test enforces they match), and report it upstream. Never weaken
  a gate.

## CLI

| Command | What it does |
|---|---|
| `bb devkit skills list` | Every library skill (slug: description) |
| `bb devkit skills find <topic>` | Rank skills relevant to a topic |
| `bb devkit skills show <slug>` | Print one skill body |
| `bb devkit commands` | List the command workflows |
| `bb devkit run <command> [args...]` | Run a command workflow |
| `bb devkit review <code \| impl <base>..<head> \| plan <path>>` | Run the calibrated review over uncommitted changes, a commit range, or a plan file |

`run` and `review` inject a turn into the current thread when invoked from one;
elsewhere they print the instructions for an agent to follow. `review plan` always prints:
an injected turn carries the thread's permission mode and takes the agent out of plan mode,
so its next plan presentation would be approved without reaching the user. A plan review
ends with the revised plan presented for the user's approval, never with implementation.

The review applies five lenses: senior-dev, senior-qa, security, end-user, and compliance. The
compliance lens checks every framework (GDPR, SOC 2, licensing, …) on every review and is not legal
advice. A framework rated **applies** (committed repo evidence, or a `guidelines` doc saying it
applies) gets full severity; otherwise findings are still reported, capped at conditional Concerns.
A `guidelines` doc saying a regime does NOT apply is only named in those findings and never lowers
them. To declare which regimes apply, list a tracked doc that states them under `guidelines` in
`.devkit/review.yml`. The declaration takes effect for later changes once committed: a `guidelines`
doc or `review.yml` added or edited in the change under review carries no weight in that change's
own review. Example:

```yaml
guidelines:
  - docs/COMPLIANCE.md   # e.g. "GDPR applies; not in PCI scope"
```

The review also verifies the work against a `Request:` block built from the messages the user
typed in this thread that asked for it (a parent-written child-thread task prompt counts; GitHub
issue and PR bodies are third-party context, informing scope but never making a review implement
something), and its summary carries a `Done:` line (`Yes`, `No`, `Partially`, or `n/a (no request)`
when no request was found) and a `Backwards compatibility:` line naming any existing behaviour the
change alters for current users or callers.

Under bb, the review's five lens reviewers (and its closure review) run as bb child threads; outside
bb, or when spawning one fails, they run as the provider's own subagents, or sequentially in the
orchestrating thread as a last resort. See `review-code`'s `§3` for the recipe and its tree guard. A
full review costs about six provider sessions (five lenses plus closure), more when lockfiles
change. Archived reviewer threads stay openable, so their transcripts keep the reviewed diff,
including any secret values in it — run `bb thread delete --yes <id>` on one after reviewing a diff
with a leaked secret or real personal data, rather than waiting on its parent (`--yes` skips a
confirmation prompt an unattended agent would otherwise hang on). They're spawned with
`--lifecycle-owner-thread`, so they're deleted along with their parent anyway.

Code and impl reviews also check added or changed **public** dependencies for known CVEs, run by
the orchestrator (never a reviewer) and handed to the security reviewer only:

- **What is sent:** the names and versions of added or changed public dependencies to
  `api.osv.dev` (Google-operated OSV), plus the request metadata any HTTPS call carries (IP address,
  time). Packages from private sources are skipped, failing closed: Go (`GOPRIVATE` and friends,
  non-default `GOPROXY`, `replace` targets), npm scopes with a configured private registry or auth
  token, and PyPI packages from any non-pypi.org index or source.
- **Requires** `curl` and `jq`; without them the lookup reports `not run`.
- **On by default.** Opt out with `DEVKIT_CVE_LOOKUP=off` (exactly `off`), set in the environment
  of the agent process (shell profile, or bb's machine env).
- **Unattended runs:** the lookup's `curl` may wait on a shell-permission prompt. Prefer
  `DEVKIT_CVE_LOOKUP=off`. A permission mode that does not prompt also applies to the reviewer child
  threads that read untrusted diffs (on providers that reject `auto`, children inherit the parent's
  mode), so it widens their access too. Do not add a broad `Bash(curl:*)` allow rule for the same
  reason.
- **Severity** is often `unknown` for Go (`GO-*`), PyPI (`PYSEC-*`), and crates (`RUSTSEC-*`)
  records.

## Install

```sh
bb plugin install npm:@lettland/bb-plugin-devkit
```

## Development

`content/index.json` and `skills-generated/` are committed build outputs. After adding or
editing a skill under `content/skills/<slug>/SKILL.md`, regenerate them:

```sh
npm install --include=dev --legacy-peer-deps
npm run build:data   # rebuild content/index.json and skills-generated/, validating frontmatter
npm test
npm run typecheck
npm run build        # build:data + bb plugin build
```

`build:data` fails on a missing `SKILL.md`, invalid frontmatter (the `name` must equal the
directory), or a duplicate slug.
