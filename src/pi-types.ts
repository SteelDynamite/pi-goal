import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";

type MessageContent = string | Array<{ type: string; text?: string }>;

export type SessionMessage =
	| Message
	| { role: "system"; content: unknown }
	| { role: "custom"; customType: string; content: MessageContent }
	| { role: "bashExecution"; command: string; output: string; excludeFromContext?: boolean }
	| { role: "branchSummary"; summary: string }
	| { role: "compactionSummary"; summary: string };

export type SessionEntry =
	| { type: "message"; message: SessionMessage }
	| { type: "thinking_level_change" }
	| { type: "model_change" }
	| { type: "usage" }
	| { type: "compaction" }
	| { type: "branch_summary" }
	| { type: "custom"; customType: string; data?: unknown }
	| { type: "custom_message"; customType: string; content: MessageContent; details?: unknown }
	| { type: "context_edit" }
	| { type: "label" }
	| { type: "session_info" };

export type SessionBoundaryDraft =
	| { type: "custom"; customType: string; data?: unknown }
	| { type: "custom_message"; customType: string; content: MessageContent; display: boolean; details?: unknown }
	| { type: "context_edit"; targetId: string; replacement: unknown }
	| { type: "compaction"; summary: string; firstKeptEntryId: string | null; details?: unknown };

export type ExtensionContext = {
	model?: Model<Api>;
	signal?: AbortSignal;
	hasPendingMessages(): boolean;
	modelRegistry: {
		complete(
			model: Model<Api>,
			context: { systemPrompt?: string; messages: Message[] },
			options: { signal?: AbortSignal; maxTokens?: number; cacheRetention?: "none" | "short" | "long"; sessionId?: string },
		): Promise<AssistantMessage>;
	};
	sessionManager: {
		getBranch(): SessionEntry[];
		buildSessionProjection(): { messages: SessionMessage[] };
		getSessionId(): string;
	};
	ui: {
		setStatus(key: string, value: string | undefined): void;
	};
};

export type ExtensionAPI = {
	appendEntry(customType: string, data: unknown): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
	registerCommand(
		name: string,
		command: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
	): void;
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(
		event: "before_agent_start",
		handler: (
			event: { systemPrompt: string },
			ctx: ExtensionContext,
		) =>
			| void
			| { message: { customType: string; content: string; display: boolean; details?: unknown } }
			| Promise<void | { message: { customType: string; content: string; display: boolean; details?: unknown } }>,
	): void;
	on(
		event: "turn_end",
		handler: (
			event: { outcome: "completed" | "aborted" | "error"; message: SessionMessage; entries: SessionBoundaryDraft[] },
			ctx: ExtensionContext,
		) =>
			| void
			| { entries?: SessionBoundaryDraft[]; continue?: boolean }
			| Promise<void | { entries?: SessionBoundaryDraft[]; continue?: boolean }>,
	): void;
	on(
		event: "session_compact",
		handler: (
			event: { reason: "manual" | "threshold" | "overflow"; willRetry: boolean },
			ctx: ExtensionContext,
		) => void | Promise<void>,
	): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
};
