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

	pi.registerFlag("blind", {
		description: "Start blind to project context, conversation history, and tools",
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

	function enable(ctx: ExtensionContext, persist = true): void {
		if (!enabled) {
			toolsBeforeBlind = pi.getActiveTools();
			enabledAt = Date.now();
		}
		enabled = true;
		pi.setActiveTools([]);
		updateStatus(ctx);
		if (persist) persistState();
	}

	function disable(ctx: ExtensionContext, persist = true): void {
		const toolsToRestore = existingTools(toolsBeforeBlind ?? sessionDefaultTools);
		enabled = false;
		enabledAt = 0;
		pi.setActiveTools(toolsToRestore);
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
			toolsBeforeBlind = saved.data.toolsBeforeBlind ?? sessionDefaultTools;
			pi.setActiveTools([]);
		} else {
			enabled = false;
			enabledAt = 0;
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

			if (shouldEnable) {
				enable(ctx);
				ctx.ui.notify(
					"Project context hidden. Tools and earlier conversation are excluded.",
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

		// Reassert this in case another extension changed the active tool set.
		pi.setActiveTools([]);

		return {
			systemPrompt: `You are a general-purpose AI assistant in blind mode.

Answer using only the user's messages sent since blind mode was enabled and your replies to those messages.

Rules:
- Do not use, request, infer, or claim knowledge of files in the current project.
- No tools are available.
- Treat content pasted or attached by the user as the only available local context.
- Do not mention the current working directory or project configuration.
- Be concise.`,
		};
	});

	pi.on("context", async (event) => {
		if (!enabled) return;

		pi.setActiveTools([]);
		return {
			messages: event.messages.filter(
				(message) =>
					timestampOf(message) >= enabledAt &&
					(message.role === "user" || message.role === "assistant"),
			),
		};
	});

	pi.on("tool_call", async () => {
		if (!enabled) return;
		return {
			block: true,
			reason: "Blind mode blocks all tools. Use /blind off to restore them.",
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
		if (command?.sourceInfo.scope !== "project") return;

		ctx.ui.notify(
			`/${commandName} comes from the project and is unavailable while project context is hidden.`,
			"warning",
		);
		return { action: "handled" };
	});
}
