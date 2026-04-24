# Agent Admission Checklist

Language:
- English (default)
- [简体中文](zh-CN/research/agent-admission-checklist.md)

## Summary

This checklist defines the minimum evidence and pass criteria required before a new agent can be admitted into `acp-runtime`.

It requires:

- protocol coverage review
- project-scenario regression review
- permission and mode research
- durable artifacts such as transcripts, summaries, and notes

Artifacts should now be stored under:

```text
.tmp/harness-outputs/<agent>/<timestamp>/
```

When reviewing scenario evidence, `matrix-summary.json` should now be treated as the first-pass gate summary.
At minimum it should expose:

- whether all applicable `P0` scenarios passed
- which required `P0` scenarios failed
- which permission behavior families were observed
- which expected permission behavior families are still missing from evidence

`pnpm harness:check-admission -- --type <agent>` should now fail with a non-zero exit code only when admission blockers remain.
At minimum, blockers include:

- any applicable `P0` scenario failure
- missing evidence for any permission family that has an applicable scenario case for that agent

`pnpm harness:run-agent -- --type <agent>` remains the stricter full-matrix command and may still fail when non-admission protocol or lifecycle cases remain red.
## Translation

- [简体中文](zh-CN/research/agent-admission-checklist.md)
