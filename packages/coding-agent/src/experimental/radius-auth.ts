import { readFile } from "node:fs/promises";
import { normalizeRadiusGatewayUrl } from "@earendil-works/pi-ai/providers/radius-config";
import type { AuthInput } from "../cli/experimental/command-options.ts";
import { getRadiusGatewayUrl } from "../core/radius.ts";
import { resolvePath } from "../utils/paths.ts";

export { ENV_RADIUS_GATEWAY } from "../core/radius.ts";

export interface RadiusRelayAuth {
	readonly gateway: string;
	readonly token: string;
}

/** Resolve explicit or stored Radius credentials anew for every relay connection attempt. */
export class RadiusRelayAuthResolver {
	readonly #input: AuthInput | undefined;
	readonly #gateway: string;

	constructor(input?: AuthInput, gateway = getRadiusGatewayUrl()) {
		this.#input = input;
		this.#gateway = normalizeRadiusGatewayUrl(gateway);
	}

	get gateway(): string {
		return this.#gateway;
	}

	async resolve(options: {
		readonly required: boolean;
		readonly signal?: AbortSignal;
	}): Promise<RadiusRelayAuth | undefined> {
		options.signal?.throwIfAborted();
		if (process.env.PI_OFFLINE !== undefined) {
			if (options.required) throw new Error("Radius relay connections are unavailable in offline mode");
			return undefined;
		}

		const explicit = await this.#explicitToken(options.signal);
		if (explicit !== undefined) return { gateway: this.#gateway, token: explicit };

		// Oak fork: there is no login, so no stored Radius credential exists to fall back to.
		if (options.required) {
			throw new Error("Radius relay connections are unavailable in this build (local models only)");
		}
		return undefined;
	}

	async #explicitToken(signal: AbortSignal | undefined): Promise<string | undefined> {
		if (this.#input === undefined) return undefined;
		const value =
			this.#input.type === "token"
				? this.#input.token
				: await readFile(resolvePath(this.#input.path), { encoding: "utf8", signal });
		const token = value.trim();
		if (token.length === 0) throw new Error("Radius authentication token must not be empty");
		return token;
	}
}
