import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessage } from "./pi-types.ts";

export const GOAL_STATE_ENTRY = "goal-state";
export const GOAL_CONTEXT_MESSAGE = "goal-context";
export const GOAL_STATUS_MESSAGE = "goal-status";
export const GOAL_EVALUATION_MESSAGE = "goal-evaluation";
export const GOAL_CONTINUATION_PREFIX = "[GOAL SUPERVISOR CONTINUATION]";
export const DEFAULT_MAX_EVALUATIONS = 25;
export const EVALUATOR_MAX_TOKENS = 2000;
export const MAX_CONDITION_CHARS = 4000;
export const TRANSCRIPT_CHAR_LIMIT = 24000;

export type GoalStatus = "active" | "achieved" | "cleared";

export type GoalState = {
	version: 1;
	status: GoalStatus;
	condition: string;
	startedAt: number;
	updatedAt: number;
	evaluatedTurns: number;
	maxEvaluations: number;
	lastReason?: string;
	lastContinuation?: string;
	achievedAt?: number;
	clearedAt?: number;
	stopReason?: string;
};

export type EvaluatorResult = {
	met: boolean;
	reason: string;
	continuation?: string;
};

export function isOrchestratedChild(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_ORCHESTRATED_CHILD === "1";
}

export function parseGoalArgs(args: string):
	| { action: "status" }
	| { action: "clear" }
	| { action: "set"; condition: string } {
	const trimmed = args.trim();
	if (!trimmed) return { action: "status" };
	if (/^(clear|stop|off|reset|none|cancel)$/i.test(trimmed)) return { action: "clear" };
	return { action: "set", condition: trimmed.slice(0, MAX_CONDITION_CHARS) };
}

export function createActiveGoal(condition: string, now = Date.now()): GoalState {
	return {
		version: 1,
		status: "active",
		condition,
		startedAt: now,
		updatedAt: now,
		evaluatedTurns: 0,
		maxEvaluations: parseMaxEvaluations(condition) ?? DEFAULT_MAX_EVALUATIONS,
	};
}

export function clearGoal(state: GoalState | undefined, reason = "cleared", now = Date.now()): GoalState | undefined {
	if (!state) return undefined;
	return {
		...state,
		status: "cleared",
		updatedAt: now,
		clearedAt: now,
		stopReason: reason,
	};
}

export function achieveGoal(state: GoalState, reason: string, now = Date.now()): GoalState {
	return {
		...state,
		status: "achieved",
		updatedAt: now,
		achievedAt: now,
		lastReason: reason,
	};
}

export function updateAfterUnmetEvaluation(state: GoalState, result: EvaluatorResult, now = Date.now()): GoalState {
	return {
		...state,
		updatedAt: now,
		evaluatedTurns: state.evaluatedTurns + 1,
		lastReason: result.reason,
		lastContinuation: result.continuation,
	};
}

export function updateAfterMetEvaluation(state: GoalState, result: EvaluatorResult, now = Date.now()): GoalState {
	return achieveGoal(
		{
			...state,
			evaluatedTurns: state.evaluatedTurns + 1,
		},
		result.reason,
		now,
	);
}

export function hasReachedMaxEvaluations(state: GoalState): boolean {
	return state.evaluatedTurns >= state.maxEvaluations;
}

export function parseMaxEvaluations(condition: string): number | undefined {
	const match = condition.match(/\b(?:or\s+)?stop\s+after\s+(\d{1,3})\s+turns?\b/i);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isInteger(value) || value < 1) return undefined;
	return value;
}

export function isGoalState(value: unknown): value is GoalState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<GoalState>;
	return (
		state.version === 1 &&
		(state.status === "active" || state.status === "achieved" || state.status === "cleared") &&
		typeof state.condition === "string" &&
		typeof state.startedAt === "number" &&
		typeof state.updatedAt === "number" &&
		typeof state.evaluatedTurns === "number"
	);
}

export function latestGoalState(entries: readonly SessionEntry[]): GoalState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY) continue;
		if (isGoalState(entry.data)) return entry.data;
	}
	return undefined;
}

export function formatGoalStatus(state: GoalState | undefined, now = Date.now()): string {
	if (!state) return "No goal has been set in this session.";
	const lines = [`Goal status: ${state.status}`];
	lines.push(`Condition: ${state.condition}`);
	if (state.status === "active") lines.push(`Running: ${formatDuration(now - state.startedAt)}`);
	if (state.status === "achieved" && state.achievedAt) lines.push(`Achieved after: ${formatDuration(state.achievedAt - state.startedAt)}`);
	if (state.status === "cleared" && state.clearedAt) lines.push(`Cleared after: ${formatDuration(state.clearedAt - state.startedAt)}`);
	lines.push(`Evaluated turns: ${state.evaluatedTurns}/${state.maxEvaluations}`);
	if (state.lastReason) lines.push(`Latest evaluator reason: ${state.lastReason}`);
	if (state.stopReason) lines.push(`Stop reason: ${state.stopReason}`);
	return lines.join("\n");
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function buildGoalContext(state: GoalState): string {
	return [
		"[GOAL ACTIVE]",
		"Continue working until this completion condition is demonstrably met.",
		"Surface evidence in the transcript, because the evaluator cannot run tools or inspect files independently.",
		"",
		"Goal condition:",
		state.condition,
	].join("\n");
}

export function hasGoalContextMessage(state: GoalState, messages: readonly SessionMessage[]): boolean {
	return messages.some(
		(message) =>
			message.role === "custom" &&
			message.customType === GOAL_CONTEXT_MESSAGE &&
			message.content === buildGoalContext(state) &&
			"details" in message &&
			isRecord(message.details) &&
			message.details.goalStartedAt === state.startedAt,
	);
}

export function buildContinuationPrompt(state: GoalState): string {
	const guidance = state.lastContinuation || state.lastReason || "The goal is not met yet.";
	return [
		GOAL_CONTINUATION_PREFIX,
		"Continue working toward the active /goal.",
		"Surface concrete evidence for completion in the transcript.",
		"",
		"Goal condition:",
		state.condition,
		"",
		"Evaluator guidance:",
		guidance,
	].join("\n");
}

export function buildEvaluatorSystemPrompt(): string {
	return [
		"You are a goal completion evaluator for a coding agent session.",
		"Decide whether the transcript proves the goal condition is met.",
		"You cannot run tools or inspect files; only judge evidence shown in the transcript.",
		"Return only minified JSON with this shape:",
		'{"met":false,"reason":"short reason","continuation":"what the agent should do next"}',
		"Use met=true only when the transcript clearly demonstrates completion.",
	].join("\n");
}

export function buildEvaluatorPrompt(state: GoalState, entries: readonly SessionEntry[]): string {
	return ["Goal condition:", state.condition, "", "Transcript evidence:", serializeTranscript(entries, TRANSCRIPT_CHAR_LIMIT)].join("\n");
}

export function extractEvaluatorText(response: Pick<AssistantMessage, "content" | "stopReason" | "errorMessage">): string {
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`Evaluator model ${response.stopReason}: ${response.errorMessage || "no error message provided"}`);
	}

	const text = response.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
	if (text) return text;

	const blockTypes = response.content.map((item) => item.type).join(", ") || "none";
	throw new Error(
		`Evaluator model returned no text to parse (stopReason: ${response.stopReason}; content blocks: ${blockTypes}). ` +
			"Try again, reduce reasoning, or switch to a current model that returns text for evaluator JSON.",
	);
}

export function buildEvaluatorCompleteOptions(signal: AbortSignal | undefined, sessionId: string) {
	return {
		signal,
		maxTokens: EVALUATOR_MAX_TOKENS,
		cacheRetention: "short" as const,
		sessionId: `${sessionId}:pi-goal-evaluator`,
	};
}

export function parseEvaluatorResponse(text: string): EvaluatorResult {
	const jsonText = extractJsonObject(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		throw new Error(`Evaluator returned invalid JSON: ${text.slice(0, 500)}`);
	}
	if (!parsed || typeof parsed !== "object") throw new Error("Evaluator returned a non-object JSON value");
	const value = parsed as { met?: unknown; reason?: unknown; continuation?: unknown };
	if (typeof value.met !== "boolean") throw new Error("Evaluator JSON missing boolean met");
	if (typeof value.reason !== "string" || !value.reason.trim()) throw new Error("Evaluator JSON missing reason");
	return {
		met: value.met,
		reason: value.reason.trim().slice(0, 1000),
		continuation: typeof value.continuation === "string" ? value.continuation.trim().slice(0, 2000) : undefined,
	};
}

export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((item): item is TextContent | ToolCall => item.type === "text" || item.type === "toolCall")
		.map((item) => (item.type === "text" ? item.text : `[tool call: ${item.name}]`))
		.join("\n")
		.trim();
}

export function messageText(message: SessionMessage): string {
	switch (message.role) {
		case "system":
			return "";
		case "user": {
			const text = contentText(message.content);
			return text.startsWith(GOAL_CONTINUATION_PREFIX) ? "" : text;
		}
		case "toolResult":
		case "custom":
			return contentText(message.content);
		case "assistant":
			return assistantContentText(message.content);
		case "bashExecution":
			if (message.excludeFromContext === true) return "";
			return [`$ ${message.command}`, message.output].filter(Boolean).join("\n");
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return exhaustiveMessage(message);
	}
}

function assistantContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!isRecord(item)) return "";
			if (item.type === "text" && typeof item.text === "string") return item.text;
			if (item.type === "toolCall" && typeof item.name === "string") return `[tool call: ${item.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "[image]"))
		.join("\n");
}

export function serializeTranscript(entries: readonly SessionEntry[], charLimit = TRANSCRIPT_CHAR_LIMIT): string {
	const chunks: string[] = [];
	for (const entry of entries) {
		switch (entry.type) {
			case "message": {
				const text = messageText(entry.message);
				if (text) chunks.push(`${entry.message.role}: ${text}`);
				break;
			}
			case "custom_message": {
				if (
					entry.customType === GOAL_CONTEXT_MESSAGE ||
					entry.customType === GOAL_EVALUATION_MESSAGE ||
					entry.customType === GOAL_STATUS_MESSAGE
				) {
					break;
				}
				const content = contentText(entry.content);
				if (content) chunks.push(`custom(${entry.customType}): ${content}`);
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "usage":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "context_edit":
			case "label":
			case "session_info":
				break;
			default:
				exhaustiveEntry(entry);
		}
	}

	const text = chunks.join("\n\n---\n\n");
	if (text.length <= charLimit) return text;
	if (charLimit <= 0) return "";

	const marker = "\n\n[transcript truncated: middle omitted]\n\n";
	if (charLimit <= marker.length) return text.slice(-charLimit);
	const available = charLimit - marker.length;
	const headLength = Math.floor(available / 3);
	return text.slice(0, headLength) + marker + text.slice(-(available - headLength));
}

function exhaustiveMessage(_message: never): string {
	return "";
}

function exhaustiveEntry(_entry: never): void {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function extractJsonObject(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i);
	if (fenced) return fenced[1].trim();
	return trimmed;
}
