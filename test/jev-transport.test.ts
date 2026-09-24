import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestBody, createHttpClient, postAssessment, validateResponse, PROBABILITY_SUM_TOLERANCE } from "../src/jev.ts";
import { hashBytes } from "../src/redact.ts";
import type { Question } from "../src/types.ts";

/**
 * Transport and answer-validation regressions. One POST, a total deadline, a
 * capped body, zero retries, and strict TypeSafe-compatible answer shapes:
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
	assert.equal(calls, 1, "one dispatched request per assessment");
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

test("client: zero requests and zero attempts when the key is missing or the request is oversized", async () => {
	let calls = 0;
	const fetchImpl = (async () => { calls += 1; return responseOf({}); }) as unknown as typeof fetch;
	const noKey = createHttpClient({ endpoint: "https://x.test", model: "m", apiKeyEnv: "ABSENT_KEY", deadlineMs: 1000, maxRequestBytes: 1000, maxResponseBytes: 1000, env: {}, fetchImpl });
	const a1 = await noKey.assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: {}, signal: undefined, deadlineMs: 1000 });
	assert.ok(!a1.ok && a1.usage.attempts === 0 && calls === 0);

	const tiny = createHttpClient({ endpoint: "https://x.test", model: "m", apiKeyEnv: "TEST_JEV_KEY", deadlineMs: 1000, maxRequestBytes: 1024, maxResponseBytes: 1000, env: { TEST_JEV_KEY: "k" }, fetchImpl });
	const a2 = await tiny.assess({ kind: "direction", snapshot: SNAPSHOT as never, questions: QUESTIONS, state: { huge: "y".repeat(4000) }, signal: undefined, deadlineMs: 1000 });
	assert.ok(!a2.ok && a2.usage.attempts === 0 && calls === 0, "an oversized request is never dispatched");
	assert.equal(a2.usage.requestBytes > 1024, true);
});
