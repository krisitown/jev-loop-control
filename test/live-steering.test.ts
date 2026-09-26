import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFixture, fauxAssistantMessage, fauxToolCall, type FixtureOptions } from "./support/harness.ts";
import { liveObserve } from "../src/live-observe.ts";
import { makeScrub } from "../src/redact.ts";
import { readJsonLines } from "../src/trace.ts";
import { repeatedFailureFocus } from "../src/policy.ts";
import { defaultConfig } from "../src/config.ts";
import type { Assessment, EvidenceSnapshot, JevClient, Question } from "../src/types.ts";

/**
 * Production-adapter integration: the REAL `liveObserve()` controller loaded as a
 * real inline extension inside a real Pi 0.87.1 session, with only the Jev
 * transport replaced. The actor is the scripted fake provider, the tools are
 * instrumented toys, and the harness refuses every network attempt, so nothing
 * here says anything about hosted answer quality. What it does prove is how the
 * shipped adapter behaves on the real lifecycle: it blocks before execution, it
 * injects its recovery objective into the actual model messages, it counts one
 * intervention per blocked batch rather than per tool, it preserves the original
 * task and evidence across follow-ups, and it stays inert in `observe` and at a
 * zero intervention cap.
 */

const KEY_ENV = "JEV_TEST_API_KEY";
const FAKE_KEY = "synthetic-fake-key-not-a-secret";
const GUIDANCE_TYPE = "jev-loop-control.recovery-guidance";

interface Probe {
	/** Per model request: message roles plus the guidance actually visible. */
	requests: Array<{ roles: string[]; guidance: string[]; texts: string[] }>;
}

/**
 * The scripted verifier. Every question id it was actually given must be answered
 * with an option drawn from that question's own options, so a protocol drift fails
 * the test instead of silently producing a pass-through.
 */
class AnswerMismatch extends Error {}

interface RunResult {
	fixture: Awaited<ReturnType<typeof createFixture>>;
	probe: Probe;
	/** One entry per dispatched request, in dispatch order, with its answers. */
	sent: Array<{ kind: string; questions: Question[]; state: Record<string, unknown>; answers: Record<string, unknown> }>;
	events: Array<Record<string, unknown>>;
	summary: Record<string, unknown> | undefined;
}

/** Answers scripted per direction request; completion is always MET/COMPLETE. */
function fakeClient(script: { direction: Array<"VERIFY" | "PROCEED">; tuned?: Array<"none" | "strong"> }, sent: RunResult["sent"]): JevClient {
	let directionIndex = 0;
	const scrub = makeScrub([FAKE_KEY]);
	return {
		origin: "synthetic",
		async assess({ kind, questions, state }): Promise<Assessment> {
			const index = directionIndex;
			if (kind === "direction") directionIndex++;
			const legacyVerdict = script.direction[Math.min(index, script.direction.length - 1)] ?? "PROCEED";
			const tunedVerdict = script.tuned?.[Math.min(index, script.tuned.length - 1)] ?? "none";
			const answers: Record<string, Assessment["answers"][string]> = {};
			for (const question of questions) {
				if (question.type === "noul") {
					answers[question.id] = { type: "noul", questionId: question.id, noul: 0.9 };
					continue;
				}
				let selected = "MET";
				if (question.role === "next_step") {
					if (kind === "direction") {
						selected = legacyVerdict;
					}
					else {
						selected = "COMPLETE";
					}
				}
				else if (question.role === "focus_requirement") {
					selected = question.criteria.R1 === undefined ? "NONE" : "R1";
				}
				else if (question.role === "correction_needed") selected = tunedVerdict === "strong" ? "CORRECTION_JUSTIFIED" : "NO_CORRECTION_JUSTIFIED";
				else if (question.role === "primary_concern") selected = tunedVerdict === "strong" ? "CONTRACT_CONTRADICTION" : "NONE";
				else if (question.role === "evidence_anchor") selected = tunedVerdict === "strong" ? (Object.keys(question.criteria).find((id) => id !== "NONE" && id !== "UNKNOWN") ?? "UNKNOWN") : "NONE";
				else if (question.role === "requirement_focus") selected = tunedVerdict === "strong" ? (Object.keys(question.criteria).find((id) => !["PROCESS", "NONE", "UNKNOWN"].includes(id)) ?? "UNKNOWN") : "NONE";
				else if (question.role === "completion_status") selected = "SUPPORTED";
				else if (question.role === "concern_outcome") selected = "UNKNOWN";
				answers[question.id] = {
					type: "choice",
					questionId: question.id,
					choice: selected,
					probabilities: weightsFor(question, selected, 0.9),
					confidence: 0.9,
				};
			}
			// Exact map: the answer keys are exactly the question ids it was given.
			const given = questions.map((question) => question.id).sort().join(",");
			const answered = Object.keys(answers).sort().join(",");
			if (given !== answered) {
				throw new AnswerMismatch(`answer map does not match the questions (${kind})`);
			}
			for (const question of questions) {
				if (question.type === "choice") {
					const answer = answers[question.id] as { probabilities: Record<string, number>; choice: string };
					const options = Object.keys(question.criteria).sort().join(",");
					if (Object.keys(answer.probabilities).sort().join(",") !== options) {
						throw new AnswerMismatch(`${question.id}: probabilities are not the question's options`);
					}
					const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0);
					if (Math.abs(sum - 1) > 1e-9) {
						throw new AnswerMismatch(`${question.id}: distribution sums to ${sum}`);
					}
					if (!(question.criteria[answer.choice] !== undefined)) {
						throw new AnswerMismatch(`${question.id}: choice is not an option`);
					}
				}
			}
			// The dispatched bytes are scrubbed before they are ever reported.
			void scrub(JSON.stringify({ kind, state }));
			sent.push({ kind, questions, state, answers: { ...answers } });
			return {
				kind,
				ok: true,
				status: "UNRESOLVED",
				answers,
				findings: [],
				notes: "synthetic fixture answers; no hosted assessment happened",
				cost: { billedUsd: 0, marketUsd: 0, unknown: false },
				usage: { requestBytes: 1024, responseBytes: 512, attempts: 1 },
				timings: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ms: 1 },
				requestId: `fake-${kind}-${sent.length}`,
				requestHash: "fake-request-hash",
				responseHash: "fake-response-hash",
				origin: "synthetic",
			};
		},
	};
}

/** A distribution that sums to exactly 1 over the question's own options. */
function weightsFor(question: Question, selected: string, top: number): Record<string, number> {
	const ids = question.type === "choice" ? Object.keys(question.criteria) : [];
	const others = ids.filter((id) => id !== selected);
	const share = others.length > 0 ? Number((((1 - top) / others.length)).toFixed(12)) : 0;
	const out: Record<string, number> = { [selected]: top };
	for (const id of others) {
		out[id] = share;
	}
	const sum = Object.values(out).reduce((total, value) => total + value, 0);
	out[selected] = Number((out[selected]! + (1 - sum)).toFixed(12));
	return out;
}

/**
 * One fixture run. The config file lives OUTSIDE the actor workspace (its own
 * temp directory, reached through JEV_LOOP_CONTROL_CONFIG) and `trace.dir` points
 * outside the workspace too.
 */
async function runFixture(
	/** node:test's context, typed structurally to avoid a version-specific import. */
	t: { after(fn: () => void): void },
	options: {
		mode: "observe" | "enforce";
		limits?: Record<string, unknown>;
		direction: Array<"VERIFY" | "PROCEED">;
		prompts: string[];
		script?: FixtureOptions["script"];
		tuning?: Record<string, unknown>;
		tuned?: Array<"none" | "strong">;
	},
): Promise<RunResult> {
	const supervisorDir = mkdtempSync(join(tmpdir(), "jev-live-config-"));
	const traceDir = join(supervisorDir, "traces");
	mkdirSync(traceDir);
	const configPath = join(supervisorDir, "jev-loop-control.config.json");
	// Only documented keys: budget.maxRequests exists, limits.maxRequests does not.
	writeFileSync(configPath, JSON.stringify({
		version: 1,
		mode: options.mode,
		jev: { enabled: true, apiKeyEnv: KEY_ENV, deadlineMs: 2000 },
		budget: { maxRequests: 50 },
		policy: { probabilityThreshold: 0.8, gapThreshold: 0.2, repeatDiagnosticThreshold: 0.85 },
		limits: { maxTerminalContinuations: 2, ...(options.limits ?? {}) },
		...(options.tuning ? { tuning: options.tuning } : {}),
		trace: { dir: traceDir, artifacts: false },
	}));

	const savedKey = process.env[KEY_ENV];
	const savedMode = process.env.JEV_LOOP_CONTROL_MODE;
	process.env[KEY_ENV] = FAKE_KEY;
	t.after(() => {
		if (savedKey === undefined) {
			delete process.env[KEY_ENV];
		}
		else {
			process.env[KEY_ENV] = savedKey;
		}
		// createFixture clears it; do the same on the way out so no leaked value
		// can silence another test file running in this process.
		if (savedMode === undefined) {
			delete process.env.JEV_LOOP_CONTROL_MODE;
		}
		else {
			process.env.JEV_LOOP_CONTROL_MODE = savedMode;
		}
		rmSync(supervisorDir, { recursive: true, force: true });
	});

	const probe: Probe = { requests: [] };
	const sent: RunResult["sent"] = [];

	const contextProbe: ExtensionFactory = (pi) => {
		// Registered after the adapter, so it reports what the model will see.
		pi.on("context", (event) => {
			const guidance: string[] = [];
			const texts: string[] = [];
			for (const message of event.messages) {
				if (message.role === "custom" && message.customType.startsWith("jev-loop-control.")) {
					guidance.push(message.customType);
					texts.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
				}
			}
			probe.requests.push({ roles: event.messages.map((message) => message.role), guidance, texts });
			return undefined;
		});
	};

	const script = options.script ?? [
		fauxAssistantMessage([fauxToolCall("write_toy", { path: "notes.txt", text: "first draft" }, { id: "call-write" })]),
		fauxAssistantMessage([fauxToolCall("read_toy", { path: "notes.txt" }, { id: "call-read" })]),
		fauxAssistantMessage("Wrote notes.txt and read it back to confirm."),
	];

	const fixture = await createFixture({
		script,
		tools: [{ name: "write_toy" }, { name: "read_toy" }],
		env: { [KEY_ENV]: FAKE_KEY, JEV_LOOP_CONTROL_CONFIG: configPath, JEV_LOOP_CONTROL_MODE: undefined },
		extensions: [
			{
				name: "jev-loop-control-live",
				factory: ((pi: ExtensionAPI) => {
					liveObserve(pi, { client: fakeClient({ direction: options.direction, ...(options.tuned ? { tuned: options.tuned } : {}) }, sent) });
				}) satisfies ExtensionFactory,
			},
			{ name: "context-probe", factory: contextProbe },
		],
	});
	t.after(() => fixture.dispose());

	for (const prompt of options.prompts) {
		await fixture.session.prompt(prompt);
	}

	const runs = readdirSync(traceDir);
	assert.equal(runs.length, 1, `exactly one run directory under ${traceDir}`);
	const runDir = join(traceDir, runs[0]!);
	let summary: Record<string, unknown> | undefined;
	try {
		summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as Record<string, unknown>;
	}
	catch (error) {
		summary = undefined;
		void error;
	}

	return { fixture, probe, sent, events: readJsonLines(join(runDir, "events.jsonl")), summary };
}

test("tuned adapter preserves large Unicode proposal units and complete question instructions", async (t) => {
	const marker = "КРАЕН_Ω_🧪_中間";
	const large = `${"а".repeat(5000)}${marker}${"β".repeat(5000)}`;
	const run = await runFixture(t, {
		mode: "observe",
		direction: ["PROCEED"],
		prompts: ["Preserve the exact Unicode marker while writing the requested file."],
		tuning: { enabled: true, selector: "s2", softPayloadBytes: 32768, proposalEvery: 1, completionEnabled: true, cooldownCheckpoints: 0 },
		script: [
			fauxAssistantMessage([fauxToolCall("write_toy", { path: "unicode.txt", text: large }, { id: "call-unicode" })]),
			fauxAssistantMessage("Completed the requested write."),
		],
	});
	const direction = run.sent.find((item) => item.kind === "direction");
	assert.ok(direction, "tuned direction assessment dispatched through the production adapter");
	const state = direction.state as { current_proposal?: { text?: string }; coverage?: { local?: string } };
	assert.match(state.current_proposal?.text ?? "", new RegExp(marker));
	assert.equal(state.coverage?.local, "sufficient");
	assert.deepEqual(direction.questions.slice(0, 4).map((question) => question.id), ["correction_needed", "primary_concern", "evidence_anchor", "requirement_focus"]);
	assert.match(direction.questions[0]?.instructions ?? "", /INSUFFICIENT_EVIDENCE/);
	assert.equal(run.fixture.executed.includes("write_toy"), true, "productive proposal remains unblocked");
	assert.equal(run.summary?.finalStatus, "UNRESOLVED", "unknown global coverage cannot certify completion");
});

test("tuned adapter skips an oversize protected proposal instead of invoking clipping fallback", async (t) => {
	const large = `begin-${"中".repeat(12_000)}-end`;
	const run = await runFixture(t, {
		mode: "observe",
		direction: ["PROCEED"],
		prompts: ["Write the supplied content exactly."],
		tuning: { enabled: true, selector: "s2", softPayloadBytes: 4096, proposalEvery: 1, completionEnabled: true, cooldownCheckpoints: 0 },
		script: [
			fauxAssistantMessage([fauxToolCall("write_toy", { path: "large.txt", text: large }, { id: "call-large" })]),
			fauxAssistantMessage("Completed the requested write."),
		],
	});
	assert.equal(run.sent.some((item) => item.kind === "direction"), false, "no partial direction packet is assessed");
	assert.equal(run.fixture.executed.includes("write_toy"), true, "unchecked context passes through without blocking");
	const skipped = ofType(run.events, "assessment_skipped").find((event) => event.kind === "direction");
	assert.equal(skipped?.reason, "UNCHECKED_CONTEXT");
	assert.equal(skipped?.protectedMaterialPreserved, true);
});

test("strong tuned guidance is delivered only when the next actor context contains it", async (t) => {
	const run = await runFixture(t, {
		mode: "enforce",
		direction: ["PROCEED", "PROCEED"],
		tuned: ["none", "strong"],
		prompts: ["Read notes.txt, then write a result that preserves the request."],
		tuning: { enabled: true, selector: "s2", softPayloadBytes: 24576, proposalEvery: 1, completionEnabled: true, cooldownCheckpoints: 0 },
		script: [
			fauxAssistantMessage([fauxToolCall("read_toy", { path: "notes.txt" }, { id: "call-read-first" })]),
			fauxAssistantMessage([fauxToolCall("write_toy", { path: "notes.txt", text: "replacement" }, { id: "call-write-second" })]),
			fauxAssistantMessage("Stopped after the supervisor correction."),
		],
	});
	assert.deepEqual(run.fixture.executed, ["read_toy"], `the grounded second proposal is blocked before execution: ${JSON.stringify(ofType(run.events, "direction_assessment"))}`);
	const lifecycle = ofType(run.events, "intervention.lifecycle").filter((event) => event.action === "strong");
	assert.deepEqual(lifecycle.map((event) => event.stage).slice(0, 4), ["selected", "applied", "queued", "delivered"]);
	assert.equal(lifecycle[3]?.basis, "next_actor_context_contains_guidance");
	assert.ok(run.probe.requests.some((request) => request.texts.some((text) => text.includes("Concern:") && text.includes("Exit check:"))), "the actor request contains the evidence-linked guidance");
});

function fixtureNetworkClean(fixture: { networkAttempts: string[] }): boolean {
	return fixture.networkAttempts.length === 0;
}

function ofType(events: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
	return events.filter((event) => event.type === type);
}

function requirementText(state: Record<string, unknown> | undefined): string {
	const task = state?.task as { requirements?: Array<{ description?: string }> } | undefined;
	return (task?.requirements ?? []).map((requirement) => requirement.description ?? "").join("\n");
}

test("enforce: VERIFY blocks the write before it executes, the read still runs, guidance reaches the model", async (t) => {
	const run = await runFixture(t, {
		mode: "enforce",
		direction: ["VERIFY", "PROCEED"],
		prompts: ["write the note to notes.txt, then read it back"],
	});

	assert.deepEqual(run.fixture.executed, ["read_toy"], "the blocked proposal must never execute; the corrected one must");
	assert.equal(run.fixture.errors.length, 0, `no extension errors: ${JSON.stringify(run.fixture.errors)}`);
	assert.equal(run.fixture.providerCalls(), 3, "blocked call, corrected call, final answer");

	// Exactly one intervention, traced as a real enforce-side block.
	const blocks = ofType(run.events, "intervention.block");
	assert.equal(blocks.length, 1, "one intervention per blocked batch, never one per tool");
	assert.equal(blocks[0]?.status, "VERIFY");
	assert.equal(blocks[0]?.actualApply, "block");
	assert.equal(blocks[0]?.sibling, false);
	assert.ok(blocks[0]?.memo, "an applied block carries its objective");
	assert.equal(ofType(run.events, "intervention.suppressed").length, 0);
	assert.equal(ofType(run.events, "intervention.continuation").length, 0);

	// The verdict travelled to the model: one request per actor turn.
	assert.equal(run.probe.requests.length, 3);

	// Guidance really is injected into the model messages, and only in enforce.
	const injected = run.probe.requests.filter((request) => request.guidance.includes(GUIDANCE_TYPE));
	assert.ok(injected.length > 0, "the recovery objective must be visible to the model");
	const guidanceText = injected[0]!.texts.join("\n");
	assert.ok(guidanceText.includes("VERIFY"), `the guidance names the temporary mode: ${guidanceText}`);
	assert.match(guidanceText, /original user task/i, "guidance keeps the original task in scope");
	assert.ok(ofType(run.events, "recovery.guidance").length >= 1, "the injection is traced");

	// Never injected twice into one request.
	for (const request of run.probe.requests) {
		assert.ok(request.guidance.filter((type) => type === GUIDANCE_TYPE).length <= 1, "one guidance message per request");
	}

	// Completion settled the run instead of inventing a continuation.
	const completion = ofType(run.events, "completion_assessment")[0];
	assert.equal(completion?.status, "COMPLETE");
	assert.equal(completion?.actualApply, "none");

	// Questions, answers, and options line up exactly for every dispatch (the
	// verifier inside the fake client already threw otherwise; this is the
	// explicit assertion of the same contract).
	for (const request of run.sent) {
		const ids = request.questions.map((question) => question.id);
		assert.equal(new Set(ids).size, ids.length, "question ids are unique");
		assert.deepEqual(Object.keys(request.answers).sort(), [...ids].sort(), "answers map exactly onto the questions");
		for (const question of request.questions) {
			if (question.type !== "choice") {
				continue;
			}
			const answer = request.answers[question.id] as { probabilities: Record<string, number> };
			assert.deepEqual(Object.keys(answer.probabilities).sort(), Object.keys(question.criteria).sort(), `${question.id}: options match`);
			assert.equal(Object.values(answer.probabilities).reduce((total, value) => total + value, 0), 1, `${question.id}: sums to 1`);
		}
	}
	assert.equal(fixtureNetworkClean(run.fixture), true, "no network was touched");

	assert.equal(run.summary?.actualInterventions, 1, "summary counts the intervention that actually applied");
	assert.equal(run.summary?.deferredSiblings, 0);
	assert.equal(run.summary?.origin, "synthetic");
	assert.equal(run.summary?.finalStatus, "COMPLETE");
	assert.deepEqual(run.summary?.errors, []);
});

test("enforce: a sibling batch is one intervention and every sibling is deferred", async (t) => {
	const run = await runFixture(t, {
		mode: "enforce",
		direction: ["VERIFY", "PROCEED"],
		prompts: ["write the note and read it back in one go"],
		script: [
			fauxAssistantMessage([
				fauxToolCall("write_toy", { path: "notes.txt", text: "first draft" }, { id: "call-write" }),
				fauxToolCall("read_toy", { path: "notes.txt" }, { id: "call-read-1" }),
			]),
			fauxAssistantMessage([fauxToolCall("read_toy", { path: "notes.txt" }, { id: "call-read-2" })]),
			fauxAssistantMessage("Wrote and read notes.txt."),
		],
	});

	const blocks = ofType(run.events, "intervention.block");
	assert.equal(blocks.filter((event) => event.sibling !== true).length, 1, "exactly one counted intervention");
	assert.ok(blocks.some((event) => event.sibling === true), "deferred siblings trace as siblings of the same block");
	for (const block of blocks) {
		assert.equal(typeof block.proposalId, "string", "every block record names its proposal");
		assert.equal(block.actualApply, "block");
	}
	assert.equal(run.summary?.actualInterventions, 1, "the count stays honest with a sibling batch");
	assert.equal(run.summary?.deferredSiblings, 1);
	assert.deepEqual(run.fixture.executed, ["read_toy"], "no sibling of the blocked batch executed");
	assert.equal(run.fixture.errors.length, 0);
});

test("observe: assessments are recorded, tools execute unmodified, no guidance is injected", async (t) => {
	const run = await runFixture(t, {
		mode: "observe",
		direction: ["VERIFY", "PROCEED"],
		prompts: ["write the note to notes.txt, then read it back"],
	});

	assert.deepEqual(run.fixture.executed, ["write_toy", "read_toy"], "observe must never change the execution path");
	assert.equal(ofType(run.events, "intervention.block").length, 0);
	assert.equal(run.probe.requests.filter((request) => request.guidance.length > 0).length, 0, "no guidance outside enforce");
	const direction = ofType(run.events, "direction_assessment");
	assert.ok(direction.length >= 1, "observe still assesses and records");
	assert.equal(direction[0]?.actualApply, "none");
	assert.equal(direction[0]?.recommendedApply, "block", "the recommendation is recorded without being applied");
	assert.equal(run.fixture.errors.length, 0);
});

test("enforce with a zero intervention cap blocks nothing and injects nothing", async (t) => {
	const run = await runFixture(t, {
		mode: "enforce",
		limits: { maxInterventionsPerTask: 0 },
		direction: ["VERIFY", "PROCEED"],
		prompts: ["write the note to notes.txt, then read it back"],
	});

	assert.deepEqual(run.fixture.executed, ["write_toy", "read_toy"], "a zero cap must not block anything");
	assert.equal(ofType(run.events, "intervention.block").length, 0);
	assert.equal(run.probe.requests.filter((request) => request.guidance.length > 0).length, 0, "no recovery, so no guidance");
	assert.equal(run.fixture.errors.length, 0);
});

test("a follow-up prompt keeps the original task, the correction, and the earlier evidence", async (t) => {
	const original = "write the original note to notes.txt, then read it back";
	const correction = "correction: use capital letters in the note";
	const run = await runFixture(t, {
		mode: "enforce",
		direction: ["VERIFY", "PROCEED", "PROCEED", "PROCEED"],
		prompts: [original, correction],
		script: [
			fauxAssistantMessage([fauxToolCall("write_toy", { path: "notes.txt", text: "first draft" }, { id: "call-write" })]),
			fauxAssistantMessage([fauxToolCall("read_toy", { path: "notes.txt" }, { id: "call-read" })]),
			fauxAssistantMessage("Wrote notes.txt and read it back."),
			fauxAssistantMessage([fauxToolCall("write_toy", { path: "notes.txt", text: "CAPS DRAFT" }, { id: "call-write-2" })]),
			fauxAssistantMessage("Rewrote notes.txt in capital letters."),
		],
	});

	assert.deepEqual(run.fixture.executed, ["read_toy", "write_toy"], "the first proposal was blocked; later ones ran");
	assert.equal(run.fixture.errors.length, 0);

	const followUp = run.sent.filter((request) => request.kind === "direction" && requirementText(request.state).includes("Follow-up Correction"));
	assert.ok(followUp.length > 0, "the follow-up run sent a direction assessment");
	const text = requirementText(followUp.at(-1)!.state);
	assert.ok(text.includes(original), "the original request text is preserved, not replaced");
	assert.ok(text.includes("use capital letters"), "the correction is part of the task the assessment sees");

	// Execution history and counters survive the follow-up rather than resetting.
	const history = followUp.at(-1)!.state.evidence as { recent_actions?: Array<{ tool?: string; executed?: boolean }> };
	const executedTools = (history.recent_actions ?? []).filter((action) => action.executed).map((action) => action.tool);
	assert.ok(executedTools.includes("read_toy"), "the earlier executed tool result is still in the evidence");
	const controller = followUp.at(-1)!.state.controller as { interventions_used?: number };
	assert.equal(controller.interventions_used, 1, "counters carry across the follow-up instead of restarting");

	assert.equal(run.summary?.finalStatus, "COMPLETE");
});

test("repeated-failure fallback reads the real snapshot contract honestly", () => {
	// Contract guard: the fallback depends on executed provenance, tool name,
	// argument hash, and evidence ids all being present on observations.
	const snapshot = {
		observations: [
			{ id: "E1", toolName: "write_toy", toolCallId: "c1", ok: false, provenance: "executed", text: "failed", argsHash: "h1" },
			{ id: "E2", toolName: "write_toy", toolCallId: "c2", ok: false, provenance: "executed", text: "failed", argsHash: "h1" },
		],
		toolCalls: [{ id: "c3", name: "write_toy", arguments: { path: "a" }, argsHash: "h1" }],
	} as unknown as EvidenceSnapshot;
	const hit = repeatedFailureFocus(snapshot, defaultConfig(), 0.9);
	assert.deepEqual(hit, { toolName: "write_toy", argsHash: "h1", evidenceIds: ["E1", "E2"] });
	assert.equal(repeatedFailureFocus(snapshot, defaultConfig(), 0.5), null, "the diagnostic threshold is required");
});
