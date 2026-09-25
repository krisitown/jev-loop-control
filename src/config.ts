/**
 * Configuration loading and strict validation.
 *
 * One file, `jev-loop-control.config.json` in the project root, or an explicit
 * path in `JEV_LOOP_CONTROL_CONFIG`. Unknown keys and malformed values are
 * rejected: a supervisor that silently guesses is worse than one that refuses to
 * run. A rejected configuration never quietly lowers the requested mode; the
 * problem is reported through status, the trace, and the doctor.
 *
 * The file may name an environment variable (`apiKeyEnv`). It never contains a
 * secret, and no secret is ever written to a trace or report.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type SupervisorMode = "off" | "observe" | "enforce";

export const CONFIG_FILENAME = "jev-loop-control.config.json";
export const CONFIG_PATH_ENV = "JEV_LOOP_CONTROL_CONFIG";
export const MODE_ENV = "JEV_LOOP_CONTROL_MODE";

export const DEFAULT_ENDPOINTS = {
	/** Vercel AI Gateway, TypeSafe-compatible profile. */
	vercelTypesafe: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
	/** Direct TypeSafe endpoint. */
	directTypesafe: "https://api.typesafe.ai/v1/systemone",
} as const;

export interface JevSection {
	/** When false, no hosted assessment is attempted in any mode. */
	enabled: boolean;
	endpoint: string;
	model: string;
	/** NAME of the environment variable holding the key. Not the key. */
	apiKeyEnv: string;
	/** Total wall-clock deadline for one assessment, in ms. No retries. */
	deadlineMs: number;
	maxResponseBytes: number;
	/**
	 * Local transport guard: a serialized request larger than this is never put
	 * on the wire, and the assessment fails as a transport problem instead.
	 * Configurable, and deliberately NOT a claim about any provider's own limit:
	 * raising it buys no additional provider allowance, it only widens what this
	 * client is willing to send.
	 */
	maxRequestBytes: number;
}

export interface BudgetSection {
	/** Hard cap on dispatched Jev requests per session. null means unlimited. */
	maxRequests: number | null;
	/** Project-specific spending allowance in USD. null means unlimited. */
	allowanceUsd: number | null;
	/** Conservative reservation per dispatched request when cost is unknown. */
	reserveUsdPerRequest: number;
}

export interface PolicySection {
	/** Minimum probability for the winning option to act on. */
	probabilityThreshold: number;
	/** Minimum margin over the runner-up. */
	gapThreshold: number;
	/** The repeated-work diagnostic alone never vetoes below this. */
	repeatDiagnosticThreshold: number;
}

export interface TuningSection {
	enabled: boolean;
	selector: "s1" | "s2";
	softPayloadBytes: number;
	softThreshold: number;
	strongThreshold: number;
	softMinGap: number;
	strongMinGap: number;
	proposalEvery: number;
	completionEnabled: boolean;
	cooldownCheckpoints: number;
}

/**
 * Design invariants, deliberately not configurable: a redirect always needs an
 * actionable focus, and work-mode advice is always guidance only. Exported so
 * policy, traces, and tests read the same constants.
 */
export const POLICY_INVARIANTS = Object.freeze({
	// Requirement attribution is optional: a strongly supported redirect may steer
	// on usefulness alone when no specific requirement defect is identified.
	requireActionableFocus: false,
	workModesGuidanceOnly: true,
});

export interface LimitSection {
	/** Hard cap on interventions per task. null means unlimited. */
	maxInterventionsPerTask: number | null;
	maxTerminalContinuations: number;
	/** Hard cap on assessments per session. null means unlimited. */
	maxAssessments: number | null;
	/** How many finalized proposals may be in flight before they are dropped. */
	proposalLease: number;
	/** Character budget for the evidence block. */
	maxEvidenceChars: number;
	/**
	 * Accepted and validated, but not consulted in this release: no code path
	 * reads it yet. An oversized payload is currently caught by the request-size
	 * guard instead. Kept in the schema so a config that sets it stays valid.
	 */
	maxProposalChars: number;
}

export interface TraceSection {
	/** null keeps runs under the Pi agent directory, outside the actor workspace. */
	dir: string | null;
	/** Also write the exact sanitized request/response artifacts. */
	artifacts: boolean;
}

export interface SupervisorConfig {
	version: 1;
	configPath: string | null;
	mode: SupervisorMode;
	modeSource: "default" | "config" | "environment";
	jev: JevSection;
	budget: BudgetSection;
	policy: PolicySection;
	tuning: TuningSection;
	limits: LimitSection;
	trace: TraceSection;
	/** Optional immutable task manifest; falls back to the original request. */
	taskManifestPath: string | null;
	/** True when the file set `taskManifestPath` explicitly, including `null`. */
	taskManifestExplicit: boolean;
}

export interface ConfigResult {
	config: SupervisorConfig;
	/** Fatal: the supervisor will not supervise. Always surfaced, never swallowed. */
	problems: string[];
	/** Non-fatal notices worth showing in status and the doctor. */
	notices: string[];
}

export function defaultConfig(): SupervisorConfig {
	return {
		version: 1,
		configPath: null,
		mode: "enforce",
		modeSource: "default",
		jev: {
			enabled: true,
			endpoint: DEFAULT_ENDPOINTS.vercelTypesafe,
			model: "typesafe-ai/jev",
			apiKeyEnv: "AI_GATEWAY_API_KEY",
			deadlineMs: 10000,
			maxResponseBytes: 262_144,
			// Local guard only. Sized to carry a bounded evidence snapshot plus the
			// proposal under review; not an asserted provider limit.
			maxRequestBytes: 131_072,
		},
		budget: { maxRequests: null, allowanceUsd: null, reserveUsdPerRequest: 0.01 },
		policy: {
			probabilityThreshold: 0.8,
			gapThreshold: 0.2,
			repeatDiagnosticThreshold: 0.85,
		},
		tuning: { enabled: false, selector: "s2", softPayloadBytes: 24_576, softThreshold: 0.62, strongThreshold: 0.84, softMinGap: 0.12, strongMinGap: 0.24, proposalEvery: 1, completionEnabled: true, cooldownCheckpoints: 0 },
		limits: {
			maxInterventionsPerTask: null,
			maxTerminalContinuations: 2,
			maxAssessments: null,
			proposalLease: 2,
			maxEvidenceChars: 12_000,
			maxProposalChars: 60_000,
		},
		trace: { dir: null, artifacts: true },
		taskManifestPath: null,
		taskManifestExplicit: false,
	};
}

interface Section {
	path: string;
	value: unknown;
	allowed: readonly string[];
}

class Reader {
	#problems: string[] = [];
	#notices: string[] = [];

	get problems(): string[] {
		return this.#problems;
	}
	get notices(): string[] {
		return this.#notices;
	}

	notice(message: string): void {
		this.#notices.push(message);
	}

	fail(path: string, message: string): void {
		this.#problems.push(`${path}: ${message}`);
	}

	checkKeys(section: Section): void {
		if (!this.object(section.path, section.value)) {
			return;
		}
		for (const key of Object.keys(section.value as object)) {
			if (!section.allowed.includes(key)) {
				this.fail(`${section.path}.${key}`, `unknown key (allowed: ${section.allowed.join(", ")})`);
			}
		}
	}

	object(path: string, value: unknown): Record<string, unknown> | undefined {
		if (value === undefined) {
			// Absent means "use the default"; an explicit null is a schema error.
			return {};
		}
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			this.fail(path, `expected an object, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
			return undefined;
		}
		return value as Record<string, unknown>;
	}

	string(section: Record<string, unknown>, path: string, key: string, fallback: string, options: { allowEmpty?: boolean; oneOf?: readonly string[] } = {}): string {
		const raw = section[key];
		if (raw === undefined) {
			return fallback;
		}
		if (typeof raw !== "string") {
			// Shape only: an invalid value may itself be a credential.
			this.fail(`${path}.${key}`, `expected a string, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`);
			return fallback;
		}
		const value = raw.trim();
		if (!options.allowEmpty && value === "") {
			this.fail(`${path}.${key}`, "must not be empty");
			return fallback;
		}
		if (options.oneOf && !options.oneOf.includes(value)) {
			this.fail(`${path}.${key}`, `must be one of: ${options.oneOf.join(", ")}`);
			return fallback;
		}
		return value;
	}

	number(section: Record<string, unknown>, path: string, key: string, fallback: number, range: { min: number; max: number; integer?: boolean }): number {
		const raw = section[key];
		if (raw === undefined) {
			return fallback;
		}
		if (typeof raw !== "number" || !Number.isFinite(raw)) {
			this.fail(`${path}.${key}`, "expected a finite number");
			return fallback;
		}
		if (range.integer && !Number.isInteger(raw)) {
			this.fail(`${path}.${key}`, `must be an integer, got ${raw}`);
			return fallback;
		}
		if (raw < range.min || raw > range.max) {
			this.fail(`${path}.${key}`, `must be between ${range.min} and ${range.max}, got ${raw}`);
			return fallback;
		}
		return raw;
	}

	nullableNumber(section: Record<string, unknown>, path: string, key: string, fallback: number | null, range: { min: number; max: number; integer?: boolean }): number | null {
		const raw = section[key];
		if (raw === undefined) {
			return fallback;
		}
		if (raw === null) {
			return null;
		}
		if (typeof raw !== "number" || !Number.isFinite(raw)) {
			this.fail(`${path}.${key}`, "expected a finite number or null");
			return fallback;
		}
		if (range.integer && !Number.isInteger(raw)) {
			this.fail(`${path}.${key}`, `must be an integer, got ${raw}`);
			return fallback;
		}
		if (raw < range.min || raw > range.max) {
			this.fail(`${path}.${key}`, `must be between ${range.min} and ${range.max}, got ${raw}`);
			return fallback;
		}
		return raw;
	}

	boolean(section: Record<string, unknown>, path: string, key: string, fallback: boolean): boolean {
		const raw = section[key];
		if (raw === undefined) {
			return fallback;
		}
		if (typeof raw !== "boolean") {
			this.fail(`${path}.${key}`, `expected a boolean, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`);
			return fallback;
		}
		return raw;
	}

	url(section: Record<string, unknown>, path: string, key: string, fallback: string): string {
		const value = this.string(section, path, key, fallback);
		let parsed: URL;
		try {
			parsed = new URL(value);
		}
		catch {
			// Shape only: the value may embed credentials.
			this.fail(`${path}.${key}`, "is not an absolute URL");
			return fallback;
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			this.fail(`${path}.${key}`, `URL scheme must be https: or http:, got ${parsed.protocol}`);
			return fallback;
		}
		if (parsed.username || parsed.password) {
			this.fail(`${path}.${key}`, "URL must not embed credentials");
			return fallback;
		}
		if (parsed.search !== "" || parsed.hash !== "") {
			this.fail(`${path}.${key}`, "URL must not carry a query or fragment; query strings can leak credentials");
			return fallback;
		}
		if (parsed.protocol === "http:") {
			this.#notices.push(`${path}.${key} uses plain http:; the credential would be sent unencrypted`);
		}
		return value;
	}

	envName(section: Record<string, unknown>, path: string, key: string, fallback: string): string {
		const value = this.string(section, path, key, fallback);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
			// Shape only: the value may itself be a credential.
			this.fail(`${path}.${key}`, "expected environment variable name such as AI_GATEWAY_API_KEY, not an API key");
			return fallback;
		}
		if (value.length <= 3 || value.length > 128 || value.includes("=")) {
			this.fail(`${path}.${key}`, "expected environment variable name such as AI_GATEWAY_API_KEY, not an API key");
			return fallback;
		}
		// Reject credential-shaped values that might pass the regex check
		if (/^(vck_|sk-|ghp_|github_pat_)/.test(value)) {
			this.fail(`${path}.${key}`, "expected environment variable name such as AI_GATEWAY_API_KEY, not an API key");
			return fallback;
		}
		return value;
	}
}

/** Read and validate. `path` must already be resolved; absent file means defaults. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env, io?: { read?: (p: string) => string; exists?: (p: string) => boolean }): ConfigResult {
	const read = io?.read ?? ((p: string) => readFileSync(p, "utf8"));
	const exists = io?.exists ?? ((p: string) => existsSync(p));
	const base = defaultConfig();
	const reader = new Reader();

	const rawPath = env[CONFIG_PATH_ENV]?.trim();
	let configPath: string | null = null;
	if (rawPath) {
		configPath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
		if (!exists(configPath)) {
			reader.fail(CONFIG_PATH_ENV, `configured config file does not exist: ${configPath}`);
			return { config: base, problems: reader.problems, notices: reader.notices };
		}
	}
	else {
		const candidate = resolve(cwd, CONFIG_FILENAME);
		configPath = exists(candidate) ? candidate : null;
	}

	let file: Record<string, unknown> = {};
	if (configPath) {
		let text: string;
		try {
			text = read(configPath);
		}
		catch (error) {
			reader.fail(CONFIG_PATH_ENV, `cannot read ${configPath}: ${String(error)}`);
			return { config: base, problems: reader.problems, notices: reader.notices };
		}
		try {
			const parsed: unknown = JSON.parse(text);
			const obj = reader.object("$", parsed);
			if (!obj) {
				return { config: base, problems: reader.problems, notices: reader.notices };
			}
			file = obj;
		}
		catch (error) {
			// JSON.parse messages quote the offending input; report the shape only.
			reader.fail(configPath, `is not valid JSON (${error instanceof Error ? error.name : typeof error})`);
			return { config: base, problems: reader.problems, notices: reader.notices };
		}
		reader.checkKeys({ path: "$", value: file, allowed: ["version", "mode", "jev", "budget", "policy", "tuning", "limits", "trace", "taskManifestPath"] });
	}

	const config: SupervisorConfig = { ...base, configPath };

	const version = file.version;
	if (version !== undefined && version !== 1) {
		reader.fail("version", `unsupported config version ${JSON.stringify(version)}; this build supports 1`);
	}

	const fileMode = file.mode === undefined ? undefined : reader.string(file, "$", "mode", base.mode, { oneOf: ["off", "observe", "enforce"] });
	const envMode = env[MODE_ENV]?.trim();
	if (envMode) {
		if (envMode === "off" || envMode === "observe" || envMode === "enforce") {
			config.mode = envMode;
			config.modeSource = "environment";
		}
		else {
			reader.fail(MODE_ENV, `invalid mode ${JSON.stringify(envMode)}; expected off, observe, or enforce`);
		}
	}
	else if (fileMode !== undefined) {
		config.mode = fileMode as SupervisorMode;
		config.modeSource = "config";
	}

	const jev = reader.object("jev", file.jev);
	if (jev) {
		reader.checkKeys({ path: "jev", value: jev, allowed: ["enabled", "endpoint", "model", "apiKeyEnv", "deadlineMs", "maxResponseBytes", "maxRequestBytes"] });
		config.jev = {
			enabled: reader.boolean(jev, "jev", "enabled", base.jev.enabled),
			endpoint: reader.url(jev, "jev", "endpoint", base.jev.endpoint),
			model: reader.string(jev, "jev", "model", base.jev.model),
			apiKeyEnv: reader.envName(jev, "jev", "apiKeyEnv", base.jev.apiKeyEnv),
			deadlineMs: reader.number(jev, "jev", "deadlineMs", base.jev.deadlineMs, { min: 250, max: 30_000, integer: true }),
			maxResponseBytes: reader.number(jev, "jev", "maxResponseBytes", base.jev.maxResponseBytes, { min: 1024, max: 4_194_304, integer: true }),
			maxRequestBytes: reader.number(jev, "jev", "maxRequestBytes", base.jev.maxRequestBytes, { min: 1024, max: 1_048_576, integer: true }),
		};
	}

	const budget = reader.object("budget", file.budget);
	if (budget) {
		reader.checkKeys({ path: "budget", value: budget, allowed: ["maxRequests", "allowanceUsd", "reserveUsdPerRequest"] });
		config.budget = {
			maxRequests: reader.nullableNumber(budget, "budget", "maxRequests", base.budget.maxRequests, { min: 0, max: 100_000, integer: true }),
			allowanceUsd: reader.nullableNumber(budget, "budget", "allowanceUsd", base.budget.allowanceUsd, { min: 0, max: 10_000 }),
			reserveUsdPerRequest: reader.number(budget, "budget", "reserveUsdPerRequest", base.budget.reserveUsdPerRequest, { min: 0, max: 10 }),
		};
	}

	const policy = reader.object("policy", file.policy);
	if (policy) {
		reader.checkKeys({ path: "policy", value: policy, allowed: ["probabilityThreshold", "gapThreshold", "repeatDiagnosticThreshold"] });
		config.policy = {
			probabilityThreshold: reader.number(policy, "policy", "probabilityThreshold", base.policy.probabilityThreshold, { min: 0, max: 1 }),
			gapThreshold: reader.number(policy, "policy", "gapThreshold", base.policy.gapThreshold, { min: 0, max: 1 }),
			repeatDiagnosticThreshold: reader.number(policy, "policy", "repeatDiagnosticThreshold", base.policy.repeatDiagnosticThreshold, { min: 0, max: 1 }),
		};
	}
	const tuning = reader.object("tuning", file.tuning);
	if (tuning) {
		reader.checkKeys({ path: "tuning", value: tuning, allowed: ["enabled", "selector", "softPayloadBytes", "softThreshold", "strongThreshold", "softMinGap", "strongMinGap", "proposalEvery", "completionEnabled", "cooldownCheckpoints"] });
		config.tuning = {
			enabled: reader.boolean(tuning, "tuning", "enabled", base.tuning.enabled),
			selector: reader.string(tuning, "tuning", "selector", base.tuning.selector, { oneOf: ["s1", "s2"] }) as "s1" | "s2",
			softPayloadBytes: reader.number(tuning, "tuning", "softPayloadBytes", base.tuning.softPayloadBytes, { min: 4096, max: 1_048_576, integer: true }),
			softThreshold: reader.number(tuning, "tuning", "softThreshold", base.tuning.softThreshold, { min: 0, max: 1 }),
			strongThreshold: reader.number(tuning, "tuning", "strongThreshold", base.tuning.strongThreshold, { min: 0, max: 1 }),
			softMinGap: reader.number(tuning, "tuning", "softMinGap", base.tuning.softMinGap, { min: 0, max: 1 }),
			strongMinGap: reader.number(tuning, "tuning", "strongMinGap", base.tuning.strongMinGap, { min: 0, max: 1 }),
			proposalEvery: reader.number(tuning, "tuning", "proposalEvery", base.tuning.proposalEvery, { min: 1, max: 1000, integer: true }),
			completionEnabled: reader.boolean(tuning, "tuning", "completionEnabled", base.tuning.completionEnabled),
			cooldownCheckpoints: reader.number(tuning, "tuning", "cooldownCheckpoints", base.tuning.cooldownCheckpoints, { min: 0, max: 1000, integer: true }),
		};
		if (config.tuning.strongThreshold < config.tuning.softThreshold) reader.fail("tuning.strongThreshold", "must be >= tuning.softThreshold");
	}

	const limits = reader.object("limits", file.limits);
	if (limits) {
		reader.checkKeys({ path: "limits", value: limits, allowed: ["maxInterventionsPerTask", "maxTerminalContinuations", "maxAssessments", "proposalLease", "maxEvidenceChars", "maxProposalChars"] });
		config.limits = {
			maxInterventionsPerTask: reader.nullableNumber(limits, "limits", "maxInterventionsPerTask", base.limits.maxInterventionsPerTask, { min: 0, max: 100, integer: true }),
			maxTerminalContinuations: reader.number(limits, "limits", "maxTerminalContinuations", base.limits.maxTerminalContinuations, { min: 0, max: 100, integer: true }),
			maxAssessments: reader.nullableNumber(limits, "limits", "maxAssessments", base.limits.maxAssessments, { min: 0, max: 1000, integer: true }),
			proposalLease: reader.number(limits, "limits", "proposalLease", base.limits.proposalLease, { min: 1, max: 4, integer: true }),
			maxEvidenceChars: reader.number(limits, "limits", "maxEvidenceChars", base.limits.maxEvidenceChars, { min: 500, max: 200_000, integer: true }),
			maxProposalChars: reader.number(limits, "limits", "maxProposalChars", base.limits.maxProposalChars, { min: 1000, max: 1_000_000, integer: true }),
		};
	}

	const trace = reader.object("trace", file.trace);
	if (trace) {
		reader.checkKeys({ path: "trace", value: trace, allowed: ["dir", "artifacts"] });
		const dirRaw = trace.dir;
		let dir: string | null = null;
		if (dirRaw !== undefined && dirRaw !== null) {
			if (typeof dirRaw !== "string" || dirRaw.trim() === "") {
				reader.fail("trace.dir", "must be a non-empty path or null");
			}
			else {
				dir = isAbsolute(dirRaw) ? dirRaw : resolve(cwd, dirRaw.trim());
			}
		}
		config.trace = {
			dir,
			artifacts: reader.boolean(trace, "trace", "artifacts", base.trace.artifacts),
		};
	}

	if (file.taskManifestPath !== undefined) {
		config.taskManifestExplicit = true;
		if (file.taskManifestPath === null) {
			config.taskManifestPath = null;
		}
		else {
			const raw = reader.string(file, "$", "taskManifestPath", "");
			if (raw) {
				config.taskManifestPath = isAbsolute(raw) ? raw : resolve(cwd, raw);
				if (!exists(config.taskManifestPath)) {
					reader.fail("taskManifestPath", "file does not exist");
				}
			}
		}
	}

	// Mode/transport coherence. Enforce is never quietly downgraded: a broken
	// configuration is reported and the supervisor stays inert.
	if (config.mode === "enforce" && config.limits.maxTerminalContinuations === 0) {
		reader.notice("enforce mode with maxTerminalContinuations=0 can only block tools, never continue a task");
	}
	if (config.jev.enabled && config.mode !== "off") {
		// Monetary reservation is only strictly required if a monetary cap is configured.
		// If allowanceUsd is null (unlimited), we don't enforce a positive reserve for budget integrity,
		// though the default is still positive.
		if (config.budget.allowanceUsd !== null && config.budget.reserveUsdPerRequest <= 0) {
			reader.fail("budget.reserveUsdPerRequest", "providers may omit cost metadata, so a positive per-request reservation is required when a spending allowance is configured");
		}
		if (!env[config.jev.apiKeyEnv]) {
			reader.fail("jev.apiKeyEnv", `$${config.jev.apiKeyEnv} is not set in this environment`);
		}
	}
	if (config.mode !== "off" && !config.jev.enabled) {
		reader.notice(`jev.enabled is false: ${config.mode} mode records lifecycle and decision points but makes no hosted assessment`);
	}

	return { config, problems: reader.problems, notices: reader.notices };
}

/** Redaction-safe summary for status/doctor output. */
export function describeConfig(config: SupervisorConfig): Record<string, unknown> {
	return {
		mode: config.mode,
		modeSource: config.modeSource,
		configPath: config.configPath,
		jev: {
			enabled: config.jev.enabled,
			endpoint: config.jev.endpoint,
			model: config.jev.model,
			apiKeyEnv: config.jev.apiKeyEnv,
			deadlineMs: config.jev.deadlineMs,
			maxResponseBytes: config.jev.maxResponseBytes,
			maxRequestBytes: config.jev.maxRequestBytes,
		},
		budget: config.budget,
		policy: config.policy,
		limits: config.limits,
		trace: config.trace,
		taskManifestPath: config.taskManifestPath,
	};
}
