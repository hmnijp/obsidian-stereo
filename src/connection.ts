import {
	activeServer,
	serverApiUrl,
	type ServerConfig,
	type ServerSettingsShape,
} from "./servers";

export type ProbeUrl = (url: string) => Promise<boolean>;

/**
 * Picks LAN or WAN for API requests. LAN is preferred in auto mode until a
 * probe or a failed request marks it unavailable; probeNow() brings it back.
 */
export class ConnectionManager {
	private getSettings: () => ServerSettingsShape;
	private probe: ProbeUrl | null = null;
	private timer: number | null = null;
	private lanAvailable: boolean | null = null;
	private probeKey = "";
	private probing = false;

	constructor(getSettings: () => ServerSettingsShape) {
		this.getSettings = getSettings;
	}

	setProbe(probe: ProbeUrl): void {
		this.probe = probe;
	}

	start(): void {
		if (this.timer !== null || typeof window === "undefined") return;
		this.timer = window.setInterval(() => {
			void this.probeNow();
		}, 60_000);
		void this.probeNow();
	}

	stop(): void {
		if (this.timer === null) return;
		window.clearInterval(this.timer);
		this.timer = null;
	}

	/** Forget LAN availability and probe again after a server/config change. */
	reset(): void {
		this.lanAvailable = null;
		this.probeKey = "";
		void this.probeNow();
	}

	activeServer(): ServerConfig | null {
		return activeServer(this.getSettings());
	}

	currentUrl(): string {
		const server = this.activeServer();
		if (!server) return "";
		if (server.connectionMode === "wan") {
			return server.wanUrl || server.lanUrl;
		}
		if (server.connectionMode === "lan") {
			return server.lanUrl || server.wanUrl;
		}
		if (!server.lanUrl) return server.wanUrl;
		return this.lanAvailable === false
			? server.wanUrl || server.lanUrl
			: server.lanUrl;
	}

	/** Fallback used once for JSON requests when the active URL is unreachable. */
	fallbackUrl(): string | null {
		const server = this.activeServer();
		if (!server || server.connectionMode !== "auto") return null;
		const current = this.currentUrl();
		const alternative =
			current === server.lanUrl ? server.wanUrl : server.lanUrl;
		return alternative && alternative !== current ? alternative : null;
	}

	activeKind(): "lan" | "wan" | null {
		const server = this.activeServer();
		const current = this.currentUrl();
		if (!server || !current) return null;
		return current === server.lanUrl ? "lan" : "wan";
	}

	/** Let the client report whether a request through this base worked. */
	noteRequest(baseUrl: string, ok: boolean): void {
		const server = this.activeServer();
		if (!server?.lanUrl) return;
		if (baseUrl === server.lanUrl) this.lanAvailable = ok;
	}

	/** Probe the configured LAN address; auto mode falls back to WAN on failure. */
	async probeNow(): Promise<void> {
		const server = this.activeServer();
		if (!server) {
			this.lanAvailable = null;
			this.probeKey = "";
			return;
		}

		const key = `${server.id}|${server.lanUrl}|${server.connectionMode}`;
		if (key !== this.probeKey) {
			this.probeKey = key;
			this.lanAvailable = null;
		}

		if (!server.lanUrl || server.connectionMode === "wan") {
			this.lanAvailable = false;
			return;
		}
		if (!this.probe || this.probing) return;

		this.probing = true;
		try {
			const available = await this.probe(server.lanUrl);
			if (key === this.probeKey) this.lanAvailable = available;
		} finally {
			this.probing = false;
		}
	}
}
