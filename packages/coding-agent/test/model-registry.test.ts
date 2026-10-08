import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AnthropicMessagesCompat, Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai/compat";
import { getApiProvider, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache, type ModelRegistry, type ProviderConfigInput } from "../src/core/model-registry.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.inMemory();
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
		vi.restoreAllMocks();
	});

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "openai-completions",
	): ProviderConfigInput {
		return {
			baseUrl,
			apiKey: "test-key",
			api: api as Api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function _writeModelsJson(providers: Record<string, ReturnType<typeof providerConfig>>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	const openAiModel: Model<Api> = {
		id: "test-openai-model",
		name: "Test OpenAI Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const emptyContext = normalizeContext({
		messages: [],
	});

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("overriding headers resolves at request time", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				const auth = await registry.getApiKeyAndHeaders(model);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.headers?.["X-Custom-Header"]).toBe("custom-value");
				}
			}
		});

		test("headers-only override resolves at request time", async () => {
			writeRawModelsJson({
				anthropic: {
					headers: {
						"X-Custom-Header": "custom-value",
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				const auth = await registry.getApiKeyAndHeaders(model);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.headers?.["X-Custom-Header"]).toBe("custom-value");
				}
			}
		});

		test("unconfigured compatibility auth includes static model headers", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const base = registry.getAll()[0];
			const model = {
				...base,
				provider: "missing-provider",
				headers: { "X-Static-Model": "static-value" },
			};

			const auth = await registry.getApiKeyAndHeaders(model);

			expect(auth).toEqual({ ok: true, headers: { "X-Static-Model": "static-value" } });
		});
	});

	describe("custom models merge behavior", () => {
		test("non-built-in provider custom models still require baseUrl", async () => {
			writeRawModelsJson({
				"my-custom-provider": {
					apiKey: "test-key",
					models: [
						{
							id: "my-model",
							api: "openai-completions",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getError()).toContain("baseUrl");
		});

		test("reports every provider composition error", async () => {
			writeRawModelsJson({
				"broken-one": { api: "openai-completions", models: [{ id: "one" }] },
				"broken-two": { api: "openai-completions", models: [{ id: "two" }] },
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const error = registry.getError();

			expect(error).toContain('Provider "broken-one"');
			expect(error).toContain('Provider "broken-two"');
		});

		test("provider-level compat applies to custom models", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});

		test("model schema accepts thinkingLevelMap and compat schema accepts supportsStrictMode and cacheControlFormat", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							thinkingLevelMap: {
								minimal: null,
								high: "max",
							},
							compat: {
								supportsStrictMode: false,
								cacheControlFormat: "anthropic",
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			const compat = model?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(model?.thinkingLevelMap).toEqual({ minimal: null, high: "max" });
			expect(compat?.supportsStrictMode).toBe(false);
			expect(compat?.cacheControlFormat).toBe("anthropic");
		});

		test("compat schema accepts chat template thinking configuration", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "kwargs-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								thinkingFormat: "chat-template",
								chatTemplateKwargs: {
									preserve_thinking: true,
									thinking: { $var: "thinking.enabled" },
								},
							},
						},
						{
							id: "args-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								thinkingFormat: "baseten",
								chatTemplateArgs: {
									enable_thinking: { $var: "thinking.enabled" },
								},
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const kwargsCompat = registry.find("demo", "kwargs-model")?.compat as OpenAICompletionsCompat | undefined;
			const argsCompat = registry.find("demo", "args-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(kwargsCompat?.thinkingFormat).toBe("chat-template");
			expect(kwargsCompat?.chatTemplateKwargs).toEqual({
				preserve_thinking: true,
				thinking: { $var: "thinking.enabled" },
			});
			expect(argsCompat?.thinkingFormat).toBe("baseten");
			expect(argsCompat?.chatTemplateArgs).toEqual({
				enable_thinking: { $var: "thinking.enabled" },
			});
		});

		test("compat schema accepts Anthropic eager tool input streaming flag", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsEagerToolInputStreaming: false,
					},
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as AnthropicMessagesCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.supportsEagerToolInputStreaming).toBe(false);
		});

		test("compat schema accepts long cache retention flag", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsLongCacheRetention: false,
					},
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as AnthropicMessagesCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.supportsLongCacheRetention).toBe(false);
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		// Regression test for https://github.com/earendil-works/pi/issues/9631
		test("model override deep-merges image resize limits", async () => {
			writeRawModelsJson({
				test: {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "test-key",
					api: "openai-completions",
					models: [
						{
							id: "vision-model",
							input: ["text", "image"],
							inputLimits: {
								maxRequestBytes: 32 * 1024 * 1024,
								images: {
									maxPerRequest: 100,
									resize: {
										maxWidth: 2000,
										maxHeight: 2000,
										maxBytes: 4.5 * 1024 * 1024,
										jpegQuality: 80,
									},
								},
							},
						},
					],
					modelOverrides: {
						"vision-model": {
							inputLimits: {
								images: { resize: { maxWidth: 1568, maxBytes: 524288, jpegQuality: 75 } },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("test", "vision-model");

			expect(registry.getError()).toBeUndefined();
			expect(model?.inputLimits).toMatchObject({
				maxRequestBytes: 32 * 1024 * 1024,
				images: {
					maxPerRequest: 100,
					resize: { maxWidth: 1568, maxHeight: 2000, maxBytes: 524288, jpegQuality: 75 },
				},
			});
		});

		test("model override for non-existent model ID is ignored", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});
	});

	describe("dynamic provider lifecycle", () => {
		test("modelOverrides apply to dynamically registered provider models", async () => {
			writeRawModelsJson({
				"extension-provider": {
					modelOverrides: {
						"extension-model": {
							name: "Overridden Extension Model",
							thinkingLevelMap: {
								off: null,
								minimal: null,
								low: null,
								medium: null,
								xhigh: "max",
							},
							headers: { "x-model-override": "enabled" },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("extension-provider", {
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "extension-model",
						name: "Extension Model",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			const model = registry.find("extension-provider", "extension-model");
			expect(model).toBeDefined();
			if (!model) {
				throw new Error("extension model was not registered");
			}
			expect(model.name).toBe("Overridden Extension Model");
			expect(model.thinkingLevelMap).toEqual({
				off: null,
				minimal: null,
				low: null,
				medium: null,
				xhigh: "max",
			});
			expect(getSupportedThinkingLevels(model)).toEqual(["high", "xhigh"]);
			expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
				ok: true,
				headers: { "x-model-override": "enabled" },
			});
		});

		test("failed registerProvider does not persist invalid streamSimple config", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			await expect(registry.refresh()).resolves.toMatchObject({ aborted: false });
		});

		test("failed registerProvider does not remove existing provider models", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("demo-provider", {
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();

			expect(() =>
				registry.registerProvider("demo-provider", {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "test-key",
					models: [
						{
							id: "broken-model",
							name: "Broken Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				}),
			).toThrow('Provider demo-provider, model broken-model: no "api" specified.');

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
			await expect(registry.refresh()).resolves.toMatchObject({ aborted: false });
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("streamSimple overlays do not mutate the global compat API registry", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(false);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister =
					error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});
	});

	describe("API key resolution", () => {
		/** Create provider config with custom apiKey */
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey,
				api: "openai-completions",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!exit 1"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf ''"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with $ prefix resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("$TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey with braced env syntax resolves to env value", async () => {
			const originalEnv = process.env.TEST_BRACED_API_KEY_12345;
			process.env.TEST_BRACED_API_KEY_12345 = "braced-env-api-key-value";
			const bracedKey = "$" + "{TEST_BRACED_API_KEY_12345}";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(bracedKey),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("braced-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_BRACED_API_KEY_12345;
				} else {
					process.env.TEST_BRACED_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey interpolates braced env references inside literals", async () => {
			const originalPartA = process.env.TEST_INTERPOLATED_PART_A_12345;
			const originalPartB = process.env.TEST_INTERPOLATED_PART_B_12345;
			process.env.TEST_INTERPOLATED_PART_A_12345 = "left";
			process.env.TEST_INTERPOLATED_PART_B_12345 = "right";
			const interpolatedKey = ["$", "{TEST_INTERPOLATED_PART_A_12345}_$", "{TEST_INTERPOLATED_PART_B_12345}"].join(
				"",
			);

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(interpolatedKey),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("left_right");
			} finally {
				if (originalPartA === undefined) {
					delete process.env.TEST_INTERPOLATED_PART_A_12345;
				} else {
					process.env.TEST_INTERPOLATED_PART_A_12345 = originalPartA;
				}
				if (originalPartB === undefined) {
					delete process.env.TEST_INTERPOLATED_PART_B_12345;
				} else {
					process.env.TEST_INTERPOLATED_PART_B_12345 = originalPartB;
				}
			}
		});

		test("apiKey with $$ prefix escapes a leading dollar", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("$$TEST_API_KEY_12345"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("$TEST_API_KEY_12345");
		});

		test("apiKey with $! escapes a literal bang and still interpolates later env refs", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("$!literal-$TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("!literal-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("plain apiKey is used directly even when it matches an env var", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("TEST_API_KEY_12345");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("hello-world");
		});

		describe("request-time resolution", () => {
			test("command is executed on every provider lookup", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(3);
			});

			test("commands are re-executed across registry instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry1 = await createModelRegistry(authStorage, modelsJsonPath);
				await registry1.getApiKeyForProvider("custom-provider");

				const registry2 = await createModelRegistry(authStorage, modelsJsonPath);
				await registry2.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands resolve independently", async () => {
				writeRawModelsJson({
					"provider-a": providerWithApiKey("!echo key-a"),
					"provider-b": providerWithApiKey("!echo key-b"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				const keyA = await registry.getApiKeyForProvider("provider-a");
				const keyB = await registry.getApiKeyForProvider("provider-b");

				expect(keyA).toBe("key-a");
				expect(keyB).toBe("key-b");
			});

			test("failed commands are retried", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const key1 = await registry.getApiKeyForProvider("custom-provider");
				const key2 = await registry.getApiKeyForProvider("custom-provider");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("provider auth status reports apiKey environment variables from models.json", async () => {
				const envVarName = "TEST_API_KEY_STATUS_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "status-test-key";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: envVarName,
					});
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports interpolated apiKey environment variables", async () => {
				const envVarNameA = "TEST_API_KEY_STATUS_PART_A_98765";
				const envVarNameB = "TEST_API_KEY_STATUS_PART_B_98765";
				const originalEnvA = process.env[envVarNameA];
				const originalEnvB = process.env[envVarNameB];
				process.env[envVarNameA] = "left";
				process.env[envVarNameB] = "right";
				const interpolatedKey = ["$", "{", envVarNameA, "}_$", "{", envVarNameB, "}"].join("");

				try {
					writeRawModelsJson({
						"custom-provider": providerWithApiKey(interpolatedKey),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: `${envVarNameA}, ${envVarNameB}`,
					});
				} finally {
					if (originalEnvA === undefined) {
						delete process.env[envVarNameA];
					} else {
						process.env[envVarNameA] = originalEnvA;
					}
					if (originalEnvB === undefined) {
						delete process.env[envVarNameB];
					} else {
						process.env[envVarNameB] = originalEnvB;
					}
				}
			});

			test("provider auth status reports non-env apiKey values from models.json as a config key", async () => {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("literal_api_key_value"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_key",
				});
			});

			test("missing explicit env apiKey keeps provider unavailable", async () => {
				const envVarName = "TEST_API_KEY_MISSING_TEST_98765";
				const originalEnv = process.env[envVarName];
				delete process.env[envVarName];

				try {
					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({ configured: false });
					expect(registry.getAvailable().some((model) => model.provider === "custom-provider")).toBe(false);
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports command apiKey values from models.json without executing them", async () => {
				const counterFile = join(tempDir, "status-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'echo 1 > "${counterPath}"; echo key-value'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_command",
				});
				expect(readFileSync(counterFile, "utf-8")).toBe("0");
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					const key1 = await registry.getApiKeyForProvider("custom-provider");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await registry.getApiKeyForProvider("custom-provider");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("getAvailable does not execute command-backed apiKey resolution", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const available = registry.getAvailable();

				expect(available.some((m) => m.provider === "custom-provider")).toBe(true);
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(0);
			});

			test("getApiKeyAndHeaders resolves authHeader on every request", async () => {
				const tokenFile = join(tempDir, "token");
				writeFileSync(tokenFile, "token-1");
				const tokenPath = toShPath(tokenFile);

				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(`!sh -c 'cat "${tokenPath}"'`),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth1 = await registry.getApiKeyAndHeaders(model!);
				expect(auth1).toEqual({
					ok: true,
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});

				writeFileSync(tokenFile, "token-2");

				const auth2 = await registry.getApiKeyAndHeaders(model!);
				expect(auth2).toEqual({
					ok: true,
					apiKey: "token-2",
					headers: { Authorization: "Bearer token-2" },
				});
			});

			test("getApiKeyAndHeaders resolves configured auth exactly once", async () => {
				const counterFile = join(tempDir, "auth-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(
							`!sh -c 'count=$(cat "${counterPath}"); count=$((count + 1)); echo "$count" > "${counterPath}"; echo "token-$count"'`,
						),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const auth = await registry.getApiKeyAndHeaders(registry.find("custom-provider", "test-model")!);

				expect(auth).toEqual({
					ok: true,
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});
				expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");
			});

			test("stored credentials bypass lower-priority configured auth commands", async () => {
				const counterFile = join(tempDir, "fallback-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(`!sh -c 'echo 1 > "${counterPath}"; echo fallback-key'`),
				});
				await authStorage.modify("custom-provider", async () => ({ type: "api_key", key: "stored-key" }));

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const auth = await registry.getApiKeyAndHeaders(registry.find("custom-provider", "test-model")!);

				expect(auth).toMatchObject({ ok: true, apiKey: "stored-key" });
				expect(readFileSync(counterFile, "utf-8").trim()).toBe("0");
			});

			test("getApiKeyAndHeaders returns an error for failed authHeader resolution", async () => {
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey("!exit 1"),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth = await registry.getApiKeyAndHeaders(model!);
				expect(auth.ok).toBe(false);
				if (!auth.ok) {
					expect(auth.error).toContain('Failed to resolve API key for provider "custom-provider"');
				}
			});
		});
	});
});
