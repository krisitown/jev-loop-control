/**
 * Durable run trace: an ordered JSONL log plus the exact sanitized request and
 * response artifacts, a manifest, and a summary.
 *
 * Traces default to the Pi agent directory (`<agent-dir>/jev-loop-control/runs`)
 * so run data never lands in the actor's workspace. Writes are synchronous, so
 * the order in the file is the order of the hooks. A write failure disables
 * tracing, records the failure, and the controller suspends `enforce` visibly
 * rather than intervening without a record.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, redactText, removeLiteral } from "./redact.ts";
import type { BudgetState } from "./types.ts";

export interface TraceArtifacts {
	request: string;
	response: string;
}

export interface TraceOptions {
	dir: string;
	artifacts: boolean;
	runId: string;
	scrub: (text: string) => string;
	now?: () => Date;
}

export interface RunSummary {
	runId: string;
	packageVersion: string;
	mode: string;
	effectiveMode: string;
	origin: "live" | "synthetic" | "none";
	startedAt: string;
	finishedAt: string;
	sessionId: string;
	cwd: string;
	configPath: string | null;
	problems: string[];
	notices: string[];
	counts: {
		assessments: number;
		requests: number;
		interventions: number;
		blockedBatches: number;
		continuations: number;
		deferredTools: number;
		passThroughs: number;
		failures: number;
		discardedStale: number;
	};
	cost: BudgetState & { allowanceUsd: number; reserveUsdPerRequest: number };
	tracingFailure: string | null;
	tracePath: string;
	reportPath: string;
}

export class TraceStore {
	readonly dir: string;
	readonly tracePath: string;
	readonly manifestPath: string;
	readonly summaryPath: string;
	readonly runId: string;
	#seq = 0;
	#enabled = true;
	#artifacts: boolean;
	#artifactSeq = 0;
	#scrub: (text: string) => string;
	#now: () => Date;
	failure: string | null = null;

	constructor(options: TraceOptions) {
		this.dir = options.dir;
		this.runId = options.runId;
		this.tracePath = join(options.dir, "events.jsonl");
		this.manifestPath = join(options.dir, "manifest.json");
		this.summaryPath = join(options.dir, "summary.json");
		this.#artifacts = options.artifacts;
		this.#scrub = options.scrub;
		this.#now = options.now ?? (() => new Date());
		try {
			mkdirSync(join(options.dir, "artifacts"), { recursive: true });
			// Fail fast so the first record is not the one that discovers the problem.
			appendFileSync(this.tracePath, "", "utf8");
		}
		catch (error) {
			this.#fail(error);
		}
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	record(type: string, fields: Record<string, unknown> = {}): void {
		if (!this.#enabled) {
			return;
		}
		const line = JSON.stringify({ seq: this.#seq++, at: this.#now().toISOString(), runId: this.runId, type, ...fields });
		try {
			appendFileSync(this.tracePath, `${this.#scrub(line)}\n`, "utf8");
		}
		catch (error) {
			this.#fail(error);
		}
	}

	/** Store the exact bytes exchanged, next to the record that references them. */
	artifact(kind: "request" | "response", content: string, ref: string): string | null {
		if (!this.#enabled || !this.#artifacts) {
			return null;
		}
		const name = `${String(++this.#artifactSeq).padStart(3, "0")}-${kind}-${ref}.json`;
		try {
			writeFileSync(join(this.dir, "artifacts", name), this.#scrub(content), "utf8");
			return join("artifacts", name);
		}
		catch (error) {
			this.#fail(error);
			return null;
		}
	}

	writeJson(name: string, value: unknown): void {
		if (!this.#enabled) {
			return;
		}
		try {
			writeFileSync(join(this.dir, name), `${this.#scrub(JSON.stringify(value, null, 2))}\n`, "utf8");
		}
		catch (error) {
			this.#fail(error);
		}
	}

	manifest(fields: Record<string, unknown>): void {
		this.writeJson("manifest.json", { runId: this.runId, ...fields });
	}

	summary(summary: RunSummary): void {
		this.writeJson("summary.json", summary);
	}

	#fail(error: unknown): void {
		if (this.failure === null) {
			this.failure = redactText(String(error)).slice(0, 400);
		}
		this.#enabled = false;
	}
}

/** Default location: outside the actor workspace, under the Pi agent directory. */
export function defaultRunsDir(agentDir: string, runId: string): string {
	return join(agentDir, "jev-loop-control", "runs", runId);
}

export function runId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	return `${stamp}-${process.pid}-${hashBytes(`${now.getTime()}-${Math.random()}`, 6)}`;
}

export function readJsonLines(path: string): Array<Record<string, unknown>> {
	let text: string;
	try {
		text = existsSync(path) ? readFileSync(path, "utf8") : "";
	}
	catch {
		return [];
	}
	const records: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				records.push(parsed as Record<string, unknown>);
			}
		}
		catch {
			// A partially written final line must not make the whole report unreadable.
			records.push({ type: "trace.parse_error", raw_length: trimmed.length });
		}
	}
	return records;
}

export { existsSync, mkdirSync, readFileSync, writeFileSync };
