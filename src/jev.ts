/**
 * Jev transport and answer validation.
 *
 * One HTTP POST per assessment, no SDK, no framework. The caller's abort signal
 * is honoured during both the fetch and the body read, a total deadline bounds
 * the whole exchange, and the response is capped in bytes.
 *
 * The ONE exception to "one request": an HTTP 503 is retried exactly once after
 * 500ms (see `HTTP_503_RETRY_DELAY_MS`). Overloaded servers are the only case we
 * pay for twice, and the retry stays inside the same total deadline and abort
 * signal. Nothing else is ever retried: no other HTTP code, no malformed or
 * invalid response, no deadline, no cancellation, no missing key.
 *
 * Answers are validated against the exact question map that was sent, using the
 * TypeSafe-compatible shapes:
 *   choice  -> { type: "choice", choice, probabilities, confidence }
 *   noul    -> { type: "noul", noul }   // noul is the probability of YES
 * A missing question, a wrong answer type, a non-finite number, an unknown
 * option, a distribution that does not close, or a choice that contradicts its
 * own distribution invalidates the assessment. Nothing is repaired.
 */

import { randomUUID } from "node:crypto";
import { hashBytes, redactText, removeLiteral } from "./redact.ts";
import { optionIds, type Answer, type Assessment, type AssessmentKind, type CostInfo, type EvidenceSnapshot, type JevClient, type Question } from "./types.ts";

export const PROBABILITY_SUM_TOLERANCE = 0.02;
export const SELECTED_PROBABILITY_TOLERANCE = 1e-6;

/** The only status ever retried, and the only wait we take. Exactly one retry. */
export const HTTP_503_RETRY_STATUS = 503;
export const HTTP_503_RETRY_DELAY_MS = 500;

/**
 * True only for "the server is overloaded right now": HTTP 503 with a
 * cancellation/deadline that did NOT happen (`aborted`). A 503 whose drain was
 * cut short by the deadline or the caller is not a trustworthy exchange and is
 * never retried.
 */
export function isRetryable503(outcome: Pick<ExchangeOutcome, "ok" | "status" | "aborted">): boolean {
	return !outcome.ok && outcome.status === HTTP_503_RETRY_STATUS && !outcome.aborted;
}

/**
 * A promise that resolves after `ms`, or rejects with "cancelled" as soon as
 * the signal aborts. The retry wait can never outlive a cancellation.
 */
export function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(1, ms));
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("cancelled"));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
	});
}

export interface RetryBudgetInput {
	/** The failed 503 exchange; its unknown cost is already counted by the caller. */
	kind: AssessmentKind;
	/** Attempts already dispatched for this assessment, always 1 here. */
	attempts: number;
}

export interface HttpClientOptions {
	endpoint: string;
	model: string;
	/** Name of the environment variable holding the key; never the key itself. */
	apiKeyEnv: string;
	deadlineMs: number;
	maxRequestBytes: number;
	maxResponseBytes: number;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	/** Extra literal values to strip from anything we store (e.g. the key). */
	secrets?: readonly string[];
	/**
	 * Optional gate for the single 503 retry. The client has no budget of its own:
	 * the adapter owns the request cap and the monetary allowance, so it answers
	 * whether a second dispatched request is affordable. `undefined` means "no
	 * retry budget configured", and the retry is then never taken.
	 */
	retryBudget?: (input: RetryBudgetInput) => { allowed: boolean; reason?: string };
}

export interface RequestBuild {
	body: string;
	bytes: number;
	hash: string;
}

/** Build the exact outgoing body. `state` is already sanitized by the caller. */
export function buildRequestBody(options: { model: string; state: Record<string, unknown>; questions: readonly Question[] }, scrub: (text: string) => string = (t) => t): RequestBuild {
	const questions: Record<string, Record<string, unknown>> = {};
	for (const question of options.questions) {
		questions[question.id] = {
			type: question.type,
			instructions: scrub(question.instructions),
			criteria: Object.fromEntries(Object.entries(question.criteria).map(([option, description]) => [option, scrub(description)])),
		};
	}
	const body = JSON.stringify({ model: options.model, state: scrubJson(options.state, scrub), questions });
	return { body, bytes: Buffer.byteLength(body, "utf8"), hash: hashBytes(body) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ValidationResult =
	| { ok: true; answers: Record<string, Answer>; cost: CostInfo; providerId: string | null }
	| { ok: false; problems: string[]; cost: CostInfo; providerId: string | null };

/** Strictly validate a decoded response against the questions that were sent. */
export function validateResponse(payload: unknown, questions: readonly Question[]): ValidationResult {
	const unknownCost: CostInfo = { billedUsd: null, marketUsd: null, unknown: true };
	if (!isRecord(payload)) {
		return { ok: false, problems: ["response is not a JSON object"], cost: unknownCost, providerId: null };
	}
	const cost = readCost(payload);
	const providerId = typeof payload.id === "string" ? payload.id : typeof payload.request_id === "string" ? payload.request_id : null;
	const rawAnswers = payload.answers;
	if (rawAnswers === undefined) {
		return { ok: false, problems: ["response has no `answers`"], cost, providerId };
	}
	const entries: Array<[string, unknown]> = Array.isArray(rawAnswers)
		? rawAnswers.map((item, index) => [isRecord(item) ? String(item.id ?? item.question_id ?? index) : String(index), item] as [string, unknown])
		: isRecord(rawAnswers)
			? Object.entries(rawAnswers)
			: [];
	const byId = new Map(entries);
	const problems: string[] = [];
	const answers: Record<string, Answer> = {};

	for (const question of questions) {
		const raw = byId.get(question.id);
		if (raw === undefined) {
			problems.push(`${question.id}: missing answer`);
			continue;
		}
		if (!isRecord(raw)) {
			problems.push(`${question.id}: answer is not an object`);
			continue;
		}
		// A missing `type` is not inferred: the protocol says what each answer is.
		const type = raw.type;
		if (type !== question.type) {
			problems.push(`${question.id}: answer type ${JSON.stringify(type)} does not match the ${question.type} question`);
			continue;
		}
		if (question.type === "noul") {
			const noul = raw.noul;
			if (typeof noul !== "number" || !Number.isFinite(noul)) {
				problems.push(`${question.id}: noul must be a finite number`);
				continue;
			}
			if (noul < 0 || noul > 1) {
				problems.push(`${question.id}: noul ${noul} is outside 0..1`);
				continue;
			}
			answers[question.id] = { type: "noul", questionId: question.id, noul };
			continue;
		}

		const options = optionIds(question);
		const probabilities = raw.probabilities;
		if (!isRecord(probabilities)) {
			problems.push(`${question.id}: choice answer has no probabilities object`);
			continue;
		}
		const distribution: Record<string, number> = {};
		let malformed = false;
		for (const option of options) {
			const value = probabilities[option];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
				problems.push(`${question.id}: probability for ${option} is not a finite number in 0..1`);
				malformed = true;
				break;
			}
			distribution[option] = value;
		}
		if (malformed) {
			continue;
		}
		for (const key of Object.keys(probabilities)) {
			if (!options.includes(key)) {
				problems.push(`${question.id}: distribution contains the unknown option ${key}`);
				malformed = true;
			}
		}
		if (malformed) {
			continue;
		}
		const sum = options.reduce((total, option) => total + distribution[option]!, 0);
		if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
			problems.push(`${question.id}: distribution sums to ${sum.toFixed(4)}, more than ${PROBABILITY_SUM_TOLERANCE} from 1`);
			continue;
		}
		const choice = raw.choice;
		if (typeof choice !== "string" || !options.includes(choice)) {
			problems.push(`${question.id}: choice ${JSON.stringify(choice)} is not one of ${options.join(", ")}`);
			continue;
		}
		const best = Math.max(...options.map((option) => distribution[option]!));
		if (distribution[choice]! < best - SELECTED_PROBABILITY_TOLERANCE) {
			problems.push(`${question.id}: choice ${choice} contradicts its own distribution`);
			continue;
		}
		const confidence = raw.confidence;
		if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
			problems.push(`${question.id}: confidence must be a finite number in 0..1`);
			continue;
		}
		answers[question.id] = { type: "choice", questionId: question.id, choice, probabilities: distribution, confidence };
	}
	if (problems.length > 0) {
		return { ok: false, problems, cost, providerId };
	}
	return { ok: true, answers, cost, providerId };
}

function readCost(payload: Record<string, unknown>): CostInfo {
	const source = isRecord(payload.cost) ? payload.cost : isRecord(payload.usage) && isRecord(payload.usage.cost) ? payload.usage.cost : undefined;
	// A negative charge is a malformed response, not a discount: it reads as unknown.
	const pick = (key: string): number | null => {
		const value = source?.[key];
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
	};
	const billedUsd = pick("billed_usd") ?? pick("billed") ?? pick("usd");
	const marketUsd = pick("market_usd") ?? pick("market");
	// An absent charge field is unknown, never zero. `unknown` tracks the BILLED
	// amount only: a market price alone does not settle what we were charged, so
	// the conservative reservation stays in force even when market is known.
	return { billedUsd, marketUsd, unknown: billedUsd === null };
}

export interface ExchangeOutcome {
	/** How many HTTP requests this exchange actually dispatched (1 or 0). */
	attempts: number;
	ok: boolean;
	status: number | null;
	bytes: number;
	/** Populated when the JSON decoded. */
	payload?: unknown;
	/** The raw response text actually read (caller still scrubs it). */
	responseText?: string;
	error?: string;
	timedOut: boolean;
	aborted: boolean;
}

/**
 * One bounded HTTP attempt. The abort signal and the deadline both interrupt the
 * fetch and the body read; the body read is additionally capped in bytes.
 */
export async function postAssessment(options: {
	endpoint: string;
	apiKey: string;
	body: string;
	deadlineMs: number;
	maxResponseBytes: number;
	signal: AbortSignal | undefined;
	fetchImpl?: typeof fetch;
}): Promise<ExchangeOutcome> {
	const controller = new AbortController();
	const external = options.signal;
	let timedOut = false;
	let settled = false;
	// 0 until a request is actually put on the wire.
	let attempts = 0;

	const onExternalAbort = (): void => {
		if (!settled) {
			controller.abort(external?.reason ?? new Error("aborted by the host run"));
		}
	};
	if (external) {
		if (external.aborted) {
			return { attempts: 0, ok: false, status: null, bytes: 0, error: "cancelled before dispatch", timedOut: false, aborted: true };
		}
		external.addEventListener("abort", onExternalAbort, { once: true });
	}
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("deadline exceeded"));
	}, Math.max(1, options.deadlineMs));

	const doFetch = options.fetchImpl ?? fetch;
	try {
		attempts = 1;
		const response = await doFetch(options.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${options.apiKey}` },
			body: options.body,
			signal: controller.signal,
		});
		if (!response.ok) {
			// Drain a small error body so a connection is not left dangling, but a
			// cancellation/deadline during the drain still means "no trustworthy exchange".
			const drained = await readCapped(response, 8192, controller.signal).catch(() => undefined);
			if (controller.signal.aborted) {
				return { attempts, ok: false, status: response.status, bytes: 0, error: timedOut ? "deadline exceeded" : "cancelled", timedOut, aborted: true };
			}
			return { attempts, ok: false, status: response.status, bytes: 0, error: `HTTP ${response.status}`, responseText: drained?.text, timedOut, aborted: false };
		}
		const read = await readCapped(response, options.maxResponseBytes, controller.signal);
		// A cancellation or deadline at ANY point of the read, including one that
		// made reader.cancel() resolve `done` over complete-looking partial bytes,
		// can never produce a success path.
		if (controller.signal.aborted) {
			return { attempts, ok: false, status: response.status, bytes: read.bytes, error: timedOut ? "deadline exceeded" : "cancelled", timedOut, aborted: true };
		}
		if (read.tooLarge) {
			return { attempts, ok: false, status: response.status, bytes: read.bytes, error: `response exceeds ${options.maxResponseBytes} bytes`, timedOut, aborted: controller.signal.aborted };
		}
		try {
			const payload = JSON.parse(read.text) as unknown;
			return { attempts, ok: true, status: response.status, bytes: read.bytes, payload, responseText: read.text, timedOut: false, aborted: false };
		}
		catch {
			return { attempts, ok: false, status: response.status, bytes: read.bytes, error: "response body is not valid JSON", responseText: read.text.slice(0, 8192), timedOut, aborted: false };
		}
	}
	catch (error) {
		const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
		return {
			attempts,
			ok: false,
			status: null,
			bytes: 0,
			error: timedOut ? "deadline exceeded" : aborted ? "cancelled" : "transport error: request failed",
			timedOut,
			aborted,
		};
	}
	finally {
		settled = true;
		clearTimeout(timer);
		if (external) {
			external.removeEventListener("abort", onExternalAbort);
		}
	}
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; bytes: number; tooLarge: boolean }> {
	// Check BEFORE acquiring the body: a listener registered on an already-aborted
	// signal never fires, so an `abort`-based unblock would hang forever.
	if (signal.aborted) {
		void response.body?.cancel().catch(() => undefined);
		return { text: "", bytes: 0, tooLarge: false };
	}
	if (!response.body) {
		const text = await response.text();
		const bytes = Buffer.byteLength(text, "utf8");
		return { text, bytes, tooLarge: bytes > maxBytes };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let tooLarge = false;
	const onAbort = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	// Re-check immediately after registration: the signal may have aborted in the
	// gap between the first check and the listener, and no further event will come.
	if (signal.aborted) {
		onAbort();
	}
	try {
		for (;;) {
			if (signal.aborted) {
				onAbort();
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (signal.aborted) {
				// Bytes received after cancellation are discarded, never accepted.
				chunks.length = 0;
				bytes = 0;
				break;
			}
			if (value) {
				chunks.push(value);
				bytes += value.byteLength;
				if (bytes > maxBytes) {
					tooLarge = true;
					await reader.cancel().catch(() => undefined);
					break;
				}
			}
		}
	}
	finally {
		signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
	const merged = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), bytes, tooLarge };
}

/** The production client: real HTTP, strict validation, no fallback. */
export function createHttpClient(options: HttpClientOptions): JevClient {
	const env = options.env ?? process.env;
	const scrub = (text: string): string => removeLiteral(redactText(text), options.secrets ?? []);
	return {
		origin: "live",
		async assess({ kind, snapshot, questions, state, signal, deadlineMs }): Promise<Assessment> {
			const startedAt = new Date().toISOString();
			const start = performance.now();
			const finish = (assessment: Omit<Assessment, "kind" | "timings">): Assessment => ({
				...assessment,
				kind,
				timings: { startedAt, finishedAt: new Date().toISOString(), ms: Math.round(performance.now() - start) },
			});

			const apiKey = env[options.apiKeyEnv];
			if (!apiKey) {
				return finish({
					ok: false,
					status: "UNCHECKED",
					answers: {},
					findings: [],
					notes: "",
					failure: { stage: "transport", message: `environment variable ${options.apiKeyEnv} is not set` },
					cost: { billedUsd: null, marketUsd: null, unknown: true },
					usage: { requestBytes: 0, responseBytes: 0, attempts: 0 },
					requestId: randomUUID(),
					requestHash: "",
					responseHash: "",
					origin: "live",
				});
			}

			const built = buildRequestBody({ model: options.model, state, questions }, scrub);
			// The exact sanitized outgoing bytes, captured BEFORE dispatch; the
			// request hash describes these bytes and nothing else.
			const requestBody = scrub(built.body);
			const requestHash = hashBytes(requestBody);
			const requestId = randomUUID();
			const responseArtifact = (outcome: ExchangeOutcome): { responseBody: string | undefined; responseHash: string } => {
				if (outcome.responseText === undefined) {
					return { responseBody: undefined, responseHash: "" };
				}
				// Validation/provider errors are scrubbed for the configured key too.
				const responseBody = scrub(outcome.responseText);
				return { responseBody, responseHash: hashBytes(responseBody) };
			};
			if (built.bytes > options.maxRequestBytes) {
				return finish({
					ok: false,
					status: "UNCHECKED",
					answers: {},
					findings: [],
					notes: "",
					failure: { stage: "transport", message: `request is ${built.bytes} bytes, above the configured limit of ${options.maxRequestBytes}` },
					cost: { billedUsd: null, marketUsd: null, unknown: true },
					usage: { requestBytes: built.bytes, responseBytes: 0, attempts: 0 },
					requestId,
					requestHash,
					requestBody,
					responseHash: "",
					origin: "live",
				});
			}
			// --- dispatch, with the ONE 503 retry -------------------------------------
			// Every failure except a clean HTTP 503 is final. A 503 is retried at most
			// once, after 500ms, inside the same total deadline and abort signal, and
			// only when the caller's retry budget allows another dispatched request.
			// The retry's own outcome is never retried again.
			const dispatch = (remainingMs: number): Promise<ExchangeOutcome> => postAssessment({
				endpoint: options.endpoint,
				apiKey,
				body: requestBody,
				deadlineMs: remainingMs,
				maxResponseBytes: options.maxResponseBytes,
				signal,
				fetchImpl: options.fetchImpl,
			});

			let exchange = await dispatch(deadlineMs);
			let attempts = exchange.attempts;
			let retryNote: string | null = null;
			if (!exchange.ok && isRetryable503(exchange)) {
				// The failed attempt's cost is unknown and stays unknown; the caller's
				// reservation for it stays armed. This asks for room for ONE more.
				const budget = options.retryBudget?.({ kind, attempts });
				if (!budget?.allowed) {
					retryNote = `http 503: no retry (${budget?.reason ?? "retry budget not configured"})`;
				}
				else {
					const remaining = deadlineMs - Math.round(performance.now() - start);
					if (remaining <= HTTP_503_RETRY_DELAY_MS) {
						// A retry could not fit inside the original total deadline.
						retryNote = `http 503: no retry (deadline has ${Math.max(0, remaining)}ms left, below the ${HTTP_503_RETRY_DELAY_MS}ms retry wait)`;
					}
					else {
						try {
							await sleepOrAbort(HTTP_503_RETRY_DELAY_MS, signal);
							// Recompute AFTER the wait: `remaining` is the pre-wait value,
							// and dispatching with it would stretch the deadline by the wait.
							const remainingAfterWait = deadlineMs - Math.round(performance.now() - start);
							if (remainingAfterWait <= 0) {
								// The wait ate the whole deadline: no second request goes out.
								retryNote = `http 503: retry skipped (deadline exhausted during the ${HTTP_503_RETRY_DELAY_MS}ms wait)`;
							}
							else {
								const retry = await dispatch(remainingAfterWait);
								attempts += retry.attempts;
								exchange = retry;
								retryNote = retry.ok ? `http 503 retried once after ${HTTP_503_RETRY_DELAY_MS}ms: succeeded` : `http 503 retried once after ${HTTP_503_RETRY_DELAY_MS}ms: ${retry.error ?? "still failing"}`;
							}
						}
						catch {
							// Cancelled during the wait: no second request was dispatched.
							retryNote = `http 503: retry cancelled during the ${HTTP_503_RETRY_DELAY_MS}ms wait`;
						}
					}
				}
			}
			const artifact = responseArtifact(exchange);

			if (!exchange.ok) {
				const transportNote = scrub([exchange.error ?? "request failed", retryNote].filter(Boolean).join("; "));
				return finish({
					ok: false,
					status: "UNCHECKED",
					answers: {},
					findings: [],
					notes: transportNote,
					failure: { stage: "transport", message: transportNote },
					cost: { billedUsd: null, marketUsd: null, unknown: true },
					usage: { requestBytes: built.bytes, responseBytes: exchange.bytes, attempts },
					requestId,
					requestHash,
					requestBody,
					responseHash: artifact.responseHash,
					...(artifact.responseBody !== undefined ? { responseBody: artifact.responseBody } : {}),
					origin: "live",
				});
			}

			const validated = validateResponse(exchange.payload, questions);
			if (!validated.ok) {
				return finish({
					ok: false,
					status: "UNCHECKED",
					answers: {},
					findings: [],
					notes: scrub(validated.problems.join("; ")),
					failure: { stage: "validation", message: scrub(validated.problems.join("; ")) },
					cost: validated.cost,
					usage: { requestBytes: built.bytes, responseBytes: exchange.bytes, attempts },
					requestId,
					requestHash,
					requestBody,
					responseHash: artifact.responseHash,
					...(artifact.responseBody !== undefined ? { responseBody: artifact.responseBody } : {}),
					origin: "live",
				});
			}
			return finish({
				ok: true,
				// The transport does not decide policy; policy.ts does. `UNCHECKED`
				// here means "answers are valid, no verdict applied yet".
				status: "UNCHECKED",
				answers: validated.answers,
				findings: [],
				// A 503 that a retry rescued is still worth saying so: the attempt count
				// is 2 and the first failure is not hidden.
				notes: scrub([validated.providerId ? `provider id ${validated.providerId}` : "", retryNote].filter(Boolean).join("; ")),
				cost: validated.cost,
				usage: { requestBytes: built.bytes, responseBytes: exchange.bytes, attempts },
				requestId,
				requestHash,
				requestBody,
				responseHash: artifact.responseHash,
				...(artifact.responseBody !== undefined ? { responseBody: artifact.responseBody } : {}),
				origin: "live",
			});
		},
	};
}

function scrubJson(value: unknown, scrub: (text: string) => string): unknown {
	if (typeof value === "string") {
		return scrub(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => scrubJson(item, scrub));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrubJson(item, scrub)]));
	}
	return value;
}

/** Snapshot type re-exported for callers that only need the client. */
export type { AssessmentKind, EvidenceSnapshot };
