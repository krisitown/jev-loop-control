import test from "node:test";
import assert from "node:assert/strict";
import { capText, hashBytes, hashJson, REDACTION_MARK, redactText, removeLiteral } from "../src/redact.ts";

/**
 * Redaction is the last line of defence before anything reaches a trace, a
 * report, or a Jev request. These are executable regressions for the exact
 * shapes that were missed during authoring, not inspection notes.
 */

test("quoted JSON key/value pairs lose the value, not the JSON structure", () => {
	const input = '{"apiKey":"ordinary-secret-value"}';
	const out = redactText(input);
	assert.ok(!out.includes("ordinary-secret-value"), `secret survived: ${out}`);
	assert.equal(out, '{"apiKey":"[REDACTED]"}');
	// Still valid JSON, and the key name is preserved for the reader.
	assert.deepEqual(JSON.parse(out), { apiKey: REDACTION_MARK });
});

test("bare and single-quoted assignments are redacted", () => {
	assert.equal(redactText("API_KEY=s3cr3tvalue123"), `API_KEY=${REDACTION_MARK}`);
	assert.equal(redactText("apiKey: 'abc123456'"), `apiKey: '${REDACTION_MARK}'`);
	assert.equal(redactText("password = \"hunter2hunter2\""), `password = "${REDACTION_MARK}"`);
	assert.ok(!/hunter2/.test(redactText("password = \"hunter2hunter2\"")));
});

test("authorization headers keep their scheme and drop the credential", () => {
	assert.equal(redactText("Authorization: Bearer sk-abcdef0123456789"), `Authorization: Bearer ${REDACTION_MARK}`);
	assert.equal(redactText("Authorization: Basic dXNlcjpwYXNzd29yZA=="), `Authorization: Basic ${REDACTION_MARK}`);
});

test("provider-shaped tokens and URL credentials are removed", () => {
	for (const secret of [
		"sk-abcdef0123456789",
		"sk-proj-abcdef0123456789",
		"ghp_0123456789abcdef0123",
		"AIzaSyA0123456789abcdefghij",
		"AKIA0123456789ABCDEF",
		"xoxb-0123456789abcdef",
		"rk_live_0123456789abcd",
		"eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefgh",
	]) {
		const out = redactText(`value looked like ${secret} in the log`);
		assert.ok(!out.includes(secret), `token survived: ${secret} -> ${out}`);
		assert.ok(out.includes(REDACTION_MARK));
	}
	const url = redactText("curl https://user:hunter2hunter2@api.example.com/v1");
	assert.ok(!url.includes("hunter2hunter2"), url);
	assert.match(url, /^curl https:\/\/user:\[REDACTED\]@api\.example\.com\/v1$/);
});

test("configured secret values are removed unconditionally, whatever their length", () => {
	// Short values matter too: a 4-character key is still a key.
	for (const secret of ["abcd", "hunter2", "s3cr3t-value", "AB12"]) {
		const out = removeLiteral(`key=${secret} and again ${secret}`, [secret]);
		assert.ok(!out.includes(secret), `secret survived removeLiteral: ${secret} -> ${out}`);
		assert.equal(out.split(REDACTION_MARK).length - 1, 2);
	}
	// The empty string must not be treated as a secret (it would match forever).
	assert.equal(removeLiteral("unchanged", [""]), "unchanged");
});

test("redaction composes with literal removal and is idempotent", () => {
	const secret = "zebra-antelope-123456";
	const once = removeLiteral(redactText(`Authorization: Bearer ${secret}`), [secret]);
	assert.equal(once, `Authorization: Bearer ${REDACTION_MARK}`);
	assert.equal(redactText(once), once, "applying redaction twice must not change the result");
});

test("capText keeps the elision explicit", () => {
	const long = "x".repeat(500);
	const capped = capText(long, 100);
	assert.equal(capped.truncated, true);
	assert.equal(capped.chars, 500);
	assert.ok(capped.text.includes("characters elided"));
	assert.ok(capped.text.length < long.length);
	const short = capText("short", 100);
	assert.equal(short.truncated, false);
	assert.equal(short.text, "short");
});

test("hashes describe exact canonical bytes, not object ordering", () => {
	assert.equal(hashJson({ a: 1, b: { c: 2, d: [3, 4] } }), hashJson({ b: { d: [3, 4], c: 2 }, a: 1 }));
	assert.notEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
	assert.equal(hashBytes("abc").length, 16);
	assert.equal(hashBytes("abc", 8).length, 8);
	assert.equal(hashBytes("abc"), hashBytes(new TextEncoder().encode("abc")));
});
