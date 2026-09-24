import type { SupervisorConfig } from "./config.ts";
import type { BudgetState } from "./types.ts";

/**
 * Determine if an assessment should be skipped due to budget limits.
 * Returns a reason string if skipped, or null if allowed.
 *
 * @param config The supervisor configuration
 * @param budget The current budget state
 * @param assessmentsUsed The number of assessments used so far
 */
export function assessmentBudgetReason(
	config: SupervisorConfig,
	budget: BudgetState,
	assessmentsUsed: number
): string | null {
	// Check request cap
	if (config.budget.maxRequests !== null) {
		if (budget.requestsUsed >= config.budget.maxRequests) {
			return `request cap reached (${budget.requestsUsed}/${config.budget.maxRequests})`;
		}
	}

	// Check assessment cap
	if (config.limits.maxAssessments !== null) {
		if (assessmentsUsed >= config.limits.maxAssessments) {
			return `assessment cap reached (${assessmentsUsed}/${config.limits.maxAssessments})`;
		}
	}

	// Check monetary allowance
	if (config.budget.allowanceUsd !== null) {
		const projectedCost = budget.billedUsd + budget.reservedUsd + config.budget.reserveUsdPerRequest;
		if (projectedCost > config.budget.allowanceUsd) {
			return `allowance exhausted (projected $${projectedCost.toFixed(4)} > $${config.budget.allowanceUsd.toFixed(4)})`;
		}
	}

	return null;
}
