# Prose anti-slop checklist

The phrases and structures below are AI tells: they read as machine-generated, padded, or falsely dramatic. Cut them from docs, commit bodies, PR descriptions, and your own narration. This is a checklist, not a linter — apply judgment, and read the **NOT adopted** section before tightening the rules further.

This complements `output-styles/concise.md`. That style drops _filler words_ (just, really, basically); this list drops _AI voice markers_ — whole phrases and sentence shapes that survive a filler pass but still announce a machine wrote them.

## Banned openers (throat-clearing)

Delete the opener; start with the claim.

- "Here's the thing" / "Here's why" / "Here's what's interesting"
- "The uncomfortable truth is" / "The truth is" / "The real X is"
- "It turns out" / "Let me be clear" / "I'm going to be honest" / "Can we talk about"

> ❌ Here's the thing: the cache never expires.
> ✅ The cache never expires.

## Emphasis crutches

The emphasis should come from the claim being true, not from a tag insisting it matters.

- "Full stop" / "Period" / "Let that sink in"
- "Make no mistake" / "This matters because" / "Here's why that matters"

## AI voice markers

Filler at phrase scale. `concise.md` catches the single words; these are the multi-word versions.

- "It's worth noting" / "At its core" / "At the end of the day"
- "In today's X" / "When it comes to" / "The reality is"
- "importantly" / "crucially" / "interestingly" (the adverb is doing the work the sentence should)

## Business-jargon swaps

Prefer the plain verb. The jargon adds syllables, not meaning.

| Jargon           | Plain            |
| ---------------- | ---------------- |
| navigate         | handle / address |
| unpack           | explain          |
| deep dive        | analysis         |
| lean into        | accept           |
| landscape        | field            |
| game-changer     | notable          |
| double down      | commit           |
| take a step back | reconsider       |
| circle back      | revisit          |
| moving forward   | next / from now  |

## Meta-commentary

Do the thing instead of narrating that you're about to do it.

- "As we'll see" / "Let me walk you through" / "In this section" / "I want to explore"
- "Plot twist" / "Spoiler"

## Vague declaratives

A claim of significance with no referent. Name the implication, the stake, the reason — or cut the sentence.

- "The implications are significant" / "The stakes are high"
- "The reasons are structural" / "The consequences are real"

> ❌ The implications are significant.
> ✅ Every cached token survives a deploy, so a poisoned entry persists until manual flush.

## Structural tells

Sentence shapes that manufacture drama instead of stating the point.

- **Binary-contrast drama** — "Not X. Y." / "The answer isn't X. It's Y." → state Y.
- **Negative listing** — "Not a X… Not a Y… A Z." → state Z.
- **Dramatic fragmentation** — "X. That's it." / single-word sentences for punch → write the full sentence.
- **Rhetorical setups** — "What if…?" / "Think about it:" → deliver the insight, don't tee it up.
- **False agency** — inanimate subjects with human verbs ("complaints become fixes", "the decision emerged"). Name the actor: who fixed it, who decided.

## NOT adopted (and why)

Borrowed from stop-slop but **deliberately rejected** for devkit — do not "complete the import" by adding these:

- **Em-dash ban** — devkit uses em dashes throughout its docs and skills. Keep them.
- **Three-item-list ban** — technical docs rely on lists. A list is structure, not slop.
- **Wh- sentence-starter ban** ("What", "When", "Why"…) — fine in technical prose, especially in headings and FAQ-shaped docs.
- **Blanket adverb ban / blanket passive-voice ban** — both are sometimes correct. Passive is right when the actor is irrelevant or unknown ("the row is locked for the duration"). Cut adverbs that pad; keep ones that carry meaning.
- **The 35/50 scoring rubric** — devkit scores writing via `scripts/_sharpness_check.py` (skill voice) and reader-fit (see `Skill(technical-writing)`), not a numeric prose rubric.

---

_Adapted from [stop-slop](https://github.com/hardikpandya/stop-slop) (MIT, Hardik Pandya; see THIRD_PARTY_NOTICES.md), curated for technical writing — same precedent as the [caveman](https://github.com/JuliusBrussee/caveman) credit in `concise-output`._
