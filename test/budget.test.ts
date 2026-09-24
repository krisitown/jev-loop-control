import test from "node:test";
import assert from "node:assert/strict";
import { assessmentBudgetReason } from "../src/budget.ts";
import { defaultConfig } from "../src/config.ts";
import type { BudgetState } from "../src/types.ts";

function makeBudget(overrides: Partial<BudgetState> = {}): BudgetState {
	return {
		requestsUsed: 0,
		reservedUsd: 0,
		billedUsd: 0,
		marketUsd: 0,
		unknownCosts: 0,
		...overrides,
	};
}

test("unlimited by default", () => {
	const config = defaultConfig();
	const budget = makeBudget({ requestsUsed: 1000, billedUsd: 1000 });
	assert.equal(assessmentBudgetReason(config, budget, 1000), null);
});

test("request cap enforced", () => {
	const config = defaultConfig();
	config.budget.maxRequests = 5;

	assert.equal(assessmentBudgetReason(config, makeBudget({ requestsUsed: 4 }), 0), null);
	assert.ok(assessmentBudgetReason(config, makeBudget({ requestsUsed: 5 }), 0)?.includes("request cap"));
});

test("request cap zero stops calls", () => {
	const config = defaultConfig();
	config.budget.maxRequests = 0;
	assert.ok(assessmentBudgetReason(config, makeBudget(), 0)?.includes("request cap"));
});

test("allowance cap enforced", () => {
	const config = defaultConfig();
	config.budget.allowanceUsd = 1.0;
	config.budget.reserveUsdPerRequest = 0.1;

	// 0.9 billed + 0.1 reserve = 1.0 <= 1.0 OK
	assert.equal(assessmentBudgetReason(config, makeBudget({ billedUsd: 0.9 }), 0), null);
	// 0.95 billed + 0.1 reserve = 1.05 > 1.0 Fail
	assert.ok(assessmentBudgetReason(config, makeBudget({ billedUsd: 0.95 }), 0)?.includes("allowance"));
});

test("allowance zero stops calls", () => {
	const config = defaultConfig();
	config.budget.allowanceUsd = 0;
	config.budget.reserveUsdPerRequest = 0.01;
	assert.ok(assessmentBudgetReason(config, makeBudget(), 0)?.includes("allowance"));
});

test("assessment cap enforced", () => {
	const config = defaultConfig();
	config.limits.maxAssessments = 10;

	assert.equal(assessmentBudgetReason(config, makeBudget(), 9), null);
	assert.ok(assessmentBudgetReason(config, makeBudget(), 10)?.includes("assessment cap"));
});

test("partial budgets", () => {
	const config = defaultConfig();
	config.budget.maxRequests = 5;
	config.budget.allowanceUsd = null; // Unlimited money
	config.limits.maxAssessments = null; // Unlimited assessments

	assert.equal(assessmentBudgetReason(config, makeBudget({ requestsUsed: 4, billedUsd: 1000 }), 1000), null);
	assert.ok(assessmentBudgetReason(config, makeBudget({ requestsUsed: 5, billedUsd: 1000 }), 1000)?.includes("request cap"));
});

test("assessment cap zero stops calls", () => {
	const config = defaultConfig();
	config.limits.maxAssessments = 0;
	assert.ok(assessmentBudgetReason(config, makeBudget(), 0)?.includes("assessment cap"));
});

test("unknown costs with monetary cap boundary", () => {
	const config = defaultConfig();
	config.budget.allowanceUsd = 1.0;
	config.budget.reserveUsdPerRequest = 0.1;

	// Unknown cost uses reservation. 0.9 billed + 0.1 reserve = 1.0 (boundary OK)
	assert.equal(assessmentBudgetReason(config, makeBudget({ billedUsd: 0.9, unknownCosts: 1 }), 0), null);
	// 0.95 billed + 0.1 reserve = 1.05 > 1.0 (boundary fail)
	assert.ok(assessmentBudgetReason(config, makeBudget({ billedUsd: 0.95, unknownCosts: 1 }), 0)?.includes("allowance"));
});
