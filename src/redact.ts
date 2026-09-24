/**
 * Credential redaction and content hashing for snapshots, traces, and reports.
 *
 * Three layers, all applied BEFORE anything is serialized, because a secret that
 * reaches `JSON.stringify` once can be re-escaped into a shape no text rule
 * recognises:
 *   1. structural: any value stored under a credential-shaped key is replaced,
 *      whatever its type or depth (`{apiKey:"ordinary-secret-value"}`, a nested
 *      object, a number). Text rules alone cannot promise this.
 *   2. pattern redaction of credential-shaped text, including JSON-escaped
 *      `\"apiKey\":\"value\"` fragments embedded inside a string;
 *   3. literal removal of the configured Jev API key value, if a key is present
 *      in the environment at all (its value is never logged, only replaced).
 *
 * Environment variables are never dumped. Only values that already appear in the
 * captured actor text are affected.
 */

import { createHash } from "node:crypto";

export const REDACTION_MARK = "[REDACTED]";

/**
 * Marker for bounded (elided) content. Deliberately distinct from REDACTION_MARK:
 * "we trimmed history" and "we removed a credential" are different facts and a
 * reader must be able to tell them apart.
 */
export const ELISION_MARK = "[ELIDED]";

/** Keys whose value is a credential no matter what shape it has. */
const SECRET_KEY = /^(?:(?:x|cf|gh)[_-]?)?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|authorization|bearer[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|passphrase|private[_-]?key|access[_-]?key(?:[_-]?id)?|credential|credentials|cookie)$/i;

/**
 * Each rule is written as an explicit `(match, ...groups) => replacement` so the
 * replacement never depends on how many trailing arguments `String.replace`
 * happens to append (offset and the whole input are always present).
 */
type Rule = { name: string; pattern: RegExp; format: (match: string, ...groups: string[]) => string };

/** Credential-bearing key names, as they appear in text (not as JSON keys). */
const ASSIGN_KEY = "api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|secret";

const RULES: Rule[] = [
	{
		// `apiKey: "value"`, `API_KEY=value`, and quoted JSON keys such as
		// `{"apiKey":"value"}`. The key's own quotes are captured and restored, so
		// redaction cannot turn JSON into invalid JSON. A quoted value may contain
		// anything up to the closing quote (spaces and commas included); an unquoted
		// value stops at a delimiter.
		name: "assigned-secret",
		pattern: new RegExp(`(["']?)((?:${ASSIGN_KEY}))(\\1)(\\s*[:=]\\s*)(?:((["'])([^"'\\n]*)\\6)|([^\\s"',;}\\]]+))`, "gi"),
		format: (_match, ...rest: string[]) => {
			// Positional groups: 1 key quote, 2 key, 3 key quote (repeat), 4 separator,
			// then either 5/6/7 quoted value or 8 bare value. Rest also carries the
			// offset and the whole input; never rely on trailing arity.
			const keyQuote = rest[0] ?? "";
			const key = rest[1] ?? "";
			const sep = rest[3] ?? ":";
			const valueQuote = rest[5];
			const quotedValue = rest[6];
			const bareValue = rest[7];
			return quotedValue === undefined && bareValue === undefined
				? `${keyQuote}${key}${keyQuote}${sep}${REDACTION_MARK}`
				: valueQuote !== undefined
					? `${keyQuote}${key}${keyQuote}${sep}${valueQuote}${REDACTION_MARK}${valueQuote}`
					: `${keyQuote}${key}${keyQuote}${sep}${REDACTION_MARK}`;
		},
	},
	{
		// The same assignment escaped inside a JSON string value, e.g.
		// `{"snapshot":"{\\"apiKey\\":\\"secret\\"}"}`. Text that has already been
		// serialized once must not become a leak channel.
		name: "escaped-assigned-secret",
		pattern: new RegExp(`(\\\\)(["'])(${ASSIGN_KEY})\\2(\\s*[:=]\\s*)(\\\\)(["'])([^"'\\n]*?)\\6`, "gi"),
		format: (_match, esc1 = "\\", keyQuote = "\"", key = "", sep = ":", esc2 = "\\", valueQuote = "\"") => `${esc1}${keyQuote}${key}${keyQuote}${sep}${esc2}${valueQuote}${REDACTION_MARK}${esc2}${valueQuote}`,
	},
	{
		name: "authorization-scheme",
		pattern: /\b(Bearer|Basic|Token|ApiKey)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
		format: (_match, scheme = "") => `${scheme} ${REDACTION_MARK}`,
	},
	{
		// URL userinfo, e.g. https://user:pw@host/
		name: "url-credentials",
		pattern: /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s@/]+)@/gi,
		format: (_match, scheme = "", user = "") => `${scheme}${user}:${REDACTION_MARK}@`,
	},
	{
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
		format: () => REDACTION_MARK,
	},
	{
		name: "provider-token",
		pattern: /\b(?:sk-[A-Za-z0-9_-]{10,}|sk-[a-z]{2,}-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{8,}|[rps]k_(?:live|test)_[A-Za-z0-9]{10,})\b/g,
		format: () => REDACTION_MARK,
	},
];

/** Redact credential-shaped text. Idempotent. */
export function redactText(text: string): string {
	let out = text;
	for (const rule of RULES) {
		out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => rule.format(match, ...(rest as string[])));
	}
	return out;
}

/**
 * Scrub a value structurally before it is serialized. Every string goes through
 * the text rules and the configured literals; every value stored under a
 * credential-shaped key is replaced outright, at any depth and of any type.
 * Output objects are built with `Object.fromEntries`, so a captured argument
 * named `__proto__` becomes an ordinary own property instead of polluting or
 * silently vanishing.
 */
export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
	return walkValue(value, secrets, 0);
}

const MAX_VALUE_DEPTH = 32;

function walkValue(value: unknown, secrets: readonly string[], depth: number): unknown {
	if (depth > MAX_VALUE_DEPTH) {
		return `${ELISION_MARK} depth limit`;
	}
	if (typeof value === "string") {
		return removeLiteral(redactText(value), secrets);
	}
	if (Array.isArray(value)) {
		return value.map((item) => walkValue(item, secrets, depth + 1));
	}
	if (value !== null && typeof value === "object") {
		const entries: Array<[string, unknown]> = [];
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			const safeKey = removeLiteral(redactText(key), secrets);
			entries.push([safeKey, SECRET_KEY.test(key) ? REDACTION_MARK : walkValue(item, secrets, depth + 1)]);
		}
		return Object.fromEntries(entries);
	}
	return value;
}

/** Build the single scrub function every module uses for strings. */
export function makeScrub(secrets: readonly string[]): (text: string) => string {
	return (text: string): string => removeLiteral(redactText(text), secrets);
}

/**
 * Replace every occurrence of a literal secret value. The value itself is used
 * only for the replacement and is never stored or returned.
 */
export function removeLiteral(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) {
		// Unconditional: a configured credential is removed at any length. The
		// ordering guard only skips the empty string, which would loop forever.
		if (secret.length > 0) {
			out = out.split(secret).join(REDACTION_MARK);
		}
	}
	return out;
}

/** Truncate on a character budget, keeping the fact that content was elided. */
export function capText(text: string, maxChars: number): { text: string; truncated: boolean; chars: number } {
	const chars = text.length;
	if (chars <= maxChars) {
		return { text, truncated: false, chars };
	}
	const head = Math.ceil(maxChars * 0.6);
	const tail = Math.floor(maxChars * 0.3);
	return {
		text: `${text.slice(0, head)}\n${ELISION_MARK} ${chars - head - tail} characters elided ${ELISION_MARK}\n${text.slice(chars - tail)}`,
		truncated: true,
		chars,
	};
}

/** Short hash of the exact sanitized bytes that will be serialized. */
export function hashBytes(value: string | Uint8Array, length = 16): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function hashJson(value: unknown, length = 16): string {
	return hashBytes(stableJson(value), length);
}

/** Deterministic JSON: object keys sorted so hashes are reproducible. */
export function stableJson(value: unknown): string {
	return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
	}
	return value;
}
