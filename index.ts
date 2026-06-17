import type { ExtensionAPI, ExtensionContext } from "./src/pi-types.ts";
import { complete, type Message } from "@earendil-works/pi-ai";
import {
	buildContinuationPrompt,
	buildEvaluatorCompleteOptions,
	buildEvaluatorPrompt,
	buildEvaluatorSystemPrompt,
	buildGoalContext,
	buildInitialGoalPrompt,
	clearGoal,
	createActiveGoal,
	extractEvaluatorText,
	formatGoalStatus,
	GOAL_EVALUATION_MESSAGE,
	GOAL_STATE_ENTRY,
	GOAL_STATUS_MESSAGE,
	hasReachedMaxEvaluations,
	isSubprocessChild,
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
	const disabledInChild = isSubprocessChild();

	function branchState(ctx: ExtensionContext): GoalState | undefined {
		return latestGoalState(ctx.sessionManager.getBranch());
	}

	function persist(next: GoalState | undefined, ctx?: ExtensionContext): void {
		state = next;
		if (next) pi.appendEntry(GOAL_STATE_ENTRY, next);
		if (ctx) updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (disabledInChild) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		if (state?.status === "active") {
			ctx.ui.setStatus("goal", `◎ /goal active ${state.evaluatedTurns}/${state.maxEvaluations}`);
		} else {
			ctx.ui.setStatus("goal", undefined);
		}
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

	function stopWithReason(reason: string, ctx: ExtensionContext): void {
		const stopped = clearGoal(state, reason);
		persist(stopped, ctx);
		pi.sendMessage(
			{
				customType: GOAL_EVALUATION_MESSAGE,
				content: `Goal stopped: ${reason}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	async function evaluateGoal(ctx: ExtensionContext): Promise<EvaluatorResult> {
		if (!state) throw new Error("No active goal");
		if (!ctx.model) throw new Error("No current model is selected");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) throw new Error(auth.error);

		const prompt = buildEvaluatorPrompt(state, ctx.sessionManager.getBranch());
		const userMessage: Message = {
			role: "user",
			content: prompt,
			timestamp: Date.now(),
		};
		const response = await complete(
			ctx.model,
			{
				systemPrompt: buildEvaluatorSystemPrompt(),
				messages: [userMessage],
			},
			buildEvaluatorCompleteOptions(auth.apiKey, auth.headers, ctx.signal),
		);
		return parseEvaluatorResponse(extractEvaluatorText(response));
	}

	pi.registerCommand("goal", {
		description: "Set, show, or clear a session goal that auto-continues until met",
		handler: async (args, ctx) => {
			if (disabledInChild) {
				pi.sendMessage(
					{
						customType: GOAL_STATUS_MESSAGE,
						content: "/goal is disabled in subprocess child sessions.",
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
			pi.sendUserMessage(buildInitialGoalPrompt(parsed.condition));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state = disabledInChild ? undefined : branchState(ctx);
		if (state?.status !== "active") state = state?.status === "achieved" || state?.status === "cleared" ? state : undefined;
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (disabledInChild || state?.status !== "active") return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalContext(state)}`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (disabledInChild || evaluating || state?.status !== "active") return;
		const evaluatedGoal = state;
		evaluating = true;
		try {
			const result = await evaluateGoal(ctx);
			if (state !== evaluatedGoal || state.status !== "active") return;
			if (result.met) {
				persist(updateAfterMetEvaluation(state, result), ctx);
				pi.sendMessage(
					{
						customType: GOAL_EVALUATION_MESSAGE,
						content: `Goal achieved: ${result.reason}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			const next = updateAfterUnmetEvaluation(state, result);
			persist(next, ctx);
			pi.sendMessage(
				{
					customType: GOAL_EVALUATION_MESSAGE,
					content: `Goal not met: ${result.reason}`,
					display: true,
				},
				{ triggerTurn: false },
			);

			if (hasReachedMaxEvaluations(next)) {
				stopWithReason(`maximum evaluated turns reached (${next.maxEvaluations})`, ctx);
				return;
			}

			pi.sendUserMessage(buildContinuationPrompt(next), { deliverAs: "followUp" });
		} catch (error) {
			if (state !== evaluatedGoal || state?.status !== "active") return;
			const message = error instanceof Error ? error.message : String(error);
			stopWithReason(`evaluator error: ${message}`, ctx);
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
	isSubprocessChild,
};
