# Changelog

Notable changes to `jev-loop-control`. Entries describe behaviour present in the
code at the referenced commit, plus how far it was checked. Effectiveness claims
belong to measured results, which are recorded separately from this file. Where an
entry is a development milestone rather than a published release, it says so.

## 0.4.0-dev.11 - 2026-09-26

- Retains every sanitized user instruction locally with chronological provenance
  and carries later instructions into tuned packet selection as source units.
- Reuses exact manifest-text deduplication for transported user turns, preserving
  source references and coverage without duplicating large cumulative prompts.
- Makes no semantic supersession inference; relevance, recency, exact deduplication,
  and packet bounds select among the original instruction units.
- Development checkpoint only. User-amendment semantics still require independent
  live validation before campaign readiness.

## 0.4.0-dev.10 - 2026-09-26

- Aligns the package and lockfile version metadata so an isolated Git-package
  installation remains clean. Production source is byte-identical to dev9.
- Packaging-only development checkpoint; the dev9 source and validation limits
  remain unchanged.

## 0.4.0-dev.9 - 2026-09-26

- Exposes each complete applicable requirement as a selectable evidence anchor,
  while retaining observations and trajectory for diagnostic and retry concerns.
- Exposes the user goal as an anchor only when every declared requirement source
  reference is resolved in the packet.
- Uses the same supplied-unit set for question options, policy grounding, source
  lookup, and delivered guidance. This prevents a source-backed requirement
  judgment from being suppressed solely because requirements were absent from a
  separate anchor option list.
- Development checkpoint only; thresholds and semantic decision rules are
  unchanged. Live semantic and actor-continuation validation remain separate.

## 0.4.0-dev.8 - 2026-09-26

- Tracks requirement IDs referenced by a compacted user goal and reports those
  that are absent from the selected packet. A goal with unresolved source
  references is no longer offered as contract grounding for a hard redirect;
  complete retained requirements can still ground local corrections.
- Removes compact-context placeholders from the protected goal text while
  retaining their source dependencies as metadata. Large manifest supersets
  remain optional and are never protected into an oversized wire packet.
- Refuses to route an oversized tuned schema-v2 request through the legacy
  string-clipping fallback. It preserves the exact packet and questions as an
  unchecked artifact and performs no HTTP dispatch.
- Offline replay of all 40 recorded batch-8 actor boundaries produced complete
  four- or five-question requests of 20,628–24,429 bytes, with no skipped
  checkpoints and no network calls. Hosted Jev semantics and real actor
  continuations remain unvalidated; partial coverage cannot certify completion.
- Development checkpoint only.

## 0.4.0-dev.7 - 2026-09-26

- Prevents the tuned production adapter from invoking legacy middle-clipping
  fallback when protected proposal, goal, or complete questions cannot fit the
  bounded final wire envelope; the checkpoint is recorded as unchecked instead.
- Requires unambiguous concern, anchor, and applicable requirement selections
  for hard redirects. Diffuse but valid grounding can still produce bounded soft
  advice, without imposing a blanket auxiliary probability threshold.
- Allows the exact current proposal and the user goal to ground contract
  contradictions, including the default single-requirement task representation.
- Preserves selected evidence and requirement units intact in delivered guidance
  and renders concern-specific next actions and observable exit checks.
- Records hard guidance as queued at the block boundary and delivered only when
  the next actor context contains it. Supported completion remains uncertified
  while global packet coverage is unknown or partial.
- Development checkpoint only. Hosted Jev semantics, real actor continuation,
  frozen package installation, and campaign resumption remain unvalidated.

## 0.4.0-dev.6 - 2026-09-26

- Adds a production-adapter regression proving an 18K-character Unicode tool
  argument remains intact through tuned packet construction, complete correction
  instructions reach the transport, and productive work remains unblocked.

## 0.4.0-dev.5 - 2026-09-26

- Scopes issue identity to the session branch, preserves explicit unresolved and
  unchecked outcomes, and exposes deterministic scheduling-profile comparison.
- Final offline-validation checkpoint before adapter fixture review.

## 0.4.0-dev.4 - 2026-09-26

- Integrates configurable proposal cadence, completion scheduling, evidence
  deduplication, and checkpoint cooldown into the production adapter.
- Tracks queued advice, actual delivery, the next actor response, bounded expiry,
  and Jev-assessed concern outcomes. Expiry and acknowledgement never imply
  resolution; only a sufficiently supported RESOLVED answer records resolution.
- Adds focused tuning module entry points for packet, questions, policy,
  lifecycle, and scheduler replay tooling.

## 0.4.0-dev.3 - 2026-09-26

- Preserves complete sanitized tool-result sources locally before legacy wire
  compaction, allowing S1/S2 to select intact diagnostic units and omit them as
  whole units when the packet budget requires it.
- These local originals are not serialized wholesale and do not change snapshot
  identity; the tuned packet records the selected source IDs and its own hash.
- Development checkpoint only; campaign readiness gates remain open.

## 0.4.0-dev.2 - 2026-09-26

- Extends the opt-in path to completion assessments with explicit SUPPORTED,
  CONTRADICTED, and NOT_ESTABLISHED outcomes.
- Policy now evaluates exactly the packet sent on the wire, includes structured
  tool arguments in the protected proposal, and emits evidence-linked guidance
  with an observable verification exit check.
- Soft advice is queued separately from delivery; strong blocks trace delivery.
- Development checkpoint only. Raw evidence recovery and real actor validation
  remain outstanding.

## 0.4.0-dev.1 - 2026-09-26

- Adds an opt-in correction-diagnosis path with S1/S2 evidence packet selection,
  intact question templates, separate soft/strong policy gates, grounded source
  anchors, nonblocking advice delivery, and explicit lifecycle trace stages.
- Adds pure packet, policy, lifecycle, and scheduler APIs for offline replay.
- Global coverage remains unknown unless independently verified; byte counts are
  measured on serialized UTF-8 and token counts remain explicitly unavailable.
- Development checkpoint only. No live Jev or actor-continuation validation ran.

## 0.3.5 - 2026-09-25

### Changed
- Default oversized assessments now compact already-redacted state/questions into bounded packets before dispatch.
- Actual wire body and hash are recorded as trace artifacts.
- Explicit partial coverage blocks a full COMPLETE clearance but does not by itself force VERIFY or suppress supported negative steering.
- Auth, cancel, budget, and 503 behavior remain unchanged.

### Testing
- TypeScript validation passed.
- 209 local tests passed.

- External fallback: 8/8 cases.
- Live real gateway: 5/5 cases with packet sizes 8.8–10.3 KB and 1 request per case, except one oversized-input case which used 2 attempts.

## 0.3.4 - 2026-09-25


### Changed

- HTTP 503 retries now use up to three retries (four total attempts) with 500ms, 1000ms, and 2000ms backoff within the total deadline.
- The default `jev.deadlineMs` is 10000ms; explicit configured deadlines still apply.
- Request context retains full user instructions and proposals, deduplicates exact repeated requirement text, and prunes optional older context first. Context estimates are conservative UTF-8 byte estimates (`ceil(bytes / 2)`), not exact tokenizer measurements; oversized mandatory packets are skipped unchecked.
- Questions may focus on usefulness and strong supported direction without requiring a requirement mismatch.

## 0.3.3 - 2026-09-25

Patch on top of 0.3.2.

### Changed

- Bounded verification context: Python unittest summaries from executed bash output are reported separately from tool completion; a pipeline exit 0 no longer appears as test success.
- Recent result retention updated to last 12 plus up to TWO total older problematic observations (tool errors OR failed verifications).
- Questions now distinguish a concrete local correction (EXECUTE) from approach redesign (REPLAN), compare proposed behavior with user requirements, and allow legitimate corrections of actor-authored tests.

### Testing

TypeScript and 197 tests passed, including masked unittest failures, latest-same-command checks and total retention bound. Live gateway corrective judgments and tool blocking exercised in a controlled Pi workflow, without claiming general output improvement.

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
