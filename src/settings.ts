import {
	App,
	PluginSettingTab,
	Setting,
	setIcon,
	type SettingDefinitionItem,
} from "obsidian";
import type StereoPlugin from "./main";
import { ConfirmModal, ServerEditModal } from "./modals";
import {
	activeServer,
	connectionModeLabel,
	createServerId,
	normalizeServerConfig,
	serverApiUrl,
	serverLabel,
	type ServerConfig,
} from "./servers";
import { SubsonicError, type AlbumListType } from "./subsonic";

/** What left-clicking a track row in the library does. */
export type TrackClickAction = "play" | "addToQueue" | "none";

/** Server album ordering plus client-side date, rating, and favorite sorts. */
export type AlbumSort =
	| AlbumListType
	| "releaseDate"
	| "rating"
	| "favorites";

/** Client-side ordering for the Library Tracks tab. */
export type TrackSort =
	| "title"
	| "artist"
	| "album"
	| "newest"
	| "oldest"
	| "releaseYear"
	| "releaseYearOldest"
	| "rating"
	| "favorites"
	| "plays"
	| "random";

/** How the Now Playing screen presents the current track. */
export type NowPlayingView =
	| "record"
	| "square"
	| "bars"
	| "waveform"
	| "cover"
	| "radio"
	| "boombox"
	| "stereo";

/**
 * Which visualizer internet-radio streams show. Radio has no album art and
 * cannot be audio-analysed (streams are left un-captured, so the analyser stays
 * silent), so it overrides the chosen Now Playing view while a stream is the
 * source. "follow" keeps whatever the user picked. `radio` / `boombox` reuse the
 * matching NowPlayingView values so no mapping is needed.
 */
export type RadioVisualization = "radio" | "boombox" | "follow";

/** Horizontal alignment of the lyrics panel text. */
export type LyricsAlign = "left" | "center" | "right";

/** Lifetime presets for newly created share links. */
export type ShareTtlPreset = "1h" | "24h" | "7d" | "30d" | "1y";

export const SHARE_TTL_PRESETS: ReadonlyArray<{
	value: ShareTtlPreset;
	label: string;
	ms: number;
}> = [
	{ value: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
	{ value: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
	{ value: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
	{ value: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
	{ value: "1y", label: "1 year", ms: 365 * 24 * 60 * 60 * 1000 },
];

/** Options for the internet-radio visualization dropdown. */
export const RADIO_VISUALIZATIONS: {
	value: RadioVisualization;
	label: string;
}[] = [
	{ value: "radio", label: "Radio tower" },
	{ value: "boombox", label: "Portable radio (does not react on radio)" },
	{ value: "follow", label: "Follow my chosen view" },
];

/**
 * Single source of truth for the Now Playing presentation options. Both the
 * settings dropdown and the right-click menu are built from this list, and the
 * visualizer modes are a subset of it (see isVizView), so adding a new mode is
 * a one-line change here — it then appears in every picker automatically.
 * `icon` is a Lucide id used by the context menu.
 */
export const NOW_PLAYING_VIEWS: {
	value: NowPlayingView;
	label: string;
	icon: string;
}[] = [
	{ value: "square", label: "Album art", icon: "image" },
	{ value: "record", label: "Spinning record", icon: "disc-3" },
	{ value: "waveform", label: "Visualizer: waveform", icon: "audio-waveform" },
	{ value: "bars", label: "Visualizer: frequency bars", icon: "bar-chart-3" },
	{ value: "cover", label: "Visualizer: album bars", icon: "columns-3" },
	{ value: "boombox", label: "Visualizer: portable radio", icon: "radio" },
	{ value: "stereo", label: "Visualizer: boom box", icon: "boom-box" },
	{ value: "radio", label: "Visualizer: radio tower", icon: "radio-tower" },
];

export interface StereoSettings {
	servers: ServerConfig[];
	activeServerId: string;
	/** Legacy single-server fields; only used while migrating old data. */
	serverUrl?: string;
	username?: string;
	password?: string;
	/** Legacy global share base; migrated into the first ServerConfig. */
	shareBaseUrl?: string;
	trackClickAction: TrackClickAction;
	/** Album grid order used by the Library Albums tab. */
	albumSort: AlbumSort;
	/** Album order on an artist page. */
	artistAlbumSort: AlbumSort;
	/** Track order on the Library Tracks tab. */
	trackSort: TrackSort;
	/** Use the WAN address for Navidrome browser links; LAN when off. */
	preferWanForBrowser: boolean;
	/** Report plays back to the server so play counts stay accurate. */
	scrobbleEnabled: boolean;
	/** Show the volume button and popover; when off, output stays at 100%. */
	volumeControl: boolean;
	/** Seconds the time labels and the seek-bar wheel jump by. */
	seekStep: number;
	/** Show the dice button in the extras row. */
	showRandomButton: boolean;
	/** Show the repeat button in the extras row or transport row. */
	showRepeatButton: boolean;
	/** Show the shuffle button in the extras row or transport row. */
	showShuffleButton: boolean;
	/** Show the heart button for the current track. */
	showFavoriteButton: boolean;
	/** Show the add-to-playlist button for the current track. */
	showPlaylistButton: boolean;
	/** Show the button that starts a station from the current track. */
	showStationButton: boolean;
	/** Show the share button for the current track. */
	showShareButton: boolean;
	/** Show the button that opens the current album in Navidrome. */
	showNavidromeButton: boolean;
	/** Show the button that downloads the current track to the clipboard. */
	showDownloadButton: boolean;
	/** Show the button that opens the player in a separate desktop window. */
	showNewWindowButton: boolean;
	/** Move repeat and shuffle beside Previous/Next instead of the extras row. */
	repeatShuffleInTransport: boolean;
	/** Reopen the left/right sidebar panes that were open when the plugin unloaded. */
	restoreOpenViews: boolean;
	/** Show the play/pause control in Obsidian's status bar. */
	showStatusBarPlayer: boolean;
	/** Show previous, play/pause, and next together in the status bar. */
	showStatusBarTransport: boolean;
	/** Show the server switcher in the status-bar mini player. */
	showStatusBarServers: boolean;
	/** Scale of the status-bar mini player, in percent. */
	statusBarScale: number;
	/** Persisted open state of the status-bar mini-player queue. */
	statusBarQueueOpen: boolean;
	/** Persisted open state of the status-bar mini-player lyrics. */
	statusBarLyricsOpen: boolean;
	/** Rows the status-bar queue and lyrics show before scrolling. */
	statusBarExtraRows: number;
	/** Show 1–5 star ratings in track lists. */
	showRating: boolean;
	/** Show rating and favorite controls in the album-art corners. */
	showArtOverlays: boolean;
	/** Show the rating star button in the extras row. */
	showRatingButton: boolean;
	/** Show copy actions in contextual menus. */
	contextualCopyButtons: boolean;
	/** Mark octo-fiesta streaming items with an External badge and cover frame. */
	highlightExternal: boolean;
	/** Show share actions and the share-link manager. */
	sharingEnabled: boolean;
	/** Preselected lifetime for new share links. */
	shareDefaultTtl: ShareTtlPreset;
	/** Initial state of the Allow downloads checkbox. */
	shareDownloadsByDefault: boolean;
	/** Tracks added per station batch. */
	stationBatchSize: number;
	/** Keep the play history and the queue when the active server changes. */
	keepPlaybackAcrossServers: boolean;
	nowPlayingView: NowPlayingView;
	/** Which visualizer internet-radio streams show (overrides nowPlayingView). */
	radioVisualization: RadioVisualization;
	/** Look up lyrics on LRCLIB when the server has none. */
	lyricsOnlineLookup: boolean;
	lyricsFontSize: number;
	/** Scale the lyrics text with the panel size instead of the fixed px value. */
	lyricsAutoSize: boolean;
	/** Empty string means the theme's text font. */
	lyricsFontFamily: string;
	lyricsAlign: LyricsAlign;
	searchDebounceMs: number;
	searchArtistCount: number;
	searchAlbumCount: number;
	searchSongCount: number;
}

export const DEFAULT_SETTINGS: StereoSettings = {
	servers: [],
	activeServerId: "",
	trackClickAction: "play",
	albumSort: "alphabeticalByName",
	artistAlbumSort: "releaseDate",
	trackSort: "title",
	preferWanForBrowser: true,
	scrobbleEnabled: true,
	volumeControl: true,
	seekStep: 5,
	showRandomButton: true,
	showRepeatButton: true,
	showShuffleButton: true,
	showFavoriteButton: true,
	showPlaylistButton: true,
	showStationButton: true,
	showShareButton: true,
	showNavidromeButton: true,
	showDownloadButton: true,
	showNewWindowButton: true,
	repeatShuffleInTransport: false,
	restoreOpenViews: true,
	showStatusBarPlayer: true,
	showStatusBarTransport: false,
	showStatusBarServers: true,
	statusBarScale: 100,
	statusBarQueueOpen: false,
	statusBarLyricsOpen: false,
	statusBarExtraRows: 7,
	showRating: false,
	showArtOverlays: true,
	showRatingButton: true,
	contextualCopyButtons: true,
	highlightExternal: true,
	sharingEnabled: true,
	shareDefaultTtl: "7d",
	shareDownloadsByDefault: false,
	stationBatchSize: 30,
	keepPlaybackAcrossServers: false,
	nowPlayingView: "record",
	radioVisualization: "radio",
	lyricsOnlineLookup: true,
	lyricsFontSize: 16,
	lyricsAutoSize: false,
	lyricsFontFamily: "",
	lyricsAlign: "left",
	searchDebounceMs: 300,
	searchArtistCount: 4,
	searchAlbumCount: 4,
	searchSongCount: 10,
};

/**
 * Convert legacy flat server fields into the multi-server shape. Existing
 * history/queue hashes stay valid because they use the WAN URL and username.
 */
export function migrateSettings(
	raw: Record<string, unknown>
): Partial<StereoSettings> {
	const rawServers = Array.isArray(raw.servers) ? raw.servers : [];
	const servers = rawServers
		.filter((value): value is Record<string, unknown> => !!value && typeof value === "object")
		.map((value) => normalizeServerConfig(value));
	if (servers.length > 0) {
		const activeServerId =
			typeof raw.activeServerId === "string" &&
			servers.some((server) => server.id === raw.activeServerId)
				? raw.activeServerId
				: servers[0]?.id ?? "";
		const {
			serverUrl: _serverUrl,
			username: _username,
			password: _password,
			shareBaseUrl: _shareBaseUrl,
			...rest
		} = raw;
		return {
			...(rest as Partial<StereoSettings>),
			servers,
			activeServerId,
		};
	}

	const legacyUrl = typeof raw.serverUrl === "string" ? raw.serverUrl.trim() : "";
	const legacyUser = typeof raw.username === "string" ? raw.username : "";
	const legacyPass = typeof raw.password === "string" ? raw.password : "";
	if (!legacyUrl && !legacyUser && !legacyPass) {
		return {
			...(raw as Partial<StereoSettings>),
			servers: [],
			activeServerId: "",
		};
	}

	const legacy = normalizeServerConfig({
		id: createServerId(),
		name: "Server",
		wanUrl: legacyUrl,
		lanUrl: "",
		shareBaseUrl:
			typeof raw.shareBaseUrl === "string" ? raw.shareBaseUrl : "",
		username: legacyUser,
		password: legacyPass,
		connectionMode: "auto",
	});
	const {
		serverUrl: _serverUrl,
		username: _username,
		password: _password,
		shareBaseUrl: _shareBaseUrl,
		...rest
	} = raw;
	return {
		...(rest as Partial<StereoSettings>),
		servers: [legacy],
		activeServerId: legacy.id,
	};
}

/** Search delay presets — users think in feel, not milliseconds. */
const SEARCH_SPEEDS: ReadonlyArray<{ ms: number; label: string }> = [
	{ ms: 100, label: "Instant" },
	{ ms: 200, label: "Fast" },
	{ ms: 300, label: "Normal" },
	{ ms: 500, label: "Relaxed" },
];

/** Suggestions for the lyrics font field; free text still accepts anything. */
const FONT_SUGGESTIONS = [
	"Inter",
	"Segoe UI",
	"Helvetica Neue",
	"Georgia",
	"Garamond",
	"Palatino",
	"Times New Roman",
	"JetBrains Mono",
	"Consolas",
];

type ConnectionState = "untested" | "testing" | "ok" | "error";

/** Native-control keys whose change must repaint open Now Playing views. */
const VIEW_REFRESH_KEYS = new Set<string>([
	"nowPlayingView",
	"radioVisualization",
	"lyricsAutoSize",
	"lyricsAlign",
	"volumeControl",
	"showRandomButton",
	"showRepeatButton",
	"showShuffleButton",
	"showFavoriteButton",
	"showPlaylistButton",
	"showStationButton",
	"showShareButton",
	"showNavidromeButton",
	"showDownloadButton",
	"showNewWindowButton",
	"repeatShuffleInTransport",
	"showRating",
	"showArtOverlays",
	"showRatingButton",
]);

export class StereoSettingTab extends PluginSettingTab {
	plugin: StereoPlugin;

	private connectionState: ConnectionState = "untested";
	private connectionMessage = "Not tested yet.";
	private statusEl: HTMLElement | null = null;
	/** Set while the lyrics preview row is mounted; restyles it in place. */
	private applyLyricsPreview: (() => void) | null = null;

	constructor(app: App, plugin: StereoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.icon = "boom-box";
		this.containerEl.addClass("stereo-settings");
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Server",
				items: [
					{
						name: "",
						searchable: false,
						render: (setting) => this.renderServers(setting),
					},
					{
						name: "Connection status",
						searchable: false,
						render: (setting) => this.renderStatus(setting),
					},
					{
						name: "Prefer WAN for browser links",
						desc: "Open Navidrome links with the WAN address. Turn off to prefer the LAN address instead.",
						control: { type: "toggle", key: "preferWanForBrowser" },
					},
				],
			},
			{
				type: "group",
				heading: "Library",
				items: [
					{
						name: "Track click action",
						desc: "What clicking a track does. Right-click always offers every action.",
						render: (setting) =>
							this.segmented(
								setting,
								[
									{ value: "play", label: "Play" },
									{ value: "addToQueue", label: "Queue" },
									{ value: "none", label: "Nothing" },
								],
								() => this.plugin.settings.trackClickAction,
								async (value) => {
									this.plugin.settings.trackClickAction = value;
									await this.plugin.saveSettings();
								}
							),
					},
				],
			},
			{
				type: "group",
				heading: "Sharing",
				items: [
					{
						name: "Share links",
						desc: "Show Share actions in context menus and the share-link manager. Share URL and WAN/LAN addresses are configured per server.",
						control: { type: "toggle", key: "sharingEnabled" },
					},
					{
						name: "Default link lifetime",
						desc: "Preselected lifetime when creating a share link.",
						control: {
							type: "dropdown",
							key: "shareDefaultTtl",
							options: Object.fromEntries(
								SHARE_TTL_PRESETS.map((preset) => [
									preset.value,
									preset.label,
								])
							),
						},
					},
					{
						name: "Allow downloads by default",
						desc: "Initial state of the Allow downloads checkbox in the share dialog.",
						control: { type: "toggle", key: "shareDownloadsByDefault" },
					},
				],
			},
			{
				type: "group",
				heading: "Playback",
				items: [
					{
						name: "Scrobble plays",
						desc: "Report finished plays to the server so play counts and history stay accurate.",
						control: { type: "toggle", key: "scrobbleEnabled" },
					},
					{
						name: "Seek step",
						desc: "Seconds the elapsed and remaining time labels skip when clicked. The mouse wheel over the seek bar always moves 5 seconds.",
						render: (setting) =>
							this.stepper(
								setting,
								{ min: 1, max: 60, step: 1 },
								() => this.plugin.settings.seekStep,
								async (value) => {
									this.plugin.settings.seekStep = value;
									await this.plugin.saveSettings();
								}
							),
					},
					{
						name: "Station batch size",
						desc: "Tracks added per station batch, including each More press.",
						render: (setting) =>
							this.stepper(
								setting,
								{ min: 10, max: 50, step: 5 },
								() => this.plugin.settings.stationBatchSize,
								async (value) => {
									this.plugin.settings.stationBatchSize = value;
									await this.plugin.saveSettings();
								}
							),
					},
				],
			},
			{
				type: "group",
				heading: "History",
				items: [
					{
						name: "Keep history and queue across servers",
						desc: "Keep the play history and the current queue when you switch to another server or edit the connection. Tracks that no longer exist on the active server are marked in the queue.",
						control: { type: "toggle", key: "keepPlaybackAcrossServers" },
					},
				],
			},
			{
				type: "group",
				heading: "Player buttons",
				items: [
					{
						name: "Random song button",
						desc: "Show the dice toggle. It keeps playing random songs until you turn it off.",
						control: { type: "toggle", key: "showRandomButton" },
					},
					{
						name: "Repeat button",
						desc: "Show the repeat button in the extras row or the transport row.",
						control: { type: "toggle", key: "showRepeatButton" },
					},
					{
						name: "Shuffle button",
						desc: "Show the shuffle button in the extras row or the transport row.",
						control: { type: "toggle", key: "showShuffleButton" },
					},
					{
						name: "Favorite button",
						desc: "Show the heart button in the extras row for the current track.",
						control: { type: "toggle", key: "showFavoriteButton" },
					},
					{
						name: "Rating button",
						desc: "Show the star rating button in the extras row, next to the favorite heart.",
						control: { type: "toggle", key: "showRatingButton" },
					},
					{
						name: "Add to playlist button",
						desc: "Show the add-to-playlist button in the extras row for the current track.",
						control: { type: "toggle", key: "showPlaylistButton" },
					},
					{
						name: "Station button",
						desc: "Show the button that starts a station from the current track.",
						control: { type: "toggle", key: "showStationButton" },
					},
					{
						name: "Share button",
						desc: "Show the share button for the current track. Share links must also be enabled.",
						control: { type: "toggle", key: "showShareButton" },
					},
					{
						name: "Navidrome button",
						desc: "Show the button that opens the current album in the Navidrome web UI.",
						control: { type: "toggle", key: "showNavidromeButton" },
					},
					{
						name: "Download button",
						desc: "Show the button that downloads the current track and copies the file to the clipboard. Requires server downloads.",
						control: { type: "toggle", key: "showDownloadButton" },
					},
					{
						name: "Open in new window button",
						desc: "Show the button that opens the player in a separate desktop window. This setting does not affect the status-bar player.",
						control: { type: "toggle", key: "showNewWindowButton" },
					},
					{
						name: "Volume control",
						desc: "Show the volume button. When off, playback stays at 100% and volume is controlled by the device.",
						control: { type: "toggle", key: "volumeControl" },
					},
					{
						name: "Repeat and shuffle in transport row",
						desc: "Place repeat to the left of Previous and shuffle to the right of Next, using the transport button size. When off, both stay in the extras row.",
						control: { type: "toggle", key: "repeatShuffleInTransport" },
					},
				],
			},
			{
				type: "group",
				heading: "Workspace",
				items: [
					{
						name: "Restore open players",
						desc: "Reopen every Stereo pane that was open in the left or right sidebar when the plugin was disabled. Obsidian already restores the layout after a normal app restart.",
						control: { type: "toggle", key: "restoreOpenViews" },
					},
					{
						name: "Status bar player",
						desc: "Show the play/pause icon in Obsidian's status bar. Right-click it for a mini player.",
						control: { type: "toggle", key: "showStatusBarPlayer" },
					},
					{
						name: "Status bar transport controls",
						desc: "Show previous, play/pause, and next together in the status bar. When off, only the play/pause button is shown.",
						control: { type: "toggle", key: "showStatusBarTransport" },
					},
					{
						name: "Status bar servers",
						desc: "Show the server switcher at the bottom of the status-bar mini player.",
						control: { type: "toggle", key: "showStatusBarServers" },
					},
					{
						name: "Status bar player scale",
						desc: "Scale the status-bar mini player and all of its content. 100% is the default.",
						render: (setting) =>
							this.stepper(
								setting,
								{ min: 50, max: 200, step: 5 },
								() => this.plugin.settings.statusBarScale,
								async (value) => {
									this.plugin.settings.statusBarScale = value;
									await this.plugin.saveSettings();
									this.plugin.applyStatusBarSetting();
								}
							),
					},
					{
						name: "Queue and lyrics rows",
						desc: "How many rows the status-bar queue and lyrics show before scrolling. The mini player grows upward by this many rows.",
						render: (setting) =>
							this.stepper(
								setting,
								{ min: 3, max: 20, step: 1 },
								() => this.plugin.settings.statusBarExtraRows,
								async (value) => {
									this.plugin.settings.statusBarExtraRows = value;
									await this.plugin.saveSettings();
									this.plugin.applyStatusBarSetting();
								}
							),
					},
				],
			},
			{
				type: "group",
				heading: "Ratings",
				items: [
					{
						name: "Star ratings in lists",
						desc: "Show the current rating on each track's heart. Hover the heart to pick 1–5; clicking it only toggles favorite.",
						control: { type: "toggle", key: "showRating" },
					},
					{
						name: "Cover overlays",
						desc: "Show rating and favorite icons at the bottom corners of the album-art box. Works with every cover and visualizer mode.",
						control: { type: "toggle", key: "showArtOverlays" },
					},
				],
			},
			{
				type: "group",
				heading: "Now playing",
				items: [
					{
						name: "Now playing view",
						desc: "How the current track is presented on the Now Playing screen.",
						control: {
							type: "dropdown",
							key: "nowPlayingView",
							options: Object.fromEntries(
								NOW_PLAYING_VIEWS.map((opt) => [opt.value, opt.label])
							),
						},
					},
					{
						name: "Internet-radio visualization",
						desc: "What a radio stream shows instead of your chosen view. Radio has no album art and its audio can't be visualized, so the radio tower is the natural fit; the portable radio just idles.",
						control: {
							type: "dropdown",
							key: "radioVisualization",
							options: Object.fromEntries(
								RADIO_VISUALIZATIONS.map((opt) => [opt.value, opt.label])
							),
						},
					},
					{
						name: "Contextual copy buttons",
						desc: "Show copy actions in right-click menus for track details, lyrics, queue entries, and cover art.",
						control: { type: "toggle", key: "contextualCopyButtons" },
					},
				],
			},
			{
				type: "group",
				heading: "Lyrics",
				items: [
					{
						name: "Look up lyrics online",
						desc: "When your server has no lyrics for a track, ask the free LRCLIB database. Only the track's title, artist, album, and length are sent.",
						control: { type: "toggle", key: "lyricsOnlineLookup" },
					},
					{
						name: "Auto-adjust size",
						desc: "Scale the lyrics text with the panel size, the way the album art fills its space. When off, the fixed size below is used.",
						control: { type: "toggle", key: "lyricsAutoSize" },
					},
					{
						name: "Font size",
						desc: "Size of the lyrics text, in pixels. Used when auto-adjust is off.",
						render: (setting) =>
							this.stepper(
								setting,
								{ min: 12, max: 28, step: 1 },
								() => this.plugin.settings.lyricsFontSize,
								async (value) => {
									this.plugin.settings.lyricsFontSize = value;
									await this.plugin.saveSettings();
									this.plugin.refreshNowPlayingViews();
									this.applyLyricsPreview?.();
								}
							),
					},
					{
						name: "Font",
						desc: "Font family for the lyrics. Leave empty to use the theme font.",
						render: (setting) => this.renderFontField(setting),
					},
					{
						name: "Alignment",
						desc: "How the lyrics text is aligned in the panel.",
						control: {
							type: "dropdown",
							key: "lyricsAlign",
							options: { left: "Left", center: "Centered", right: "Right" },
						},
					},
					{
						name: "",
						searchable: false,
						render: (setting) => this.renderLyricsPreview(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Search",
				items: [
					{
						name: "Highlight external content",
						desc: "Mark albums, artists, and tracks from octo-fiesta streaming providers with an External badge, a shaded 10% cover frame, and a matching cross over the cover.",
						control: { type: "toggle", key: "highlightExternal" },
					},
					{
						name: "Search speed",
						desc: "How quickly results appear after you stop typing.",
						control: {
							type: "dropdown",
							key: "searchDebounceMs",
							options: Object.fromEntries(
								SEARCH_SPEEDS.map(({ ms, label }) => [String(ms), label])
							),
						},
					},
					{
						name: "Artists",
						desc: "Search results shown for this group.",
						render: (setting) => this.countStepper(setting, "searchArtistCount"),
					},
					{
						name: "Albums",
						desc: "Search results shown for this group.",
						render: (setting) => this.countStepper(setting, "searchAlbumCount"),
					},
					{
						name: "Tracks",
						desc: "Search results shown for this group.",
						render: (setting) => this.countStepper(setting, "searchSongCount"),
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		// The speed dropdown deals in preset strings; the stored value is ms.
		if (key === "searchDebounceMs") {
			return String(nearestSearchSpeed(this.plugin.settings.searchDebounceMs));
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "searchDebounceMs") value = Number(value);
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
		if (key === "volumeControl") this.plugin.applyVolumeControlSetting();
		if (
			key === "showStatusBarPlayer" ||
			key === "showStatusBarTransport" ||
			key === "showStatusBarServers"
		) {
			this.plugin.applyStatusBarSetting();
		}
		if (key === "sharingEnabled") this.plugin.syncShareUi();
		if (key === "highlightExternal") this.plugin.applyExternalHighlightSetting();
		if (VIEW_REFRESH_KEYS.has(key)) this.plugin.refreshNowPlayingViews();
		if (key === "lyricsAlign") this.applyLyricsPreview?.();
	}

	// ------------------------------------------------------------------
	// Connection

	private renderServers(setting: Setting): void {
		setting.settingEl.empty();
		setting.settingEl.addClass("stereo-settings-servers");
		const list = setting.settingEl.createDiv({ cls: "stereo-server-list" });
		const servers = this.plugin.settings.servers;

		if (servers.length === 0) {
			list.createDiv({
				cls: "stereo-share-status",
				text: "No servers yet. Add one to get started.",
			});
		} else {
			for (const server of servers) this.serverRow(list, server);
		}

		const add = setting.settingEl.createEl("button", {
			cls: "stereo-server-add",
			text: "Add server…",
		});
		add.addEventListener("click", () => this.editServer(null));
	}

	private serverRow(parent: HTMLElement, server: ServerConfig): void {
		const active = server.id === this.plugin.settings.activeServerId;
		const row = parent.createDiv({ cls: "stereo-server-row" });
		if (active) row.addClass("stereo-server-row-active");

		const radio = row.createEl("input", {
			cls: "stereo-server-radio",
			attr: {
				type: "radio",
				name: "stereo-active-server",
				"aria-label": `Use ${serverLabel(server)}`,
			},
		});
		radio.checked = active;
		radio.addEventListener("change", () => {
			if (!radio.checked) return;
			void this.selectServer(server);
		});

		const info = row.createDiv({ cls: "stereo-server-row-main" });
		const title = info.createDiv({ cls: "stereo-server-row-title" });
		title.setText(serverLabel(server));
		const meta = info.createDiv({ cls: "stereo-server-row-meta" });
		meta.setText(
			[
				server.wanUrl ? `WAN: ${server.wanUrl}` : "",
				server.lanUrl ? `LAN: ${server.lanUrl}` : "",
				server.shareBaseUrl
					? `Share: ${server.shareBaseUrl}`
					: "Share: WAN",
				server.username ? `User: ${server.username}` : "",
				connectionModeLabel(server.connectionMode),
			]
				.filter(Boolean)
				.join(" · ")
		);

		const actions = row.createDiv({ cls: "stereo-server-row-actions" });
		this.serverActionIcon(actions, "pencil", "Edit server", () => {
			this.editServer(server);
		});
		this.serverActionIcon(actions, "trash-2", "Delete server", () => {
			new ConfirmModal(
				this.app,
				"Delete server",
				`Delete "${serverLabel(server)}" from Stereo?`,
				"Delete",
				() => {
					void this.plugin.deleteServer(server.id).then(() => {
						this.display();
						void this.testConnection();
					});
				}
			).open();
		});
	}

	private serverActionIcon(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): void {
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon",
			attr: { "aria-label": label, title: label },
		});
		setIcon(button, icon);
		button.addEventListener("click", onClick);
	}

	private async selectServer(server: ServerConfig): Promise<void> {
		await this.plugin.setActiveServer(server.id);
		this.connectionState = "untested";
		this.connectionMessage = "Not tested yet.";
		this.display();
		void this.testConnection();
	}

	private editServer(server: ServerConfig | null): void {
		new ServerEditModal(this.app, this.plugin, server, (next) => {
			void this.plugin.upsertServer(next).then(() => {
				this.connectionState = "untested";
				this.connectionMessage = "Not tested yet.";
				this.display();
				void this.testConnection();
			});
		}).open();
	}

	/** Live status dot + message + retest, in place of a normal setting row. */
	private renderStatus(setting: Setting): () => void {
		setting.settingEl.empty();
		const row = setting.settingEl.createDiv({ cls: "stereo-conn-status" });
		this.statusEl = row;

		const retest = createEl("button", {
			cls: "stereo-conn-retest",
			text: "Retest",
		});
		retest.addEventListener("click", () => void this.testConnection());

		this.updateStatusUi();
		row.appendChild(retest);

		// A fresh look at the page gets a fresh answer, without button-pressing.
		if (this.hasCredentials() && this.connectionState === "untested") {
			void this.testConnection();
		}

		return () => {
			if (this.statusEl === row) this.statusEl = null;
		};
	}

	private updateStatusUi(): void {
		const row = this.statusEl;
		if (!row) return;

		const retest = row.querySelector(".stereo-conn-retest");
		row.empty();

		row.dataset.state = this.connectionState;
		const dot = row.createSpan({ cls: "stereo-conn-dot" });
		if (this.connectionState === "testing") setIcon(dot, "loader-2");
		row.createSpan({ cls: "stereo-conn-text", text: this.connectionMessage });
		if (retest) row.appendChild(retest);
	}

	private hasCredentials(): boolean {
		const server = activeServer(this.plugin.settings);
		return !!(server?.username && server.password && serverApiUrl(server));
	}

	private async testConnection(): Promise<void> {
		if (this.connectionState === "testing") return;
		const server = activeServer(this.plugin.settings);
		if (!server || !this.hasCredentials()) {
			this.connectionState = "error";
			this.connectionMessage =
				"Configure a server URL, username, and password first.";
			this.updateStatusUi();
			return;
		}

		this.connectionState = "testing";
		this.connectionMessage = "Testing…";
		this.updateStatusUi();

		try {
			const info = await this.plugin.client.ping();
			const name = describeServer(info);
			const via = this.plugin.connection.activeKind();
			this.connectionState = "ok";
			this.connectionMessage = `Connected to ${name} as ${server.username}${
				via ? ` via ${via.toUpperCase()}` : ""
			}.`;
		} catch (error) {
			this.connectionState = "error";
			this.connectionMessage = describeConnectionError(
				error,
				serverApiUrl(server)
			);
		}
		this.updateStatusUi();
	}

	// ------------------------------------------------------------------
	// Appearance

	/** Free-text font field with a datalist of suggestions. */
	private renderFontField(setting: Setting): void {
		setting.addText((text) => {
			const listId = "stereo-font-suggestions";
			let datalist = document.getElementById(listId);
			if (!datalist) {
				datalist = createEl("datalist", { attr: { id: listId } });
				for (const font of FONT_SUGGESTIONS) {
					datalist.createEl("option", { attr: { value: font } });
				}
				text.inputEl.insertAdjacentElement("afterend", datalist);
			}
			text.inputEl.setAttr("list", listId);
			text
				.setPlaceholder("Theme font")
				.setValue(this.plugin.settings.lyricsFontFamily)
				.onChange(async (value) => {
					this.plugin.settings.lyricsFontFamily = value;
					await this.plugin.saveSettings();
					this.plugin.refreshNowPlayingViews();
					this.applyLyricsPreview?.();
				});
		});
	}

	/** Three sample lines styled live by the size / font / alignment values. */
	private renderLyricsPreview(setting: Setting): () => void {
		setting.settingEl.empty();
		const preview = setting.settingEl.createDiv({
			cls: "stereo-lyrics-preview",
		});
		preview.createDiv({ text: "So you go, and you stand on your own" });
		preview.createDiv({
			cls: "stereo-lyrics-preview-active",
			text: "And you leave on your own",
		});
		preview.createDiv({ text: "And you go home, and you cry" });

		const apply = (): void => {
			preview.style.fontSize = `${this.plugin.settings.lyricsFontSize}px`;
			preview.style.fontFamily = this.plugin.settings.lyricsFontFamily || "";
			preview.style.textAlign = this.plugin.settings.lyricsAlign;
		};
		this.applyLyricsPreview = apply;
		apply();

		return () => {
			if (this.applyLyricsPreview === apply) this.applyLyricsPreview = null;
		};
	}

	// ------------------------------------------------------------------
	// Search

	private countStepper(
		setting: Setting,
		key: "searchArtistCount" | "searchAlbumCount" | "searchSongCount"
	): void {
		this.stepper(
			setting,
			{ min: 1, max: 20, step: 1 },
			() => this.plugin.settings[key],
			async (value) => {
				this.plugin.settings[key] = value;
				await this.plugin.saveSettings();
			}
		);
	}

	// ------------------------------------------------------------------
	// Controls

	/** Connected buttons showing every choice at once; one is always active. */
	private segmented<T extends string>(
		setting: Setting,
		options: ReadonlyArray<{ value: T; label: string }>,
		get: () => T,
		set: (value: T) => Promise<void>
	): void {
		const group = setting.controlEl.createDiv({ cls: "stereo-segmented" });
		const buttons = new Map<T, HTMLButtonElement>();
		const refresh = (): void => {
			const active = get();
			for (const [value, button] of buttons) {
				button.toggleClass("stereo-segmented-active", value === active);
			}
		};
		for (const { value, label } of options) {
			const button = group.createEl("button", {
				cls: "stereo-segmented-option",
				text: label,
			});
			button.addEventListener("click", () => {
				void set(value).then(refresh);
			});
			buttons.set(value, button);
		}
		refresh();
	}

	/** Number field with −/+ buttons; typed values are clamped to the range. */
	private stepper(
		setting: Setting,
		range: { min: number; max: number; step: number },
		get: () => number,
		set: (value: number) => Promise<void>
	): void {
		const group = setting.controlEl.createDiv({ cls: "stereo-stepper" });

		const minus = group.createEl("button", { cls: "stereo-stepper-button" });
		setIcon(minus, "minus");
		const input = group.createEl("input", {
			cls: "stereo-stepper-input",
			attr: { type: "number", min: range.min, max: range.max },
		});
		input.value = String(get());
		const plus = group.createEl("button", { cls: "stereo-stepper-button" });
		setIcon(plus, "plus");

		const apply = (raw: number): void => {
			const value = Math.min(
				range.max,
				Math.max(range.min, Math.round(raw / range.step) * range.step)
			);
			input.value = String(value);
			minus.disabled = value <= range.min;
			plus.disabled = value >= range.max;
			if (value !== get()) void set(value);
		};

		minus.addEventListener("click", () => apply(get() - range.step));
		plus.addEventListener("click", () => apply(get() + range.step));
		input.addEventListener("change", () => {
			const raw = Number(input.value);
			apply(Number.isFinite(raw) ? raw : get());
		});
		apply(get());
	}
}

/** "Navidrome 0.52.5", "Gonic", or a generic fallback. */
function describeServer(info: { type?: string; version?: string }): string {
	if (!info.type) return "the server";
	const name = info.type.charAt(0).toUpperCase() + info.type.slice(1);
	return info.version ? `${name} ${info.version}` : name;
}

/** Snap an arbitrary stored delay to the nearest preset. */
function nearestSearchSpeed(ms: number): number {
	let best = SEARCH_SPEEDS[0]?.ms ?? 300;
	for (const { ms: preset } of SEARCH_SPEEDS) {
		if (Math.abs(preset - ms) < Math.abs(best - ms)) best = preset;
	}
	return best;
}

function describeConnectionError(error: unknown, serverUrl: string): string {
	if (error instanceof SubsonicError) {
		switch (error.kind) {
			case "config":
				return "Fill in the server URL, username, and password first.";
			case "auth":
				return "Server reached, but the username or password is wrong.";
			case "unreachable":
				if (serverUrl.startsWith("http://")) {
					return "Could not reach the server. If your server redirects to HTTPS, use an https:// URL here.";
				}
				return `Could not reach the server. Check the URL. (${error.message})`;
			case "server":
				return `The server returned an error: ${error.message}`;
		}
	}
	return "Connection test failed unexpectedly.";
}
