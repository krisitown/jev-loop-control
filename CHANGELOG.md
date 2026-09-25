# Changelog

Notable changes to `jev-loop-control`. Entries describe behaviour present in the
code at the referenced commit, plus how far it was checked. Effectiveness claims
belong to measured results, which are recorded separately from this file. Where an
entry is a development milestone rather than a published release, it says so.

## 0.3.3 - Candidate

Patch on top of 0.3.2.

### Changed

- Bounded verification context: Python unittest summaries from executed bash output are reported separately from tool completion; a pipeline exit 0 no longer appears as test success.
- Recent result retention updated to last 12 plus up to TWO total older problematic observations (tool errors OR failed verifications).
- Questions now distinguish a concrete local correction (EXECUTE) from approach redesign (REPLAN), compare proposed behavior with user requirements, and allow legitimate corrections of actor-authored tests.

### Testing

Relevant tests updated to reflect verification context changes and retention logic. Independent validation is pending and will be completed before release.

## 0.3.2 - 2026-09-25

Patch on top of 0.3.1.

### Added

- Single HTTP 503 retry: an overloaded-server response (503, with no deadline or
  cancellation firing during its drain) is retried exactly once after 500 ms,
  inside the same total `jev.deadlineMs` and abort signal. No other failure is
  ever retried. The retry's outcome is never retried again.
- The retry is gated by the adapter's real budget at retry time: it must clear
  `budget.maxRequests` and `budget.allowanceUsd`, but never
  `limits.maxAssessments`, because a retry is one extra *request*, not a second
  *assessment*. With no retry budget wired, the retry is never taken.
- Honest accounting: the retry raises the dispatched-request count, the failed
  503's cost stays unknown and its reservation stays armed even when the retry
  reports a known cost, and the trace records `assessment.retry` plus a
  `http 503 retried once after 500ms[: ...]` note. Successes and refusals are
  both visible; nothing is silently swallowed.

### Testing

TypeScript and 176 tests passed. Real Pi adapter tests cover accounting/caps. Live gateway retry recovery also observed. No effectiveness or improvement guarantee.

## 0.3.1 - Previous candidate

Patch on top of the 0.3.0 development milestone (`5b83579`, 153 tests passing).

### Fixed

- Historical observation arguments in the evidence payload are bounded, while
  argument hashes and the current proposal's arguments stay intact. Long old
  arguments no longer crowd out the proposal under review.
- A strong requirement-specific steering focus is kept over the repeated-failure
  fallback, so a concrete requirement gap is not replaced by generic failure
  advice.

### Testing

- Covered by pure failure/success regression tests. Effectiveness has not been
  measured; no result is claimed here.

## 0.3.0 - Development milestone (validated offline, not tagged or published)

Committed as `5b83579`. Offline suite green at that commit: 153 tests. No tag and
no publication followed. The capability descriptions in the 0.2.0 checkpoint below
remained accurate for this milestone.

## 0.2.0 - Development checkpoint (not a validated release)

Development checkpoint, committed at `9327157`. It was never validated: the test
and typecheck suites were not green at that commit, and the steering behaviour
below was still being built. Do not treat this entry as a released, working
state; see 0.3.0 for the work as it stands.

### Added

- Recovery guidance in `enforce`: a blocked direction proposal can open a recovery
  (`RESEARCH`, `REPLAN`, `VERIFY`, `EXECUTE`) with an explicit objective. The
  objective is injected as a hidden guidance message and expires after 2 proposals
  (`limits.proposalLease`). Expiry does not mean the objective was met.
- Duplicate suppression: a recovery for the same focus and evidence is not reopened.
  The drop is traced as `intervention.suppressed` instead of repeating guidance.
- Bounded recent history in each snapshot: the last 12 tool results, plus the 2 most
  recent errors that fall outside that window. `omitted_evidence_ids`,
  `omitted_observation_count`, and `context_selection` state what was left out.
- Status and trace detail: `/jev-status` reports `activeRecovery` and `lastFailure`;
  traces record `recommendedApply` separately from `actualApply`, plus intervention
  and continuation counters.

### Changed

- `limits.maxInterventionsPerTask` defaults to `null` (unlimited per task). Explicit
  values, including `0`, are still enforced. `limits.maxTerminalContinuations`
  remains 2, so an uncapped task still cannot continue itself forever.
- `jev.maxRequestBytes` default raised from 49152 to 131072. This is a local transport
  guard on what this client sends, not an asserted provider limit. Requests above the
  guard fail as transport errors; there is no retry.
- Budgets stay unlimited by default (`budget.maxRequests`, `budget.allowanceUsd`,
  `limits.maxAssessments` all `null`).
- Example config now shows `maxInterventionsPerTask: null` and `maxRequestBytes`.

### Notes

- The Pi model you configure remains the actor. Nothing in this checkpoint changes it.
- Guidance state is held in memory for the session. Restoring it across restarts or
  session replacement is deferred.
- Evidence is a bounded view of the task trajectory, not the whole context.
- Effect on output quality is not yet measured.

## 0.1.0

### Added

- Initial release: `off` / `observe` / `enforce` modes, strict configuration validation
  with fatal problems surfaced rather than swallowed, Jev assessment client with a
  per-request deadline and size guards, redaction of credentials before storage, local
  traces under the Pi agent directory, and the `/jev-status` and `/jev-trace` commands.
