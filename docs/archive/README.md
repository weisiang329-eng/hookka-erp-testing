# docs/archive — history, not instructions

> **Last verified: 2026-08-13.**

Everything in this folder **describes work that is finished, a plan that already
shipped, or a system that no longer exists.** It is kept because the reasoning is
often the only record of *why* something is the way it is.

**Do not use anything here to decide what the code does today.** Every file
carries a banner naming the date it stopped being true. If you find one without a
banner, add it.

## Why this folder exists

On 2026-08-13 an audit of all 115 docs found that ~25 had not been touched since
April 2026 while the codebase shipped 1,367 commits in the previous 30 days
alone. Stale docs were not merely useless — they were *actively producing wrong
answers*, because they sat in the same directory as the accurate ones and read
just as authoritatively. The owner's diagnosis:

> 同一个问题问了三次，AI 给出的回答都不一样。原因在于它的文档、COE 等内容，和它的
> 源代码全部是对不上的。

Two habits came out of that audit and must be kept:

1. **Every doc under `docs/` carries a `Last verified: <date> against <what>` line
   under its title.** No line, or an old date, means UNVERIFIED — read the code.
2. **A doc that describes finished work moves here, with a banner.** A wrong doc
   left in the main path is worse than no doc.

## What moved here on 2026-08-13

See the PR that created this file for the full doc → verdict → action table.
