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

Install this extension via Git:

```bash
pi install git:github.com/krisitown/jev-loop-control
```

*Note: This package is not available on npm. Do not use `npm install jev-loop-control`.*

## Quickstart

In your target project directory:

1. Download the example configuration:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/krisitown/jev-loop-control/main/jev-loop-control.config.example.json -o jev-loop-control.config.json
   ```

2. Set the configuration path (REQUIRED):
   ```bash
   export JEV_LOOP_CONTROL_CONFIG="$PWD/jev-loop-control.config.json"
   ```

3. Set your API key:
   ```bash
   export AI_GATEWAY_API_KEY="your-vercel-ai-gateway-key"
   ```

4. Start Pi:
   ```bash
   pi
   ```

**Important:** `.env` files are not automatically loaded. You must explicitly export environment variables or source your own trusted `.env` file before starting Pi.

## Configuration

The example configuration enables `observe` mode with a budget of 8 calls, $0.10 allowance, and $0.01 reserve per request. Jev charges are separate from the actor's costs. The reserve is an estimate, not a guaranteed billing cap.

### Modes

- **off**: No supervision.
- **observe**: Logs decisions and traces but does not intervene.
- **enforce**: Blocks tool batches with strong directional verdicts or requests bounded continuations for unfinished completions.

To change modes, edit `jev-loop-control.config.json` or set the environment variable:

```bash
JEV_LOOP_CONTROL_MODE=enforce pi
```

### Endpoints and API

The default configuration uses the Vercel AI Gateway TypeSafe-compatible API. You can configure `jev.endpoint`, `jev.model`, and `jev.apiKeyEnv` in the JSON config.

Default endpoint: `https://ai-gateway.vercel.sh/typesafe/v1/systemone`
Default model: `typesafe-ai/jev`

Your configured Pi model remains the actor. Bounded proposal/evidence is sent to the configured Jev endpoint; traces remain local.

## Tracing

Trace files are stored in `~/.pi/agent/jev-loop-control/runs/<run-id>` by default (respects `PI_CODING_AGENT_DIR`). Files include `events.jsonl`, `manifest.json`, `summary.json`, and artifacts.

Traces may contain project content. While tracing redacts credentials, perfect secret detection is not guaranteed. Review traces before sharing.

## Commands

- `/jev-status`: Shows current supervision status, budget usage, and trace directory.
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
export JEV_LOOP_CONTROL_CONFIG="/absolute/path/to/jev-loop-control.config.json"
pi --no-extensions -e ./src/index.ts
```

Tests use synthetic data and do not require paid credentials.

## Known Limitations

- Gateway cost fields may remain unknown; reservations are kept in these cases.
- This is a supervisor, not a security boundary.
- Completion continuation exercised with real Pi; tool-batch blocking covered by synthetic checks.

## License

MIT License. See [LICENSE](LICENSE) for details.
