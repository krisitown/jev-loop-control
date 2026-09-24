# jev-loop-control

Pi extension that supervises actor direction and completion with bounded Jev assessments.

Jev checks the actor's proposed tools and completion status, applying bounded interventions when necessary. It works alongside the actor model you already use in Pi.

**Version:** 0.1.0 (Early Release)

## Requirements

- Node.js >= 22.19.0
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
- `/jev-status`: Should show `active: true`, `mode: enforce`, and `limits: { maxRequests: null, allowanceUsd: null, maxAssessments: null }`.
- `/jev-trace`: Shows the path to the current run's trace directory.

**Important:** `.env` files are not automatically loaded. You must explicitly export environment variables or source your own trusted `.env` file before starting Pi.

## Configuration

The extension automatically discovers `jev-loop-control.config.json` in the current project directory. You can override this path with `JEV_LOOP_CONTROL_CONFIG`.

**Defaults:**
- **Mode:** `enforce` (active supervision).
- **Budgets:** Unlimited requests, spend, and assessments by default.
- **Safeguards:** Per-task limits remain active (3 interventions, 2 terminal continuations) to prevent infinite loops.

### Existing Configs

If you have an existing `jev-loop-control.config.json`, it **overrides** these defaults. Old settings (e.g., `mode: observe`, `maxRequests: 8`) remain in effect until you edit or remove the file. Raw key fields are rejected, not valid overrides.

To adopt the new defaults, rename or omit the config file, or adjust fields to remove caps.

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

Your configured Pi model remains the actor. Bounded proposal/evidence is sent to the configured Jev endpoint; traces remain local.

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

- `maxRequests`: Hard cap on dispatched requests. `null` or omitted means unlimited. `0` stops all calls.
- `allowanceUsd`: Spending allowance in USD. `null` or omitted means unlimited. `0` stops all calls.
- `reserveUsdPerRequest`: Conservative reservation per request when cost is unknown. This is an estimate, not a billing guarantee.

`limits.maxAssessments` is optional and defaults to unlimited. When migrating from old configs, remove old cap settings or set `maxAssessments: null` to avoid persisting unintended limits.

## Tracing

Trace files are stored in `~/.pi/agent/jev-loop-control/runs/<run-id>` by default (respects `PI_CODING_AGENT_DIR`). Files include `events.jsonl`, `manifest.json`, `summary.json`, and artifacts.

Traces may contain project content. While tracing redacts credentials, perfect secret detection is not guaranteed. Review traces before sharing.

## Commands

- `/jev-status`: Shows current supervision status, budget usage, and trace directory. If inactive, it explains why (e.g., missing API key or invalid explicit configuration).
- `/jev-trace`: Shows the path to the current run's trace directory.

## Status Definitions

- **UNRESOLVED**: Available evidence/confidence or limits did not justify marking task complete; it may still be functionally correct.
- **UNCHECKED**: Assessment unavailable or skipped; not a success verdict.
- **COMPLETE**: All requirements strongly supported and final claims supported.

Failed or weak assessments do not cause intervention. HTTP requests have no automatic retries. Request/assessment limits apply per session; intervention limits per task.

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

To load the extension locally for testing:

```bash
pi -e /absolute/path/to/jev-loop-control/src/index.ts
```

Tests use synthetic data and do not require paid credentials.

## Known Limitations

- Gateway cost fields may remain unknown; reservations are kept in these cases.
- This is a supervisor, not a security boundary.
- Completion continuation exercised with real Pi; tool-batch blocking covered by synthetic checks.

## License

MIT License. See [LICENSE](LICENSE) for details.
