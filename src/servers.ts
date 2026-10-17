/** How Stereo chooses between a server's LAN and WAN addresses. */
export type ConnectionMode = "auto" | "wan" | "lan";

export const CONNECTION_MODE_OPTIONS: ReadonlyArray<{
	value: ConnectionMode;
	label: string;
}> = [
	{ value: "auto", label: "Auto (LAN first)" },
	{ value: "wan", label: "WAN only" },
	{ value: "lan", label: "LAN only" },
];

export function connectionModeLabel(mode: ConnectionMode): string {
	return (
		CONNECTION_MODE_OPTIONS.find((option) => option.value === mode)?.label ??
		mode
	);
}

/** One saved server/account. The same URLs may appear with different logins. */
export interface ServerConfig {
	id: string;
	name: string;
	wanUrl: string;
	lanUrl: string;
	shareBaseUrl: string;
	username: string;
	password: string;
	connectionMode: ConnectionMode;
}

/** The subset of settings needed to resolve the active server. */
export interface ServerSettingsShape {
	servers?: ServerConfig[];
	activeServerId?: string;
	/** Legacy single-server fields, migrated on load. */
	serverUrl?: string;
	username?: string;
	password?: string;
	shareBaseUrl?: string;
}

export function createServerId(): string {
	const cryptoApi = globalThis.crypto;
	if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `server-${Date.now().toString(36)}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
}

export function normalizeServerConfig(
	raw: Partial<ServerConfig> | Record<string, unknown>
): ServerConfig {
	const mode =
		raw.connectionMode === "wan" || raw.connectionMode === "lan"
			? raw.connectionMode
			: "auto";
	const text = (value: unknown): string =>
		typeof value === "string" ? value.trim() : "";
	return {
		id: text(raw.id) || createServerId(),
		name: text(raw.name),
		wanUrl: text(raw.wanUrl),
		lanUrl: text(raw.lanUrl),
		shareBaseUrl: text(raw.shareBaseUrl),
		username: text(raw.username),
		password: typeof raw.password === "string" ? raw.password : "",
		connectionMode: mode,
	};
}

/** The selected server, falling back to the first one or legacy settings. */
export function activeServer(
	settings: ServerSettingsShape
): ServerConfig | null {
	const servers = Array.isArray(settings.servers)
		? settings.servers
		: [];
	const selected =
		servers.find((server) => server.id === settings.activeServerId) ??
		servers[0];
	if (selected) return normalizeServerConfig(selected);

	const legacyUrl = (settings.serverUrl ?? "").trim();
	const legacyUser = settings.username ?? "";
	const legacyPass = settings.password ?? "";
	if (!legacyUrl && !legacyUser && !legacyPass) return null;
	return normalizeServerConfig({
		id: "legacy",
		name: "Server",
		wanUrl: legacyUrl,
		lanUrl: "",
		shareBaseUrl: settings.shareBaseUrl ?? "",
		username: legacyUser,
		password: legacyPass,
		connectionMode: "auto",
	});
}

/** The URL for API requests, before any live LAN availability check. */
export function serverApiUrl(
	server: ServerConfig,
	mode: ConnectionMode = server.connectionMode
): string {
	if (mode === "wan") return server.wanUrl || server.lanUrl;
	if (mode === "lan") return server.lanUrl || server.wanUrl;
	return server.lanUrl || server.wanUrl;
}

/** Public base used for share links. LAN is never preferred here. */
export function serverShareBase(server: ServerConfig): string {
	return server.shareBaseUrl || server.wanUrl || server.lanUrl;
}

export function serverLabel(server: ServerConfig): string {
	return server.name || server.wanUrl || server.username || "Server";
}
