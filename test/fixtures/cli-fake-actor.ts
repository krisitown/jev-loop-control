/**
 * CLI fixture: registers the scripted fake actor as a real Pi provider.
 *
 * Used only by the real-process CLI test. It reads a JSON script named by
 * `JEV_FAKE_SCRIPT` and answers every request from it. It performs no network
 * I/O: `fauxProvider` emits Pi provider events from the scripted message.
 */

import { readFileSync } from "node:fs";
import {
	fauxProvider,
	fauxText,
	fauxToolCall,
	fauxAssistantMessage,
	type FauxResponseStep,
	type JsonObject,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ScriptStep {
	text?: string;
	toolCalls?: Array<{ name: string; args?: JsonObject; id?: string }>;
}

function loadScript(): FauxResponseStep[] {
	const path = process.env.JEV_FAKE_SCRIPT;
	if (!path) {
		throw new Error("JEV_FAKE_SCRIPT is required for the CLI fake actor");
	}
	const steps = JSON.parse(readFileSync(path, "utf8")) as ScriptStep[];
	return steps.map((step) => {
		const blocks: Array<ReturnType<typeof fauxToolCall> | ReturnType<typeof fauxText>> = (step.toolCalls ?? []).map(
			(call) => fauxToolCall(call.name, call.args ?? {}, call.id ? { id: call.id } : {}),
		);
		if (step.text !== undefined) {
			blocks.push(fauxText(step.text));
		}
		return fauxAssistantMessage(blocks.length > 0 ? blocks : "");
	});
}

const faux = fauxProvider({
	provider: "jev-fake",
	tokenSize: { min: 100_000, max: 100_000 },
	models: [{ id: "fake-actor", name: "Fake Actor (synthetic)", reasoning: false, input: ["text"] }],
});
faux.setResponses(loadScript());

export default function cliFakeActor(pi: ExtensionAPI): void {
	// Synthetic, keyless, and never dialled out: the stream is generated locally.
	pi.registerProvider(faux.provider);
}
