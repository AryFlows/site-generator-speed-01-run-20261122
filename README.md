# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/AryFlows/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/AryFlows/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Frost Site Sprint v2 — a fast static-site generator that reproduces makefun-site 1.0.0's output byte for byte, built for make.fun's "Build a static site faster, 22 November 2026" bounty. `solve.js` renders Markdown sources and templates into a full site tree (posts, tags, index, statics) with no dependencies. v2 rewrites the renderer for CPU time: a single-pass line scanner with range-based inline rendering (escaping fused into the inline scan), a flat template instruction list with pre-resolved scope slots, memoised slugs and dates, and a shared card per post. Local grade: 3/3 practice cases identical, L1 regrade reproduced byte for byte.

## Run it

```sh
node main.ts
```

`main.ts` reads `/input/cases.json`, answers each case with `run()` from `solve.js`, and writes `/output/answers.json`. Node 22, no dependencies, no network.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
