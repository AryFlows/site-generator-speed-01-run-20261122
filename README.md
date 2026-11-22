[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/AryFlows/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/AryFlows/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-01 — a faster makefun-site

A dependency-free, single-file drop-in replacement for makefun-site 1.0.0.
`solve.js` exports `run(input)`, which returns byte-for-byte the output tree
makefun-site's `build` returns for the same site, and `main.ts` is the harness
driver that reads `/input/cases.json` and writes `/output/answers.json`.

How it is faster, with identical output:

- HTML escaping scans for the next special character and copies whole plain
  runs at once instead of replacing character by character.
- Markdown is rendered in one pass straight from the source lines — no token
  objects — and inline markup is rendered over index ranges, so no substring
  is ever copied just to be rendered.
- Front matter is scanned by hand, line by line, with no regular expressions
  on the hot path.
- Slugs and long dates are memoised within a case (nothing is kept from one
  case to the next); word counts scan character codes instead of matching a
  regex and building a word list.
- Templates are parsed once per case and rendered into a single output array;
  loop scopes are allocated once per loop, not once per element.
