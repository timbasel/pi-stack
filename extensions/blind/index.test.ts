import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import blindExtension from "./index.ts";

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
	setActiveTools(names: string[]): void;
	setAvailableCommands(commands: MockCommand[]): void;
}

function tool(name: string, scope: Scope): MockTool {
	return {
		name,
		description: name,
		parameters: {},
		sourceInfo: { path: `<${scope}:${name}>`, source: scope, scope },
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
			activeTools = [...names];
		},
		getCommands() {
			return availableCommands;
		},
	};
	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			notify() {},
		},
		sessionManager: {
			getBranch() {
				return options.branch ?? [];
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
		setActiveTools: (names) => {
			activeTools = [...names];
		},
		setAvailableCommands: (nextCommands) => {
			availableCommands = nextCommands;
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

	const timestamp = Date.now() + 1;
	const result = await fixture.handlers.get("context")?.({
		messages: [
			{ role: "user", timestamp: 0 },
			{ role: "user", timestamp },
			{ role: "assistant", timestamp },
			{ role: "toolResult", timestamp, toolName: "question" },
		],
	});
	assert.deepEqual(
		result.messages.map((message: { role: string }) => message.role),
		["user", "assistant", "toolResult"],
	);

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

test("resumed blind sessions include newly active global tools", async () => {
	const fixture = await createFixture({
		activeTools: ["read", "question", "project_tool", "new_project_tool"],
		branch: [
			{
				type: "custom",
				customType: "blind-state",
				data: {
					enabled: true,
					enabledAt: Date.now() - 1000,
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

test("global tools activated during blind mode remain active and are restored", async () => {
	const fixture = await createFixture();
	await enableBlind(fixture);

	fixture.tools.push(tool("web_search", "user"));
	fixture.setActiveTools(["question", "web_search", "project_tool"]);
	await fixture.handlers.get("context")?.({ messages: [] });
	assert.deepEqual(fixture.getActiveTools(), ["question", "web_search"]);

	await fixture.commands.get("blind")?.handler("off", fixture.ctx);
	assert.deepEqual(fixture.getActiveTools(), [
		"read",
		"question",
		"project_tool",
		"web_search",
	]);
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
