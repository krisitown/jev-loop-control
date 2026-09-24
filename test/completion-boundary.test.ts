import test from "node:test";
import assert from "node:assert/strict";
import { createFixture, fauxAssistantMessage, type FauxResponseStep } from "./support/harness.ts";
import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

/**
 * Stage 0 evidence for the pre-settlement boundary: `agent_before_settle` is the
 * last actionable public boundary. It can append entries and request exactly one
 * next model request, and appending must preserve entries already proposed by
 * earlier handlers because a returned array replaces the accumulated one.
 */

function captureStep(text: string, seen: string[][]): FauxResponseStep {
	return (context) => {
		seen.push(context.messages.map((message) => message.role));
		return fauxAssistantMessage(text);
	};
}

function branchTypes(branch: readonly unknown[]): string[] {
	return branch.map((value) => {
		const entry = value as { type?: unknown; customType?: unknown };
		return `${String(entry.type)}${typeof entry.customType === "string" ? `(${entry.customType})` : ""}`;
	});
}

test("an untouched completion settles with no continuation request", async (t) => {
	const seen: string[][] = [];
	const fixture = await createFixture({ script: [captureStep("plain answer", seen)] });
	t.after(() => fixture.dispose());

	await fixture.session.prompt("answer plainly");

	assert.equal(fixture.providerCalls(), 1);
	const settle = fixture.order.filter((record) => record.at === "pi:agent_before_settle");
	assert.equal(settle.length, 1);
	assert.equal(settle[0]?.outcome, "completed");
	assert.equal(settle[0]?.canContinue, false);
	assert.equal(settle[0]?.continueRequested, false);
	assert.equal(fixture.errors.length, 0);
});

test("a valid completion boundary continuation appends entries and runs exactly one extra request", async (t) => {
	const seen: string[][] = [];
	let used = false;
	const fixture = await createFixture({
		script: [captureStep("first answer", seen), captureStep("corrected answer", seen)],
		extensions: [
			{
				name: "completion-supervisor",
				factory: ((pi) => {
					pi.on("agent_before_settle", (event) => {
						if (used) {
							return undefined;
						}
						used = true;
						const drafts: SessionBoundaryDraft[] = [
							{ type: "custom", customType: "jev.completion", data: { verdict: "insufficient", stage: "stage0" } },
							{
								type: "custom_message",
								customType: "jev.continuation",
								content: "synthetic supervisor: requirement 2 is unanswered",
								display: false,
							},
						];
						return { entries: [...event.entries, ...drafts], continue: true };
					});
				}),
			},
		],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("answer two requirements");

	assert.equal(fixture.providerCalls(), 2, "exactly one continuation request");
	assert.ok(seen.length >= 2, "the actor must be asked again");
	assert.equal(seen[1]?.at(-1), "user", "the appended custom_message must be model-visible");

	const branch = branchTypes(fixture.session.sessionManager.getBranch());
	assert.ok(branch.includes("custom(jev.completion)"), "audit entry must be committed");
	assert.ok(branch.includes("custom_message(jev.continuation)"), "continuation entry must be committed");
	assert.equal(fixture.errors.length, 0);
	assert.equal(
		fixture.order.filter((record) => record.at === "pi:agent_before_settle").length,
		2,
		"the boundary runs once per run, not once per tool",
	);
});

test("an appending boundary handler preserves entries proposed earlier in the chain", async (t) => {
	const seen: string[][] = [];
	const observed: string[][] = [];
	let used = false;
	const fixture = await createFixture({
		script: [captureStep("answer", seen), captureStep("answer after both entries", seen)],
		extensions: [
			{
				name: "first-handler",
				factory: ((pi) => {
					pi.on("agent_before_settle", (event) => {
						const drafts: SessionBoundaryDraft[] = [
							{ type: "custom", customType: "jev.first", data: { from: "first-handler" } },
							...event.entries,
						];
						return { entries: drafts };
					});
				}),
			},
			{
				name: "second-handler",
				factory: ((pi) => {
					pi.on("agent_before_settle", (event) => {
						observed.push(event.entries.map((entry) => ("customType" in entry ? String(entry.customType) : entry.type)));
						if (used) {
							return undefined;
						}
						used = true;
						const drafts: SessionBoundaryDraft[] = [
							...event.entries,
							{
								type: "custom_message",
								customType: "jev.second",
								content: "synthetic supervisor: second handler continuation",
								display: false,
							},
						];
						return { entries: drafts, continue: true };
					});
				}),
			},
		],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("answer");

	assert.deepEqual(observed[0], ["jev.first"], "the later handler must see the earlier handler's entry");
	const branch = branchTypes(fixture.session.sessionManager.getBranch());
	assert.ok(branch.indexOf("custom(jev.first)") < branch.indexOf("custom_message(jev.second)"),
		"both entries must be committed in order");
	assert.equal(fixture.providerCalls(), 2);
});

test("continuation without runnable model context is reported and never restarts the actor", async (t) => {
	const seen: string[][] = [];
	let used = false;
	const fixture = await createFixture({
		script: [captureStep("final answer", seen)],
		extensions: [
			{
				name: "invalid-continuation",
				factory: ((pi) => {
					pi.on("agent_before_settle", (event) => {
						if (used) {
							return undefined;
						}
						used = true;
						// A `custom` entry is not model-visible, so the last model-visible
						// role stays assistant and there is nothing runnable to continue from.
						const drafts: SessionBoundaryDraft[] = [
							...event.entries,
							{ type: "custom", customType: "jev.audit-only", data: { note: "not model-visible" } },
						];
						return { entries: drafts, continue: true };
					});
				}),
			},
		],
	});
	t.after(() => fixture.dispose());

	await fixture.session.prompt("answer once");

	assert.equal(fixture.providerCalls(), 1, "an invalid continuation must not start another actor run");
	assert.equal(fixture.errors.length, 1);
	assert.equal(fixture.errors[0]?.event, "agent_before_settle");
	assert.match(fixture.errors[0]?.error ?? "", /runnable model context/);
	assert.ok(branchTypes(fixture.session.sessionManager.getBranch()).includes("custom(jev.audit-only)"),
		"entries are committed before the continuation validity check");
});
