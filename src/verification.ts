/**
 * verification.ts: Separates tool completion from reported unittest outcome.
 * Recognizes executed bash python -m unittest commands and complete trailing
 * Ran/OK/FAILED summary, conservative unknown for zero/multiple checks.
 * Bounded latest per exact argument hash; does not establish correctness or
 * parse arbitrary shell commands/formats. No security proof or echo filtering
 * guarantee. Source is used for observational context.
 */


import { hashJson } from "./redact.ts";

export const VERIFICATION_FRAMEWORK = "unittest" as const;
/** Character bound of one stored summary. */
export const VERIFICATION_SUMMARY_CHARS = 300;
/** How many of the most recent verification checks `evidence.verification_checks` keeps. */
export const VERIFICATION_CHECKS_LIMIT = 4;

export type VerificationOutcome = "passed" | "failed";

/** What actually ran and reported an outcome. */
export interface VerificationRecord {
	framework: typeof VERIFICATION_FRAMEWORK;
	outcome: VerificationOutcome;
	testsRun: number;
	/** Bounded summary of the trailer and its failure block. */
	summary: string;
	/** Always `observed_output`: the claim comes from output that was printed. */
	basis: "observed_output";
}

/** One rendered entry of `evidence.verification_checks`. */
export interface VerificationCheckEntry extends VerificationRecord {
	evidence_id: string;
	tool_call_id: string;
	/** Bounded to the same argument bound as a rendered recent action. */
	command: string;
	args_hash: string;
	/** Identity of the tool that produced the record. */
	source: string;
}

/** A candidate that looked like a unittest run but cannot be classified. */
export interface VerificationUnknown {
	unknown: "zero_tests" | "multipleTrailers" | "ambiguousTail";
	summary: string;
}

export type VerificationResult = { record: VerificationRecord } | VerificationUnknown | null;

export interface ParseVerificationInput {
	/** Complete, untruncated result text of the executed call. */
	text: string;
	/** Original (un-redacted) command; scrubbing stays the caller's job. */
	command?: string;
	/** False only when the executed-tool hook never proved the call ran. */
	executed?: boolean;
}

/** A unittest summary line, as printed at the END of a real run. */
const RAN_LINE = /^Ran\s+(\d+)\s+tests?\s+in\s+\d+(?:\.\d+)?(?:e-?\d+)?s\s*$/;
const OK_LINE = /^OK(?:\s*\(([^()]*)\))?$/;
const FAILED_LINE = /^FAILED(?:\s*\(([^()]*)\))?$/;

export function invokesPythonUnittest(command: string): boolean {
  const regex = /(?:^|[;&|\n])\s*(?:\/[\w./-]*\/)?python(?:3(?:\.\d+)?|2)?\s+-m\s+unittest(?:\s|$)/;
  return regex.test(command);
}

/**
 * Parse the verification outcome of one tool result.
 *
 * `toolName` is the tool as Pi named it; only `bash` is a candidate. The text
 * must be the RAW result before any truncation: a trailer cut out of a capped
 * observation is not the end of the run.
 */
export function parseVerification(toolName: string, command: string | undefined, input: ParseVerificationInput | string): VerificationResult {
	if (typeof toolName !== "string" || toolName !== "bash") {
		return null;
	}
	if (typeof command !== "string" || !invokesPythonUnittest(command)) {
		return null;
	}
	const parsed = typeof input === "string" ? parseUnittestOutput(input) : parseUnittestOutput(input.text, input);
	return parsed;
}

/**
 * Recognize the complete final unittest trailer. Exported so a test (or an
 * auditor) can ask about one text on its own; `parseVerification` is the only
 * function that also checks the execution and command conditions.
 */
export function parseUnittestOutput(text: string, input: { command?: string; executed?: boolean } = {}): VerificationResult {
	if (typeof text !== "string" || !text.trim()) {
		return null;
	}
	if (input.executed === false) {
		return null;
	}
	const lines = text.split(/\r\n|\r|\n/);
	const trailer = findFinalTrailer(lines);
	if (!trailer) {
		return null;
	}
	const ranBefore = lines.slice(0, trailer.ranIndex).some((line) => RAN_LINE.test(line));
	const trailerCount = 1 + (ranBefore ? 1 : 0);
	if (trailer.testsRun === 0) {
		// Zero tests is not a passed suite; it says nothing about the task.
		return { unknown: "zero_tests", summary: boundedSummary(trailer.summary) };
	}
	if (trailerCount > 1) {
		return { unknown: "multipleTrailers", summary: boundedSummary(trailer.summary) };
	}
	if (looksLikeEcho(text, trailer, Boolean(input.command && invokesPythonUnittest(input.command)))) {
		return null;
	}
	return {
		record: {
			framework: VERIFICATION_FRAMEWORK,
			outcome: trailer.outcome,
			testsRun: trailer.testsRun,
			summary: boundedSummary(trailer.summary),
			basis: "observed_output",
		},
	};
}

interface TrailerInfo {
	outcome: VerificationOutcome;
	testsRun: number;
	ranIndex: number;
	okIndex: number;
	summary: string;
}

/** Locate the trailer at the END of the output, so mid-output mentions never match. */
function findFinalTrailer(lines: readonly string[]): TrailerInfo | null {
	let okIndex = -1;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]!.trim();
		if (!line) {
			continue;
		}
		// Trailing output after the trailer makes the classification ambiguous.
		if (FAILED_LINE.test(line) || OK_LINE.test(line)) {
			okIndex = index;
			break;
		}
		return null;
	}
	if (okIndex < 0) {
		return null;
	}
	const okLine = lines[okIndex]!.trim();
	const failed = FAILED_LINE.test(okLine);
	const details = failed ? okLine.match(FAILED_LINE)?.[1] : okLine.match(OK_LINE)?.[1];
	if (failed) {
	  if (!details) return null;
	  const parts = details.split(',').map(s => s.trim());
	  const validKeys = new Set(['failures', 'errors', 'unexpected successes', 'skipped', 'expected failures']);
	  let hasPositive = false;
	  for (const part of parts) {
	    const match = /^([a-z ]+)=(\d+)$/.exec(part);
	    if (!match) return null;
	    const key = match[1]!;
	    const val = parseInt(match[2]!, 10);
	    if (!validKeys.has(key)) return null;
	    if ((key === 'failures' || key === 'errors' || key === 'unexpected successes') && val > 0) hasPositive = true;
	  }
	  if (!hasPositive) return null;
	}
	if (!failed && /\b(failures?|errors?)\b/.test(details ?? "")) {
		return null;
	}
	let ranIndex = -1;
	let testsRun = -1;
	for (let index = okIndex - 1; index >= 0; index--) {
		const line = lines[index]!.trim();
		if (!line) {
			continue;
		}
		const ran = RAN_LINE.exec(line);
		if (ran) {
			ranIndex = index;
			testsRun = Number(ran[1]);
			break;
		}
		return null;
	}
	if (ranIndex < 0 || testsRun < 0 || lines.slice(ranIndex + 1, okIndex).some((line) => line.trim() !== "")) {
		return null;
	}
	return {
		outcome: failed ? "failed" : "passed",
		testsRun,
		ranIndex,
		okIndex,
		summary: trailerSummary(lines, ranIndex, okIndex, okLine),
	};
}

/** Trailer line plus the unittest failure block between `Ran` and the verdict. */
function trailerSummary(lines: readonly string[], ranIndex: number, okIndex: number, okLine: string): string {
	const block: string[] = [lines[ranIndex]!.trim()];
	for (const line of lines.slice(ranIndex + 1, okIndex)) {
		const trimmed = line.trim();
		if (/^(?:\d+\.\s|(?:FAIL|ERROR):)/.test(trimmed)) {
			block.push(trimmed);
		}
	}
	block.push(okLine);
	return block.join("\n");
}

/**
 * A trailer that is merely printed by `echo`/`printf` is not a test run. The
 * shapes only a real run produces (test-progress dots, an `OK (skipped=n)`
 * trailer, or a per-test `FAIL:`/`ERROR:` report) are the disambiguator, so a
 * command that genuinely invoked unittest is never second-guessed.
 */
function looksLikeEcho(text: string, trailer: TrailerInfo, invokedUnittest: boolean): boolean {
	if (invokedUnittest) {
		return false;
	}
	if (!/\be(?:cho|printf?)\b/.test(text)) {
		return false;
	}
	if (/\.\.\.\s+(?:ok|FAIL|ERROR)$/m.test(text)) {
		return false;
	}
	if (/\b(?:skipped|expected failures?|unexpected successes)\b\s*=/m.test(text)) {
		return false;
	}
	if (trailer.outcome === "failed" && /(?:^|\n)(?:ERROR|FAIL):[ \t]/.test(text)) {
		return false;
	}
	return true;
}

/** Collapse whitespace and bound the summary; redaction stays with the caller. */
export function boundedSummary(text: string, maxChars = VERIFICATION_SUMMARY_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}\u2026`;
}

export interface VerificationCheckInput {
	evidenceId: string;
	toolCallId: string;
	command: string;
	/** Max characters of the rendered command; the caller passes its argument bound. */
	commandChars: number;
	argsHash: string;
	record: VerificationRecord;
	source?: string;
}

/** One rendered check record: bounded command, exact argument hash, recorded outcome. */
export function verificationCheckEntry(input: VerificationCheckInput): VerificationCheckEntry {
	return {
		evidence_id: input.evidenceId,
		tool_call_id: input.toolCallId,
		command: boundedSummary(input.command, Math.max(1, input.commandChars)),
		outcome: input.record.outcome,
		testsRun: input.record.testsRun,
		framework: input.record.framework,
		summary: input.record.summary,
		basis: input.record.basis,
		args_hash: input.argsHash,
		source: input.source ?? "pi:bash_tool_output",
	};
}

/**
 * The most recent N check records in chronological order, keeping only the
 * LATEST record of each exact original argument hash. A newer result for the
 * identical command supersedes the older one; nothing is claimed about any
 * other command or suite, and no older record is reinterpreted as active.
 */
export function selectVerificationChecks(entries: readonly VerificationCheckEntry[], limit = VERIFICATION_CHECKS_LIMIT): VerificationCheckEntry[] {
	const latestByArgs = new Map<string, VerificationCheckEntry>();
	for (const entry of entries) {
		const key = hashJson({ args_hash: entry.args_hash });
		// Delete first so a re-set moves the key to the END of insertion order:
		// with A(fail), B(pass), A(pass) the chronological result is B, then the
		// latest A, and limit 1 returns the latest A, never the superseded one.
		latestByArgs.delete(key);
		latestByArgs.set(key, entry);
	}
	return [...latestByArgs.values()].slice(-Math.max(0, limit));
}
