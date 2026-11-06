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
`grc-dora`, `grc-pci-dss`, `grc-hipaa`, `grc-ccpa`) and their 28 references are a generated, pinned
vendor copy of
[Sushegaad/Claude-Skills-Governance-Risk-and-Compliance](https://github.com/Sushegaad/Claude-Skills-Governance-Risk-and-Compliance)
(MIT; see `THIRD_PARTY_NOTICES.md`). They are knowledge packs for the compliance reviewer, which
loads them itself for each framework it rates **applies** (`content/references/reviewer-compliance.md`),
and they are ordinary `devkit_find_skills` results under neutral descriptions. They are not legal
advice, and every vendored file carries a "do not edit" header as its first line: the skills after
their frontmatter, the references before their text. Besides that header and the rewrite of
`references/<name>.md` citations into `devkit_load_skill` calls, the references are byte-for-byte
upstream; each skill also gets a devkit-written description. `content/grc-upstream.json` records the
pinned commit. One upstream file is not vendored: `references/privacy-notice.md` of `gdpr-compliance`
is a drafting template for the user's own privacy notice, which the reviewer does not need, and its
`[PLACEHOLDER]: for [PURPOSE]` prose lines trip the link-definition gate below. `FRAMEWORKS` in
`scripts/sync-grc.mjs` lists it under `exclude`; an excluded file is not read, copied or listed in the
manifest, and the sync fails if any vendored text cites it or if an `exclude` entry names no upstream file.
The GDPR skill's Workflow 2 table still names a privacy-notice template that is not vendored.

Re-sync from a local clone you fetched yourself (the script makes no network calls and reads the
commit object, never the working tree), then rebuild the index. Run the re-sync, build, and
recovery commands from `plugins/devkit`:

```sh
node scripts/sync-grc.mjs <path-to-upstream-clone> <full-40-hex-commit-sha>
node scripts/build-index.mjs
```

- Before bumping the SHA, a human reads the upstream diff between the old and the new commit.
  Upstream updates monthly.
- Update the matching section in `THIRD_PARTY_NOTICES.md` (heading, full SHA, fetch date) first; the
  sync fails if the notice does not name the commit.
- The sync fails, and writes nothing, on any of these gates:
  - a symlink or another unsupported entry in the upstream tree, or an unexpected upstream file
  - raw HTML, fail closed: any `<` directly followed by an ASCII letter, `/`, `!` or `?` (tags, comments,
    declarations, CDATA, processing instructions). `1 < 2`, `x <= y`, `<3` and `<-` pass; `a<b` does not
  - an inline link or image title (`[a](url "t")`, `[a](url 't')`, `[a](url (t))`), which renders as
    nothing, and an image with non-empty alt text (`![alt](x)`). A plain link and an image with empty
    alt text (`![](x)`) pass
  - an inline link or image whose `](…)` part does not close on its own line, fail closed: for every `](`,
    a line ending (LF, CR or CRLF) or the end of the text before the closing `)` (parentheses balanced, a
    backslash escapes the next character) is refused. A title can hide behind a container prefix on the next
    line (`> [a](` then `> <)> "t")`, or `> [a](x` then `>"t")`), so the rule refuses the whole class instead of
    modelling prefixes. `[a](x) and [b](y)` on one line passes; `[a](x` then `"t")` and a lone `[a](` do not
  - an inline link or image destination in angle brackets, fail closed: any `](` followed by `<`, also with whitespace between `(` and `<`
    (`[a](<x>)`, `[a]( <)> "t")`). A plain link (`[a](https://x)`) and `![](x.png)` pass
  - a character reference, fail closed: a numeric one (`&#8203;`, `&#x200B;`) or a named one (`&shy;`,
    `&amp;`), because it renders as another character and can hide an invisible one. `R&D`, `a & b`,
    `AT&T` and `&;` pass
  - a line that could start or end a Markdown link-reference definition (`[label]: destination "title"`,
    which renders as nothing and can hide text). This is a fail-closed line rule, not a CommonMark
    parser: the text is split on CRLF, CR or LF; on each line, leading spaces, tabs, `>` and list markers
    (`-`, `*`, `+`, `1.`, `1)`, each followed by a space, a tab or the line end) are removed; the line is
    rejected if what is left starts with `[` and contains `]:`, or if its first `]:` has no unescaped
    `[` before it on that line (a label opened on an earlier line; a `[` is escaped when an odd number
    of backslashes directly precede it). It also rejects such lines inside code blocks
    and prose such as `[PLACEHOLDER]: for [PURPOSE]`; that is intended. Lines such as
    `**Requirement [X.X]: [Name]**` and `Use [X]: the value` pass
  - an invisible or direction-changing character: any Unicode format character (`Cf`), any control
    character except tab, LF and CR (`Cc`), the line and paragraph separators U+2028 and U+2029, U+FFFC,
    the whole tag block U+E0000-U+E007F, and these marks that are not format characters: U+034F,
    U+115F, U+1160, U+17B4, U+17B5, U+180B-U+180D, U+180F, U+3164, U+FE00-U+FE0E, U+FFA0 and
    U+E0100-U+E01EF; also every default-ignorable code point (except U+FE0F, which has its own rule
    below), every private-use character (`Co`), every unassigned code point (`Cn`, including
    noncharacters such as U+FFFE) and U+2800
  - a U+FE0F that does not directly follow a pictographic character, and is not between a keycap base
    (`0-9`, `#`, `*`) and U+20E3
  - upstream frontmatter keys other than exactly `name` and `description`, and a frontmatter block that
    holds a line starting with `---` (such as `---x: c`), which would hide later keys from that check
  - a dangling `references/<name>.md` citation
  - a malformed previous manifest (including a framework entry without a valid `upstream` name, a slug
    listed twice, or a reference listed twice)
  - a target file the previous manifest does not list
  - a path the run would delete or write through that is not what the manifest says: a listed file
    that is not a regular file, a skill directory that is a symlink or a file, `content/skills` or
    `content/references` that exists but is a symlink or a file, a `content/grc-upstream.json` that is
    a symlink or a directory, or a `content` directory that is missing, a symlink or a file
- A re-sync that adds or drops frameworks or references must update the counts pinned in
  `src/loader.test.ts` (9 frameworks, 28 references). `src/rank.test.ts` pins the top results of three
  queries against `content/index.json`; a re-sync can move them, and its failure message shows the
  actual top 3.
- If a sync fails with an I/O error, re-run it: the manifest is written first and lists every file the
  run may have written. If the re-run fails too, `git checkout -- content` restores the last committed
  state (then delete any new untracked files under `content/` the failed run left; see `git status`).
- The content gates live in `scripts/grc-gates.mjs`. A gate error that names a line says `upstream line <n>`:
  the line counts from the upstream file.
- If only one reference file fails a gate and the reviewer does not need it, list it under that
  framework's `exclude` in `FRAMEWORKS`; otherwise drop the framework from `FRAMEWORKS` and from the
  slug list in `reviewer-compliance.md` (a test enforces they match). Report it upstream. Never weaken
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
