import assert from "node:assert/strict";
import test from "node:test";
import goalExtension from "../index.ts";
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
	GOAL_CONTEXT_MESSAGE,
	GOAL_CONTINUATION_PREFIX,
	GOAL_EVALUATION_MESSAGE,
	GOAL_STATE_ENTRY,
	GOAL_STATUS_MESSAGE,
	hasGoalContextMessage,
	isOrchestratedChild,
	latestGoalState,
	parseEvaluatorResponse,
	parseGoalArgs,
	parseMaxEvaluations,
	serializeTranscript,
	updateAfterMetEvaluation,
	updateAfterUnmetEvaluation,
} from "../src/core.ts";

function registerGoalExtension(pi: any): void {
	const childMarker = process.env.PI_ORCHESTRATED_CHILD;
	delete process.env.PI_ORCHESTRATED_CHILD;
	try {
		goalExtension(pi);
	} finally {
		if (childMarker === undefined) delete process.env.PI_ORCHESTRATED_CHILD;
		else process.env.PI_ORCHESTRATED_CHILD = childMarker;
	}
}

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

test("buildEvaluatorCompleteOptions uses distinct short-lived cache affinity", () => {
	const options = buildEvaluatorCompleteOptions(undefined, "session-1");
	assert.equal(options.maxTokens, EVALUATOR_MAX_TOKENS);
	assert.equal(options.cacheRetention, "short");
	assert.equal(options.sessionId, "session-1:pi-goal-evaluator");
	assert.equal("apiKey" in options, false);
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

test("transcript serialization omits system entries and retains valid evidence roles", () => {
	const entries = [
		{ type: "message", message: { role: "system", content: "system prompt", sections: { preamble: "ignored" }, timestamp: 0 } },
		{ type: "message", message: { role: "system", content: [{ type: "text", text: "system update" }], timestamp: 0 } },
		{ type: "message", message: { role: "unknown", content: [{ type: "text", text: "unknown content" }], timestamp: 0 } },
		{ type: "message", message: { role: "user", content: `${GOAL_CONTINUATION_PREFIX}\nnot evidence`, timestamp: 1 } },
		{ type: "message", message: { role: "user", content: "run tests", timestamp: 1 } },
		{
			type: "message",
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
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "10 passing" }],
				isError: false,
				timestamp: 3,
			},
		},
	] as any[];
	const state = createActiveGoal("tests pass", 1);
	assert.doesNotThrow(() => buildEvaluatorPrompt(state, entries));
	const full = serializeTranscript(entries, 1000);
	assert.doesNotMatch(full, /system prompt|system update|unknown content|not evidence/);
	assert.match(full, /user: run tests/);
	assert.match(full, /assistant: npm test exits 0/);
	assert.match(full, /toolResult: 10 passing/);
});

test("transcript serialization excludes supervisor messages and keeps head and tail", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "anchor", timestamp: 1 } },
		{ type: "message", message: { role: "user", content: `middle-${"x".repeat(200)}`, timestamp: 2 } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "tail evidence" }], stopReason: "stop" } },
		{ type: "custom_message", customType: GOAL_CONTEXT_MESSAGE, content: "goal context" },
		{ type: "custom_message", customType: GOAL_EVALUATION_MESSAGE, content: "not evidence" },
		{ type: "custom_message", customType: GOAL_STATUS_MESSAGE, content: "status" },
	] as any[];
	const text = serializeTranscript(entries, 130);
	assert.equal(text.length, 130);
	assert.match(text, /^user: anchor/);
	assert.match(text, /assistant: tail evidence$/);
	assert.match(text, /truncated/);
	assert.doesNotMatch(text, /goal context|not evidence|status/);

	const oversizedTail = serializeTranscript(
		[
			{ type: "message", message: { role: "user", content: "head", timestamp: 1 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: `latest-${"z".repeat(300)}` }] } },
		] as any[],
		100,
	);
	assert.equal(oversizedTail.length, 100);
	assert.match(oversizedTail, /^user: head/);
	assert.match(oversizedTail, /z{20}$/);
});

test("goal context is immutable while continuation carries evaluator guidance", () => {
	const state = updateAfterUnmetEvaluation(createActiveGoal("tests pass", 1), { met: false, reason: "no proof" }, 2);
	assert.match(buildGoalContext(state), /tests pass/);
	assert.doesNotMatch(buildGoalContext(state), /no proof/);
	assert.match(buildContinuationPrompt(state), /no proof/);
	assert.doesNotMatch(buildEvaluatorPrompt(state, []), /Previous evaluator reason|no proof/);
	assert.match(buildEvaluatorPrompt(state, []), /Transcript evidence/);
	assert.match(formatGoalStatus(state, 3000), /Evaluated turns: 1/);
});

test("goal context markers identify one activation", () => {
	const state = createActiveGoal("tests pass", 100);
	const marker = {
		role: "custom",
		customType: GOAL_CONTEXT_MESSAGE,
		content: buildGoalContext(state),
		details: { goalStartedAt: 100 },
	} as const;
	assert.equal(hasGoalContextMessage(state, [marker]), true);
	assert.equal(hasGoalContextMessage(createActiveGoal("different goal", 100), [marker]), false);
	assert.equal(hasGoalContextMessage(createActiveGoal("tests pass", 101), [marker]), false);
});

test("extension uses turn boundaries for atomic continuation", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	const entries: any[] = [];
	const sent: Array<{ message: any; options: any }> = [];
	const continuations: Array<{ content: string; options: any }> = [];
	const completions: Array<{ context: any; options: any }> = [];
	const evaluatorResponses = [
		'{"met":false,"reason":"missing proof","continuation":"run tests"}',
		'{"met":false,"reason":"still missing proof","continuation":"show output"}',
		'{"met":true,"reason":"tests passed"}',
	];
	let projectionMessages: any[] = [];
	const pi = {
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
			entries.push({ type: "custom_message", ...message });
			if (message.customType === GOAL_CONTEXT_MESSAGE) projectionMessages.push({ role: "custom", ...message });
		},
		sendUserMessage(content: string, options: any) {
			continuations.push({ content, options });
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	};
	const ctx = {
		model: { api: "test", provider: "test", id: "test" },
		signal: new AbortController().signal,
		hasPendingMessages: () => false,
		modelRegistry: {
			async complete(_model: unknown, context: unknown, options: unknown) {
				completions.push({ context, options });
				return { content: [{ type: "text", text: evaluatorResponses.shift() }], stopReason: "stop" };
			},
		},
		sessionManager: {
			getBranch: () => entries,
			buildSessionProjection: () => ({ messages: projectionMessages }),
			getSessionId: () => "session-1",
		},
		ui: { setStatus() {} },
	};
	registerGoalExtension(pi);
	await handlers.get("session_start")?.({}, ctx);
	await commands.get("goal")?.("tests pass", ctx);
	assert.equal(sent.filter(({ message }) => message.customType === GOAL_CONTEXT_MESSAGE).length, 1);
	assert.deepEqual(sent[0].options, { triggerTurn: false });
	assert.equal(continuations[0].content.startsWith(GOAL_CONTINUATION_PREFIX), true);
	assert.deepEqual(continuations[0].options, { deliverAs: "followUp" });
	assert.equal(await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx), undefined);

	assert.equal(handlers.has("agent_end"), false);
	await handlers.get("turn_end")?.({ outcome: "aborted", message: { role: "assistant", stopReason: "aborted" }, entries: [] }, ctx);
	assert.equal(completions.length, 0);
	assert.equal(latestGoalState(entries)?.status, "active");

	projectionMessages = [];
	const evaluated = await handlers.get("turn_end")?.({ outcome: "completed", message: { role: "assistant", stopReason: "stop" }, entries: [] }, ctx);
	assert.equal(evaluated.continue, true);
	assert.equal(evaluated.entries.length, 1);
	assert.equal(evaluated.entries[0].customType, GOAL_EVALUATION_MESSAGE);
	assert.equal(evaluated.entries[0].content.startsWith(GOAL_CONTINUATION_PREFIX), true);
	assert.equal(completions.length, 1);
	assert.equal(completions[0].options.signal, ctx.signal);
	assert.equal(completions[0].options.cacheRetention, "short");
	assert.equal(latestGoalState(entries)?.evaluatedTurns, 1);
	assert.equal(continuations.length, 1);
	assert.equal(handlers.has("agent_before_settle"), false);

	const marker = { role: "custom", ...sent[0].message };
	projectionMessages = [marker];
	const continued = await handlers.get("turn_end")?.({ outcome: "completed", message: { role: "assistant", stopReason: "stop" }, entries: [] }, ctx);
	assert.equal(continued.continue, true);
	assert.equal(continued.entries[0].content.startsWith(GOAL_CONTINUATION_PREFIX), true);
	assert.equal(completions.length, 2);
	assert.equal(latestGoalState(entries)?.evaluatedTurns, 2);
	assert.equal(continuations.length, 1);

	projectionMessages = [];
	const restored = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
	assert.equal(restored.message.customType, GOAL_CONTEXT_MESSAGE);
	projectionMessages = [{ role: "custom", ...restored.message }];
	const achieved = await handlers.get("turn_end")?.({ outcome: "completed", message: { role: "assistant", stopReason: "stop" }, entries: [] }, ctx);
	assert.equal(achieved.continue, undefined);
	assert.equal(achieved.entries.length, 1);
	assert.equal(achieved.entries[0].customType, GOAL_EVALUATION_MESSAGE);
	assert.equal(achieved.entries.some((entry: any) => entry.customType === GOAL_CONTEXT_MESSAGE), false);
	assert.equal(completions.length, 3);
	assert.equal(continuations.length, 1);
	assert.equal(latestGoalState(entries)?.status, "achieved");
});

test("evaluator abort preserves active state and remains resumable", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	const entries: any[] = [];
	const controller = new AbortController();
	let evaluatorStarted!: () => void;
	const started = new Promise<void>((resolve) => (evaluatorStarted = resolve));
	let completionCount = 0;
	const pi = {
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: any) {
			entries.push({ type: "custom_message", ...message });
		},
		sendUserMessage() {},
		registerCommand(name: string, command: any) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	};
	const ctx: any = {
		model: { api: "test", provider: "test", id: "test" },
		signal: controller.signal,
		hasPendingMessages: () => false,
		modelRegistry: {
			async complete(_model: unknown, _context: unknown, options: any) {
				completionCount++;
				if (completionCount > 1) return { content: [{ type: "text", text: '{"met":true,"reason":"done"}' }], stopReason: "stop" };
				evaluatorStarted();
				return await new Promise((_, reject) => {
					options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
				});
			},
		},
		sessionManager: {
			getBranch: () => entries,
			buildSessionProjection: () => ({ messages: [] }),
			getSessionId: () => "session-abort",
		},
		ui: { setStatus() {} },
	};
	registerGoalExtension(pi);
	await handlers.get("session_start")?.({}, ctx);
	await commands.get("goal")?.("finish safely", ctx);

	const evaluation = handlers
		.get("turn_end")
		?.({ outcome: "completed", message: { role: "assistant", stopReason: "stop" }, entries: [] }, ctx);
	await started;
	controller.abort();
	assert.equal(await evaluation, undefined);
	assert.equal(latestGoalState(entries)?.status, "active");
	assert.equal(latestGoalState(entries)?.evaluatedTurns, 0);
	assert.equal(entries.some((entry) => entry.customType === GOAL_EVALUATION_MESSAGE), false);

	ctx.signal = new AbortController().signal;
	const resumed = await handlers
		.get("turn_end")
		?.({ outcome: "completed", message: { role: "assistant", stopReason: "stop" }, entries: [] }, ctx);
	assert.equal(resumed.entries[0].customType, GOAL_EVALUATION_MESSAGE);
	assert.equal(latestGoalState(entries)?.status, "achieved");
});

test("boundary continuation cannot escape through delayed input after clear", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	const entries: any[] = [];
	let sendUserCalls = 0;
	let releaseInput!: () => void;
	const inputGate = new Promise<void>((resolve) => (releaseInput = resolve));
	const escapedInputs: string[] = [];
	const pi = {
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: any) {
			entries.push({ type: "custom_message", ...message });
		},
		sendUserMessage(content: string) {
			sendUserCalls++;
			if (sendUserCalls > 1) void inputGate.then(() => escapedInputs.push(content));
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	};
	const ctx = {
		model: { api: "test", provider: "test", id: "test" },
		signal: new AbortController().signal,
		hasPendingMessages: () => false,
		modelRegistry: {
			async complete() {
				return { content: [{ type: "text", text: '{"met":false,"reason":"missing","continuation":"keep going"}' }], stopReason: "stop" };
			},
		},
		sessionManager: {
			getBranch: () => entries,
			buildSessionProjection: () => ({ messages: [] }),
			getSessionId: () => "session-race",
		},
		ui: { setStatus() {} },
	};
	registerGoalExtension(pi);
	await handlers.get("session_start")?.({}, ctx);
	await commands.get("goal")?.("finish safely", ctx);
	const boundary = await handlers
		.get("turn_end")
		?.({ outcome: "completed", message: { role: "assistant", stopReason: "stop" }, entries: [] }, ctx);
	assert.equal(boundary.continue, true);
	assert.equal(boundary.entries[0].content.startsWith(GOAL_CONTINUATION_PREFIX), true);

	await handlers
		.get("agent_before_settle")
		?.({ outcome: "completed", entries: [], context: { contextMessages: [], pendingMessages: [] } }, ctx);
	await commands.get("goal")?.("clear", ctx);
	releaseInput();
	await inputGate;
	await Promise.resolve();
	assert.equal(sendUserCalls, 1);
	assert.deepEqual(escapedInputs, []);
	assert.equal(latestGoalState(entries)?.status, "cleared");
});

test("tool-turn compaction restores one context marker before the next request", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	const entries: any[] = [];
	const sent: Array<{ message: any; options: any }> = [];
	const queuedCustomMessages: any[] = [];
	const userMessages: string[] = [];
	let projectionMessages: any[] = [];
	let streaming = false;
	let completionCount = 0;
	const pi = {
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
			const contextMessage = { role: "custom", ...message };
			if (streaming && options?.deliverAs === "steer") {
				queuedCustomMessages.push(contextMessage);
				return;
			}
			entries.push({ type: "custom_message", ...message });
			projectionMessages.push(contextMessage);
		},
		sendUserMessage(content: string) {
			userMessages.push(content);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	};
	const ctx = {
		model: { api: "test", provider: "test", id: "test" },
		signal: new AbortController().signal,
		hasPendingMessages: () => false,
		modelRegistry: {
			async complete() {
				completionCount++;
				return { content: [{ type: "text", text: '{"met":true,"reason":"done"}' }], stopReason: "stop" };
			},
		},
		sessionManager: {
			getBranch: () => entries,
			buildSessionProjection: () => ({ messages: projectionMessages }),
			getSessionId: () => "session-compact",
		},
		ui: { setStatus() {} },
	};
	registerGoalExtension(pi);
	await handlers.get("session_start")?.({}, ctx);
	await commands.get("goal")?.("tool work completes", ctx);
	streaming = true;

	const toolTurn = await handlers.get("turn_end")?.(
		{ outcome: "completed", message: { role: "assistant", stopReason: "toolUse" }, entries: [] },
		ctx,
	);
	assert.equal(toolTurn, undefined);
	assert.equal(completionCount, 0);

	projectionMessages = [{ role: "compactionSummary", summary: "tool call and result retained" }];
	await handlers.get("session_compact")?.({ reason: "threshold", willRetry: false }, ctx);
	assert.equal(queuedCustomMessages.length, 1);
	assert.equal(queuedCustomMessages[0].customType, GOAL_CONTEXT_MESSAGE);
	assert.deepEqual(sent.at(-1)?.options, { deliverAs: "steer" });
	assert.equal(userMessages.length, 1);

	const nextRequestMessages = [...projectionMessages, ...queuedCustomMessages];
	const goal = latestGoalState(entries);
	assert.equal(goal?.status, "active");
	assert.equal(hasGoalContextMessage(goal!, nextRequestMessages), true);

	projectionMessages = nextRequestMessages;
	queuedCustomMessages.length = 0;
	await handlers.get("session_compact")?.({ reason: "threshold", willRetry: false }, ctx);
	assert.equal(sent.filter(({ message }) => message.customType === GOAL_CONTEXT_MESSAGE).length, 2);
	assert.equal(queuedCustomMessages.length, 0);
});

test("isOrchestratedChild recognizes only PI_ORCHESTRATED_CHILD=1", () => {
	assert.equal(isOrchestratedChild({}), false);
	assert.equal(isOrchestratedChild({ PI_ORCHESTRATED_CHILD: "1" }), true);
	assert.equal(isOrchestratedChild({ PI_ORCHESTRATED_CHILD: "0" }), false);
});
