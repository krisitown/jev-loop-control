import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFixture, fauxAssistantMessage, fauxToolCall } from "./support/harness.ts";
import { liveObserve } from "../src/live-observe.ts";
import { readJsonLines } from "../src/trace.ts";
import { retryRequestBudget, retryRequestBudgetReason, assessmentBudgetReason } from "../src/budget.ts";
import { defaultConfig, loadConfig } from "../src/config.ts";
import type { Question } from "../src/types.ts";

/**
 * ACTUAL accounting regressions for the HTTP 503 retry schedule (4 attempts max,
 * 500/1000/2000ms waits), run through the
 * REAL production wiring: `liveObserve(pi, { fetchImpl })` builds the real
 * client inside the real adapter with the real retry gate reading the real
 * shared budget, and only the wire is scripted. Counters are then read back
 * out of summary.json/events.jsonl. There is deliberately NO mirrored budget
 * in this file: whatever the fixture's scripted fetch sees, production made it.
 *
 * The invariants (see review 32): EVERY failed 503's cost is unknown no matter
 * what the retry finally reports, so each extra dispatched request keeps its
 * own reservation and stays an unknown cost, even on a known-cost success. A
 * retry schedule is one assessment, never several, and it can never spend past
 * `budget.maxRequests`.
 */

const KEY_ENV = "JEV_RETRY_TEST_API_KEY";
const FAKE_KEY = "synthetic-fake-retry-key-not-a-secret";

/**
 * Answers for the questions the REAL outbound request actually asked, derived
 * from the JSON body the client put on the wire (the questions map entries carry
 * `type`/`criteria`, not `role`). PROCEED whenever the choice offers it, NONE
 * for a focus question, otherwise the first option; probability 1 on the choice,
 * noul 0.1. Anything else is not what production asks, and answering something
 * else would make the success path a fiction.
 */
function answerWhatWasAsked(bodyText: string): Record<string, unknown> {
	const body = JSON.parse(bodyText) as { questions?: Record<string, { type?: string; criteria?: Record<string, unknown> }> };
	const answers: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(body.questions ?? {})) {
		if (question?.type === "noul") {
			answers[id] = { type: "noul", noul: 0.1 };
			continue;
		}
		const ids = Object.keys(question?.criteria ?? {});
		assert.ok(ids.length > 0, `question ${id} asks with no options`);
		const selected = ids.includes("PROCEED") ? "PROCEED" : /focus/i.test(id) && ids.includes("NONE") ? "NONE" : ids[0]!;
		const probabilities: Record<string, number> = {};
		for (const id2 of ids) {
			probabilities[id2] = 0;
		}
		probabilities[selected] = 1;
		answers[id] = { type: "choice", questionId: id, choice: selected, probabilities, confidence: 0.9 };
	}
	return answers;
}

interface RunResult {
	summary: Record<string, unknown> | undefined;
	events: Array<Record<string, unknown>>;
	calls: number;
}

async function runRetryFixture(
	t: { after(fn: () => void): void },
	options: { script: number[]; billedUsd: number | null; budget?: Record<string, unknown> },
): Promise<RunResult> {
	const supervisorDir = mkdtempSync(join(tmpdir(), "jev-retry-config-"));
	const traceDir = join(supervisorDir, "traces");
	mkdirSync(traceDir);
	const configPath = join(supervisorDir, "jev-loop-control.config.json");
	writeFileSync(configPath, JSON.stringify({
		version: 1,
		mode: "observe",
		jev: { enabled: true, apiKeyEnv: KEY_ENV, deadlineMs: 20000 },
		budget: options.budget ?? {},
		// One direction assessment for the whole session: a terminal completion
		// assessment can never add requests to what these tests count.
		limits: { maxAssessments: 1 },
		trace: { dir: traceDir, artifacts: false },
	}));

	const savedKey = process.env[KEY_ENV];
	const state = { index: 0, calls: 0 };
	t.after(() => {
		if (savedKey === undefined) {
			delete process.env[KEY_ENV];
		}
		else {
			process.env[KEY_ENV] = savedKey;
		}
		rmSync(supervisorDir, { recursive: true, force: true });
	});

	// The only fake here is the wire: the client, the retry gate, the shared
	// budget object, and every counter are production code inside liveObserve.
	const fetchImpl = (async (_url: unknown, init: unknown) => {
		state.calls += 1;
		const status = options.script[Math.min(state.index, options.script.length - 1)] ?? options.script.at(-1)!;
		state.index += 1;
		if (status !== 200) {
			return new Response("{}", { status });
		}
		const answers = answerWhatWasAsked(String((init as { body: string }).body));
		const body = {
			answers,
			...(options.billedUsd !== null ? { cost: { billed_usd: options.billedUsd } } : {}),
			id: `req-${state.calls}`,
		};
		return new Response(JSON.stringify(body), { status: 200 });
	}) as unknown as typeof fetch;

	// The client, the retry gate, the shared budget object, and every
	// counter are production code inside liveObserve.
	const factory: ExtensionFactory = (pi: ExtensionAPI) => {
		liveObserve(pi, { fetchImpl });
	};

	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([fauxToolCall("write_toy", { path: "notes.txt", text: "x" }, { id: "call-write" })]),
			fauxAssistantMessage("done"),
		],
		tools: [{ name: "write_toy" }, { name: "read_toy" }],
		// `undefined` makes the harness DELETE the mode override, exactly like the
		// live-steering suite: without it the config's own mode never applies.
		env: { [KEY_ENV]: FAKE_KEY, JEV_LOOP_CONTROL_CONFIG: configPath, JEV_LOOP_CONTROL_MODE: undefined },
		extensions: [{ name: "jev-retry-accounting", factory }],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("write the note to notes.txt");

	const runs = readdirSync(traceDir);
	assert.equal(runs.length, 1, `exactly one run directory under ${traceDir}`);
	const runDir = join(traceDir, runs[0]!);
	let summary: Record<string, unknown> | undefined;
	try {
		summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as Record<string, unknown>;
	}
	catch {
		summary = undefined;
	}
	return { summary, events: readJsonLines(join(runDir, "events.jsonl")), calls: state.calls };
}

function ofType(events: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
	return events.filter((event) => event.type === type);
}

/** The one direction assessment's retry view, with sane defaults for "no retry". */
function retryView(run: RunResult): { attempts: number; note: string | null; extra: number; traceUnknown: number } {
	const assessment = ofType(run.events, "direction_assessment")[0];
	assert.ok(assessment, "the observe-mode assessment was traced");
	const usage = assessment.usage as { attempts: number };
	const retry = ofType(run.events, "assessment.retry")[0];
	const note = (assessment.retry as string | null | undefined) ?? null;
	return {
		attempts: usage.attempts,
		note: note ?? (retry ? (retry.note as string) : null),
		extra: retry ? (retry.extraRequests as number) : 0,
		traceUnknown: retry ? (retry.unknownCosts as number) : 0,
	};
}

function counters(run: RunResult): { requests: number; assessments: number; budget: Record<string, number> } {
	assert.ok(run.summary, "summary.json was written");
	return {
		requests: run.summary.requests as number,
		assessments: run.summary.assessments as number,
		budget: run.summary.budget as Record<string, number>,
	};
}

test("accounting: 503 then known-cost 200 leaves the failed attempt reserved and unknown", { timeout: 60_000 }, async (t) => {
	const run = await runRetryFixture(t, { script: [503, 200], billedUsd: 0.05 });
	assert.equal(run.calls, 2, "exactly two HTTP requests");
	const view = retryView(run);
	assert.equal(view.attempts, 2);
	assert.match(view.note ?? "", /http 503 retried 1 time\(s\) after exponential waits: succeeded/);
	assert.equal(view.extra, 1);
	assert.equal(view.traceUnknown, 1, "the retry trace counts the FIRST 503's unknown cost");

	const { requests, assessments, budget } = counters(run);
	assert.equal(requests, 2, "both dispatched requests are counted");
	assert.equal(assessments, 1, "a retry is never a second assessment");
	assert.equal(budget.billedUsd, 0.05, "billed is exactly what the FINAL response reported");
	assert.equal(budget.unknownCosts, 1, "the failed 503's cost is unknown even though the final cost was known");
	// The final settlement subtracted ONE reservation; the retry's own reservation
	// stays armed, so exactly reserveUsdPerRequest (the default 0.01) remains.
	assert.ok(Math.abs((budget.reservedUsd ?? 0) - 0.01) < 1e-9, `one failed-attempt reservation stays armed: ${budget.reservedUsd}`);
});

test("accounting: an all-503 exchange spends the whole schedule and leaves four unknowns and four reservations", { timeout: 60_000 }, async (t) => {
	// No caps configured: the schedule, not the gate, ends the exchange at 4
	// dispatched requests, and EVERY failed 503 keeps its own unknown cost and
	// its own armed reservation. A fifth request is never dispatched.
	const run = await runRetryFixture(t, { script: [503], billedUsd: null });
	assert.equal(run.calls, 4, "initial plus 3 retries, never a fifth");
	const view = retryView(run);
	assert.equal(view.attempts, 4);
	assert.match(view.note ?? "", /http 503 retried 3 time\(s\) after exponential waits/);

	const { requests, assessments, budget } = counters(run);
	assert.equal(requests, 4);
	assert.equal(assessments, 1, "the whole retry schedule is still one assessment");
	assert.equal(budget.unknownCosts, 4, "every dispatched request cost something nobody reported");
	assert.ok(Math.abs((budget.reservedUsd ?? 0) - 0.04) < 1e-9, `all four reservations stay armed: ${budget.reservedUsd}`);
	assert.equal(budget.billedUsd, 0);
});

test("accounting: three 503s rescued by a known-cost attempt 4 keep every failed attempt unknown and reserved", { timeout: 120_000 }, async (t) => {
	const run = await runRetryFixture(t, { script: [503, 503, 503, 200], billedUsd: 0.05 });
	assert.equal(run.calls, 4, "exactly four HTTP requests");
	const view = retryView(run);
	assert.equal(view.attempts, 4);
	assert.match(view.note ?? "", /http 503 retried 3 time\(s\) after exponential waits: succeeded/);
	assert.equal(view.extra, 3);

	const { requests, assessments, budget } = counters(run);
	assert.equal(requests, 4, "all four dispatched requests are counted");
	assert.equal(assessments, 1, "the retry schedule is still one assessment");
	assert.equal(budget.billedUsd, 0.05, "billed is exactly what the FINAL response reported");
	assert.equal(budget.unknownCosts, 3, "the failed 503s' costs are unknown even though the final cost was known");
	// The final settlement subtracted ONE reservation; the retries' own
	// reservations stay armed: 3 x reserveUsdPerRequest (the default 0.01).
	assert.ok(Math.abs((budget.reservedUsd ?? 0) - 0.03) < 1e-9, `three failed-attempt reservations stay armed: ${budget.reservedUsd}`);
});

test("accounting: maxRequests 1 denies the retry at the real gate, maxRequests 2 allows exactly one retry", { timeout: 120_000 }, async (t) => {
	// Cap already spent by the assessment's own request: the retry must not go out.
	const capped = await runRetryFixture(t, { script: [503, 200], billedUsd: 0.05, budget: { maxRequests: 1 } });
	assert.equal(capped.calls, 1, "a request cap of 1 leaves no room for a second dispatch");
	assert.equal(retryView(capped).attempts, 1);
	assert.match(retryView(capped).note ?? "", /http 503: no retry \(request cap reached \(1\/1\)\)/);
	assert.equal(counters(capped).requests, 1);

	// A cap of 2 has exactly one retry's room: the second dispatch goes out, and
	// the gate denies the third with the attempts already dispatched (2/2).
	const allowed = await runRetryFixture(t, { script: [503, 503, 200], billedUsd: 0.05, budget: { maxRequests: 2 } });
	assert.equal(allowed.calls, 2, "a request cap of 2 leaves exactly one retry's room");
	assert.equal(retryView(allowed).attempts, 2);
	assert.match(retryView(allowed).note ?? "", /http 503: no retry \(request cap reached \(2\/2\)\)/);
	assert.equal(counters(allowed).requests, 2);
});

test("accounting: maxRequests 3 spends the cap on exactly two retries and stops at 3 attempts", { timeout: 120_000 }, async (t) => {
	const capped = await runRetryFixture(t, { script: [503, 503, 503, 200], billedUsd: 0.05, budget: { maxRequests: 3 } });
	assert.equal(capped.calls, 3, "the initial request plus two retries exhaust the cap; no fourth goes out");
	assert.equal(retryView(capped).attempts, 3);
	assert.match(retryView(capped).note ?? "", /http 503: no retry \(request cap reached \(3\/3\)\)/);
	const { requests, budget } = counters(capped);
	assert.equal(requests, 3);
	assert.equal(budget.unknownCosts, 3, "all three dispatched 503s cost something nobody reported");
	assert.ok(Math.abs((budget.reservedUsd ?? 0) - 0.03) < 1e-9, `all three reservations stay armed: ${budget.reservedUsd}`);
});

test("gate: retry budget ignores the assessment cap and keeps the ordinary preflight unchanged", () => {
	// The unit-level contract of the gate the adapter wires in: imported from
	// production, not reimplemented here.
	const config = defaultConfig();
	config.limits.maxAssessments = 1;
	config.budget.maxRequests = 2;
	const spent = { requestsUsed: 1, reservedUsd: 0.01, billedUsd: 0, marketUsd: 0, unknownCosts: 0 };
	// A retry is not another assessment: the assessment cap must not stop it...
	assert.equal(retryRequestBudgetReason(config, spent), null);
	// ...while the ordinary assessment preflight still stops at that same cap.
	assert.ok(assessmentBudgetReason(config, spent, 1)?.includes("assessment cap"));
	config.budget.maxRequests = 1;
	assert.ok(retryRequestBudgetReason(config, spent)?.includes("request cap"));
	assert.deepEqual(retryRequestBudget(config, spent), { allowed: false, reason: retryRequestBudgetReason(config, spent) });
});

// Sanity: loadConfig really reads the fixture dir the way production does, so a
// silently-missing config cannot turn these into unlimited-budget no-ops.
test("accounting: allowanceUsd cap stops dispatch after 2 requests with persistent 503s", { timeout: 60_000 }, async (t) => {
	const run = await runRetryFixture(t, {
		script: [503],
		billedUsd: null,
		budget: { allowanceUsd: 0.025, reserveUsdPerRequest: 0.01 },
	});
	assert.equal(run.calls, 2, "allowance cap allows exactly 2 dispatches (2 * 0.01 <= 0.025, 3 * 0.01 > 0.025)");
	const view = retryView(run);
	assert.equal(view.attempts, 2);
	assert.match(view.note ?? "", /http 503: no retry \(allowance exhausted \(projected .* > .*\)/);
	const { requests, budget } = counters(run);
	assert.equal(requests, 2);
	assert.equal(budget.unknownCosts, 2, "both dispatched 503s have unknown costs");
	assert.ok(Math.abs((budget.reservedUsd ?? 0) - 0.02) < 1e-9, `two reservations stay armed: ${budget.reservedUsd}`);
});

test("fixture: the adapter's own config carries the caps under test", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-retry-cfg-"));
	try {
		const configPath = join(dir, "jev-loop-control.config.json");
		writeFileSync(configPath, JSON.stringify({ version: 1, mode: "observe", jev: { enabled: true, apiKeyEnv: KEY_ENV }, budget: { maxRequests: 1 }, limits: { maxAssessments: 1 }, trace: { dir: join(dir, "traces"), artifacts: false } }));
		const loaded = loadConfig(dir, { JEV_LOOP_CONTROL_CONFIG: configPath, [KEY_ENV]: FAKE_KEY });
		assert.deepEqual(loaded.problems, []);
		assert.equal(loaded.config?.budget.maxRequests, 1);
		assert.equal(loaded.config?.limits.maxAssessments, 1);
	}
	finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
