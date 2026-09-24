import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, defaultConfig, describeConfig, CONFIG_PATH_ENV, MODE_ENV } from "../src/config.ts";

/**
 * Config validation regressions. The loader must be strict without being
 * clever: unknown/bad/null fields are rejected, and a diagnostic message never
 * echoes back a raw invalid value (which may itself be a credential).
 */

function load(json: unknown, env: Record<string, string> = { AI_GATEWAY_API_KEY: "synthetic-key" }, options: { read?: (p: string) => string; exists?: (p: string) => boolean } = {}) {
	const text = typeof json === "string" ? json : JSON.stringify(json);
	return loadConfig("/project", { [CONFIG_PATH_ENV]: "/project/jev-loop-control.config.json", ...env }, {
		read: options.read ?? (() => text),
		exists: options.exists ?? (() => true),
	});
}

test("defaults: mode enforce, live enabled, unlimited caps", () => {
	const base = defaultConfig();
	assert.equal(base.mode, "enforce");
	assert.equal(base.modeSource, "default");
	assert.equal(base.jev.enabled, true);
	assert.equal(base.budget.allowanceUsd, null);
	assert.equal(base.budget.maxRequests, null);
	assert.equal(base.limits.maxAssessments, null);
	// Total interventions are unlimited by default; only terminal continuations
	// and the local request guard stay bounded.
	assert.equal(base.limits.maxInterventionsPerTask, null);
	assert.equal(base.limits.maxTerminalContinuations, 2);
	// 131072 is a local transport guard, not an asserted provider limit.
	assert.equal(base.jev.maxRequestBytes, 131_072);

	// An empty project with no config file is the default: enforce, valid if key present.
	const result = loadConfig("/empty", { AI_GATEWAY_API_KEY: "synthetic-key" }, { read: () => { throw new Error("must not read"); }, exists: () => false });
	assert.deepEqual(result.problems, []);
	assert.equal(result.config.mode, "enforce");

	// Without key, it fails validation for missing key.
	const noKey = loadConfig("/empty", {}, { read: () => { throw new Error("must not read"); }, exists: () => false });
	assert.ok(noKey.problems.some((p) => p.includes("AI_GATEWAY_API_KEY") && p.includes("not set")));
});

test("unknown keys and wrong types are rejected", () => {
	const r = load({ mode: "observe", surprise: true });
	assert.ok(r.problems.some((p) => p.includes("surprise") && p.includes("unknown key")), r.problems.join(";"));
	const bad = load({ jev: { enabled: "yes", deadlineMs: "5000" } });
	assert.ok(bad.problems.some((p) => p.includes("jev.enabled") && p.includes("boolean")));
	assert.ok(bad.problems.some((p) => p.includes("jev.deadlineMs") && p.includes("finite")));
});

test("null section values are schema errors, not silent defaults", () => {
	const r = load({ jev: null, budget: null });
	assert.ok(r.problems.some((p) => p.startsWith("jev:") && p.includes("expected an object")));
	assert.ok(r.problems.some((p) => p.startsWith("budget:") && p.includes("expected an object")));
});

test("taskManifestPath: explicit null is legal, paths resolve, missing files fail", () => {
	const explicitNull = load({ taskManifestPath: null });
	assert.deepEqual(explicitNull.problems, []);
	assert.equal(explicitNull.config.taskManifestExplicit, true);
	assert.equal(explicitNull.config.taskManifestPath, null);

	const rel = load({ taskManifestPath: "task.json" }, { AI_GATEWAY_API_KEY: "synthetic-key" }, { exists: (p) => !p.endsWith("gone.json") });
	assert.deepEqual(rel.problems, []);
	assert.equal(rel.config.taskManifestPath, "/project/task.json");
	assert.equal(rel.config.taskManifestExplicit, true);

	const missing = load({ taskManifestPath: "gone.json" }, {}, { exists: (p) => p !== "/project/gone.json" });
	assert.ok(missing.problems.some((p) => p.startsWith("taskManifestPath") && p.includes("does not exist")));

	const wrongType = load({ taskManifestPath: 42 });
	assert.ok(wrongType.problems.some((p) => p.includes("taskManifestPath") && p.includes("string")));
});

test("endpoint: HTTP(S) only, embedded credentials and queries rejected, never echoed back", () => {
	const creds = load({ jev: { endpoint: "https://user:hunter2-pw@api.example.com/v1" } });
	assert.ok(creds.problems.some((p) => p.includes("must not embed credentials")));
	assert.ok(!JSON.stringify(creds.problems).includes("hunter2-pw"), "diagnostic must not echo the raw URL");

	const query = load({ jev: { endpoint: "https://api.example.com/v1?key=SECRETVALUE" } });
	assert.ok(query.problems.some((p) => p.includes("query or fragment")));
	assert.ok(!JSON.stringify(query.problems).includes("SECRETVALUE"), "query strings can carry credentials; they must not be echoed");

	const ftp = load({ jev: { endpoint: "ftp://api.example.com/v1" } });
	assert.ok(ftp.problems.some((p) => p.includes("scheme")));

	const plain = load({ jev: { endpoint: "http://localhost:8787/v1" } });
	assert.deepEqual(plain.problems, []);
	assert.ok(plain.notices.some((n) => n.includes("unencrypted")));
});

test("invalid values are never reflected in problems, even when they look like secrets", () => {
	const r = load({ jev: { apiKeyEnv: "sk-abcdef0123456789" }, mode: { nested: "object" } });
	const serialized = JSON.stringify(r.problems);
	assert.ok(!serialized.includes("sk-abcdef0123456789"), serialized);
	assert.ok(r.problems.some((p) => p.includes("jev.apiKeyEnv")));
});

test("apiKeyEnv accepts a variable NAME only, never a key value", () => {
	const ok = load({ jev: { apiKeyEnv: "MY_JEV_KEY", enabled: false } });
	assert.deepEqual(ok.problems, []);
	assert.equal(ok.config.jev.apiKeyEnv, "MY_JEV_KEY");

	// Test credential-shaped values are rejected
	const syntheticKey = "vck_not_a_real_key_for_tests";
	const looksLikeKey = load({ jev: { apiKeyEnv: syntheticKey } });
	assert.ok(looksLikeKey.problems.some((p) => p.includes("expected environment variable name such as AI_GATEWAY_API_KEY, not an API key")));
	assert.ok(!JSON.stringify(looksLikeKey.problems).includes(syntheticKey), "raw value must not appear in problems");
	assert.ok(!JSON.stringify(describeConfig(looksLikeKey.config)).includes(syntheticKey), "raw value must not appear in describeConfig");

	// Verify fallback to default when rejected
	assert.equal(looksLikeKey.config.jev.apiKeyEnv, "AI_GATEWAY_API_KEY");
});

test("live observe AND enforce require enabled and API key; budgets are optional", () => {
	for (const mode of ["observe", "enforce"] as const) {
		// No budget specified -> unlimited, valid if key present
		const noBudget = load({ mode, jev: { enabled: true } }, { AI_GATEWAY_API_KEY: "present" });
		assert.deepEqual(noBudget.problems, []);
		assert.equal(noBudget.config.budget.maxRequests, null);
		assert.equal(noBudget.config.budget.allowanceUsd, null);

		// Partial budget: maxRequests only
		const partialBudget = load({ mode, jev: { enabled: true }, budget: { maxRequests: 5 } }, { AI_GATEWAY_API_KEY: "present" });
		assert.deepEqual(partialBudget.problems, []);
		assert.equal(partialBudget.config.budget.maxRequests, 5);
		assert.equal(partialBudget.config.budget.allowanceUsd, null);
		assert.equal(partialBudget.config.limits.maxAssessments, null);

		// Explicit zero budget -> valid (stops calls)
		const zeroBudget = load({ mode, jev: { enabled: true }, budget: { maxRequests: 0, allowanceUsd: 0 } }, { AI_GATEWAY_API_KEY: "present" });
		assert.deepEqual(zeroBudget.problems, []);
		assert.equal(zeroBudget.config.budget.maxRequests, 0);

		// Missing key -> fatal
		const noKey = load({ mode, jev: { enabled: true } }, {});
		assert.ok(noKey.problems.some((p) => p.includes("AI_GATEWAY_API_KEY") && p.includes("not set")));
	}
});

test("budget validation: negative numbers rejected", () => {
	const r = load({ budget: { maxRequests: -1 } });
	assert.ok(r.problems.some((p) => p.includes("maxRequests") && p.includes("between")));
	const r2 = load({ budget: { allowanceUsd: -0.1 } });
	assert.ok(r2.problems.some((p) => p.includes("allowanceUsd") && p.includes("between")));
});

test("defaults with no config file: unlimited interventions and the 131072 request guard", () => {
	const r = loadConfig("/empty", { AI_GATEWAY_API_KEY: "synthetic-key" }, { read: () => { throw new Error("must not read"); }, exists: () => false });
	assert.deepEqual(r.problems, []);
	assert.equal(r.config.limits.maxInterventionsPerTask, null);
	assert.equal(r.config.limits.maxTerminalContinuations, 2);
	assert.equal(r.config.jev.maxRequestBytes, 131_072);
	assert.ok(JSON.stringify(describeConfig(r.config)).includes("131072"), "guard is visible in the redaction-safe summary");
});

test("limits.maxInterventionsPerTask: default null, explicit null/0/3 accepted", () => {
	const absent = load({});
	assert.deepEqual(absent.problems, []);
	assert.equal(absent.config.limits.maxInterventionsPerTask, null, "omitted means unlimited, not an inherited cap");

	for (const value of [null, 0, 3]) {
		const r = load({ limits: { maxInterventionsPerTask: value } });
		assert.deepEqual(r.problems, [], `expected ${JSON.stringify(value)} to be accepted: ${r.problems.join("; ")}`);
		assert.equal(r.config.limits.maxInterventionsPerTask, value);
	}

	// An explicit cap is stored verbatim; it is a cap, not a target or a default.
	// A config written before 0.2.0 keeps its 3 and still overrides the unlimited
	// default: the upgrade lifts nothing silently.
	const capped = load({ limits: { maxInterventionsPerTask: 3 } });
	assert.equal(capped.config.limits.maxInterventionsPerTask, 3);
	assert.equal(capped.config.limits.maxTerminalContinuations, 2, "a per-task cap never silently moves the continuation bound");
});

test("limits.maxInterventionsPerTask: malformed values are rejected and fall back to unlimited", () => {
	for (const bad of ["3", true, [3], {}, 1.5, -1]) {
		const r = load({ limits: { maxInterventionsPerTask: bad } });
		assert.ok(r.problems.some((p) => p.includes("maxInterventionsPerTask")), `${JSON.stringify(bad)}: ${r.problems.join("; ")}`);
		assert.equal(r.config.limits.maxInterventionsPerTask, null, "a rejected cap falls back to the unlimited default, never to a guessed number");
	}

	const echoed = load({ limits: { maxInterventionsPerTask: "hunter2-per-task" } });
	assert.ok(!JSON.stringify(echoed.problems).includes("hunter2-per-task"), "diagnostics report shape only");
});

test("jev.maxRequestBytes: configurable local guard, bounded range, no provider claim", () => {
	const raised = load({ jev: { maxRequestBytes: 262_144 } });
	assert.deepEqual(raised.problems, []);
	assert.equal(raised.config.jev.maxRequestBytes, 262_144);

	const lowered = load({ jev: { maxRequestBytes: 1024 } });
	assert.deepEqual(lowered.problems, []);
	assert.equal(lowered.config.jev.maxRequestBytes, 1024);

	const tooBig = load({ jev: { maxRequestBytes: 2_000_000 } });
	assert.ok(tooBig.problems.some((p) => p.includes("maxRequestBytes") && p.includes("between")));
	assert.equal(tooBig.config.jev.maxRequestBytes, 131_072);

	const tooSmall = load({ jev: { maxRequestBytes: 16 } });
	assert.ok(tooSmall.problems.some((p) => p.includes("maxRequestBytes") && p.includes("between")));

	const wrongType = load({ jev: { maxRequestBytes: "131072" } });
	assert.ok(wrongType.problems.some((p) => p.includes("maxRequestBytes") && p.includes("finite number")));
	const echoed = load({ jev: { maxRequestBytes: "hunter2-bytes" } });
	assert.ok(!JSON.stringify(echoed.problems).includes("hunter2-bytes"), "diagnostics report shape only");
});

test("limits.maxAssessments: explicit 0 and null are valid", () => {
	const zero = load({ limits: { maxAssessments: 0 } });
	assert.deepEqual(zero.problems, []);
	assert.equal(zero.config.limits.maxAssessments, 0);

	const nullVal = load({ limits: { maxAssessments: null } });
	assert.deepEqual(nullVal.problems, []);
	assert.equal(nullVal.config.limits.maxAssessments, null);
});

test("budget.reserveUsdPerRequest: zero disallowed only when monetary cap provided", () => {
	// With allowanceUsd set, reserve must be positive
	const withCap = load({ jev: { enabled: true }, budget: { allowanceUsd: 1.0, reserveUsdPerRequest: 0 } }, { AI_GATEWAY_API_KEY: "present" });
	assert.ok(withCap.problems.some((p) => p.includes("reserveUsdPerRequest") && p.includes("positive")));

	// Without allowanceUsd (unlimited), reserve can be 0
	const noCap = load({ jev: { enabled: true }, budget: { allowanceUsd: null, reserveUsdPerRequest: 0 } }, { AI_GATEWAY_API_KEY: "present" });
	assert.deepEqual(noCap.problems, []);
	assert.equal(noCap.config.budget.reserveUsdPerRequest, 0);
});

test("budget validation: strings rejected", () => {
	const r = load({ budget: { maxRequests: "5" } });
	assert.ok(r.problems.some((p) => p.includes("maxRequests") && p.includes("finite number or null")));
});

test("budget validation: null is unlimited", () => {
	const r = load({ budget: { maxRequests: null, allowanceUsd: null } });
	assert.deepEqual(r.problems, []);
	assert.equal(r.config.budget.maxRequests, null);
	assert.equal(r.config.budget.allowanceUsd, null);
});

test("mode: environment overrides file; an invalid env mode is fatal, not downgraded quietly", () => {
	const overrode = load({ mode: "enforce" }, { [MODE_ENV]: "observe" });
	assert.equal(overrode.config.mode, "observe");
	assert.equal(overrode.config.modeSource, "environment");
	const invalid = load({ mode: "observe" }, { [MODE_ENV]: "yolo" });
	assert.ok(invalid.problems.some((p) => p.startsWith(MODE_ENV)));
});

test("environment variable value is never copied into the config or problems", () => {
	const r = load({ mode: "observe", jev: { enabled: true }, budget: { maxRequests: 2, allowanceUsd: 1, reserveUsdPerRequest: 0.01 } }, { AI_GATEWAY_API_KEY: "super-secret-key-value" });
	assert.deepEqual(r.problems, []);
	const serialized = JSON.stringify(describeConfig(r.config));
	assert.ok(!serialized.includes("super-secret-key-value"));
	assert.ok(!JSON.stringify(r).includes("super-secret-key-value"));
});

test("malformed JSON reports the shape, not a quoted echo of the input", () => {
	const r = load(`{"apiKey": "leaked-secret-value-123",`);
	assert.equal(r.problems.length, 1);
	assert.ok(r.problems[0]!.includes("not valid JSON"), r.problems[0]!);
	assert.ok(!r.problems[0]!.includes("leaked-secret-value-123"));
});

test("configured config file that does not exist is fatal and stops the read", () => {
	const r = loadConfig("/project", { [CONFIG_PATH_ENV]: "/project/gone.json" }, { read: () => { throw new Error("must not read"); }, exists: () => false });
	assert.ok(r.problems.some((p) => p.startsWith(CONFIG_PATH_ENV) && p.includes("does not exist")));
});

test("unsupported config version is rejected", () => {
	const r = load({ version: 2 });
	assert.ok(r.problems.some((p) => p.startsWith("version")));
});

test("explicit off mode is valid without API key", () => {
	const r = load({ mode: "off", jev: { enabled: true } }, {});
	assert.deepEqual(r.problems, []);
	assert.equal(r.config.mode, "off");
});
