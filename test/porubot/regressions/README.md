# porubot regression tests

Small, deterministic tests that reproduce a specific, previously observed
RL-collector/pipeline failure (a phase transition that was skipped, or that
got stuck waiting on a preceding phase's input) as a fixed, fast assertion,
so a future `pokerogue` submodule update surfaces the regression via a
seconds-long test run instead of a multi-minute strategic-collection timeout.

Scope for this folder specifically (see `AGENTS.md` and
`docs/pokerogue-submodule-versioning.md` for the full policy):

- Only new test files. No edits to any existing file under `pokerogue/`.
- No changes under `pokerogue/src/`.
- Fixed scenarios only (a specific seed/wave/state), no per-invocation
  parameters. Parametrized data-generation runs (seeds, run counts, DQN
  checkpoint paths, large JSONL output) stay on the existing template
  harness in the main repo (`scripts/90-dev/rl/templates/*.template.ts`,
  rendered at runtime into `pokerogue/test/.external-rl/`), not here.

Run via the main repo's dedicated script (not the submodule's own
`pnpm test`, which would otherwise pick these up on every upstream test run
too):

```bash
npm run rl:test:porubot:regressions
```
