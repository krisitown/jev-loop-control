import test from "node:test";
import assert from "node:assert/strict";
import { createFixture, createGate, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./support/harness.ts";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Stage 0 cancellation evidence.
 *
 * The compatibility audit predicted from source that `ctx.signal` may already be
 * cleared at `agent_before_settle`, and that `session.abort()` prevents another
 * actor run but still commits the entries returned by an awaited boundary
 * handler. These fixtures reproduce both behaviours against the real Pi 0.87.1
 * lifecycle and then show the narrow public-only alternative.
 */

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

const answer = (text: string): FauxResponseStep => fauxAssistantMessage(text);

test("signal availability by hook: live during the run, absent at the pre-settlement boundary", async (t) => {
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([fauxToolCall("note", { note: "x" }, { id: "call-1" })]),
			answer("done"),
		],
		tools: [{ name: "note" }],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("note this");

	const at = (name: string): string | undefined => fixture.order.find((record) => record.at === name)?.signal;
	assert.equal(at("pi:agent_start"), "present");
	assert.equal(at("pi:tool_call"), "present", "tool preflight has a live operation signal");
	assert.equal(at("pi:agent_end"), "present", "agent_end handlers still run inside the active run");
	assert.equal(at("pi:agent_before_settle"), "absent", "the low-level run is finished at the boundary");
});

test("REPRODUCED GAP: entries returned by a boundary handler are committed after cancellation", async (t) => {
	const state = { phase: "idle" };
	const gate = createGate();
	t.after(() => gate.open());

	const fixture = await createFixture({
		script: [answer("answer"), answer("continued")],
		extensions: [
			{
				name: "slow-boundary",
				factory: ((pi) => {
					pi.on("agent_before_settle", async (event) => {
						state.phase = "awaiting-assessment";
						await gate.promise;
						state.phase = "returned";
						// A late answer that a real Jev wait would have produced.
						return {
							entries: [
								...event.entries,
								{ type: "custom" as const, customType: "jev.late", data: { note: "late assessment" } },
							],
						};
					});
				}) satisfies ExtensionFactory,
			},
		],
	});
	t.after(() => fixture.dispose());

	const prompting = fixture.session.prompt("answer once");
	await waitFor(() => state.phase === "awaiting-assessment", "the boundary handler to start its assessment");

	const aborting = fixture.session.abort();
	gate.open();
	await Promise.all([prompting, aborting]);

	assert.equal(state.phase, "returned");
	assert.equal(fixture.providerCalls(), 1, "cancellation must not start another actor run");
	assert.equal(
		fixture.order.filter((record) => record.at === "pi:agent_settled").length,
		1,
		"the session still settles",
	);
	// The adverse part: the late entry is committed even though the run was cancelled.
	assert.ok(
		fixture.session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "jev.late"),
		"documented limitation: boundary entries are committed before the abort flag is checked",
	);
});

interface PreAssessmentState {
	started: number;
	/** `pending` while the synthetic assessment runs, then its final verdict. */
	verdict: "pending" | "supported" | "cancelled";
	consumedAtSettle: number;
	discardedAtSettle: number;
	boundaryRan: number;
	agentEndToSettleMs: number;
}

/**
 * Public-only alternative to the gap above.
 *
 * The bounded, cancellable assessment is awaited inside `agent_end`, where
 * `ctx.signal` is still live. `agent_before_settle` then only consumes the
 * already-final immutable result synchronously, so no `await` is open there and
 * nothing can be committed after a cancellation.
 */
function preAssessingSupervisor(state: PreAssessmentState, assessmentMs: number): ExtensionFactory {
	return (pi) => {
		const maxTerminalContinuations = 1;
		let candidate: { readonly text: string } | undefined;
		let endedAt = 0;

		pi.on("agent_end", async (event, ctx: ExtensionContext) => {
			const last = event.messages.at(-1);
			const hasToolCalls = last?.role === "assistant"
				&& Array.isArray(last.content)
				&& last.content.some((block) => block.type === "toolCall");
			if (last?.role !== "assistant" || hasToolCalls || last.stopReason === "aborted" || last.stopReason === "error") {
				return;
			}
			if (state.consumedAtSettle >= maxTerminalContinuations) {
				// Budget discipline: one terminal continuation per episode.
				return;
			}
			state.started += 1;
			state.verdict = "pending";
			endedAt = Date.now();
			const signal = ctx.signal;
			const outcome = await new Promise<"supported" | "cancelled">((resolve) => {
				const timer = setTimeout(() => resolve("supported"), assessmentMs);
				const cancel = (): void => {
					clearTimeout(timer);
					resolve("cancelled");
				};
				if (!signal) {
					// Defensive: a wait must not outlive the run that owns it.
					clearTimeout(timer);
					resolve("cancelled");
					return;
				}
				if (signal.aborted) {
					cancel();
					return;
				}
				signal.addEventListener("abort", cancel, { once: true });
			});
			state.verdict = outcome;
			candidate = outcome === "supported" ? Object.freeze({ text: "synthetic: second requirement unanswered" }) : undefined;
		});

		pi.on("agent_before_settle", (event) => {
			state.boundaryRan += 1;
			state.agentEndToSettleMs = Date.now() - endedAt;
			if (state.verdict !== "supported" || candidate === undefined) {
				state.discardedAtSettle += 1;
				return undefined;
			}
			state.consumedAtSettle += 1;
			const verdict = candidate;
			candidate = undefined;
			state.verdict = "pending";
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message" as const,
						customType: "jev.completion-continuation",
						content: verdict.text,
						display: false,
					},
				],
				continue: true,
			};
		});
	};
}

test("cancellable assessment in agent_end: cancellation discards it, commits nothing, and never restarts the actor", async (t) => {
	const state: PreAssessmentState = {
		started: 0,
		verdict: "pending",
		consumedAtSettle: 0,
		discardedAtSettle: 0,
		boundaryRan: 0,
		agentEndToSettleMs: 0,
	};
	const fixture = await createFixture({
		script: [answer("partial answer"), answer("completed answer")],
		extensions: [{ name: "completion-supervisor", factory: preAssessingSupervisor(state, 250) }],
	});
	t.after(() => fixture.dispose());

	const prompting = fixture.session.prompt("answer two requirements");
	await waitFor(() => state.started === 1, "the assessment to start");

	await fixture.session.abort();
	await prompting;

	assert.equal(state.verdict, "cancelled", "the assessment must observe Pi's own abort signal");
	assert.equal(fixture.providerCalls(), 1, "no continuation and no actor restart");
	assert.equal(state.consumedAtSettle, 0);
	assert.equal(
		fixture.session.sessionManager
			.getBranch()
			.some((entry) => entry.type === "custom_message" && entry.customType === "jev.completion-continuation"),
		false,
		"nothing may be committed into model context after a cancellation",
	);
	assert.equal(
		fixture.order.filter((record) => record.at === "pi:agent_before_settle").length,
		0,
		"finding: when cancellation is observed before settlement, the boundary does not run at all",
	);
	assert.equal(fixture.order.at(-1)?.at, "pi:agent_settled");
});

test("same design without cancellation: the immutable result is consumed synchronously at the boundary", async (t) => {
	const state: PreAssessmentState = {
		started: 0,
		verdict: "pending",
		consumedAtSettle: 0,
		discardedAtSettle: 0,
		boundaryRan: 0,
		agentEndToSettleMs: 0,
	};
	const fixture = await createFixture({
		script: [answer("partial answer"), answer("completed answer")],
		extensions: [{ name: "completion-supervisor", factory: preAssessingSupervisor(state, 20) }],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("answer two requirements");

	assert.equal(state.started, 1, "the continuation budget stops a second assessment");
	assert.equal(state.verdict, "pending", "the consumed candidate is cleared after use");
	assert.equal(state.consumedAtSettle, 1);
	assert.equal(state.discardedAtSettle, 1, "the second settlement has no candidate and abstains");
	assert.equal(state.boundaryRan, 2, "the boundary runs again for the continuation run");
	assert.equal(fixture.providerCalls(), 2, "exactly one continuation request");
	assert.ok(
		fixture.session.sessionManager
			.getBranch()
			.some((entry) => entry.type === "custom_message" && entry.customType === "jev.completion-continuation"),
		"the continuation entry is committed once",
	);
	// Cost of the amendment: settlement waits for the assessment.
	assert.ok(state.agentEndToSettleMs >= 0);
});

test("cancellation during an in-flight tool records no effect and restarts nothing", async (t) => {
	const gate = createGate();
	t.after(() => gate.open());

	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([fauxToolCall("slow", { note: "x" }, { id: "call-1" })]),
			answer("after tool"),
		],
		tools: [{ name: "slow", gate: gate.promise }],
	});
	t.after(() => fixture.dispose());

	const prompting = fixture.session.prompt("do it slowly");
	await waitFor(() => fixture.order.some((record) => record.at === "tool:enter"), "the tool to enter execute()");

	const aborting = fixture.session.abort();
	gate.open();
	await Promise.all([prompting, aborting]);

	assert.deepEqual(fixture.executed, [], "an aborted tool must not record an effect");
	assert.equal(fixture.order.filter((r) => r.at === "tool:aborted").length, 1);
	assert.equal(fixture.providerCalls(), 1, "no follow-up actor turn after cancellation");
	assert.equal(
		fixture.order.filter((record) => record.at === "pi:agent_before_settle").length,
		0,
		"an aborted run settles without the pre-settlement boundary",
	);
	assert.equal(fixture.order.at(-1)?.at, "pi:agent_settled");
});
