import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

/** Oak fork: only loopback models can be configured, listed or used. */
describe("local models only", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-local-only-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function registryFor(providers: Record<string, unknown>) {
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers }));
		return createModelRegistry(AuthStorage.inMemory(), modelsPath, { fixtures: false });
	}

	const local = {
		baseUrl: "http://127.0.0.1:8080/v1",
		api: "openai-completions",
		models: [{ id: "local-model", contextWindow: 8192 }],
	};

	it("has no built-in cloud providers", async () => {
		const registry = await registryFor({});
		expect(registry.getAll()).toEqual([]);
		expect(registry.getAvailable()).toEqual([]);
	});

	it("lists a keyless loopback provider as available", async () => {
		const registry = await registryFor({ local });
		const ids = registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
		expect(ids).toEqual(["local/local-model"]);
		const model = registry.find("local", "local-model");
		expect(model).toBeDefined();
		expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({ ok: true, apiKey: "local" });
	});

	it("rejects a cloud base URL and reports why", async () => {
		const registry = await registryFor({
			local,
			cloud: {
				baseUrl: "https://api.openai.com/v1",
				api: "openai-completions",
				apiKey: "sk-real-looking-key",
				models: [{ id: "gpt-x" }],
			},
		});
		expect(registry.getAvailable().map((m) => m.provider)).toEqual(["local"]);
		expect(registry.find("cloud", "gpt-x")).toBeUndefined();
		expect(registry.getError()).toContain("only loopback endpoints");
	});

	it("rejects a LAN address and non-OpenAI-compatible APIs", async () => {
		const registry = await registryFor({
			lan: { ...local, baseUrl: "http://192.168.1.20:8080/v1" },
			anthropicish: { ...local, api: "anthropic-messages" },
		});
		expect(registry.getAvailable()).toEqual([]);
		const error = registry.getError() ?? "";
		expect(error).toContain("192.168.1.20");
		expect(error).toContain("anthropic-messages");
	});

	it("refuses extension providers that use OAuth or a remote endpoint", async () => {
		const registry = await registryFor({});
		const model = {
			id: "m",
			name: "m",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		};
		expect(() =>
			registry.registerProvider("ext-oauth", {
				baseUrl: "http://127.0.0.1:1/v1",
				api: "openai-completions",
				oauth: {
					name: "Ext",
					login: async () => ({ refresh: "", access: "", expires: 0 }),
					refreshToken: async (c) => c,
					getApiKey: () => "k",
				},
				models: [model],
			}),
		).toThrow(/OAuth providers are not supported/);
		expect(() =>
			registry.registerProvider("ext-cloud", {
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				apiKey: "k",
				models: [model],
			}),
		).toThrow(/only loopback endpoints/);
	});

	it("ignores API keys in the environment", async () => {
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-from-env";
		try {
			const registry = await registryFor({
				local: { ...local, apiKey: "$OPENAI_API_KEY" },
			});
			const model = registry.find("local", "local-model");
			// "$OPENAI_API_KEY" cannot resolve (the environment is not readable), so the model is not usable.
			expect(model && registry.hasConfiguredAuth(model)).toBeFalsy();
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});

	it("removes /login, /logout, /share and /bug", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		for (const removed of ["login", "logout", "share", "bug"]) expect(names).not.toContain(removed);
		expect(names).toContain("model");
	});

	it("has no --api-key option", () => {
		expect((parseArgs(["--api-key", "sk-test"]) as { apiKey?: string }).apiKey).toBeUndefined();
	});

	it("blocks global fetch to non-loopback hosts but allows loopback", async () => {
		configureHttpDispatcher();
		await expect(fetch("https://example.com/")).rejects.toThrow();
		// Loopback is permitted; nothing listens on port 1, so the failure must be a connection error, not a refusal.
		const error = await fetch("http://127.0.0.1:1/").catch((e: unknown) => e);
		expect(String((error as { cause?: unknown })?.cause ?? error)).not.toContain("Refusing to contact");
	});
});
