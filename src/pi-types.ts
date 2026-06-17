import type { Api, Message, Model } from "@earendil-works/pi-ai";

export type SessionEntry =
	| { type: "message"; message: Message }
	| { type: "custom"; customType: string; data: unknown }
	| { type: "custom_message"; customType: string; content: string | Array<{ type: string; text?: string }> };

export type ExtensionContext = {
	model?: Model<Api>;
	signal?: AbortSignal;
	modelRegistry: {
		getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
	};
	sessionManager: {
		getBranch(): SessionEntry[];
	};
	ui: {
		setStatus(key: string, value: string | undefined): void;
	};
};

export type ExtensionAPI = {
	appendEntry(customType: string, data: unknown): void;
	sendMessage(message: { customType: string; content: string; display?: boolean }, options?: { triggerTurn?: boolean }): void;
	sendUserMessage(content: string, options?: { deliverAs?: "followUp" | string }): void;
	registerCommand(
		name: string,
		command: { description: string; handler: (args: string, ctx: ExtensionContext) => void | Promise<void> },
	): void;
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(
		event: "before_agent_start",
		handler: (event: { systemPrompt: string }, ctx: ExtensionContext) => void | { systemPrompt: string } | Promise<void | { systemPrompt: string }>,
	): void;
	on(event: "agent_end", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
};
