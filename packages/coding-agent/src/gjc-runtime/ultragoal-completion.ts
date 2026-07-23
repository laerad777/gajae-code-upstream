import {
	findLedgerReceiptEvent,
	terminalCriticCeilingReached,
	terminalCriticGateOverridden,
	validateDeferredMemberReceiptFresh,
	validateReceiptFreshBase,
	validateSupersededFinalAggregateReceipt,
} from "./ultragoal-receipt-freshness";
import type { UltragoalGoal, UltragoalLedgerEvent, UltragoalPlan, UltragoalReceiptKind } from "./ultragoal-runtime";

export type UltragoalGuardState =
	| "inactive"
	| "unrelated_goal"
	| "active_verified_complete"
	| "active_missing_receipt"
	| "active_stale_receipt"
	| "active_missing_final_receipt"
	| "active_dirty_quality_gate"
	| "active_review_blocked_unrecorded"
	| "active_review_blocked_recorded"
	| "active_missing_critic_verdict"
	| "unreadable_fail_closed";

export interface UltragoalGuardDiagnostic {
	state: UltragoalGuardState;
	message: string;
	goalId?: string;
}

export interface UltragoalAskBlockDiagnostic {
	active: boolean;
	reason: string;
	source: "absent" | "durable_state" | "durable_state_unreadable" | "ledger" | "goals_json";
	goalsPath?: string;
	ledgerPath?: string;
	goalIds?: string[];
	message: string;
}

function requiredGoals(plan: UltragoalPlan): UltragoalGoal[] {
	return plan.goals.filter(goal => goal.status !== "superseded");
}

/**
 * Select the goal whose final-aggregate receipt should represent the run.
 * Prefer a receipt that still validates fresh; several goals can hold
 * final-aggregate receipts once plan growth (e.g. `steer add_subgoal`) stales
 * an earlier one and a later checkpoint re-mints. Fall back to the newest
 * holder (array-last) purely for diagnostics when none validates.
 */
export function findFinalAggregateReceiptGoal(
	plan: UltragoalPlan,
	ledger: readonly UltragoalLedgerEvent[],
): UltragoalGoal | null {
	const candidates = [...requiredGoals(plan)]
		.reverse()
		.filter(goal => goal.completionVerification?.receiptKind === "final-aggregate");
	if (candidates.length === 0) return null;
	return (
		candidates.find(
			goal =>
				validateCompletionReceipt({ plan, ledger, goal, receiptKind: "final-aggregate" }).state ===
				"active_verified_complete",
		) ?? candidates[0]!
	);
}

/**
 * A review-blocker replacement can stand in for a superseded validation-batch
 * final only while validating the run's final aggregate receipt. Ordinary
 * per-goal validation continues to require the original batch-close receipt.
 */
function hasFreshReviewedBatchFinalReplacement(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	deferredGoal: UltragoalGoal;
}): boolean {
	const finalGoalId = input.deferredGoal.completionVerification?.validationBatch?.finalGoalId;
	const finalGoal = finalGoalId ? input.plan.goals.find(goal => goal.id === finalGoalId) : undefined;
	if (finalGoal?.status !== "superseded") return false;
	const replacements = input.plan.goals.filter(
		goal =>
			goal.status === "complete" &&
			goal.steering?.kind === "review_blocker" &&
			goal.steering.blockedGoalId === finalGoal.id,
	);
	if (replacements.length !== 1) return false;
	const replacement = replacements[0]!;
	const receipt = replacement.completionVerification;
	if (receipt?.receiptKind !== "per-goal") return false;
	return (
		validateCompletionReceipt({
			plan: input.plan,
			ledger: input.ledger,
			goal: replacement,
			receiptKind: "per-goal",
		}).state === "active_verified_complete"
	);
}

export function validateCompletionReceipt(input: {
	plan: UltragoalPlan;
	ledger: readonly UltragoalLedgerEvent[];
	goal: UltragoalGoal;
	receiptKind: UltragoalReceiptKind;
}): UltragoalGuardDiagnostic {
	const receipt = input.goal.completionVerification;
	if (!receipt) {
		return {
			state: input.receiptKind === "final-aggregate" ? "active_missing_final_receipt" : "active_missing_receipt",
			message: `Ultragoal ${input.goal.id} has no ${input.receiptKind} completion verification receipt.`,
			goalId: input.goal.id,
		};
	}
	if (input.receiptKind === "final-aggregate") {
		const checkpointEvent = findLedgerReceiptEvent(input.ledger, receipt);
		if (checkpointEvent) {
			const qualityGate =
				typeof checkpointEvent.qualityGateJson === "object" &&
				checkpointEvent.qualityGateJson !== null &&
				!Array.isArray(checkpointEvent.qualityGateJson)
					? (checkpointEvent.qualityGateJson as Record<string, unknown>)
					: undefined;
			const criticReview =
				qualityGate &&
				typeof qualityGate.criticReview === "object" &&
				qualityGate.criticReview !== null &&
				!Array.isArray(qualityGate.criticReview)
					? (qualityGate.criticReview as Record<string, unknown>)
					: undefined;
			if (criticReview?.verdict !== "OKAY") {
				return {
					state: "active_missing_critic_verdict",
					message: `Ultragoal ${input.goal.id} final aggregate receipt checkpoint requires criticReview with verdict OKAY.`,
					goalId: input.goal.id,
				};
			}
		}
	}
	if (receipt.validationBatch?.role === "deferred-member") {
		return validateDeferredMemberReceiptFresh({
			plan: input.plan,
			ledger: input.ledger,
			goal: input.goal,
			receipt,
			receiptKind: input.receiptKind,
			requireClose: true,
		});
	}
	const baseDiagnostic = validateReceiptFreshBase({
		plan: input.plan,
		ledger: input.ledger,
		goal: input.goal,
		receipt,
		receiptKind: input.receiptKind,
	});
	if (baseDiagnostic) return baseDiagnostic;
	if (input.receiptKind === "final-aggregate") {
		if (terminalCriticCeilingReached(input.ledger) && !terminalCriticGateOverridden(input.ledger)) {
			return {
				state: "active_stale_receipt",
				message: `Ultragoal ${input.goal.id} final aggregate receipt is stale because the terminal-critic ceiling is currently reached.`,
				goalId: input.goal.id,
			};
		}
	}
	if (receipt.validationBatch?.role === "batch-close") {
		for (const memberId of receipt.validationBatch.memberIds) {
			const member = input.plan.goals.find(goal => goal.id === memberId);
			if (
				!member?.validationBatch ||
				member.validationBatch.metadataHash !== receipt.validationBatch.memberMetadataHashes[memberId]
			) {
				return {
					state: "active_stale_receipt",
					message: `Ultragoal ${input.goal.id} batch-close receipt has stale member metadata for ${memberId}.`,
					goalId: input.goal.id,
				};
			}
			if (memberId === receipt.validationBatch.finalGoalId) continue;
			const memberReceipt = member.completionVerification;
			if (memberReceipt?.validationBatch?.role !== "deferred-member") {
				return {
					state: "active_missing_final_receipt",
					message: `Ultragoal ${input.goal.id} batch-close receipt requires deferred member receipt for ${memberId}.`,
					goalId: input.goal.id,
				};
			}
			const memberDiagnostic = validateDeferredMemberReceiptFresh({
				plan: input.plan,
				ledger: input.ledger,
				goal: member,
				receipt: memberReceipt,
				receiptKind: "per-goal",
				requireClose: false,
			});
			if (memberDiagnostic.state !== "active_verified_complete") return memberDiagnostic;
			if (
				receipt.validationBatch.memberReceiptIds[memberId] !== memberReceipt.receiptId ||
				receipt.validationBatch.memberChangeSetHashes[memberId] !== memberReceipt.validationBatch.changeSetHash
			) {
				return {
					state: "active_stale_receipt",
					message: `Ultragoal ${input.goal.id} batch-close receipt is stale for deferred member ${memberId}.`,
					goalId: input.goal.id,
				};
			}
		}
	}
	if (input.receiptKind === "final-aggregate") {
		const incomplete = requiredGoals(input.plan).filter(goal => goal.status !== "complete");
		if (incomplete.length > 0) {
			return {
				state: "active_missing_final_receipt",
				message: `Ultragoal final receipt is not valid while required goals remain incomplete: ${incomplete.map(goal => goal.id).join(", ")}.`,
				goalId: input.goal.id,
			};
		}
		for (const priorGoal of requiredGoals(input.plan)) {
			if (priorGoal.id === input.goal.id) continue;
			if (!priorGoal.completionVerification) {
				return {
					state: "active_missing_receipt",
					message: `Ultragoal final receipt is missing per-goal evidence for: ${priorGoal.id}.`,
					goalId: input.goal.id,
				};
			}
			if (
				priorGoal.completionVerification.validationBatch?.role !== "deferred-member" &&
				priorGoal.completionVerification.receiptKind === "final-aggregate"
			) {
				// A prior goal may hold the run's previous final-aggregate receipt
				// when plan growth staled it and a later checkpoint re-minted the
				// aggregate receipt. Accept it as historical evidence for its own
				// goal instead of demanding an impossible per-goal receipt.
				const supersededDiagnostic = validateSupersededFinalAggregateReceipt({
					ledger: input.ledger,
					goal: priorGoal,
					receipt: priorGoal.completionVerification,
				});
				if (supersededDiagnostic) {
					return {
						state: supersededDiagnostic.state,
						message: `Ultragoal final receipt requires valid historical evidence for ${priorGoal.id}: ${supersededDiagnostic.message}`,
						goalId: input.goal.id,
					};
				}
				continue;
			}
			const priorDiagnostic =
				priorGoal.completionVerification.validationBatch?.role === "deferred-member"
					? validateDeferredMemberReceiptFresh({
							plan: input.plan,
							ledger: input.ledger,
							goal: priorGoal,
							receipt: priorGoal.completionVerification,
							receiptKind: "per-goal",
							requireClose: !hasFreshReviewedBatchFinalReplacement({
								plan: input.plan,
								ledger: input.ledger,
								deferredGoal: priorGoal,
							}),
						})
					: validateCompletionReceipt({
							plan: input.plan,
							ledger: input.ledger,
							goal: priorGoal,
							receiptKind: "per-goal",
						});
			if (priorDiagnostic.state !== "active_verified_complete") {
				return {
					state: priorDiagnostic.state,
					message: `Ultragoal final receipt requires a valid per-goal receipt for ${priorGoal.id}: ${priorDiagnostic.message}`,
					goalId: input.goal.id,
				};
			}
		}
	}
	return {
		state: "active_verified_complete",
		message: `Ultragoal ${input.goal.id} has a fresh ${input.receiptKind} receipt.`,
		goalId: input.goal.id,
	};
}
