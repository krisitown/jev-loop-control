/**
 * CLI fixture: one instrumented toy tool.
 *
 * Appends a line to `JEV_TOY_LOG` from inside `execute()`, which is the
 * execution-proof channel used by the real-process CLI test. A tool_start or
 * tool_call event is only lifecycle observation; this log line is the evidence
 * that the tool actually ran.
 */

import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function cliToyTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "mark",
		label: "Mark (synthetic)",
		description: "Synthetic toy tool: records that it executed and returns a short confirmation.",
		parameters: Type.Object({ note: Type.Optional(Type.String()) }),
		executionMode: "parallel",
		execute: async (toolCallId, params) => {
			const log = process.env.JEV_TOY_LOG;
			if (log) {
				appendFileSync(log, `executed ${toolCallId} ${JSON.stringify(params)}\n`, "utf8");
			}
			return {
				content: [{ type: "text", text: `marked:${params.note ?? ""}` }],
				details: { executed: true },
			};
		},
	});
}
