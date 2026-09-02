import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "blind-state";
const STATUS_ID = "blind";

interface BlindState {
	enabled: boolean;
	enabledAt?: number;
	toolsBeforeBlind?: string[];
}

function timestampOf(message: { timestamp?: number }): number {
	return typeof message.timestamp === "number" ? message.timestamp : 0;
}

export default function blindExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let enabledAt = 0;
	let toolsBeforeBlind: string[] | undefined;
	let sessionDefaultTools: string[] = [];
	let allowedBlindTools = new Set<string>();

	pi.registerFlag("blind", {
		description: "Start blind to project context and conversation history",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_ID,
			enabled ? ctx.ui.theme.fg("warning", "blind") : undefined,
		);
	}

	function persistState(): void {
		pi.appendEntry<BlindState>(STATE_TYPE, {
			enabled,
			enabledAt: enabled ? enabledAt : undefined,
			toolsBeforeBlind,
		});
	}

	function existingTools(toolNames: string[]): string[] {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		return toolNames.filter((name) => available.has(name));
	}

	function uniqueTools(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function userScopedTools(toolNames: string[]): string[] {
		const userScoped = new Set(
			pi
				.getAllTools()
				.filter((tool) => tool.sourceInfo.scope === "user")
				.map((tool) => tool.name),
		);
		return uniqueTools(toolNames).filter((name) => userScoped.has(name));
	}

	function activateBlindTools(toolNames: string[], reset = false): void {
		if (reset) allowedBlindTools.clear();

		for (const toolName of userScopedTools(toolNames)) {
			allowedBlindTools.add(toolName);
		}

		const activeTools = userScopedTools([...allowedBlindTools]);
		allowedBlindTools = new Set(activeTools);
		pi.setActiveTools(activeTools);

		if (toolsBeforeBlind) {
			toolsBeforeBlind = uniqueTools([...toolsBeforeBlind, ...activeTools]);
		}
	}

	function isAllowedBlindTool(toolName: string): boolean {
		return (
			allowedBlindTools.has(toolName) &&
			userScopedTools([toolName]).length === 1
		);
	}

	function enable(ctx: ExtensionContext, persist = true): void {
		if (!enabled) {
			toolsBeforeBlind = pi.getActiveTools();
			enabledAt = Date.now();
		}
		enabled = true;
		activateBlindTools(toolsBeforeBlind ?? sessionDefaultTools, true);
		updateStatus(ctx);
		if (persist) persistState();
	}

	function disable(ctx: ExtensionContext, persist = true): void {
		const toolsToRestore = existingTools(toolsBeforeBlind ?? sessionDefaultTools);
		enabled = false;
		enabledAt = 0;
		pi.setActiveTools(toolsToRestore);
		allowedBlindTools.clear();
		toolsBeforeBlind = toolsToRestore;
		updateStatus(ctx);
		if (persist) persistState();
		toolsBeforeBlind = undefined;
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		const saved = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find(
				(entry) => entry.type === "custom" && entry.customType === STATE_TYPE,
			) as { data?: BlindState } | undefined;

		if (saved?.data?.enabled) {
			enabled = true;
			enabledAt = saved.data.enabledAt ?? Date.now();
			const savedTools = saved.data.toolsBeforeBlind ?? sessionDefaultTools;
			const currentUserTools = userScopedTools(sessionDefaultTools);
			toolsBeforeBlind = uniqueTools([...savedTools, ...currentUserTools]);
			activateBlindTools(toolsBeforeBlind, true);
		} else {
			enabled = false;
			enabledAt = 0;
			allowedBlindTools.clear();
			toolsBeforeBlind = undefined;
			const savedTools = saved?.data?.toolsBeforeBlind ?? sessionDefaultTools;
			pi.setActiveTools(existingTools(savedTools));
		}
		updateStatus(ctx);
	}

	pi.registerCommand("blind", {
		description: "Toggle blind mode (on, off, or status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "status") {
				ctx.ui.notify(
					enabled
						? "Project context is hidden."
						: "Project context is visible.",
					"info",
				);
				return;
			}

			if (action && action !== "on" && action !== "off" && action !== "toggle") {
				ctx.ui.notify("Usage: /blind [on|off|toggle|status]", "error");
				return;
			}

			const shouldEnable = action === "off" ? false : action === "on" ? true : !enabled;
			if (shouldEnable === enabled) {
				ctx.ui.notify(
					enabled ? "Project context is already hidden." : "Project context is already visible.",
					"info",
				);
				return;
			}

			await ctx.waitForIdle();

			if (shouldEnable) {
				enable(ctx);
				ctx.ui.notify(
					"Project context hidden. User-scoped tools remain available; project tools and earlier conversation are excluded.",
					"info",
				);
			} else {
				disable(ctx);
				ctx.ui.notify("Project context visible. Previous tools restored.", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionDefaultTools = pi.getActiveTools();
		restoreFromBranch(ctx);

		if (pi.getFlag("blind") === true && !enabled) {
			enable(ctx);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("before_agent_start", async () => {
		if (!enabled) return;

		// Keep active user-scoped tools, but remove anything a project extension enabled.
		activateBlindTools(pi.getActiveTools());

		return {
			systemPrompt: `You are a general-purpose AI assistant in blind mode.

Answer using only the user's messages sent since blind mode was enabled, your replies to those messages, and results from the available user-scoped tools.

Rules:
- Do not use, request, infer, or claim knowledge of files in the current project.
- Only user-scoped tools are available. Do not claim that no tools are available.
- Treat content pasted or attached by the user as the only available local context.
- Do not mention the current working directory or project configuration.
- Be concise.`,
		};
	});

	pi.on("context", async (event) => {
		if (!enabled) return;

		activateBlindTools(pi.getActiveTools());
		return {
			messages: event.messages.filter(
				(message) =>
					timestampOf(message) >= enabledAt &&
					(message.role === "user" ||
						message.role === "assistant" ||
						message.role === "toolResult"),
			),
		};
	});

	pi.on("tool_call", async (event) => {
		if (!enabled || isAllowedBlindTool(event.toolName)) return;
		return {
			block: true,
			reason:
				"Blind mode only allows user-scoped tools. Use /blind off to restore other tools.",
		};
	});

	pi.on("session_before_compact", async () => {
		if (enabled) return { cancel: true };
	});

	pi.on("session_before_tree", async () => {
		if (enabled) return { cancel: true };
	});

	pi.on("input", async (event, ctx) => {
		if (!enabled || !event.text.startsWith("/")) return;

		const commandName = event.text.slice(1).split(/\s+/, 1)[0];
		const command = pi.getCommands().find((candidate) => candidate.name === commandName);
		if (
			command?.sourceInfo.scope !== "project" ||
			command.source === "extension"
		) {
			return;
		}

		ctx.ui.notify(
			`/${commandName} comes from the project and is unavailable while project context is hidden.`,
			"warning",
		);
		return { action: "handled" };
	});
}
