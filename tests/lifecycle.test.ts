import assert from "node:assert/strict";
import test from "node:test";
import goalExtension from "../index.ts";
import { clearGoal, createActiveGoal, GOAL_STATE_ENTRY, latestGoalState, updateAfterMetEvaluation } from "../src/core.ts";

function createHarness(child = false) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	const calls = {
		entries: [] as any[],
		sent: [] as any[],
		userMessages: [] as string[],
		completions: 0,
		status: undefined as string | undefined,
	};
	const ctx = {
		model: { api: "test", provider: "test", id: "test" },
		signal: new AbortController().signal,
		hasPendingMessages: () => false,
		modelRegistry: {
			async complete() {
				calls.completions++;
				return { content: [{ type: "text", text: '{"met":false,"reason":"missing proof"}' }], stopReason: "stop" };
			},
		},
		sessionManager: {
			getBranch: () => calls.entries,
			buildSessionProjection: () => ({ messages: [] }),
			getSessionId: () => "lifecycle-test",
		},
		ui: { setStatus(_key: string, value: string | undefined) { calls.status = value; } },
	};
	const marker = process.env.PI_ORCHESTRATED_CHILD;
	process.env.PI_ORCHESTRATED_CHILD = child ? "1" : "0";
	try {
		goalExtension({
			appendEntry(customType, data) { calls.entries.push({ type: "custom", customType, data }); },
			sendMessage(message) { calls.sent.push(message); },
			sendUserMessage(content) { calls.userMessages.push(content); },
			registerCommand(name, command) { commands.set(name, command.handler); },
			on(event, handler) { handlers.set(event, handler); },
		});
	} finally {
		if (marker === undefined) delete process.env.PI_ORCHESTRATED_CHILD;
		else process.env.PI_ORCHESTRATED_CHILD = marker;
	}
	return {
		calls,
		emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
		goal: (args: string) => commands.get("goal")!(args, ctx),
	};
}

const completedTurn = { outcome: "completed", message: { role: "assistant", stopReason: "stop" }, entries: [] };

test("tree navigation drops an abandoned goal before unrelated work", async () => {
	const h = createHarness();
	await h.goal("abandoned work");
	h.calls.entries = [];
	await h.emit("session_tree");
	assert.equal(h.calls.status, undefined);
	assert.equal(await h.emit("before_agent_start"), undefined);
	assert.equal(await h.emit("turn_end", completedTurn), undefined);
	assert.equal(h.calls.completions, 0);
	await h.goal("");
	assert.match(h.calls.sent.at(-1).content, /No goal has been set/);
	assert.deepEqual(h.calls.entries, []);
});

test("tree navigation restores the selected branch goal and its remaining budget", async () => {
	const h = createHarness();
	await h.goal("other branch");
	const restored = { ...createActiveGoal("selected branch", 1), evaluatedTurns: 2, maxEvaluations: 3 };
	h.calls.entries = [{ type: "custom", customType: GOAL_STATE_ENTRY, data: restored }];
	await h.emit("session_tree");
	assert.match(h.calls.status!, /2\/3/);
	assert.match((await h.emit("before_agent_start")).message.content, /selected branch/);
	const boundary = await h.emit("turn_end", completedTurn);
	assert.equal(boundary.continue, undefined);
	assert.equal(latestGoalState(h.calls.entries)?.status, "cleared");
	assert.equal(latestGoalState(h.calls.entries)?.evaluatedTurns, 3);
	assert.equal(latestGoalState(h.calls.entries)?.condition, "selected branch");
});

test("tree navigation does not reactivate achieved or cleared branch goals", async () => {
	for (const terminal of [
		clearGoal(createActiveGoal("cleared branch"))!,
		updateAfterMetEvaluation(createActiveGoal("achieved branch"), { met: true, reason: "done" }),
	]) {
		const h = createHarness();
		await h.goal("active elsewhere");
		h.calls.entries = [{ type: "custom", customType: GOAL_STATE_ENTRY, data: terminal }];
		await h.emit("session_tree");
		assert.equal(h.calls.status, undefined);
		assert.equal(await h.emit("before_agent_start"), undefined);
		assert.equal(await h.emit("turn_end", completedTurn), undefined);
		assert.equal(h.calls.completions, 0);
	}
});

test("resume and tree restoration fail closed on malformed or exhausted newest state", async () => {
	for (const event of ["session_start", "session_tree"]) {
		for (const invalid of [
			{ maxEvaluations: undefined }, { maxEvaluations: null }, { maxEvaluations: "25" },
			{ maxEvaluations: Infinity }, { maxEvaluations: NaN }, { maxEvaluations: 0 }, { maxEvaluations: 1000 },
			{ evaluatedTurns: -1 }, { evaluatedTurns: NaN }, { evaluatedTurns: 25 }, { evaluatedTurns: 26 },
		]) {
			const h = createHarness();
			await h.goal("old active goal");
			h.calls.entries.push({ type: "custom", customType: GOAL_STATE_ENTRY, data: { ...createActiveGoal("invalid goal"), ...invalid } });
			const entryCount = h.calls.entries.length;
			h.calls.sent = [];
			h.calls.userMessages = [];
			await h.emit(event);
			assert.equal(h.calls.status, undefined);
			assert.equal(await h.emit("before_agent_start"), undefined);
			await h.emit("session_compact");
			for (let turn = 0; turn < 30; turn++) assert.equal(await h.emit("turn_end", completedTurn), undefined);
			assert.equal(h.calls.completions, 0);
			assert.deepEqual(h.calls.sent, []);
			assert.deepEqual(h.calls.userMessages, []);
			assert.equal(h.calls.entries.length, entryCount);
			await h.goal("clear");
			assert.equal(h.calls.entries.length, entryCount);
		}
	}
});

test("valid resumed goal spends only its remaining evaluation budget", async () => {
	const h = createHarness();
	h.calls.entries = [{ type: "custom", customType: GOAL_STATE_ENTRY, data: { ...createActiveGoal("finish", 1), evaluatedTurns: 24 } }];
	await h.emit("session_start");
	assert.match(h.calls.status!, /24\/25/);
	const result = await h.emit("turn_end", completedTurn);
	assert.equal(result.continue, undefined);
	assert.equal(h.calls.completions, 1);
	assert.equal(latestGoalState(h.calls.entries)?.status, "cleared");
	assert.equal(latestGoalState(h.calls.entries)?.evaluatedTurns, 25);
	assert.equal(await h.emit("turn_end", completedTurn), undefined);
	assert.equal(h.calls.completions, 1);
});

test("tree restoration and commands cannot enable goals in an orchestrated child", async () => {
	const h = createHarness(true);
	h.calls.entries = [{ type: "custom", customType: GOAL_STATE_ENTRY, data: createActiveGoal("parent work") }];
	await h.emit("session_start");
	await h.emit("session_tree");
	await h.goal("child work");
	assert.equal(await h.emit("before_agent_start"), undefined);
	assert.equal(await h.emit("turn_end", completedTurn), undefined);
	assert.equal(h.calls.status, undefined);
	assert.equal(h.calls.completions, 0);
	assert.equal(h.calls.userMessages.length, 0);
	assert.equal(h.calls.entries.length, 1);
});
