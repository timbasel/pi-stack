import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	formatSkillsForPrompt,
	getAgentDir,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "blind-state";
const STATUS_ID = "blind";
const DEFAULT_PROMPT = "You are an AI assistant operating inside pi, an agent harness.";
const ACCESS_NOTICE =
	"The current project's working directory, instructions, and files are unavailable through project-scoped tools or built-in filesystem access. Use existing conversation context, content the user provides directly, and available user-scoped tools.";

interface BlindState {
	enabled: boolean;
	toolsBeforeBlind?: string[];
}

interface ProjectPrompts {
	system?: string;
	append?: string;
}

interface PromptPolicy {
	agentDir?: string;
	selectedTools?: string[];
	restrictedRead?: boolean;
	projectPrompts?: ProjectPrompts;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBlindState(value: unknown): BlindState | undefined {
	if (!isRecord(value) || typeof value.enabled !== "boolean") return;
	const tools = value.toolsBeforeBlind;
	if (
		tools !== undefined &&
		(!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))
	) {
		return;
	}
	return {
		enabled: value.enabled,
		...(tools ? { toolsBeforeBlind: unique(tools) } : {}),
	};
}

function latestBlindState(entries: readonly unknown[]): BlindState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			!isRecord(entry) ||
			entry.type !== "custom" ||
			entry.customType !== STATE_TYPE
		) {
			continue;
		}
		const state = parseBlindState(entry.data);
		if (state) return state;
	}
}

function readProjectPrompts(cwd: string): ProjectPrompts {
	const read = (filename: string): string | undefined => {
		try {
			const content = readFileSync(
				join(cwd, CONFIG_DIR_NAME, filename),
				"utf8",
			).replace(/^\uFEFF/, "");
			return content || undefined;
		} catch {
			return;
		}
	};
	return { system: read("SYSTEM.md"), append: read("APPEND_SYSTEM.md") };
}

function globalContext(
	files: NonNullable<BuildSystemPromptOptions["contextFiles"]>,
	agentDir: string,
): NonNullable<BuildSystemPromptOptions["contextFiles"]> {
	const root = resolve(agentDir);
	return files.filter((file) => resolve(dirname(file.path)) === root);
}

function globalSkills(skills: Skill[]): Skill[] {
	return skills.filter((skill) => skill.sourceInfo.scope === "user");
}

/** Mirrors Pi's generated context block so it can be replaced in an otherwise unchanged prompt. */
function formatContext(
	files: NonNullable<BuildSystemPromptOptions["contextFiles"]>,
): string {
	if (files.length === 0) return "";
	const entries = files
		.map(
			({ path, content }) =>
				`<project_instructions path="${path}">\n${content}\n</project_instructions>\n`,
		)
		.join("\n");
	return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${entries}\n</project_context>\n`;
}

function explicitSkills(skills: Skill[]): string {
	const formatted = formatSkillsForPrompt(skills);
	const catalog = formatted.indexOf("<available_skills>");
	if (catalog === -1) return "";
	return `\n\nThe following user-scoped skills provide specialized instructions for specific tasks.\nTheir full instructions are supplied only when the user invokes \`/skill:<name>\`.\n\n${formatted.slice(catalog)}`;
}

function replaceLast(text: string, search: string, replacement = ""): string | undefined {
	const index = text.lastIndexOf(search);
	if (index === -1) return;
	return text.slice(0, index) + replacement + text.slice(index + search.length);
}

function stripWorkingDirectory(prompt: string, cwd: string): string {
	const line = `\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`;
	return (replaceLast(prompt, line) ?? prompt).trimEnd();
}

function safePrompt(
	options: BuildSystemPromptOptions,
	agentDir: string,
	selectedTools: string[] | undefined,
	project: ProjectPrompts,
): string {
	const context = globalContext(options.contextFiles ?? [], agentDir);
	const skills = globalSkills(options.skills ?? []);
	const canRead = selectedTools?.includes("read") ?? true;
	const custom =
		options.customPrompt && options.customPrompt !== project.system
			? options.customPrompt
			: DEFAULT_PROMPT;
	const append =
		options.appendSystemPrompt && options.appendSystemPrompt !== project.append
			? `\n\n${options.appendSystemPrompt}`
			: "";
	const catalog =
		skills.length === 0
			? ""
			: canRead
				? formatSkillsForPrompt(skills)
				: explicitSkills(skills);
	return `${custom}${append}${formatContext(context)}${catalog}`.trimEnd();
}

export function sanitizeBlindSystemPrompt(
	systemPrompt: string,
	options: BuildSystemPromptOptions,
	policy: PromptPolicy = {},
): string {
	const agentDir = policy.agentDir ?? getAgentDir();
	const selectedTools = policy.selectedTools ?? options.selectedTools;
	const project = policy.projectPrompts ?? readProjectPrompts(options.cwd);
	const finish = (prompt: string) => {
		const readNotice = policy.restrictedRead
			? " The read tool is limited to files belonging to the listed user-scoped skills."
			: "";
		return `${stripWorkingDirectory(prompt, options.cwd)}\n\n${ACCESS_NOTICE}${readNotice}`;
	};
	const fallback = () => finish(safePrompt(options, agentDir, selectedTools, project));
	let prompt = systemPrompt;

	if (project.system && options.customPrompt === project.system) {
		const next = replaceLast(prompt, project.system, DEFAULT_PROMPT);
		if (next === undefined) return fallback();
		prompt = next;
	}
	if (project.append && options.appendSystemPrompt === project.append) {
		const next = replaceLast(prompt, `\n\n${project.append}`);
		if (next === undefined) return fallback();
		prompt = next;
	}

	const context = options.contextFiles ?? [];
	if (context.length > 0) {
		const next = replaceLast(prompt, formatContext(context), formatContext(globalContext(context, agentDir)));
		if (next === undefined) return fallback();
		prompt = next;
	}

	const skills = options.skills ?? [];
	if (skills.length > 0) {
		const generated = formatSkillsForPrompt(skills);
		const allowed = globalSkills(skills);
		const canRead = selectedTools?.includes("read") ?? true;
		const catalog = canRead ? formatSkillsForPrompt(allowed) : explicitSkills(allowed);
		if (prompt.includes(generated)) {
			prompt = replaceLast(prompt, generated, catalog)!;
		} else if (options.selectedTools?.includes("read") ?? true) {
			return fallback();
		} else if (catalog && !prompt.includes(catalog)) {
			prompt += catalog;
		}
	}

	return finish(prompt);
}

export default function blindExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let toolsBeforeBlind: string[] | undefined;
	let defaultTools: string[] = [];
	let allowedUserTools = new Set<string>();
	let skillRoots = new Set<string>();
	let projectPrompts: ProjectPrompts | undefined;

	pi.registerFlag("blind", {
		description: "Start with project access disabled",
		type: "boolean",
		default: false,
	});

	const catalog = () => {
		const tools = pi.getAllTools();
		return {
			available: new Set(tools.map((tool) => tool.name)),
			user: new Set(
				tools
					.filter((tool) => tool.sourceInfo.scope === "user")
					.map((tool) => tool.name),
			),
			builtinRead: tools.some(
				(tool) =>
					tool.name === "read" && tool.sourceInfo.source === "builtin",
			),
		};
	};
	const select = (names: string[], allowed: Set<string>) =>
		unique(names).filter((name) => allowed.has(name));
	const restrictedReadAvailable = (tools: ReturnType<typeof catalog>) =>
		skillRoots.size > 0 && tools.builtinRead;

	function setActiveTools(names: string[]): void {
		const current = pi.getActiveTools();
		const unchanged =
			current.length === names.length &&
			current.every((name, index) => name === names[index]);
		if (!unchanged) pi.setActiveTools(names);
	}

	function reconcileTools(names: string[], reset = false): boolean {
		const tools = catalog();
		if (reset) allowedUserTools.clear();
		for (const name of select(names, tools.user)) allowedUserTools.add(name);

		const userTools = select([...allowedUserTools], tools.user);
		const restrictedRead = restrictedReadAvailable(tools);
		allowedUserTools = new Set(userTools);
		setActiveTools(restrictedRead ? [...userTools, "read"] : userTools);
		if (toolsBeforeBlind) {
			toolsBeforeBlind = unique([...toolsBeforeBlind, ...userTools]);
		}
		return restrictedRead;
	}

	function updateSkillRoots(skills: Skill[]): void {
		const roots = new Set<string>();
		for (const skill of globalSkills(skills)) {
			try {
				roots.add(realpathSync(skill.baseDir));
			} catch {
				// Missing skill directories grant no read access.
			}
		}
		skillRoots = roots;
	}

	function allowedSkillRead(
		event: { toolName: string; input?: unknown },
		tools: ReturnType<typeof catalog>,
	): boolean {
		if (
			event.toolName !== "read" ||
			!restrictedReadAvailable(tools) ||
			!isRecord(event.input)
		) {
			return false;
		}
		const path = event.input.path;
		if (typeof path !== "string" || !isAbsolute(path)) return false;

		let canonical: string;
		try {
			canonical = realpathSync(path);
		} catch {
			return false;
		}
		const allowed = [...skillRoots].some((root) => {
			const child = relative(root, canonical);
			return (
				child === "" ||
				(child !== ".." &&
					!child.startsWith(`..${sep}`) &&
					!isAbsolute(child))
			);
		});
		if (allowed) event.input.path = canonical;
		return allowed;
	}

	function setStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_ID,
			enabled ? ctx.ui.theme.fg("warning", "blind") : undefined,
		);
	}

	function enable(ctx: ExtensionContext): void {
		if (!enabled) toolsBeforeBlind = pi.getActiveTools();
		enabled = true;
		projectPrompts = readProjectPrompts(ctx.cwd);
		skillRoots.clear();
		reconcileTools(toolsBeforeBlind ?? defaultTools, true);
		setStatus(ctx);
		pi.appendEntry<BlindState>(STATE_TYPE, { enabled: true, toolsBeforeBlind });
	}

	function disable(ctx: ExtensionContext): void {
		const restored = select(toolsBeforeBlind ?? defaultTools, catalog().available);
		enabled = false;
		setActiveTools(restored);
		allowedUserTools.clear();
		skillRoots.clear();
		projectPrompts = undefined;
		setStatus(ctx);
		pi.appendEntry<BlindState>(STATE_TYPE, {
			enabled: false,
			toolsBeforeBlind: restored,
		});
		toolsBeforeBlind = undefined;
	}

	function restore(ctx: ExtensionContext): void {
		const state = latestBlindState(ctx.sessionManager.getBranch());
		allowedUserTools.clear();
		skillRoots.clear();
		if (state?.enabled) {
			enabled = true;
			projectPrompts = readProjectPrompts(ctx.cwd);
			const userDefaults = select(defaultTools, catalog().user);
			toolsBeforeBlind = unique([
				...(state.toolsBeforeBlind ?? defaultTools),
				...userDefaults,
			]);
			reconcileTools(toolsBeforeBlind, true);
		} else {
			enabled = false;
			projectPrompts = undefined;
			setActiveTools(select(state?.toolsBeforeBlind ?? defaultTools, catalog().available));
			toolsBeforeBlind = undefined;
		}
		setStatus(ctx);
	}

	pi.registerCommand("blind", {
		description: "Toggle project access (on, off, or status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") {
				ctx.ui.notify(
					enabled
						? "Project access is disabled."
						: "Project access is enabled.",
					"info",
				);
				return;
			}
			if (action && action !== "on" && action !== "off" && action !== "toggle") {
				ctx.ui.notify("Usage: /blind [on|off|toggle|status]", "error");
				return;
			}

			const shouldEnable =
				action === "off" ? false : action === "on" ? true : !enabled;
			if (shouldEnable === enabled) {
				ctx.ui.notify(
					enabled
						? "Project access is already disabled."
						: "Project access is already enabled.",
					"info",
				);
				return;
			}

			await ctx.waitForIdle();
			if (shouldEnable) {
				enable(ctx);
				ctx.ui.notify(
					"Project access disabled. Existing conversation context and user-scoped tools remain available.",
					"info",
				);
			} else {
				disable(ctx);
				ctx.ui.notify("Project access enabled. Previous tools restored.", "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		defaultTools = pi.getActiveTools();
		restore(ctx);
		if (pi.getFlag("blind") === true && !enabled) enable(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		updateSkillRoots(event.systemPromptOptions.skills ?? []);
		const restrictedRead = reconcileTools(pi.getActiveTools());
		return {
			systemPrompt: sanitizeBlindSystemPrompt(
				event.systemPrompt,
				event.systemPromptOptions,
				{
					agentDir: getAgentDir(),
					selectedTools: pi.getActiveTools(),
					restrictedRead,
					projectPrompts,
				},
			),
		};
	});

	pi.on("context", () => {
		if (enabled) reconcileTools(pi.getActiveTools());
	});

	pi.on("tool_call", (event) => {
		if (!enabled) return;
		const tools = catalog();
		if (
			(allowedUserTools.has(event.toolName) &&
				tools.user.has(event.toolName)) ||
			allowedSkillRead(event, tools)
		) {
			return;
		}
		return {
			block: true,
			reason:
				"Project access is disabled. Only user-scoped tools and reads within user-scoped skills are available. Use /blind off to restore project tools.",
		};
	});

	pi.on("input", (event, ctx) => {
		if (!enabled || !event.text.startsWith("/")) return;
		const name = event.text.slice(1).split(/\s+/, 1)[0];
		const command = pi.getCommands().find((candidate) => candidate.name === name);
		if (command?.sourceInfo.scope !== "project" || command.source === "extension") return;
		ctx.ui.notify(
			`/${name} comes from the project and is unavailable while project access is disabled.`,
			"warning",
		);
		return { action: "handled" };
	});
}
