import { Notice, Plugin, WorkspaceLeaf, debounce } from "obsidian";
import { ConnectionManager } from "./connection";
import { FavoritesIndex } from "./favorites";
import { PlayerSnapshot, PlayerStore } from "./player";
import { historyConnection, legacyHistoryConnection, type HistorySnapshot } from "./history";
import {
	DEFAULT_SETTINGS,
	StereoSettings,
	StereoSettingTab,
	migrateSettings,
} from "./settings";
import { normalizeServerConfig, type ServerConfig } from "./servers";
import {
	ShareCreateModal,
	SharesModal,
	resolveQueueShareTarget,
	type ShareTarget,
} from "./share";
import type { StationSeed } from "./station";
import { Song, SubsonicClient } from "./subsonic";
import { STEREO_VIEW_TYPE, StereoView } from "./view";

interface StereoData {
	settings: StereoSettings;
	playerState?: PlayerSnapshot;
	history?: HistorySnapshot;
}

export default class StereoPlugin extends Plugin {
	settings: StereoSettings = { ...DEFAULT_SETTINGS };
	connection: ConnectionManager = new ConnectionManager(() => this.settings);
	client: SubsonicClient = new SubsonicClient(
		() => this.settings,
		this.connection
	);
	player: PlayerStore = new PlayerStore(this.client, () => this.settings);
	favorites: FavoritesIndex = new FavoritesIndex(
		this.client,
		() => historyConnection(this.settings)
	);

	private playerState: PlayerSnapshot | undefined;
	private pendingSave: Promise<void> = Promise.resolve();
	private savePlayerState = debounce(
		() => {
			void this.saveAll();
		},
		1000,
		true
	);

	async onload(): Promise<void> {
		await this.loadDataFile();
		this.favorites.syncConnection();
		this.connection.setProbe((url) => this.client.probe(url));
		this.connection.start();

		if (this.playerState) {
			this.player.restore(this.playerState);
		}
		this.player.setPersistence((snapshot) => {
			this.playerState = snapshot;
			this.savePlayerState();
		});
		this.player.history.setPersistence(() => { void this.saveAll(); });
		this.applyVolumeControlSetting();

		this.registerView(STEREO_VIEW_TYPE, (leaf) => new StereoView(leaf, this));
		this.addSettingTab(new StereoSettingTab(this.app, this));

		this.addRibbonIcon("boom-box", "Open Stereo", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-player",
			name: "Open player",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "manage-share-links",
			name: "Manage share links",
			callback: () => {
				this.openShares();
			},
		});
	}

	onunload(): void {
		// Per Obsidian guidelines: do not detach leaves of our view type here.
		// Registered events/DOM listeners are cleaned up automatically.
		this.connection.stop();
		this.player.destroy();
		this.favorites.destroy();
		this.savePlayerState.cancel();
		void this.saveAll();
	}

	/**
	 * Toggle a song's favorite flag on the server and mirror it into the play
	 * queue. Returns the new `starred` value so callers can update their own
	 * copies. Throws on server failure.
	 */
	async toggleSongFavorite(song: Song): Promise<string | undefined> {
		const starred = await this.favorites.toggle(song);
		this.player.updateSong(song.id, { starred });
		this.player.history.updateSong(song.id, { starred });
		return starred;
	}

	/**
	 * Start a station and report the outcome — the shared entry point for the
	 * player button and the context menus. `lead` is the seeded track when the
	 * seed is a song; it plays first (or keeps playing, if it already is).
	 */
	async startStation(seed: StationSeed, lead?: Song): Promise<void> {
		try {
			const queued = await this.player.startStation(seed, lead);
			if (queued === 0) {
				new Notice("The server had no tracks to build this station from.");
				return;
			}
			new Notice(`Station started: ${seed.label}`);
		} catch {
			new Notice("Could not build the station from the server.");
		}
	}

	/** Re-apply the Now Playing view choice to open players (settings change). */
	refreshNowPlayingViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) leaf.view.applyNowPlayingView();
		}
	}

	/** Open the share dialog for one library item or a queue snapshot. */
	openShare(target: ShareTarget): void {
		new ShareCreateModal(this.app, this, target).open();
	}

	/** Open the share-link manager. */
	openShares(): void {
		new SharesModal(this.app, this).open();
	}

	/** Switch the active server and reload the views. */
	async setActiveServer(id: string): Promise<void> {
		if (
			!this.settings.servers.some((server) => server.id === id) ||
			id === this.settings.activeServerId
		) {
			return;
		}
		this.settings.activeServerId = id;
		this.connection.reset();
		this.favorites.syncConnection();
		this.player.syncConnection();
		await this.saveAll();
		this.refreshAllViews();
	}

	/** Insert or update a server configuration. */
	async upsertServer(server: ServerConfig): Promise<void> {
		const normalized = normalizeServerConfig(server);
		const index = this.settings.servers.findIndex(
			(entry) => entry.id === normalized.id
		);
		if (index >= 0) this.settings.servers[index] = normalized;
		else this.settings.servers.push(normalized);
		if (
			!this.settings.servers.some(
				(entry) => entry.id === this.settings.activeServerId
			)
		) {
			this.settings.activeServerId = this.settings.servers[0]?.id ?? "";
		}
		this.connection.reset();
		this.favorites.syncConnection();
		this.player.syncConnection();
		await this.saveAll();
		this.refreshAllViews();
	}

	/** Remove a server, selecting another one when the active one is deleted. */
	async deleteServer(id: string): Promise<void> {
		this.settings.servers = this.settings.servers.filter(
			(server) => server.id !== id
		);
		if (this.settings.activeServerId === id) {
			this.settings.activeServerId = this.settings.servers[0]?.id ?? "";
		}
		this.connection.reset();
		this.favorites.syncConnection();
		this.player.syncConnection();
		await this.saveAll();
		this.refreshAllViews();
	}

	private refreshAllViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) leaf.view.reloadForConnection();
		}
	}

	/** Resolve the current queue to its album/playlist source or a snapshot. */
	async openShareQueue(): Promise<void> {
		const state = this.player.getState();
		const target = await resolveQueueShareTarget(
			state.queue,
			state.queueOrigin,
			this.client
		);
		if (!target) {
			new Notice("The queue has no shareable tracks.");
			return;
		}
		this.openShare(target);
	}

	/** Update share-button visibility in every open player. */
	syncShareUi(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) leaf.view.syncShareUi();
		}
	}

	/** When the volume control is disabled, output stays at 100% and only the
	 * device controls loudness. */
	applyVolumeControlSetting(): void {
		if (!this.settings.volumeControl && this.player.getState().volume !== 1) {
			this.player.setVolume(1);
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(STEREO_VIEW_TYPE)[0] ?? null;

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: STEREO_VIEW_TYPE, active: true });
		}

		await workspace.revealLeaf(leaf);
	}

	private async loadDataFile(): Promise<void> {
		const raw = (await this.loadData()) as
			| (Partial<StereoData> & Record<string, unknown>)
			| null;
		if (!raw) {
			this.player.history.restore(undefined, historyConnection(this.settings));
			return;
		}

		// Current shape: { settings, playerState, history }. Legacy shape: flat settings.
		const settingsRaw = (raw.settings ?? raw) as Record<string, unknown>;
		this.settings = {
			...DEFAULT_SETTINGS,
			...migrateSettings(settingsRaw),
		};
		const connection = historyConnection(this.settings);
		const legacyConnection = legacyHistoryConnection(this.settings);
		// A server URL or username saved mid-edit still carries the previous
		// account's queue; the history snapshot names the account it belongs to.
		// Data from before history support has no snapshot and keeps its queue.
		const historyRaw = raw.history as
			| { connection?: unknown; entries?: unknown }
			| undefined;
		const savedConnection = historyRaw?.connection;
		const sameAccount =
			savedConnection === connection || savedConnection === legacyConnection;
		this.playerState =
			savedConnection === undefined || sameAccount
				? raw.playerState
				: undefined;
		const historySnapshot =
			sameAccount && historyRaw
				? { ...historyRaw, connection }
				: raw.history;
		this.player.history.restore(historySnapshot, connection);
	}

	async saveSettings(): Promise<void> {
		await this.saveAll();
	}

	/**
	 * Apply a finished server URL or username edit: drop the previous account's
	 * history, queue and undo. Called when the field is left, not per keystroke,
	 * so correcting a typo does not throw the current session away.
	 */
	async commitConnection(): Promise<void> {
		this.favorites.syncConnection();
		this.player.syncConnection();
		await this.saveAll();
	}

	private async saveAll(): Promise<void> {
		const data: StereoData = {
			settings: { ...this.settings },
			playerState: this.playerState,
			history: this.player.history.getSnapshot(),
		};
		// Keep an earlier playback save from overwriting a later history clear.
		this.pendingSave = this.pendingSave.then(() => this.saveData(data)).catch(() => {
			new Notice("Could not save Stereo data.");
		});
		await this.pendingSave;
	}
}
