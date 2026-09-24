import test from "node:test";
import assert from "node:assert/strict";
import { createFixture, fauxAssistantMessage, fauxToolCall, toolCallsOf, type OrderRecord } from "./support/harness.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Stage 0 evidence: one assistant message with three sibling tool calls, in both
 * execution modes. A synthetic "redirect" decision derived from the whole
 * message must be able to defer every sibling before anything executes.
 *
 * The synthetic decision stands in for the future Jev assessment: it is produced
 * once per proposal and reused by identity. No Jev call happens here and nothing
 * about real assessment quality is implied.
 */

interface AssessmentState {
	/** Number of logical assessments started (should be 1 per proposal). */
	started: number;
	/** Proposals observed at message_end, with their sibling tool call ids. */
	proposals: Array<{ key: string; siblings: string[] }>;
	/** Assessment token consumed by each tool_call hook. */
	consumed: string[];
	hooks: string[];
}

function redirectingSupervisor(state: AssessmentState): ExtensionFactory {
	return (pi) => {
		/** toolCallId -> proposal key, filled in when the message is finalized. */
		const owners = new Map<string, string>();
		/** Immutable synthetic decision per proposal. */
		const decisions = new Map<string, { readonly token: string; readonly reason: string }>();

		pi.on("message_end", (event) => {
			const siblings = toolCallsOf(event.message).map((block) => `${block.name}:${block.id}`);
			if (event.message.role !== "assistant" || siblings.length === 0) {
				return;
			}
			// Assistant objects carry no id in the public event, so the sibling set is
			// used as the proposal key. A real implementation also binds branch and
			// epoch identity; that belongs to a later stage.
			const key = siblings.join(",");
			for (const block of toolCallsOf(event.message)) {
				owners.set(block.id, key);
			}
			state.proposals.push({ key, siblings });
			state.started += 1;
			// Synthetic decision: a real implementation would await Jev here.
			decisions.set(key, {
				token: `assessment-${state.started}`,
				reason: `synthetic redirect for ${siblings.length} calls (assessment-${state.started})`,
			});
		});

		pi.on("tool_call", (event) => {
			state.hooks.push(`${event.toolName}:${event.toolCallId}`);
			const key = owners.get(event.toolCallId);
			const decision = key === undefined ? undefined : decisions.get(key);
			if (!decision) {
				return undefined;
			}
			state.consumed.push(decision.token);
			return { block: true, reason: decision.reason };
		});
	};
}

function scriptForProposal() {
	return [
		fauxAssistantMessage([
			fauxToolCall("alpha", { note: "a" }, { id: "call-a" }),
			fauxToolCall("beta", { note: "b" }, { id: "call-b" }),
			fauxToolCall("gamma", { note: "c" }, { id: "call-c" }),
		]),
		fauxAssistantMessage("acknowledged"),
	] as const;
}

for (const mode of ["sequential", "parallel"] as const) {
	test(`sibling blocking defers all ${mode} siblings with zero tool executions`, async (t) => {
		const state: AssessmentState = { started: 0, proposals: [], consumed: [], hooks: [] };
		const fixture = await createFixture({
			script: [...scriptForProposal()],
			tools: [
				{ name: "alpha", executionMode: mode },
				{ name: "beta", executionMode: mode },
				{ name: "gamma", executionMode: mode },
			],
			extensions: [{ name: "redirector", factory: redirectingSupervisor(state) }],
		});
		t.after(() => fixture.dispose());

		await fixture.session.prompt("do all three things at once");

		assert.deepEqual(fixture.executed, [], "no sibling may execute once the batch is deferred");
		assert.deepEqual(
			state.hooks,
			["alpha:call-a", "beta:call-b", "gamma:call-c"],
			"every sibling must still be reported to the extension",
		);
		assert.equal(state.started, 1, "exactly one logical assessment per proposal");
		assert.deepEqual(state.consumed, ["assessment-1", "assessment-1", "assessment-1"],
			"every sibling must consume the same memoised decision");

		const toolResults = fixture.order.filter((r: OrderRecord) => r.at === "pi:message_end" && r.role === "toolResult");
		assert.equal(toolResults.length, 3, "every deferred call is reported back to the actor separately");
		assert.equal(fixture.providerCalls(), 2, "the actor still gets its normal follow-up turn");
	});
}

test("parallel preflight prepares every sibling before the first execution", async (t) => {
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([
				fauxToolCall("alpha", { note: "a" }, { id: "call-a" }),
				fauxToolCall("beta", { note: "b" }, { id: "call-b" }),
			]),
			fauxAssistantMessage("ok"),
		],
		tools: [
			{ name: "alpha", executionMode: "parallel" },
			{ name: "beta", executionMode: "parallel" },
		],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("run two independent tools");

	const firstExecution = fixture.order.findIndex((record) => record.at === "tool:effect");
	const hookIndexes = fixture.order
		.map((record, index) => (record.at === "pi:tool_call" ? index : -1))
		.filter((index) => index >= 0);
	assert.equal(hookIndexes.length, 2);
	assert.ok(
		Math.max(...hookIndexes) < firstExecution,
		"in parallel mode both preflight hooks run before any tool executes",
	);
	assert.deepEqual(fixture.executed, ["alpha", "beta"]);
});

test("sequential preflight interleaves preflight and execution", async (t) => {
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([
				fauxToolCall("alpha", { note: "a" }, { id: "call-a" }),
				fauxToolCall("beta", { note: "b" }, { id: "call-b" }),
			]),
			fauxAssistantMessage("ok"),
		],
		tools: [
			{ name: "alpha", executionMode: "sequential" },
			{ name: "beta", executionMode: "sequential" },
		],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("run two tools one at a time");

	const firstExecution = fixture.order.findIndex((record) => record.at === "tool:effect");
	const secondHook = fixture.order
		.map((record, index) => (record.at === "pi:tool_call" ? index : -1))
		.filter((index) => index >= 0)[1];
	assert.ok(secondHook !== undefined && secondHook > firstExecution,
		"in sequential mode the second sibling is only preflighted after the first executed");
	assert.deepEqual(fixture.executed, ["alpha", "beta"]);
});
