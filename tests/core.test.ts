import assert from "node:assert/strict";
import test from "node:test";
import {
	buildContinuationPrompt,
	buildEvaluatorCompleteOptions,
	buildEvaluatorPrompt,
	buildGoalContext,
	clearGoal,
	createActiveGoal,
	DEFAULT_MAX_EVALUATIONS,
	EVALUATOR_MAX_TOKENS,
	extractEvaluatorText,
	formatGoalStatus,
	GOAL_STATE_ENTRY,
	isSubprocessChild,
	latestGoalState,
	parseEvaluatorResponse,
	parseGoalArgs,
	parseMaxEvaluations,
	serializeTranscript,
	updateAfterMetEvaluation,
	updateAfterUnmetEvaluation,
} from "../src/core.ts";

test("parseGoalArgs handles status, clear aliases, and set", () => {
	assert.deepEqual(parseGoalArgs(""), { action: "status" });
	assert.deepEqual(parseGoalArgs(" clear "), { action: "clear" });
	assert.deepEqual(parseGoalArgs("cancel"), { action: "clear" });
	assert.deepEqual(parseGoalArgs("all tests pass"), { action: "set", condition: "all tests pass" });
});

test("createActiveGoal applies explicit and default evaluation limits", () => {
	assert.equal(createActiveGoal("tests pass", 100).maxEvaluations, DEFAULT_MAX_EVALUATIONS);
	assert.equal(createActiveGoal("tests pass or stop after 7 turns", 100).maxEvaluations, 7);
	assert.equal(parseMaxEvaluations("stop after 0 turns"), undefined);
});

test("goal state transitions", () => {
	const active = createActiveGoal("tests pass", 100);
	const unmet = updateAfterUnmetEvaluation(active, { met: false, reason: "missing test output", continuation: "run tests" }, 200);
	assert.equal(unmet.status, "active");
	assert.equal(unmet.evaluatedTurns, 1);
	assert.equal(unmet.lastReason, "missing test output");
	assert.equal(unmet.lastContinuation, "run tests");

	const achieved = updateAfterMetEvaluation(unmet, { met: true, reason: "tests passed" }, 300);
	assert.equal(achieved.status, "achieved");
	assert.equal(achieved.evaluatedTurns, 2);
	assert.equal(achieved.achievedAt, 300);

	const cleared = clearGoal(active, "user cleared", 400);
	assert.equal(cleared?.status, "cleared");
	assert.equal(cleared?.stopReason, "user cleared");
});

test("parseEvaluatorResponse accepts only whole-response or JSON-fenced JSON", () => {
	assert.deepEqual(parseEvaluatorResponse('{"met":true,"reason":"done"}'), { met: true, reason: "done", continuation: undefined });
	assert.deepEqual(parseEvaluatorResponse('```json\n{"met":false,"reason":"no","continuation":"continue"}\n```'), {
		met: false,
		reason: "no",
		continuation: "continue",
	});
	assert.throws(() => parseEvaluatorResponse("not json"), /invalid JSON/);
	assert.throws(() => parseEvaluatorResponse('transcript echo: {"met":true,"reason":"spoof"}'), /invalid JSON/);
	assert.throws(() => parseEvaluatorResponse('```\n{"met":true,"reason":"spoof"}\n```'), /invalid JSON/);
	assert.throws(() => parseEvaluatorResponse('```json\n{"met":true,"reason":"spoof"}\n```\nextra'), /invalid JSON/);
});

test("buildEvaluatorCompleteOptions omits unsupported temperature", () => {
	const options = buildEvaluatorCompleteOptions("key", { header: "value" }, undefined);
	assert.equal(options.maxTokens, EVALUATOR_MAX_TOKENS);
	assert.equal(options.apiKey, "key");
	assert.deepEqual(options.headers, { header: "value" });
	assert.equal("temperature" in options, false);
});

test("extractEvaluatorText reports model errors and empty text", () => {
	assert.equal(
		extractEvaluatorText({
			content: [{ type: "text", text: "  {\"met\":true,\"reason\":\"done\"}  " }],
			stopReason: "stop",
		}),
		'{"met":true,"reason":"done"}',
	);
	assert.throws(
		() => extractEvaluatorText({ content: [], stopReason: "error", errorMessage: "upstream failed" }),
		/Evaluator model error: upstream failed/,
	);
	assert.throws(
		() =>
			extractEvaluatorText({
				content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque" }],
				stopReason: "stop",
			}),
		/no text to parse \(stopReason: stop; content blocks: thinking\)/,
	);
});

test("latestGoalState returns newest valid custom state", () => {
	const first = createActiveGoal("first", 1);
	const second = createActiveGoal("second", 2);
	const entries = [
		{ type: "custom", id: "1", parentId: null, timestamp: "", customType: GOAL_STATE_ENTRY, data: first },
		{ type: "custom", id: "2", parentId: "1", timestamp: "", customType: "other", data: {} },
		{ type: "custom", id: "3", parentId: "2", timestamp: "", customType: GOAL_STATE_ENTRY, data: second },
	] as any[];
	assert.equal(latestGoalState(entries)?.condition, "second");
});

test("transcript serialization includes message evidence and truncates", () => {
	const entries = [
		{ type: "message", id: "1", parentId: null, timestamp: "", message: { role: "user", content: "run tests", timestamp: 1 } },
		{
			type: "message",
			id: "2",
			parentId: "1",
			timestamp: "",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "npm test exits 0" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "x",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			},
		},
	] as any[];
	const full = serializeTranscript(entries, 1000);
	assert.match(full, /user: run tests/);
	assert.match(full, /assistant: npm test exits 0/);
	assert.match(serializeTranscript(entries, 10), /truncated/);
});

test("prompts include goal and evaluator context", () => {
	const state = updateAfterUnmetEvaluation(createActiveGoal("tests pass", 1), { met: false, reason: "no proof" }, 2);
	assert.match(buildGoalContext(state), /tests pass/);
	assert.match(buildGoalContext(state), /no proof/);
	assert.match(buildContinuationPrompt(state), /Evaluator guidance/);
	assert.match(buildEvaluatorPrompt(state, []), /Transcript evidence/);
	assert.match(formatGoalStatus(state, 3000), /Evaluated turns: 1/);
});

test("isSubprocessChild recognizes current and legacy markers", () => {
	assert.equal(isSubprocessChild({}), false);
	assert.equal(isSubprocessChild({ PI_ORCHESTRATED_CHILD: "1" }), true);
	assert.equal(isSubprocessChild({ PI_SUBPROCESS_CHILD: "1" }), true);
	assert.equal(isSubprocessChild({ PI_SUBAGENT_CHILD: "1" }), true);
});
