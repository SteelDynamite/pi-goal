import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "./src/pi-types.ts";
import type { Message } from "@earendil-works/pi-ai";
import {
	buildContinuationPrompt,
	buildEvaluatorCompleteOptions,
	buildEvaluatorPrompt,
	buildEvaluatorSystemPrompt,
	buildGoalContext,
	clearGoal,
	createActiveGoal,
	extractEvaluatorText,
	formatGoalStatus,
	GOAL_CONTEXT_MESSAGE,
	GOAL_EVALUATION_MESSAGE,
	GOAL_STATE_ENTRY,
	GOAL_STATUS_MESSAGE,
	hasGoalContextMessage,
	hasReachedMaxEvaluations,
	isOrchestratedChild,
	latestGoalState,
	parseEvaluatorResponse,
	parseGoalArgs,
	updateAfterMetEvaluation,
	updateAfterUnmetEvaluation,
	type EvaluatorResult,
	type GoalState,
} from "./src/core.ts";

export default function goalExtension(pi: ExtensionAPI): void {
	let state: GoalState | undefined;
	let evaluating = false;
	const disabledInOrchestratedChild = isOrchestratedChild();

	function branchState(ctx: ExtensionContext): GoalState | undefined {
		return latestGoalState(ctx.sessionManager.getBranch());
	}

	function persist(next: GoalState | undefined, ctx?: ExtensionContext): void {
		state = next;
		if (next) pi.appendEntry(GOAL_STATE_ENTRY, next);
		if (ctx) updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (disabledInOrchestratedChild) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		if (state?.status === "active") {
			ctx.ui.setStatus("goal", `◎ /goal active ${state.evaluatedTurns}/${state.maxEvaluations}`);
		} else {
			ctx.ui.setStatus("goal", undefined);
		}
	}

	function goalContextMessage(goal: GoalState) {
		return {
			customType: GOAL_CONTEXT_MESSAGE,
			content: buildGoalContext(goal),
			display: true,
			details: { goalStartedAt: goal.startedAt },
		};
	}

	function showStatus(ctx: ExtensionContext): void {
		pi.sendMessage(
			{
				customType: GOAL_STATUS_MESSAGE,
				content: formatGoalStatus(state ?? branchState(ctx)),
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	function evaluationEntry(content: string): SessionBoundaryDraft {
		return { type: "custom_message", customType: GOAL_EVALUATION_MESSAGE, content, display: true };
	}

	function stopWithReason(reason: string, ctx: ExtensionContext): SessionBoundaryDraft {
		persist(clearGoal(state, reason), ctx);
		return evaluationEntry(`Goal stopped: ${reason}`);
	}

	async function evaluateGoal(ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<EvaluatorResult> {
		if (!state) throw new Error("No active goal");
		if (!ctx.model) throw new Error("No current model is selected");
		const prompt = buildEvaluatorPrompt(state, ctx.sessionManager.getBranch());
		const userMessage: Message = {
			role: "user",
			content: prompt,
			timestamp: Date.now(),
		};
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{
				systemPrompt: buildEvaluatorSystemPrompt(),
				messages: [userMessage],
			},
			buildEvaluatorCompleteOptions(signal, ctx.sessionManager.getSessionId()),
		);
		return parseEvaluatorResponse(extractEvaluatorText(response));
	}

	pi.registerCommand("goal", {
		description: "Set, show, or clear a session goal that auto-continues until met",
		handler: async (args, ctx) => {
			if (disabledInOrchestratedChild) {
				pi.sendMessage(
					{
						customType: GOAL_STATUS_MESSAGE,
						content: "/goal is disabled in orchestrated child sessions.",
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			const parsed = parseGoalArgs(args);
			if (parsed.action === "status") {
				showStatus(ctx);
				return;
			}

			if (parsed.action === "clear") {
				const current = state ?? branchState(ctx);
				if (current?.status === "active") persist(clearGoal(current), ctx);
				showStatus(ctx);
				return;
			}

			const next = createActiveGoal(parsed.condition);
			persist(next, ctx);
			pi.sendMessage(goalContextMessage(next), { triggerTurn: false });
			pi.sendUserMessage(buildContinuationPrompt(next), { deliverAs: "followUp" });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state = disabledInOrchestratedChild ? undefined : branchState(ctx);
		if (state?.status !== "active") state = state?.status === "achieved" || state?.status === "cleared" ? state : undefined;
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (disabledInOrchestratedChild || state?.status !== "active") return;
		if (hasGoalContextMessage(state, ctx.sessionManager.buildSessionProjection().messages)) return;
		return { message: goalContextMessage(state) };
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (disabledInOrchestratedChild || state?.status !== "active") return;
		if (hasGoalContextMessage(state, ctx.sessionManager.buildSessionProjection().messages)) return;
		// Pi queues this into an active run, but only appends it while idle; omitting triggerTurn never starts a run.
		pi.sendMessage(goalContextMessage(state), { deliverAs: "steer" });
	});

	pi.on("turn_end", async (event, ctx) => {
		if (
			disabledInOrchestratedChild ||
			evaluating ||
			state?.status !== "active" ||
			event.outcome !== "completed" ||
			event.message.role !== "assistant" ||
			event.message.stopReason === "toolUse" ||
			ctx.hasPendingMessages()
		) {
			return;
		}
		const evaluatedGoal = state;
		const evaluationSignal = ctx.signal;
		evaluating = true;
		try {
			const result = await evaluateGoal(ctx, evaluationSignal);
			if (evaluationSignal?.aborted || state !== evaluatedGoal || state.status !== "active") return;
			if (result.met) {
				persist(updateAfterMetEvaluation(state, result), ctx);
				return { entries: [...event.entries, evaluationEntry(`Goal achieved: ${result.reason}`)] };
			}

			const next = updateAfterUnmetEvaluation(state, result);
			persist(next, ctx);
			if (hasReachedMaxEvaluations(next)) {
				return { entries: [...event.entries, stopWithReason(`maximum evaluated turns reached (${next.maxEvaluations})`, ctx)] };
			}
			return {
				entries: [...event.entries, evaluationEntry(buildContinuationPrompt(next))],
				continue: true,
			};
		} catch (error) {
			if (evaluationSignal?.aborted || state !== evaluatedGoal || state?.status !== "active") return;
			const message = error instanceof Error ? error.message : String(error);
			return { entries: [...event.entries, stopWithReason(`evaluator error: ${message}`, ctx)] };
		} finally {
			evaluating = false;
		}
	});

	pi.on("session_shutdown", async () => {
		evaluating = false;
	});
}

export const __test__ = {
	parseGoalArgs,
	parseEvaluatorResponse,
	extractEvaluatorText,
	buildEvaluatorPrompt,
	formatGoalStatus,
	createActiveGoal,
	clearGoal,
	isOrchestratedChild,
};
