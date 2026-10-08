/**
 * Oak fork: local models only.
 *
 * Every model request must target a loopback endpoint (127.0.0.0/8, localhost, ::1). This module is
 * the single definition of "local" shared by the model runtime, the stream funnels and the HTTP layer,
 * so cloud endpoints are refused at the last moment even if a provider or models.json entry slips
 * through composition-time validation.
 */
import { lazyStream } from "./api/lazy.ts";
import type { Api, AssistantMessageEventStream, Model } from "./types.ts";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]"]);
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/u;

/** Chat APIs a local server can speak. `faux` is the offline in-memory test provider (no network). */
const LOCAL_CHAT_APIS = ["openai-completions", "openai-responses"];

/** True for http(s)/ws(s) URLs whose host is a loopback address. Missing or malformed URLs are not local. */
export function isLoopbackUrl(value: string | undefined): boolean {
	if (!value) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
		return false;
	}
	const host = url.hostname.toLowerCase();
	return LOOPBACK_HOSTNAMES.has(host) || IPV4_LOOPBACK.test(host);
}

/** True for chat APIs that local servers implement. */
export function isLocalChatApi(api: string): boolean {
	return LOCAL_CHAT_APIS.includes(api) || api === "faux" || api.startsWith("faux:");
}

export class NonLoopbackEndpointError extends Error {
	constructor(baseUrl: string | undefined, subject?: string) {
		super(
			`Refusing to contact ${baseUrl ? `"${baseUrl}"` : "an endpoint without a base URL"}${subject ? ` for ${subject}` : ""}: this build only allows local models (loopback endpoints such as http://127.0.0.1:8080/v1).`,
		);
		this.name = "NonLoopbackEndpointError";
	}
}

/** Throws unless `baseUrl` is a loopback endpoint. */
export function assertLoopbackBaseUrl(baseUrl: string | undefined, subject?: string): void {
	if (!isLoopbackUrl(baseUrl)) throw new NonLoopbackEndpointError(baseUrl, subject);
}

/** An error-terminated stream for `model`, used when a direct stream call would leave the machine. */
export function blockedStream<TApi extends Api>(model: Model<TApi>): AssistantMessageEventStream {
	return lazyStream(model as Model<Api>, async () => {
		throw new NonLoopbackEndpointError(model.baseUrl, `${model.provider}/${model.id}`);
	});
}
