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
compliance lens always runs but is applicability-gated and not legal advice: to declare which
regimes apply (GDPR, SOC 2, …), list a tracked doc that states them under `guidelines` in
`.devkit/review.yml`. The declaration takes effect for later changes once committed: a `guidelines`
doc or `review.yml` added or edited in the change under review carries no weight in that change's
own review. Example:

```yaml
guidelines:
  - docs/COMPLIANCE.md   # e.g. "GDPR applies; not in PCI scope"
```

Under bb, the review's five lens reviewers (and its closure review) run as bb child threads; outside
bb, or when spawning one fails, they run as the provider's own subagents, or sequentially in the
orchestrating thread as a last resort. See `review-code`'s `§3` for the recipe and its tree guard. A
full review costs about six provider sessions (five lenses plus closure), more when lockfiles
change. Archived reviewer threads stay openable, so their transcripts keep the reviewed diff,
including any secret values in it — run `bb thread delete --yes <id>` on one after reviewing a diff
with a leaked secret or real personal data, rather than waiting on its parent (`--yes` skips a
confirmation prompt an unattended agent would otherwise hang on). They're spawned with
`--lifecycle-owner-thread`, so they're deleted along with their parent anyway.

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
