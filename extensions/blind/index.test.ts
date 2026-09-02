import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type ExtensionAPI,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import blindExtension, { sanitizeBlindSystemPrompt } from "./index.ts";

type Scope = "user" | "project" | "temporary";
type Handler = (...args: any[]) => any;

interface MockTool {
	name: string;
	description: string;
	parameters: Record<string, never>;
	sourceInfo: {
		path: string;
		source: string;
		scope: Scope;
	};
}

interface MockCommand {
	name: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: { scope: Scope };
}

interface FixtureOptions {
	activeTools?: string[];
	blindFlag?: boolean;
	cwd?: string;
	branch?: unknown[];
	commands?: MockCommand[];
	tools?: MockTool[];
	waitForIdle?: () => Promise<void>;
}

interface Fixture {
	commands: Map<string, { handler: Handler }>;
	ctx: unknown;
	handlers: Map<string, Handler>;
	tools: MockTool[];
	getActiveTools(): string[];
	getSetActiveToolsCallCount(): number;
	setActiveTools(names: string[]): void;
	setAvailableCommands(commands: MockCommand[]): void;
	setBranch(entries: unknown[]): void;
}

function tool(name: string, scope: Scope): MockTool {
	return {
		name,
		description: name,
		parameters: {},
		sourceInfo: {
			path: `<${scope}:${name}>`,
			source: name === "read" && scope === "temporary" ? "builtin" : scope,
			scope,
		},
	};
}

function skill(name: string, scope: Scope, filePath: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath,
		baseDir: filePath.slice(0, filePath.lastIndexOf("/")),
		disableModelInvocation: false,
		sourceInfo: {
			path: filePath,
			source: scope,
			scope,
			origin: "top-level",
		},
	};
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const tools = [
		tool("read", "temporary"),
		tool("question", "user"),
		tool("project_tool", "project"),
		...(options.tools ?? []),
	];
	let activeTools = options.activeTools ?? [
		"read",
		"question",
		"project_tool",
	];
	let availableCommands = options.commands ?? [];
	let branch = options.branch ?? [];
	let setActiveToolsCallCount = 0;

	const pi = {
		registerFlag() {},
		getFlag() {
			return options.blindFlag ?? false;
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		appendEntry() {},
		getActiveTools() {
			return [...activeTools];
		},
		getAllTools() {
			return [...tools];
		},
		setActiveTools(names: string[]) {
			setActiveToolsCallCount++;
			activeTools = [...names];
		},
		getCommands() {
			return availableCommands;
		},
	};
	const ctx = {
		cwd: options.cwd ?? "/work/project",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			notify() {},
		},
		sessionManager: {
			getBranch() {
				return branch;
			},
		},
		waitForIdle() {
			return options.waitForIdle?.() ?? Promise.resolve();
		},
	};

	blindExtension(pi as unknown as ExtensionAPI);
	await handlers.get("session_start")?.({}, ctx);

	return {
		commands,
		ctx,
		handlers,
		tools,
		getActiveTools: () => [...activeTools],
		getSetActiveToolsCallCount: () => setActiveToolsCallCount,
		setActiveTools: (names) => {
			activeTools = [...names];
		},
		setAvailableCommands: (nextCommands) => {
			availableCommands = nextCommands;
		},
		setBranch: (entries) => {
			branch = entries;
		},
	};
}

async function enableBlind(fixture: Fixture): Promise<void> {
	await fixture.commands.get("blind")?.handler("on", fixture.ctx);
}

test("blind mode keeps active user tools and blocks all other tools", async () => {
	const fixture = await createFixture({
		tools: [tool("inactive_user_tool", "user")],
	});

	await enableBlind(fixture);
	assert.deepEqual(fixture.getActiveTools(), ["question"]);

	const handleToolCall = fixture.handlers.get("tool_call");
	assert.ok(handleToolCall);
	assert.equal(await handleToolCall({ toolName: "question" }), undefined);
	assert.equal((await handleToolCall({ toolName: "read" })).block, true);
	assert.equal(
		(
			await handleToolCall({
				toolName: "inactive_user_tool",
			})
		).block,
		true,
	);

	const result = await fixture.handlers.get("context")?.({
		messages: [
			{ role: "user", content: "Earlier project discussion" },
			{ role: "assistant", content: [] },
			{ role: "toolResult", toolName: "question", content: [] },
			{ role: "custom", customType: "ask:summary", content: "answer" },
		],
	});
	assert.equal(result, undefined);

	await fixture.commands.get("blind")?.handler("off", fixture.ctx);
	assert.deepEqual(fixture.getActiveTools(), [
		"read",
		"question",
		"project_tool",
	]);
});

test("blind transitions wait until the agent is idle", async () => {
	let releaseIdle: (() => void) | undefined;
	const idle = new Promise<void>((resolve) => {
		releaseIdle = resolve;
	});
	const fixture = await createFixture({ waitForIdle: () => idle });

	const enabling = fixture.commands.get("blind")?.handler("on", fixture.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(fixture.getActiveTools(), [
		"read",
		"question",
		"project_tool",
	]);

	releaseIdle?.();
	await enabling;
	assert.deepEqual(fixture.getActiveTools(), ["question"]);
});

test("tree navigation restores project access state in both directions", async () => {
	const fixture = await createFixture();
	const enabledState = {
		type: "custom",
		customType: "blind-state",
		data: {
			enabled: true,
			toolsBeforeBlind: ["read", "question", "project_tool"],
		},
	};
	const disabledState = {
		type: "custom",
		customType: "blind-state",
		data: {
			enabled: false,
			toolsBeforeBlind: ["read", "question", "project_tool"],
		},
	};

	await enableBlind(fixture);
	assert.deepEqual(fixture.getActiveTools(), ["question"]);

	fixture.setBranch([]);
	await fixture.handlers.get("session_tree")?.({}, fixture.ctx);
	assert.deepEqual(fixture.getActiveTools(), [
		"read",
		"question",
		"project_tool",
	]);

	fixture.setBranch([enabledState]);
	await fixture.handlers.get("session_tree")?.({}, fixture.ctx);
	assert.deepEqual(fixture.getActiveTools(), ["question"]);

	fixture.setBranch([enabledState, disabledState]);
	await fixture.handlers.get("session_tree")?.({}, fixture.ctx);
	assert.deepEqual(fixture.getActiveTools(), [
		"read",
		"question",
		"project_tool",
	]);

	fixture.setBranch([enabledState]);
	await fixture.handlers.get("session_tree")?.({}, fixture.ctx);
	assert.deepEqual(fixture.getActiveTools(), ["question"]);
});

test("blind mode allows compaction and tree navigation", async () => {
	const fixture = await createFixture();
	await enableBlind(fixture);

	assert.equal(
		await fixture.handlers.get("session_before_compact")?.({}, fixture.ctx),
		undefined,
	);
	assert.equal(
		await fixture.handlers.get("session_before_tree")?.({}, fixture.ctx),
		undefined,
	);
});

test("resumed blind sessions include newly active global tools", async () => {
	const fixture = await createFixture({
		activeTools: ["read", "question", "project_tool", "new_project_tool"],
		branch: [
			{
				type: "custom",
				customType: "blind-state",
				data: {
					enabled: true,
					toolsBeforeBlind: ["read", "project_tool"],
				},
			},
		],
		tools: [tool("new_project_tool", "project")],
	});

	assert.deepEqual(fixture.getActiveTools(), ["question"]);

	await fixture.commands.get("blind")?.handler("off", fixture.ctx);
	assert.deepEqual(fixture.getActiveTools(), [
		"read",
		"project_tool",
		"question",
	]);
});

test("malformed persisted state is ignored", async () => {
	const fixture = await createFixture({
		branch: [
			{
				type: "custom",
				customType: "blind-state",
				data: {
					enabled: true,
					toolsBeforeBlind: ["read", "question", "project_tool"],
				},
			},
			{
				type: "custom",
				customType: "blind-state",
				data: { enabled: true, toolsBeforeBlind: 42 },
			},
		],
	});

	assert.deepEqual(fixture.getActiveTools(), ["question"]);
});

test("global tools activated during blind mode remain active and are restored", async () => {
	const fixture = await createFixture();
	await enableBlind(fixture);

	fixture.tools.push(tool("web_search", "user"));
	fixture.setActiveTools(["question", "web_search", "project_tool"]);
	await fixture.handlers.get("context")?.({ messages: [] });
	assert.deepEqual(fixture.getActiveTools(), ["question", "web_search"]);

	const callsAfterReconciliation = fixture.getSetActiveToolsCallCount();
	await fixture.handlers.get("context")?.({ messages: [] });
	assert.equal(
		fixture.getSetActiveToolsCallCount(),
		callsAfterReconciliation,
	);

	await fixture.commands.get("blind")?.handler("off", fixture.ctx);
	assert.deepEqual(fixture.getActiveTools(), [
		"read",
		"question",
		"project_tool",
		"web_search",
	]);
});

test("blind mode enables read only for user-scoped skill files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-blind-skill-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const skillDir = join(root, "user-skill");
	const skillFile = join(skillDir, "SKILL.md");
	const referenceFile = join(skillDir, "references/guide.md");
	const projectFile = join(cwd, "secret.txt");
	const escapedLink = join(skillDir, "escaped-secret.txt");
	await mkdir(join(skillDir, "references"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(skillFile, "skill instructions");
	await writeFile(referenceFile, "skill reference");
	await writeFile(projectFile, "project secret");
	await symlink(projectFile, escapedLink);

	const fixture = await createFixture({ cwd });
	await enableBlind(fixture);
	const beforeResult = await fixture.handlers.get("before_agent_start")?.({
		systemPrompt: `You are Pi's normal assistant.\nCurrent working directory: ${cwd}`,
		systemPromptOptions: {
			cwd,
			selectedTools: ["question"],
			skills: [skill("global-skill", "user", skillFile)],
		},
	});

	assert.deepEqual(fixture.getActiveTools(), ["question", "read"]);
	assert.match(beforeResult.systemPrompt, /read tool is limited to files belonging/);

	const handleToolCall = fixture.handlers.get("tool_call");
	assert.equal(
		await handleToolCall?.({ toolName: "read", input: { path: skillFile } }),
		undefined,
	);
	assert.equal(
		await handleToolCall?.({ toolName: "read", input: { path: referenceFile } }),
		undefined,
	);
	assert.equal(
		(
			await handleToolCall?.({
				toolName: "read",
				input: { path: projectFile },
			})
		).block,
		true,
	);
	assert.equal(
		(
			await handleToolCall?.({
				toolName: "read",
				input: { path: escapedLink },
			})
		).block,
		true,
	);
	assert.equal(
		(
			await handleToolCall?.({
				toolName: "read",
				input: { path: "SKILL.md" },
			})
		).block,
		true,
	);

	await fixture.handlers.get("before_agent_start")?.({
		systemPrompt: `You are Pi's normal assistant.\nCurrent working directory: ${cwd}`,
		systemPromptOptions: {
			cwd,
			selectedTools: ["question", "read"],
			skills: [],
		},
	});
	assert.deepEqual(fixture.getActiveTools(), ["question"]);
});

test("blind prompt retains user resources and removes project context", () => {
	const cwd = "/work/project";
	const agentDir = "/home/test/.pi/agent";
	const contextFiles = [
		{ path: join(agentDir, "AGENTS.md"), content: "global instructions" },
		{ path: join(cwd, "AGENTS.md"), content: "project instructions" },
	];
	const skills = [
		skill("global-skill", "user", join(agentDir, "skills/global/SKILL.md")),
		skill("project-skill", "project", join(cwd, ".pi/skills/project/SKILL.md")),
	];
	const options = {
		cwd,
		customPrompt: "You are Pi's normal assistant.",
		appendSystemPrompt: "Global append",
		selectedTools: ["read", "question"],
		contextFiles,
		skills,
	};
	const result = sanitizeBlindSystemPrompt(
		buildSystemPrompt(options),
		options,
		{ agentDir },
	);

	assert.match(result, /You are Pi's normal assistant/);
	assert.match(result, /Global append/);
	assert.match(result, /global instructions/);
	assert.match(result, /global-skill/);
	assert.match(result, /current project's working directory/);
	assert.doesNotMatch(result, /project instructions/);
	assert.doesNotMatch(result, /project-skill/);
	assert.doesNotMatch(result, /Current working directory/);
	assert.doesNotMatch(result, /blind mode/i);
});

test("blind prompt falls back safely when Pi prompt formatting changes", () => {
	const cwd = "/work/project";
	const agentDir = "/home/test/.pi/agent";
	const options = {
		cwd,
		customPrompt: "You are Pi's normal assistant.",
		selectedTools: ["read"],
		contextFiles: [
			{ path: join(agentDir, "AGENTS.md"), content: "global instructions" },
			{ path: join(cwd, "AGENTS.md"), content: "project secret" },
		],
	};
	const changedPrompt = buildSystemPrompt(options).replace(
		"Project-specific instructions and guidelines:",
		"Project instructions:",
	);

	const result = sanitizeBlindSystemPrompt(changedPrompt, options, { agentDir });
	assert.match(result, /global instructions/);
	assert.doesNotMatch(result, /project secret/);
});

test("blind prompt removes the final project append occurrence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-blind-append-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi/APPEND_SYSTEM.md"), "repeated text");
	const options = {
		cwd,
		customPrompt: "Allowed copy\n\nrepeated text",
		appendSystemPrompt: "repeated text",
		selectedTools: ["question"],
	};

	const result = sanitizeBlindSystemPrompt(buildSystemPrompt(options), options);
	assert.equal(result.match(/repeated text/g)?.length, 1);
	assert.match(result, /^Allowed copy/);
});

test("blind prompt advertises user skills without claiming it can read them", () => {
	const userSkill = skill(
		"global-skill",
		"user",
		"/home/test/.pi/agent/skills/global/SKILL.md",
	);

	const options = {
		cwd: "/work/project",
		customPrompt: "You are Pi's normal assistant.",
		selectedTools: ["question"],
		skills: [userSkill],
	};
	const result = sanitizeBlindSystemPrompt(
		buildSystemPrompt(options),
		options,
		{ agentDir: "/home/test/.pi/agent" },
	);

	assert.match(result, /global-skill/);
	assert.match(result, /only when the user invokes/);
	assert.doesNotMatch(result, /Use the read tool/);
});

test("blind prompt removes project system prompt files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-blind-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(cwd, ".pi/SYSTEM.md"), "project system secret");
	await writeFile(join(cwd, ".pi/APPEND_SYSTEM.md"), "project append secret");

	const options = {
		cwd,
		customPrompt: "project system secret",
		appendSystemPrompt: "project append secret",
		selectedTools: ["question"],
	};
	const result = sanitizeBlindSystemPrompt(
		buildSystemPrompt(options),
		options,
		{ agentDir },
	);

	assert.doesNotMatch(result, /project system secret/);
	assert.doesNotMatch(result, /project append secret/);
	assert.match(result, /^You are an AI assistant operating inside pi/);
});

test("project skills and prompts are blocked but extension commands are left alone", async () => {
	const fixture = await createFixture();
	await enableBlind(fixture);

	fixture.setAvailableCommands([
		{
			name: "project-skill",
			source: "skill",
			sourceInfo: { scope: "project" },
		},
		{
			name: "project-command",
			source: "extension",
			sourceInfo: { scope: "project" },
		},
	]);

	assert.deepEqual(
		await fixture.handlers.get("input")?.(
			{ text: "/project-skill", source: "interactive" },
			fixture.ctx,
		),
		{ action: "handled" },
	);
	assert.equal(
		await fixture.handlers.get("input")?.(
			{ text: "/project-command", source: "interactive" },
			fixture.ctx,
		),
		undefined,
	);
});
