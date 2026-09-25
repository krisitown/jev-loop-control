# jev-loop-control

Pi extension that supervises actor direction and completion with bounded Jev assessments.

Jev checks the actor's proposed tools and completion status, applying bounded interventions when necessary. It works alongside the actor model you already use in Pi: **your configured Pi model stays the actor.** This version does not change that.

**Version:** 0.3.2 (candidate) · See [CHANGELOG.md](CHANGELOG.md).

Jev supervises and, in `enforce`, redirects work that its evidence does not support. Whether that improves your outcomes is yours to measure: this project makes no proven-effectiveness claim, and traces plus statuses are written so you can check each decision yourself.

## Requirements

- Node.js >= 22.19.0 (tests use Node's built-in test runner and type stripping)
- Pi Coding Agent 0.87.1 (tested)

## Installation

Install Pi globally:

```bash
npm install -g @earendil-works/pi-coding-agent@0.87.1
```

Install this extension via Git in a normal terminal:

```bash
pi install git:github.com/krisitown/jev-loop-control
```

*Note: This package is not available on npm. Do not use `npm install jev-loop-control`.*

**Important:** Install first. Wrappers adding provider flags before `install` break the command. Run `/reload` or restart Pi after installation.

For local development, cloning alone is not installation. Use:

```bash
pi install /absolute/path/to/jev-loop-control
```

See [Pi packages](https://pi.dev/docs/latest/packages) and [Pi extensions](https://pi.dev/docs/latest/extensions).

## Quickstart

In your target project directory:

1. Set your API key:
   ```bash
   export AI_GATEWAY_API_KEY="your-vercel-ai-gateway-key"
   ```

2. Start Pi:
   ```bash
   pi
   ```

**No config download or `JEV_LOOP_CONTROL_CONFIG` export is required.**

If Pi is already running, restart it after exporting the environment variable.

Verify activation:
- `/jev-status`: Should show `active: true`, `mode: enforce`, and `limits: { maxRequests: null, allowanceUsd: null, maxAssessments: null, maxInterventions: null }`.
- `/jev-trace`: Shows the path to the current run's trace directory.

**Important:** `.env` files are not automatically loaded. You must explicitly export environment variables or source your own trusted `.env` file before starting Pi.

## Configuration

The extension automatically discovers `jev-loop-control.config.json` in the current project directory. You can override this path with `JEV_LOOP_CONTROL_CONFIG`.

**Defaults:**

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `enforce` | Active supervision. |
| `budget.maxRequests`, `budget.allowanceUsd`, `limits.maxAssessments` | `null` | Unlimited. Set a number to cap, `0` to stop calls. |
| `limits.maxInterventionsPerTask` | `null` | Unlimited interventions per task. |
| `limits.maxTerminalContinuations` | `2` | A task can be continued past completion at most twice. |
| `limits.proposalLease` | `2` | Proposals a recovery objective stays attached to. |
| `jev.maxRequestBytes` | `131072` | Local transport guard, not a provider limit. |
| `jev.maxResponseBytes` | `262144` | Response size guard. |
| `jev.deadlineMs` | `5000` | Wall-clock deadline per assessment. Retries HTTP 503 once after 500ms within the deadline. |

### Existing Configs

If you have an existing `jev-loop-control.config.json`, it **overrides** these defaults. In particular a stored `"maxInterventionsPerTask": 3` still caps every task at 3 interventions; the upgrade does not lift it. Old settings (e.g. `mode: observe`, `maxRequests: 8`) likewise remain in effect until you edit or remove the file. Raw key fields are rejected, not valid overrides.

To adopt the new defaults, rename or omit the config file, remove the cap keys, or set them to `null`.

### Optional Overrides

You can override the mode via environment variable:

```bash
JEV_LOOP_CONTROL_MODE=observe pi
```

Valid modes: `enforce`, `observe`, `off`.

### Endpoints and API

The default configuration uses the Vercel AI Gateway TypeSafe-compatible API. You can configure `jev.endpoint`, `jev.model`, and `jev.apiKeyEnv` in the JSON config.

Default endpoint: `https://ai-gateway.vercel.sh/typesafe/v1/systemone`
Default model: `typesafe-ai/jev`

`jev.apiKeyEnv` is the **NAME** of the environment variable containing the key, not the key itself. Example:

```json
{
  "jev": {
    "apiKeyEnv": "AI_GATEWAY_API_KEY"
  }
}
```

The actual key value must be exported or sourced before launching Pi. `.env` files are not automatically loaded. A restart is needed after changing environment variables.

Your configured Pi model remains the actor. A bounded snapshot of the task trajectory is sent to the configured Jev endpoint; traces remain local.

### Request Size Guard

`jev.maxRequestBytes` (default `131072`) is a **local** ceiling on what this client will put on the wire. It is not an assertion about any provider's own limit, and raising it buys no extra provider allowance. A request above the guard is reported as a transport failure and the proposal passes through unassessed; there is no retry. Lower it if you want smaller outbound requests, raise it only if you have confirmed your endpoint accepts them.

### HTTP 503 Retry

Exactly one failure mode is ever retried: an HTTP **503** whose response drained without the deadline or a cancellation firing. After a fixed **500 ms** wait, one second request goes out — inside the same total `jev.deadlineMs`, never a second one after that, and never for any other status, an invalid body, a transport error, a deadline, or a cancellation. If the retry succeeds, the assessment succeeds with `attempts: 2` and a trace note (`http 503 retried once after 500ms: succeeded`); the first failure is not hidden. The retry spends from the same `budget.maxRequests` and `budget.allowanceUsd` as any other request (checked at retry time), but it is **one assessment, not two**. The failed 503's cost stays unknown and its reservation stays armed even when the retry reports a known cost, so `unknownCosts` and `reservedUsd` in `/jev-status` and `summary.json` stay honest.

### Optional Budget Limits

To limit costs, add a `budget` section to your config:

```json
{
  "budget": {
    "maxRequests": 8,
    "allowanceUsd": 0.10,
    "reserveUsdPerRequest": 0.01
  }
}
```

- `maxRequests`: Hard cap on dispatched requests, including the single 503 retry. `null` or omitted means unlimited. `0` stops all calls.
- `allowanceUsd`: Spending allowance in USD. `null` or omitted means unlimited. `0` stops all calls.
- `reserveUsdPerRequest`: Conservative reservation per request when cost is unknown. This is an estimate, not a billing guarantee.

`limits.maxAssessments` is optional and defaults to unlimited. When migrating from old configs, remove old cap settings or set `maxAssessments: null` to avoid persisting unintended limits.

## What Jev Sees

Each assessment carries a **bounded view of the task trajectory**, not the whole conversation:

- Task requirements and their origin (from the manifest, or the original request).
- The single proposal under review: terminal text or proposed tool calls with their argument hashes.
- Conversation history capped at `limits.maxEvidenceChars` (default 12000), excluding the candidate text itself.
- Recent tool results: the **last 12** observations, plus the **2 most recent errors** that fall outside that window, so an old failure is not silently forgotten.
- Recent actions: the last 24 actions with success/error status, whether they actually executed, and arguments capped at 600 characters plus a hash.
- Deterministic facts: the last 24, with an omitted count.
- The last 5 prior interventions, `omitted_evidence_ids`, and `context_selection` truncation metadata.

**This is a bounded selection, not "all context."** Omissions are declared in the payload so an assessment can be read as partial. `limits.maxProposalChars` is accepted by the schema but not yet applied; a very large proposal is caught by the request-size guard instead and comes back `UNCHECKED`.

## Interventions and Recovery Guidance

In `enforce`, a direction block opens a recovery: a mode (`RESEARCH`, `REPLAN`, `VERIFY`, `EXECUTE`) and an objective taken from the assessment memo. The objective is delivered as a hidden guidance message and stays attached for `limits.proposalLease` proposals (default **2**), then expires. **Expiry does not mean the objective was met.**

- **Duplicate suppression:** a recovery for the same focus and the same recent evidence is not reopened. The repeat is traced as `intervention.suppressed` instead of re-issuing the same advice.
- **Repeats at completion:** the same unfinished focus with no new evidence stops instead of looping.
- **Caps are still respected.** `maxInterventionsPerTask` is unlimited by default, but an explicit number is a hard cap; `0` disables interventions. `maxTerminalContinuations` (default 2) always bounds continuations past completion.
- Guidance state lives in memory for the session. It is not restored after a restart or session replacement (deferred).

## Tracing

Trace files are stored in `~/.pi/agent/jev-loop-control/runs/<run-id>` by default (respects `PI_CODING_AGENT_DIR`). Files include `events.jsonl`, `manifest.json`, `summary.json`, and artifacts.

Traces may contain project content. While tracing redacts credentials, perfect secret detection is not guaranteed. Review traces before sharing.

## Commands

- `/jev-status`: Current supervision status, limits, budget usage, trace directory, `activeRecovery`, and `lastFailure`. If inactive, it explains why (e.g. missing API key or invalid explicit configuration).
- `/jev-trace`: Shows the path to the current run's trace directory.

## Reading the Result

Two different things are recorded, and they are not interchangeable:

- **`recommendedApply`** — what the assessment suggested, on the `direction_assessment` / `completion_assessment` event.
- **`actualApply`** — on an assessment event it is always `none`: that event records the recommendation only, not the outcome. The outcome is a separate event.
- **`assessment_failure` / `UNCHECKED`** — a gateway failure, deadline, or size guard. No verdict was produced. That is not a disagreement with the actor; it is the absence of an assessment.

To establish what actually happened, correlate the `direction_assessment` / `completion_assessment` event with the `intervention.block`, `intervention.continuation`, or `intervention.suppressed` event carrying the same `requestId` and `proposalId`. The intervention event is where `actualApply` reflects enforcement; `actualApply: "none"` on an assessment event by itself says nothing about suppression.

Status values:

- **UNRESOLVED**: Available evidence, confidence, or limits did not justify marking the task complete. It may still be functionally correct. It is not a claim that Jev and the actor disagree. A valid but weak or uncertain answer lands here, not in `assessment_failure`.
- **UNCHECKED**: Assessment unavailable or skipped; not a success verdict.
- **COMPLETE**: All requirements strongly supported and final claims supported.

Failed or weak assessments do not cause intervention. HTTP requests retry 503 once after 500ms within the deadline; other failures are not retried. Request/assessment limits apply per session; intervention limits per task.

## Task Manifest

You can optionally specify a `taskManifestPath` in the config pointing to a JSON file with requirements. This helps Jev assess completion against specific goals.

Example schema:
```json
{
  "requirements": [
    {
      "id": "R1",
      "summary": "Describe the required behavior and verification"
    }
  ]
}
```

See [example config](jev-loop-control.config.example.json).

## Development

Clone the repo and install dependencies:

```bash
git clone https://github.com/krisitown/jev-loop-control
cd jev-loop-control
npm ci
npm run check
```

Tests need no `tsx` or other loader. Node 22 runs the TypeScript sources directly:

```bash
node --test test/config.test.ts    # one file
node --test "test/*.test.ts"       # everything
```

To load the extension locally for testing:

```bash
pi -e /absolute/path/to/jev-loop-control/src/index.ts
```

Tests use synthetic data and do not require paid credentials.

## Known Limitations

- Improved output quality is not proven here; measure it on your own workloads.
- Evidence is bounded by design. Jev does not see the entire context window.
- Recovery guidance state is in memory only; it is not rebuilt after a restart.
- Gateway cost fields may remain unknown; reservations are kept in these cases.
- This is a supervisor, not a security boundary.
- Completion continuation exercised with real Pi; tool-batch blocking covered by synthetic checks.

## License

MIT License. See [LICENSE](LICENSE) for details.
