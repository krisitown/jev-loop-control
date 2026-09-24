/**
 * Preload for the real-process CLI fixture: blocks network access in the child
 * process and appends every attempt to `JEV_NETWORK_LOG`.
 *
 * Loaded with `node --import`, before Pi starts.
 */

import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const log = process.env.JEV_NETWORK_LOG;

function record(what) {
	if (log) {
		appendFileSync(log, `${String(what)}\n`, "utf8");
	}
}

function describe(input) {
	if (typeof input === "string") {
		return input;
	}
	if (input && typeof input === "object" && "url" in input) {
		return String(input.url);
	}
	return String(input);
}

globalThis.fetch = (input) => {
	record(`fetch ${describe(input)}`);
	throw new Error(`network access is not allowed in fixtures: ${describe(input)}`);
};

for (const [name, mod] of [["http", http], ["https", https]]) {
	for (const method of ["request", "get"]) {
		const original = mod[method];
		mod[method] = (...args) => {
			record(`${name}.${method} ${describe(args[0])}`);
			throw new Error(`network access is not allowed in fixtures: ${describe(args[0])}`);
		};
		void original;
	}
}
