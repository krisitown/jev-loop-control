import test from "node:test";
import assert from "node:assert/strict";
import { assertNoNetwork, createFixture, fauxAssistantMessage, fauxToolCall } from "./support/harness.ts";

/**
 * Canonical stage 0 evidence: one complete synthetic episode with a real Pi
 * 0.87.1 session, a scripted fake actor, and one instrumented toy tool.
 * The assertion below is the observed lifecycle order, not an idealised one.
 */
test("smoke: scripted fake actor drives a real Pi session in the observed order", async (t) => {
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([fauxToolCall("note", { note: "one" }, { id: "call-1" })]),
			fauxAssistantMessage("done"),
		],
		tools: [{ name: "note" }],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("make a note");

	assert.deepEqual(fixture.executed, ["note"]);
	assert.equal(fixture.providerCalls(), 2, "one request per actor turn");
	assert.equal(fixture.session.getLastAssistantText(), "done");
	assert.deepEqual(
		fixture.order.map((record) => `${record.at}${record.at === "pi:message_end" ? `(${record.role})` : ""}`),
		[
			"pi:agent_start",
			"pi:message_end(system)",
			"pi:message_end(user)",
			"pi:message_end(assistant)",
			"pi:tool_execution_start",
			"pi:tool_call",
			"tool:enter",
			"tool:effect",
			"pi:tool_result",
			"pi:tool_execution_end",
			"pi:message_end(toolResult)",
			"pi:message_end(assistant)",
			"pi:agent_end",
			"pi:agent_before_settle",
			"pi:agent_settled",
		],
	);
	assert.deepEqual(fixture.errors, []);
	assertNoNetwork(fixture.networkAttempts);
});
