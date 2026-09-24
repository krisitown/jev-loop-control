import test from "node:test";
import assert from "node:assert/strict";
import { createFixture, fauxAssistantMessage, fauxToolCall, type OrderRecord } from "./support/harness.ts";

/**
 * Stage 0 evidence: where the whole assistant proposal becomes visible relative
 * to tool preflight, and which events mean "the tool actually ran".
 */

function assistantMessages(order: OrderRecord[]): OrderRecord[] {
	return order.filter((record) => record.at === "pi:message_end" && record.role === "assistant");
}

test("the complete assistant message is final before the first awaited preflight", async (t) => {
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([
				fauxToolCall("read_file", { path: "a" }, { id: "call-1" }),
				fauxToolCall("read_file", { path: "b" }, { id: "call-2" }),
			]),
			fauxAssistantMessage("both read"),
		],
		tools: [{ name: "read_file", executionMode: "sequential" }],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("read both files");

	const finalMessage = assistantMessages(fixture.order)[0];
	assert.ok(finalMessage, "expected an assistant message_end");
	assert.deepEqual(finalMessage.toolCalls, ["read_file:call-1", "read_file:call-2"]);

	const messageIndex = fixture.order.indexOf(finalMessage);
	const firstHook = fixture.order.findIndex((record) => record.at === "pi:tool_call");
	const firstExecution = fixture.order.findIndex((record) => record.at === "tool:effect");

	// The whole proposal — including both siblings — is final before preflight.
	assert.ok(messageIndex < firstHook, "message_end must precede the first tool_call hook");
	assert.ok(messageIndex < firstExecution, "message_end must precede any tool execution");

	// tool_execution_start is lifecycle only: it precedes the preflight hook.
	const firstStart = fixture.order.findIndex((record) => record.at === "pi:tool_execution_start");
	assert.ok(firstStart < firstHook, "tool_execution_start precedes tool_call, so it is not execution proof");
	assert.equal(fixture.order[firstStart]?.at, "pi:tool_execution_start");

	assert.deepEqual(fixture.executed, ["read_file", "read_file"]);
});

test("tool_result is reported before tool_execution_end", async (t) => {
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([fauxToolCall("note", { note: "x" }, { id: "call-1" })]),
			fauxAssistantMessage("ok"),
		],
		tools: [{ name: "note" }],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("note this");

	const result = fixture.order.findIndex((record) => record.at === "pi:tool_result");
	const end = fixture.order.findIndex((record) => record.at === "pi:tool_execution_end");
	assert.ok(result >= 0 && end >= 0);
	assert.ok(result < end, "tool_result (afterToolCall) is dispatched before tool_execution_end");
});

test("a blocked tool never reaches execute() and the batch continues without terminate", async (t) => {
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([fauxToolCall("note", { note: "x" }, { id: "call-1" })]),
			fauxAssistantMessage("understood"),
		],
		tools: [{ name: "note" }],
		extensions: [
			{
				name: "blocker",
				factory: (pi) => {
					pi.on("tool_call", () => ({ block: true, reason: "synthetic: deferred by supervisor" }));
				},
			},
		],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("note this");

	assert.deepEqual(fixture.executed, [], "a blocked tool must not execute");
	assert.equal(fixture.providerCalls(), 2, "the actor still gets one follow-up turn");
	// Finding: an immediate preflight block never reaches the executed-tool
	// `tool_result` hook. A trace must read tool_execution_end (and the
	// toolResult message) to keep deferred or invalid calls visible.
	assert.equal(
		fixture.order.some((record) => record.at === "pi:tool_result"),
		false,
		"blocked calls do not dispatch tool_result",
	);
	const end = fixture.order.find((record) => record.at === "pi:tool_execution_end");
	assert.equal(end?.isError, true, "the block is reported as an error result");
	assert.equal(
		fixture.order.some((record) => record.at === "pi:message_end" && record.role === "toolResult"),
		true,
		"the block still produces a model-visible toolResult message",
	);
	// No early termination: the actor continued normally after the block.
	assert.equal(fixture.order.at(-2)?.at, "pi:agent_before_settle");
});
