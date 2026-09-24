import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixture, fauxAssistantMessage, fauxToolCall } from "./support/harness.ts";
import jevLoopControl, { resolveBootstrapConfig } from "../src/index.ts";

/** Stage 0 checks for the shipped extension entry point. */

test("configuration: off by default, observe needs a trace path, enforce is reported and downgraded", () => {
	assert.deepEqual(resolveBootstrapConfig({}), {
		mode: "off",
		effectiveMode: "off",
		tracePath: undefined,
		diagnostics: [],
	});

	const observe = resolveBootstrapConfig({
		JEV_LOOP_CONTROL_MODE: "observe",
		JEV_LOOP_CONTROL_TRACE: "traces/run.jsonl",
	});
	assert.equal(observe.mode, "observe");
	assert.equal(observe.effectiveMode, "observe");
	assert.equal(observe.tracePath, join(process.cwd(), "traces/run.jsonl"));
	assert.deepEqual(observe.diagnostics, []);

	const enforce = resolveBootstrapConfig({ JEV_LOOP_CONTROL_MODE: "enforce", JEV_LOOP_CONTROL_TRACE: "/tmp/t.jsonl" });
	assert.equal(enforce.mode, "enforce");
	assert.equal(enforce.effectiveMode, "observe");
	assert.match(enforce.diagnostics[0] ?? "", /not implemented/);

	const noPath = resolveBootstrapConfig({ JEV_LOOP_CONTROL_MODE: "observe" });
	assert.equal(noPath.effectiveMode, "off");
	assert.match(noPath.diagnostics[0] ?? "", /TRACE is required/);

	const garbage = resolveBootstrapConfig({ JEV_LOOP_CONTROL_MODE: "aggressive" });
	assert.equal(garbage.mode, "off");
	assert.equal(garbage.effectiveMode, "off");
	assert.match(garbage.diagnostics[0] ?? "", /invalid JEV_LOOP_CONTROL_MODE/);
});

test("off mode registers nothing and writes nothing", async (t) => {
	const tracePath = "{tempDir}/off.jsonl";
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([fauxToolCall("note", { note: "x" }, { id: "call-1" })]),
			fauxAssistantMessage("done"),
		],
		tools: [{ name: "note" }],
		env: { JEV_LOOP_CONTROL_MODE: "off", JEV_LOOP_CONTROL_TRACE: tracePath },
		extensions: [{ name: "jev-loop-control", factory: jevLoopControl }],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("note this");

	assert.equal(existsSync(join(fixture.tempDir, "off.jsonl")), false, "off must not write a trace");
	assert.deepEqual(fixture.executed, ["note"]);
	assert.equal(fixture.providerCalls(), 2);
});

test("observe mode records the real lifecycle and changes no behaviour", async (t) => {
	const fixture = await createFixture({
		script: [
			fauxAssistantMessage([fauxToolCall("note", { note: "x" }, { id: "call-1" })]),
			fauxAssistantMessage("done"),
		],
		tools: [{ name: "note" }],
		env: {
			JEV_LOOP_CONTROL_MODE: "observe",
			JEV_LOOP_CONTROL_TRACE: "{tempDir}/observe.jsonl",
		},
		extensions: [{ name: "jev-loop-control", factory: jevLoopControl }],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("note this");

	const lines = readFileSync(join(fixture.tempDir, "observe.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { seq: number; type: string; toolCalls?: string[]; signal?: string });

	assert.equal(lines[0]?.type, "bootstrap_config");

	assert.deepEqual(
		lines.map((line) => line.seq),
		lines.map((_line, index) => index),
		"trace sequence numbers are monotonic and gap-free",
	);
	assert.deepEqual(
		lines.map((line) => line.type),
		[
			"bootstrap_config",
			"session_start",
			"input",
			"agent_start",
			"message_end",
			"message_end",
			"message_end",
			"tool_execution_start",
			"tool_call",
			"tool_result",
			"tool_execution_end",
			"message_end",
			"message_end",
			"agent_end",
			"agent_before_settle",
			"agent_settled",
		],
	);

	// The proposal, including its tool call, is final before the first preflight.
	const assistant = lines.find((line) => line.toolCalls?.length === 1);
	const firstHook = lines.findIndex((line) => line.type === "tool_call");
	assert.ok(assistant !== undefined && lines.indexOf(assistant) < firstHook);

	const settle = lines.find((line) => line.type === "agent_before_settle");
	assert.equal(settle?.signal, "absent", "the shipped observer records the boundary signal gap");
	assert.equal(lines.at(-1)?.type, "agent_settled");

	// Observation only: identical behaviour to the same script without the extension.
	assert.deepEqual(fixture.executed, ["note"]);
	assert.equal(fixture.providerCalls(), 2);
	assert.equal(fixture.session.getLastAssistantText(), "done");
});
