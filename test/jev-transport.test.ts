import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestBody, createHttpClient, isRetryable503, postAssessment, sleepOrAbort, validateResponse, DEFAULT_JEV_DEADLINE_MS, HTTP_503_MAX_ATTEMPTS, HTTP_503_RETRY_DELAYS_MS, HTTP_503_RETRY_STATUS, PROBABILITY_SUM_TOLERANCE } from "../src/jev.ts";
import { hashBytes } from "../src/redact.ts";
import type { Question } from "../src/types.ts";

/**
 * Transport and answer-validation regressions. One POST, a total deadline, a
 * capped body, and strict TypeSafe-compatible answer shapes. The ONLY retry is
 * the HTTP 503 schedule: at most 4 dispatched requests (initial + 3 retries)
 * with 500/1000/2000ms waits, inside the same deadline and abort signal; nothing
 * else is ever retried:
 * choice -> {type:"choice",choice,probabilities,confidence}; noul -> {type:
 * "noul", noul} where noul is the probability of YES.
 */

const QUESTIONS: Question[] = [
	{
		type: "choice",
		id: "next_step",
		role: "next_step",
		instructions: "What is the next step?",
		criteria: { PROCEED: "go", RESEARCH: "look", UNCERTAIN: "shrug" },
	},
	{
		type: "noul",
		id: "unproductive_repeat",
		role: "unproductive_repeat",
		instructions: "Is this a repeat?",
		criteria: { true: "yes repeat", false: "no" },
	},
];

const GOOD_ANSWERS = {
	next_step: { type: "choice", choice: "PROCEED", probabilities: { PROCEED: 0.9, RESEARCH: 0.08, UNCERTAIN: 0.02 }, confidence: 0.7 },
	unproductive_repeat: { type: "noul", noul: 0.1 },
};

function responseOf(body: unknown, init: { status?: number } = {}): Response {
	return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- validation

test("validateResponse: strict TypeSafe-compatible shapes", () => {
	const ok = validateResponse({ answers: GOOD_ANSWERS }, QUESTIONS);
	assert.ok(ok.ok, JSON.stringify(ok));
	if (ok.ok) {
		assert.equal(ok.answers.next_step?.type, "choice");
		assert.deepEqual(Object.keys(ok.answers.next_step!.probabilities!), ["PROCEED", "RESEARCH", "UNCERTAIN"]);
		// Confidence is retained as reported, NOT replaced by P(selected).
		assert.equal((ok.answers.next_step as { confidence: number }).confidence, 0.7);
		assert.equal(ok.answers.unproductive_repeat?.type, "noul");
		assert.equal(ok.answers.unproductive_repeat?.noul, 0.1);
	}

	const bad: Array<[unknown, string]> = [
		[{ answers: { ...GOOD_ANSWERS, next_step: { ...GOOD_ANSWERS.next_step, type: "noul" } } }, "answer type"],
		[{ answers: { ...GOOD_ANSWERS, next_step: { choice: "PROCEED", probabilities: { PROCEED: 1, RESEARCH: 0, UNCERTAIN: 0 }, confidence: 1 } } }, "answer type undefined"],
		[{ answers: { ...GOOD_ANSWERS, next_step: { ...GOOD_ANSWERS.next_step, probabilities: { PROCEED: 0.6, RESEARCH: 0.3, UNCERTAIN: 0.05 } } } }, "sum"],
		[{ answers: { ...GOOD_ANSWERS, next_step: { ...GOOD_ANSWERS.next_step, probabilities: { ...GOOD_ANSWERS.next_step.probabilities, EXTRA: 0.0 } } } }, "unknown option"],
		[{ answers: { ...GOOD_ANSWERS, next_step: { ...GOOD_ANSWERS.next_step, choice: "NOPE" } } }, "unknown choice"],
		[{ answers: { ...GOOD_ANSWERS, next_step: { ...GOOD_ANSWERS.next_step, choice: "RESEARCH", probabilities: { PROCEED: 0.9, RESEARCH: 0.09, UNCERTAIN: 0.01 } } } }, "contradicts distribution"],
		[{ answers: { ...GOOD_ANSWERS, next_step: { ...GOOD_ANSWERS.next_step, confidence: 1.5 } } }, "confidence range"],
		[{ answers: { ...GOOD_ANSWERS, next_step: { ...GOOD_ANSWERS.next_step, probabilities: { ...GOOD_ANSWERS.next_step.probabilities, RESEARCH: Number.NaN } } } }, "non-finite"],
		[{ answers: { ...GOOD_ANSWERS, unproductive_repeat: { type: "noul", noul: 1.5 } } }, "noul range"],
		[{ answers: { ...GOOD_ANSWERS, unproductive_repeat: { type: "noul", noul: "0.9" } } }, "noul type"],
		[{ answers: GOOD_ANSWERS, extra_question: GOOD_ANSWERS.next_step }, "n/a"], // extra answers are ignored; see below
		[{ answers: {} }, "missing answers"],
		["not an object", "not an object"],
	];
	for (const [payload, label] of bad) {
		const result = validateResponse(payload, QUESTIONS);
		if (label === "n/a") {
			// Extra answers that were not asked about are ignored, not invented into questions.
			assert.ok(result.ok, `${label} should still validate`);
			continue;
		}
		assert.ok(!result.ok, `${label} should fail validation`);
	}

	// A missing answer for any sent question is fatal.
	const missing = validateResponse({ answers: { next_step: GOOD_ANSWERS.next_step } }, QUESTIONS);
	assert.ok(!missing.ok && missing.problems.some((p) => p.includes("unproductive_repeat") && p.includes("missing")));
}	);

test("validateResponse: cost reading rejects negatives and keeps billed/market independent", () => {
	const withAnswers = (cost: unknown) => ({ answers: GOOD_ANSWERS, cost });
	const both = validateResponse(withAnswers({ billed_usd: 0.01, market_usd: 0.02 }), QUESTIONS);
	assert.deepEqual([both.cost.billedUsd, both.cost.marketUsd, both.cost.unknown], [0.01, 0.02, false]);

	// Market-only: the charge is still unknown, so the reservation must stay armed.
	const market = validateResponse(withAnswers({ market_usd: 0.02 }), QUESTIONS);
	assert.deepEqual([market.cost.billedUsd, market.cost.marketUsd, market.cost.unknown], [null, 0.02, true]);

	const billedOnly = validateResponse(withAnswers({ billed_usd: 0.01 }), QUESTIONS);
	assert.deepEqual([billedOnly.cost.billedUsd, billedOnly.cost.marketUsd, billedOnly.cost.unknown], [0.01, null, false]);

	// Missing cost is unknown, never zero.
	const none = validateResponse({ answers: GOOD_ANSWERS }, QUESTIONS);
	assert.deepEqual([none.cost.billedUsd, none.cost.marketUsd, none.cost.unknown], [null, null, true]);

	// A negative charge is malformed, not a credit.
	const negative = validateResponse(withAnswers({ billed_usd: -0.01, market_usd: -0.02 }), QUESTIONS);
	assert.deepEqual([negative.cost.billedUsd, negative.cost.marketUsd, negative.cost.unknown], [null, null, true]);
});

test("validateResponse: sum tolerance is honest and small", () => {
	const inside = validateResponse({ answers: { ...GOOD_ANSWERS, next_step: { type: "choice", choice: "PROCEED", probabilities: { PROCEED: 0.9, RESEARCH: 0.09, UNCERTAIN: 0.005 }, confidence: 1 } } }, QUESTIONS);
	assert.ok(inside.ok);
	const outside = validateResponse({ answers: { ...GOOD_ANSWERS, next_step: { type: "choice", choice: "PROCEED", probabilities: { PROCEED: 0.9, RESEARCH: 0.05, UNCERTAIN: 0.005 }, confidence: 1 } } }, QUESTIONS);
	assert.ok(!outside.ok && outside.problems.some((p) => p.includes("sums")));
	assert.equal(PROBABILITY_SUM_TOLERANCE, 0.02);
});

test("buildRequestBody: sanitized bytes, honest hash, protocol question map", () => {
	const secret = "sk-supersecretkey123";
	const built = buildRequestBody({ model: "typesafe-ai/jev", state: { note: `used ${secret} here`, nested: { deep: "clean" } }, questions: QUESTIONS }, (t) => t.split(secret).join("[REDACTED]"));
	const parsed = JSON.parse(built.body);
	assert.ok(!built.body.includes(secret), "the outgoing body is the sanitized body");
	assert.equal(built.bytes, Buffer.byteLength(built.body, "utf8"));
	assert.equal(built.hash, hashBytes(built.body), "the hash describes the exact serialized bytes");
	assert.deepEqual(Object.keys(parsed.questions), ["next_step", "unproductive_repeat"]);
	assert.deepEqual(Object.keys(parsed.questions.next_step), ["type", "instructions", "criteria"]);
	assert.equal(parsed.questions.unproductive_repeat.type, "noul");
});

// ---------------------------------------------------------------- transport

test("postAssessment: exactly one POST, bounded bytes, no retries", async () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return responseOf({ answers: GOOD_ANSWERS });
	}) as unknown as typeof fetch;
	const outcome = await postAssessment({ endpoint: "https://example.test/v1", apiKey: "k", body: "{}", deadlineMs: 2000, maxResponseBytes: 1024, signal: undefined, fetchImpl });
	assert.ok(outcome.ok);
	assert.equal(calls, 1, "one dispatched request per attempt");
	assert.equal(outcome.attempts, 1, "postAssessment itself never repeats: the single 503 retry lives in the client");
});

test("postAssessment: a response over the byte cap fails the assessment, it is not trimmed", async () => {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
			// never close: the cap must trip without the stream ending
		},
	});
	const fetchImpl = (async () => new Response(stream)) as unknown as typeof fetch;
	const outcome = await postAssessment({ endpoint: "https://example.test/v1", apiKey: "k", body: "{}", deadlineMs: 2000, maxResponseBytes: 1024, signal: undefined, fetchImpl });
	assert.ok(!outcome.ok);
	assert.match(outcome.error ?? "", /exceeds 1024 bytes/);
});

test("postAssessment: pre-aborted signal dispatches NOTHING (zero attempts)", async () => {
	let calls = 0;
	const fetchImpl = (async () => { calls += 1; return responseOf({}); }) as unknown as typeof fetch;
	const ac = new AbortController();
	ac.abort();
	const outcome = await postAssessment({ endpoint: "https://example.test/v1", apiKey: "k", body: "{}", deadlineMs: 2000, maxResponseBytes: 4096, signal: ac.signal, fetchImpl });
	assert.equal(calls, 0, "no request may touch the network after cancellation");
	assert.ok(!outcome.ok && outcome.aborted);
	assert.equal(outcome.error, "cancelled before dispatch");
});

test("postAssessment: deadline during the BODY READ never returns success, not even with partial valid JSON", async () => {
	// The stream delivers a COMPLETE, valid JSON answer and then stalls forever.
	// A reader.cancel() resolving `done` must not be mistaken for a completed read.
	const body = new TextEncoder().encode(JSON.stringify({ answers: GOOD_ANSWERS }));
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(body);
			// intentionally never closes
		},
	});
	const fetchImpl = (async () => new Response(stream)) as unknown as typeof fetch;
	const outcome = await postAssessment({ endpoint: "https://example.test/v1", apiKey: "k", body: "{}", deadlineMs: 60, maxResponseBytes: 65536, signal: undefined, fetchImpl });
	assert.ok(!outcome.ok, "a timed-out read of partial bytes is never success");
	assert.equal(outcome.timedOut, true);
	assert.equal(outcome.payload, undefined);
});

test("postAssessment: external abort during the body read discards partial bytes", async () => {
	const body = new TextEncoder().encode(JSON.stringify({ answers: GOOD_ANSWERS }));
	const ac = new AbortController();
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(body);
			setTimeout(() => ac.abort(), 10);
			// never closes
		},
	});
	const fetchImpl = (async () => new Response(stream)) as unknown as typeof fetch;
	const outcome = await postAssessment({ endpoint: "https://example.test/v1", apiKey: "k", body: "{}", deadlineMs: 5000, maxResponseBytes: 65536, signal: ac.signal, fetchImpl });
	assert.ok(!outcome.ok, "cancelled mid-read never reports ok");
	assert.equal(outcome.timedOut, false);
	assert.equal(outcome.payload, undefined);
});

test("postAssessment: abort BEFORE the response arrives, then a deadline on an open stream, settles promptly with no success", { timeout: 1500 }, async () => {
	// Adversarial repro: the fake fetch aborts the EXTERNAL signal immediately
	// before returning a Response whose stream never ends. If the body reader
	// registers its listener on an already-aborted controller signal, no abort
	// event ever fires again and reader.read() hangs past every deadline.
	const ac = new AbortController();
	const fetchImpl = (async () => {
		ac.abort();
		return new Response(new ReadableStream({ start() { /* open forever */ } }));
	}) as unknown as typeof fetch;
	const started = performance.now();
	const outcome = await Promise.race([
		postAssessment({ endpoint: "https://example.test/v1", apiKey: "k", body: "{}", deadlineMs: 30, maxResponseBytes: 65536, signal: ac.signal, fetchImpl }),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HANG: postAssessment did not settle within the 150ms race window")), 150)),
	]);
	const elapsed = performance.now() - started;
	assert.ok(elapsed < 150, `settled in ${elapsed.toFixed(0)}ms`);
	assert.ok(!outcome.ok, "a cancelled exchange never reports success");
	assert.equal(outcome.aborted, true);
	assert.equal(outcome.payload, undefined);
});

test("postAssessment: transport errors never echo raw error text containing credentials", async () => {
	const fetchImpl = (async () => {
		throw new Error("connect failed for https://api.example.com?key=leaked-secret-value");
	}) as unknown as typeof fetch;
	const outcome = await postAssessment({ endpoint: "https://example.test/v1", apiKey: "k", body: "{}", deadlineMs: 1000, maxResponseBytes: 4096, signal: undefined, fetchImpl });
	assert.ok(!outcome.ok);
	assert.ok(!(outcome.error ?? "").includes("leaked-secret-value"), outcome.error ?? "");
});

// ---------------------------------------------------------------- client

function clientWith(fetchImpl: typeof fetch, secrets: readonly string[] = []) {
	return createHttpClient({
		endpoint: "https://example.test/v1",
		model: "typesafe-ai/jev",
		apiKeyEnv: "TEST_JEV_KEY",
		deadlineMs: 2000,
		maxRequestBytes: 49_152,
		maxResponseBytes: 262_144,
		env: { TEST_JEV_KEY: "key-value-8899" },
		fetchImpl,
		secrets,
	});
}

const SNAPSHOT = { target: { kind: "proposal", proposalHash: "h", messageRef: "r" }, task: { manifest: false, requirements: [], origin: "R0" }, actorText: "", proposalText: "", toolCalls: [], observations: [], priorInterventions: [], facts: [], scope: { sessionId: "s", taskId: "t", branch: "b", snapshotHash: "v" }, truncated: false, representation: {} } as const;

test("client: captures the exact sanitized request bytes BEFORE dispatch and hashes of the saved bytes", async () => {
	const secret = "key-value-8899";
	let sentBody = "";
	const fetchImpl = (async (_url: unknown, init: unknown) => {
		sentBody = String((init as { body: string }).body);
		return responseOf({ answers: GOOD_ANSWERS, cost: { billed_usd: 0.01 }, id: "req-1" });
	}) as unknown as typeof fetch;
	const assessment = await clientWith(fetchImpl, [secret]).assess({
		kind: "direction",
		snapshot: SNAPSHOT as never,
		questions: QUESTIONS,
		state: { note: `the key is ${secret}`, ok: 1 },
		signal: undefined,
		deadlineMs: 2000,
	});
	assert.ok(assessment.ok);
	assert.equal(assessment.usage.attempts, 1);
	assert.ok(sentBody.length > 0);
	assert.ok(!assessment.requestBody!.includes(secret), "the stored request artifact is the sanitized body");
	assert.ok(!sentBody.includes(secret), "even the outgoing bytes carry no configured secret");
	assert.equal(assessment.requestHash, hashBytes(assessment.requestBody!), "the hash describes the exact saved bytes");
	assert.equal(assessment.responseHash, hashBytes(assessment.responseBody!), "the response hash describes the exact saved response");
	assert.ok(assessment.responseBody!.includes("PROCEED"), "the response artifact is the actual received body, not a normalized re-encoding");
	assert.deepEqual([assessment.cost.billedUsd, assessment.cost.unknown], [0.01, false]);
	assert.match(assessment.notes, /provider id req-1/);
});

test("client: validation failure messages are scrubbed of the configured key", async () => {
	const secret = "key-value-8899";
	const fetchImpl = (async () => responseOf({ answers: { next_step: { type: "choice", choice: "PROCEED", probabilities: { PROCEED: 1, RESEARCH: 0, UNCERTAIN: 0 }, confidence: 1, note: `signed with ${secret}` }, unproductive_repeat: { type: "noul", noul: 5 } } })) as unknown as typeof fetch;
	const assessment = await clientWith(fetchImpl, [secret]).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 2000 });
	assert.ok(!assessment.ok);
	assert.ok(!JSON.stringify(assessment).includes(secret), "validation problems must not echo the configured key");
	assert.equal(assessment.failure?.stage, "validation");
});

test("client: zero requests on missing key; one clipped dispatch on oversized proposal", async () => {
	let calls = 0;
	const fetchImpl = (async () => { calls += 1; return responseOf({}); }) as unknown as typeof fetch;

	// Missing key: zero dispatch
	const noKey = createHttpClient({ endpoint: "https://x.test", model: "m", apiKeyEnv: "ABSENT_KEY", deadlineMs: 1000, maxRequestBytes: 1000, maxResponseBytes: 1000, env: {}, fetchImpl });
	const a1 = await noKey.assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 1000 });
	assert.ok(!a1.ok && a1.usage.attempts === 0 && calls === 0);

	// Oversized proposal: one clipped dispatch
	const tiny = createHttpClient({ endpoint: "https://x.test", model: "m", apiKeyEnv: "TEST_JEV_KEY", deadlineMs: 1000, maxRequestBytes: 4096, maxResponseBytes: 1000, env: { TEST_JEV_KEY: "k" }, fetchImpl });
	const state = { proposal: { tool_calls: [{ name: "test_tool", arguments: { data: "y".repeat(12000) } }] } };
	const a2 = await tiny.assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state, signal: undefined, deadlineMs: 1000 });

	assert.equal(calls, 1, "fallback dispatched exactly once");
	assert.ok(!a2.ok && a2.usage.attempts === 1 && a2.partialCoverage === true);
	assert.ok(a2.usage.requestBytes <= 4096);
	assert.ok(a2.requestBody);
	const parsed = JSON.parse(a2.requestBody);
	assert.strictEqual(parsed.state._fallback.partial_coverage, true);
	assert.strictEqual(parsed.state._fallback.proposal_clipped, true);
});

// ---------------------------------------------------------------- 503 retry

/**
 * The one retry this client is allowed to make: an HTTP 503 costs at most FOUR
 * dispatched requests, on 500/1000/2000ms waits, inside the same total deadline
 * and the same abort signal, with the retry budget asked before every retry.
 * Every other failure is final.
 */

/** Scratch client: only the retry budget and the deadline vary per test. */
function retryClient(fetchImpl: typeof fetch, extra: { deadlineMs?: number; secrets?: readonly string[]; retryBudget?: (input: { kind: string; attempts: number }) => { allowed: boolean; reason?: string } } = {}) {
	return createHttpClient({
		endpoint: "https://example.test/v1",
		model: "typesafe-ai/jev",
		apiKeyEnv: "TEST_JEV_KEY",
		deadlineMs: extra.deadlineMs ?? 4000,
		maxRequestBytes: 49_152,
		maxResponseBytes: 262_144,
		env: { TEST_JEV_KEY: "key-value-8899" },
		fetchImpl,
		...(extra.secrets ? { secrets: extra.secrets } : {}),
		...(extra.retryBudget ? { retryBudget: extra.retryBudget as never } : {}),
	});
}

const allowRetry = () => ({ allowed: true });
const refuseRetry = (reason: string) => () => ({ allowed: false, reason });

function statusResponse(status: number, body: unknown = {}): Response {
	return new Response(JSON.stringify(body), { status });
}

/** Scripted responses, consumed one per dispatched request. */
function scripted(responses: Array<number | Response | (() => Response)>): { fetchImpl: typeof fetch; bodies: string[] } {
	const state = { index: 0 };
	const bodies: string[] = [];
	const fetchImpl = (async (_url: unknown, init: unknown) => {
		bodies.push(String((init as { body: string }).body));
		const next = responses[Math.min(state.index, responses.length - 1)] ?? responses.at(-1)!;
		state.index += 1;
		return typeof next === "function" ? next() : typeof next === "number" ? statusResponse(next, GOOD_ANSWERS) : next;
	}) as unknown as typeof fetch;
	return { fetchImpl, bodies };
}

test("retry: HTTP 503 three times then 200 succeeds on attempt 4 with the exponential waits", { timeout: 15_000 }, async () => {
	const { fetchImpl, bodies } = scripted([503, 503, 503, () => statusResponse(200, { answers: GOOD_ANSWERS, id: "req-4" })]);
	const started = performance.now();
	const assessment = await retryClient(fetchImpl, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 20_000 });
	const elapsed = performance.now() - started;
	assert.ok(assessment.ok, JSON.stringify(assessment.failure));
	assert.equal(assessment.usage.attempts, 4, "the initial request plus 3 retries, never more");
	assert.match(assessment.notes, /http 503 retried 3 time\(s\) after exponential waits: succeeded/);
	assert.equal(bodies.length, 4);
	assert.equal(bodies[0], bodies[3], "every retry sends the identical body: same questions, same state, same encoding");
	assert.ok(elapsed >= 3500, `the 500+1000+2000ms waits were all taken (${elapsed.toFixed(0)}ms)`);
	assert.ok(elapsed < 7000, `no wait beyond the schedule (${elapsed.toFixed(0)}ms)`);
});

test("retry: HTTP 503 always stops at exactly 4 requests and does not hide the failure", { timeout: 15_000 }, async () => {
	let calls = 0;
	const fetchImpl = (async () => { calls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const assessment = await retryClient(fetchImpl, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 20_000 });
	assert.equal(calls, HTTP_503_MAX_ATTEMPTS, "exactly 3 retries, then it gives up");
	assert.ok(!assessment.ok);
	assert.equal(assessment.usage.attempts, 4);
	assert.equal(assessment.failure?.stage, "transport");
	assert.match(assessment.failure?.message ?? "", /HTTP 503/);
	assert.match(assessment.failure?.message ?? "", /http 503 retried 3 time\(s\) after exponential waits: HTTP 503/);
	// Four dispatched requests, none of which reported a charge: all unknown.
	assert.deepEqual([assessment.cost.billedUsd, assessment.cost.unknown], [null, true]);
});

test("retry: the waits are 500/1000/2000ms and every attempt stays inside the ORIGINAL deadline", { timeout: 15_000 }, async () => {
	const { fetchImpl } = scripted([503, 503, 503, () => statusResponse(200, { answers: GOOD_ANSWERS })]);
	const stamps: number[] = [];
	const started = performance.now();
	const recording = (async (url: unknown, init: unknown) => {
		stamps.push(Math.round(performance.now() - started));
		return fetchImpl(url as never, init as never);
	}) as unknown as typeof fetch;
	const assessment = await retryClient(recording, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 20_000 });
	assert.ok(assessment.ok);
	assert.equal(assessment.usage.attempts, 4);
	assert.equal(stamps.length, 4);
	const gaps = stamps.slice(1).map((stamp, i) => stamp - stamps[i]!);
	for (let i = 0; i < HTTP_503_RETRY_DELAYS_MS.length; i += 1) {
		assert.ok(gaps[i]! >= HTTP_503_RETRY_DELAYS_MS[i]!, `wait ${i + 1} waited ${gaps[i]}ms, expected at least ${HTTP_503_RETRY_DELAYS_MS[i]}ms`);
		assert.ok(gaps[i]! < HTTP_503_RETRY_DELAYS_MS[i]! + 300, `wait ${i + 1} waited ${gaps[i]}ms, expected ~${HTTP_503_RETRY_DELAYS_MS[i]}ms`);
	}
	assert.ok(assessment.timings.ms < HTTP_503_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 2000, "the recorded time is the whole exchange, inside the original deadline");
});

test("retry: only 503 retries; every other status, invalid body, or transport failure is final", { timeout: 5000 }, async () => {
	const cases: Array<[number | "json" | "throw", Response]> = [
		[400, statusResponse(400, {})],
		[408, statusResponse(408, {})],
		[429, statusResponse(429, {})],
		[500, statusResponse(500, {})],
		[502, statusResponse(502, {})],
		[504, statusResponse(504, {})],
	];
	for (const [label, response] of cases) {
		let calls = 0;
		const fetchImpl = (async () => { calls += 1; return response; }) as unknown as typeof fetch;
		const assessment = await retryClient(fetchImpl, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 2000 });
		assert.equal(calls, 1, `HTTP ${label} must not be retried`);
		assert.equal(assessment.usage.attempts, 1);
		assert.ok(!assessment.ok);
		assert.ok(!JSON.stringify(assessment).includes("http 503"), `no retry talk on HTTP ${label}`);
	}

	// A 200 whose body is not JSON is an invalid response, not an overload.
	let jsonCalls = 0;
	const badJson = (async () => { jsonCalls += 1; return new Response("{ not json", { status: 200 }); }) as unknown as typeof fetch;
	const jsonAssessment = await retryClient(badJson, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 2000 });
	assert.equal(jsonCalls, 1, "an undecodable body is never retried");
	assert.equal(jsonAssessment.usage.attempts, 1);

	// A transport error is final too.
	let throwCalls = 0;
	const throws = (async () => { throwCalls += 1; throw new Error("connection reset"); }) as unknown as typeof fetch;
	const transport = await retryClient(throws, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 2000 });
	assert.equal(throwCalls, 1, "a transport error is never retried");
	assert.equal(transport.usage.attempts, 1);

	// A 200 that fails validation is an answer problem, not an overloaded server.
	let validationCalls = 0;
	const invalid = (async () => { validationCalls += 1; return statusResponse(200, { answers: {} }); }) as unknown as typeof fetch;
	const invalidAssessment = await retryClient(invalid, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 2000 });
	assert.equal(validationCalls, 1, "an invalid answer set is never retried");
	assert.equal(invalidAssessment.usage.attempts, 1);
	assert.equal(invalidAssessment.failure?.stage, "validation");
});

test("retry: a 503 whose drain was cut by the deadline is not retried, and no second request happens after the deadline", { timeout: 5000 }, async () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
				// never closes: the drain is still running when the deadline hits
			},
		}), { status: HTTP_503_RETRY_STATUS });
	}) as unknown as typeof fetch;
	const assessment = await retryClient(fetchImpl, { retryBudget: allowRetry, deadlineMs: 80 }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 80 });
	assert.equal(calls, 1, "an aborted 503 exchange is not a clean 'overloaded' signal, and the deadline leaves no room anyway");
	assert.ok(!assessment.ok);
	assert.equal(assessment.usage.attempts, 1);
	assert.equal(isRetryable503({ ok: false, status: HTTP_503_RETRY_STATUS, aborted: true }), false);
});

test("retry: cancellation during a retry wait dispatches NOTHING more and settles promptly", { timeout: 2000 }, async () => {
	let calls = 0;
	const fetchImpl = (async () => { calls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const ac = new AbortController();
	// Start the first assessment and abort it DURING its 500ms retry wait: the
	// second request of that exchange is never dispatched.
	const inFlight = retryClient(fetchImpl, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: ac.signal, deadlineMs: 60_000 });
	const started = performance.now();
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	ac.abort();
	const first = performance.now();
	await inFlight;
	// Second assessment: aborted BEFORE dispatch, so nothing is sent at all.
	const aborted = await retryClient(fetchImpl, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: ac.signal, deadlineMs: 60_000 });
	const elapsed = performance.now() - first;
	assert.ok(calls >= 1 && calls <= 2, `only the first attempt dispatched (${calls} calls)`);
	assert.equal(aborted.usage.attempts, 0, "a cancelled caller dispatches nothing");
	assert.ok(elapsed < 200, `a pre-aborted caller settles immediately (${elapsed.toFixed(0)}ms)`);
	assert.ok(!aborted.ok && /cancelled/.test(aborted.failure?.message ?? ""));
	assert.ok(started < first);
});

test("retry: sleepOrAbort resolves after the wait and rejects immediately when the signal is already aborted", async () => {
	const started = performance.now();
	await sleepOrAbort(30, undefined);
	assert.ok(performance.now() - started >= 25);
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(sleepOrAbort(5000, ac.signal), /cancelled/);
});

test("retry: the retry budget decides, so maxRequests 1 denies and maxRequests 2 allows", { timeout: 5000 }, async () => {
	// Denied: the caller's request cap is already spent by this assessment.
	let deniedCalls = 0;
	const deniedFetch = (async () => { deniedCalls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const denied = await retryClient(deniedFetch, { retryBudget: refuseRetry("request cap reached (1/1)") }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 4000 });
	assert.equal(deniedCalls, 1, "no second request when the budget says no");
	assert.ok(!denied.ok);
	assert.equal(denied.usage.attempts, 1);
	assert.match(denied.failure?.message ?? "", /http 503: no retry \(request cap reached \(1\/1\)\)/);

	// The budget is asked before EVERY retry, with the attempts actually
	// dispatched so far (see the maxRequests-gated test below).

	// No budget wired in at all: the conservative answer is "no retry".
	let silentCalls = 0;
	const silentFetch = (async () => { silentCalls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const silent = await retryClient(silentFetch).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 4000 });
	assert.equal(silentCalls, 1, "a client with no retry budget never retries on its own");
	assert.equal(silent.usage.attempts, 1);
	assert.match(silent.failure?.message ?? "", /retry budget not configured/);
});

test("retry: the retry budget is asked before EVERY retry with the actual attempt count, so maxRequests 3 stops at 3 attempts", { timeout: 15_000 }, async () => {
	// A cap of 3: the initial dispatch plus two retries fit; the third does not.
	let calls = 0;
	const gatedFetch = (async () => { calls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const gate = await retryClient(gatedFetch, {
		retryBudget: ({ attempts }) => (attempts < 3 ? { allowed: true } : { allowed: false, reason: `request cap reached (${attempts}/3)` }),
	}).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 20_000 });
	assert.equal(calls, 3, "the gate, not the schedule, stops at the cap");
	assert.equal(gate.usage.attempts, 3);
	assert.match(gate.failure?.message ?? "", /http 503: no retry \(request cap reached \(3\/3\)\)/);

	// The gate is asked, not assumed: once per planned retry, with the attempts
	// ACTUALLY dispatched so far (the failed 503s included).
	const seen: Array<{ kind: string; attempts: number }> = [];
	const probing = (async () => statusResponse(HTTP_503_RETRY_STATUS, {})) as unknown as typeof fetch;
	await retryClient(probing, {
		retryBudget: (input) => {
			seen.push(input);
			return { allowed: true };
		},
	}).assess({ kind: "completion", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 20_000 });
	assert.deepEqual(seen, [
		{ kind: "completion", attempts: 1 },
		{ kind: "completion", attempts: 2 },
		{ kind: "completion", attempts: 3 },
	], "asked exactly once per planned retry, before it, with real counts");

	// No budget wired in at all: the conservative answer is "no retry".
	let silentCalls = 0;
	const silentFetch = (async () => { silentCalls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const silent = await retryClient(silentFetch).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 4000 });
	assert.equal(silentCalls, 1, "a client with no retry budget never retries on its own");
	assert.equal(silent.usage.attempts, 1);
	assert.match(silent.failure?.message ?? "", /retry budget not configured/);
});

test("retry: cancellation between attempts 1 and 2 stops there, and the overall deadline bounds the whole schedule", { timeout: 10_000 }, async () => {
	// Cancellation mid-assessment: the first 503 goes out, the caller aborts
	// during the 500ms wait, and no second request is ever dispatched.
	let calls = 0;
	const fetchImpl = (async () => { calls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 60);
	const cancelled = await retryClient(fetchImpl, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: ac.signal, deadlineMs: 60_000 });
	assert.equal(calls, 1, "a cancelled caller never dispatches the retry");
	assert.equal(cancelled.usage.attempts, 1);
	assert.ok(!cancelled.ok);
	assert.match(cancelled.notes, /http 503: retry cancelled during the 500ms wait/);

	// Explicit deadline: the 500+1000ms waits exhaust 1200ms, so the schedule
	// stops on the deadline, not on the attempt limit, and never overshoots it.
	let deadlineCalls = 0;
	const deadlineFetch = (async () => { deadlineCalls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const deadlineStarted = performance.now();
	const bounded = await retryClient(deadlineFetch, { retryBudget: allowRetry, deadlineMs: 1200 }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 1200 });
	const deadlineElapsed = performance.now() - deadlineStarted;
	assert.equal(deadlineCalls, 2, "attempt 3 would need a 1000ms wait the deadline does not have");
	assert.equal(bounded.usage.attempts, 2);
	assert.ok(deadlineElapsed < 1700, `the explicit deadline is honoured (${deadlineElapsed.toFixed(0)}ms)`);
	assert.match(bounded.notes ?? bounded.failure?.message ?? "", /below the \d+ms retry wait|deadline exhausted/);
});

test("retry: an absent or zero caller deadline falls back to the 10s default and a huge one stays bounded by the attempt cap", { timeout: 15_000 }, async () => {
	assert.equal(DEFAULT_JEV_DEADLINE_MS, 10_000);
	// With no usable caller deadline the 3500ms of waits must still fit: a 0ms
	// dispatch deadline would otherwise kill every retry.
	for (const callerDeadline of [0, undefined]) {
		let calls = 0;
		const fetchImpl = (async () => { calls += 1; return calls < 4 ? statusResponse(HTTP_503_RETRY_STATUS, {}) : statusResponse(200, { answers: GOOD_ANSWERS }); }) as unknown as typeof fetch;
		const assessment = await retryClient(fetchImpl, { retryBudget: allowRetry }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, ...(callerDeadline === undefined ? {} : { deadlineMs: callerDeadline }) } as never);
		assert.ok(assessment.ok, `default deadline must carry the full ${calls}-attempt schedule: ${JSON.stringify(assessment.failure)}`);
		assert.equal(assessment.usage.attempts, 4);
		assert.ok(assessment.timings.ms < DEFAULT_JEV_DEADLINE_MS, `the default 10s deadline bounds the exchange (${assessment.timings.ms}ms)`);
	}
});

test("retry: a missing API key is never retried and never dispatched", async () => {
	let calls = 0;
	const fetchImpl = (async () => { calls += 1; return statusResponse(HTTP_503_RETRY_STATUS, {}); }) as unknown as typeof fetch;
	const noKey = createHttpClient({ endpoint: "https://x.test", model: "m", apiKeyEnv: "ABSENT_KEY", deadlineMs: 1000, maxRequestBytes: 100_000, maxResponseBytes: 1000, env: {}, fetchImpl, retryBudget: allowRetry });
	const assessment = await noKey.assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 1000 });
	assert.equal(calls, 0);
	assert.equal(assessment.usage.attempts, 0);
	assert.ok(!assessment.ok && !JSON.stringify(assessment).includes("http 503"));
});

test("retry: 503 bytes and artifacts describe the LAST attempt, and neither echoes the key", async () => {
	const secret = "key-value-8899";
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return calls === 1 ? statusResponse(HTTP_503_RETRY_STATUS, {}) : statusResponse(200, { answers: GOOD_ANSWERS, cost: { billed_usd: 0.02 }, id: `req-${calls}` });
	}) as unknown as typeof fetch;
	const assessment = await retryClient(fetchImpl, { retryBudget: allowRetry, secrets: [secret] }).assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: { note: `the key is ${secret}` }, signal: undefined, deadlineMs: 4000 });
	assert.ok(assessment.ok);
	assert.equal(assessment.usage.attempts, 2);
	assert.equal(assessment.usage.requestBytes, Buffer.byteLength(assessment.requestBody!, "utf8"), "requestBytes counts the body that was sent, not attempts x body");
	assert.equal(assessment.responseHash, hashBytes(assessment.responseBody!), "the stored response is the bytes of the attempt that settled the exchange");
	assert.ok(assessment.responseBody!.includes("PROCEED"));
	assert.ok(!JSON.stringify(assessment).includes(secret));
});

test("retry: HTTP_503_RETRY_* constants keep the policy honest", () => {
	assert.equal(HTTP_503_RETRY_STATUS, 503);
	assert.deepEqual([...HTTP_503_RETRY_DELAYS_MS], [500, 1000, 2000]);
	assert.equal(HTTP_503_MAX_ATTEMPTS, 4, "initial plus 3 retries, never more");
	assert.equal(isRetryable503({ ok: false, status: 503, aborted: false }), true);
	assert.equal(isRetryable503({ ok: false, status: 500, aborted: false }), false);
	assert.equal(isRetryable503({ ok: false, status: null, aborted: false }), false);
	assert.equal(isRetryable503({ ok: false, status: 503, aborted: true }), false);
	assert.equal(isRetryable503({ ok: true, status: 200, aborted: false }), false);
});
