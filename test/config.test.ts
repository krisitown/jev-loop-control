import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, defaultConfig, describeConfig, CONFIG_PATH_ENV, MODE_ENV } from "../src/config.ts";

/**
 * Config validation regressions. The loader must be strict without being
 * clever: unknown/bad/null fields are rejected, live inference is impossible
 * without an explicit budget, and a diagnostic message never echoes back a
 * raw invalid value (which may itself be a credential).
 */

function load(json: unknown, env: Record<string, string> = {}, options: { read?: (p: string) => string; exists?: (p: string) => boolean } = {}) {
	const text = typeof json === "string" ? json : JSON.stringify(json);
	return loadConfig("/project", { [CONFIG_PATH_ENV]: "/project/jev-loop-control.config.json", ...env }, {
		read: options.read ?? (() => text),
		exists: options.exists ?? (() => true),
	});
}

test("defaults: mode off, live disabled, no env needed", () => {
	const base = defaultConfig();
	assert.equal(base.mode, "off");
	assert.equal(base.modeSource, "default");
	assert.equal(base.jev.enabled, false);
	assert.equal(base.budget.allowanceUsd, 0);
	// An empty project with no config file is the default: off, no problems.
	const result = loadConfig("/empty", {}, { read: () => { throw new Error("must not read"); }, exists: () => false });
	assert.deepEqual(result.problems, []);
	assert.equal(result.config.mode, "off");
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

	const rel = load({ taskManifestPath: "task.json" }, {}, { exists: (p) => !p.endsWith("gone.json") });
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
	const ok = load({ jev: { apiKeyEnv: "MY_GATEWAY_KEY", enabled: false } });
	assert.deepEqual(ok.problems, []);
	assert.equal(ok.config.jev.apiKeyEnv, "MY_GATEWAY_KEY");
	const looksLikeKey = load({ jev: { apiKeyEnv: "sk-live-abcdef0123456789" } });
	assert.ok(looksLikeKey.problems.some((p) => p.includes("environment variable NAME")));
	assert.ok(!JSON.stringify(looksLikeKey.problems).includes("abcdef0123456789"));
});

test("live observe AND enforce both require enabled plus positive allowance/reservation and a finite nonzero cap", () => {
	for (const mode of ["observe", "enforce"] as const) {
		const noAllowance = load({ mode, jev: { enabled: true }, budget: { maxRequests: 5, allowanceUsd: 0, reserveUsdPerRequest: 0.01 } }, { AI_GATEWAY_API_KEY: "present" });
		assert.ok(noAllowance.problems.some((p) => p.includes("allowanceUsd") && p.includes("nonzero")), `${mode}: ${noAllowance.problems.join(";")}`);

		const zeroCap = load({ mode, jev: { enabled: true }, budget: { maxRequests: 0, allowanceUsd: 1, reserveUsdPerRequest: 0.01 } }, { AI_GATEWAY_API_KEY: "present" });
		assert.ok(zeroCap.problems.some((p) => p.includes("maxRequests")));

		const noReservation = load({ mode, jev: { enabled: true }, budget: { maxRequests: 5, allowanceUsd: 1, reserveUsdPerRequest: 0 } }, { AI_GATEWAY_API_KEY: "present" });
		assert.ok(noReservation.problems.some((p) => p.includes("reserveUsdPerRequest")));

		const noKey = load({ mode, jev: { enabled: true }, budget: { maxRequests: 5, allowanceUsd: 1, reserveUsdPerRequest: 0.01 } }, {});
		assert.ok(noKey.problems.some((p) => p.includes("AI_GATEWAY_API_KEY") && p.includes("not set")));

		const good = load({ mode, jev: { enabled: true }, budget: { maxRequests: 5, allowanceUsd: 1, reserveUsdPerRequest: 0.01 } }, { AI_GATEWAY_API_KEY: "present" });
		assert.deepEqual(good.problems, []);
		assert.equal(good.config.mode, mode);
	}
});

test("enabled never infers a budget: defaults plus enabled still fail", () => {
	const r = load({ mode: "enforce", jev: { enabled: true } }, { AI_GATEWAY_API_KEY: "present" });
	assert.ok(r.problems.some((p) => p.includes("allowanceUsd")));
	assert.ok(r.problems.some((p) => p.includes("maxRequests")));
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
