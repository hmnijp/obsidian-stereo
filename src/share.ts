import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	Setting,
	setIcon,
} from "obsidian";
import type StereoPlugin from "./main";
import { ConfirmModal } from "./modals";
import type { QueueOrigin } from "./player";
import { activeServer } from "./servers";
import { SHARE_TTL_PRESETS, type ShareTtlPreset } from "./settings";
import {
	SubsonicError,
	type Album,
	type Artist,
	type Playlist,
	type ShareEntry,
	type ShareLink,
	type Song,
} from "./subsonic";

export type ShareKind = "song" | "album" | "playlist" | "artist" | "queue";

/** What a share dialog points at: one resource, several queue tracks, or a source. */
export interface ShareTarget {
	kind: ShareKind;
	resourceIds: string[];
	title: string;
	subtitle?: string;
	/** True when the target is a snapshot of the current queue. */
	snapshot?: boolean;
}

export interface ShareSourceClient {
	getAlbum(id: string): Promise<{ album: Album; songs: Song[] }>;
	getPlaylist(id: string): Promise<{ playlist: Playlist; songs: Song[] }>;
	getPlaylists(): Promise<Playlist[]>;
}

const SHARE_KIND_ICONS: Record<ShareKind, string> = {
	song: "music",
	album: "disc",
	playlist: "list-music",
	artist: "user",
	queue: "list-music",
};

function trackCountLabel(count: number): string {
	return `${count} track${count === 1 ? "" : "s"}`;
}

function entryCountLabel(entries: ShareEntry[]): string {
	if (entries.length === 0) return "";
	if (entries.every((entry) => entry.isDir)) {
		return `${entries.length} album${entries.length === 1 ? "" : "s"}`;
	}
	return trackCountLabel(entries.length);
}

export function shareTargetForSong(song: Song): ShareTarget {
	return {
		kind: "song",
		resourceIds: [song.id],
		title: song.title,
		subtitle: ["Track", song.artist, song.album].filter(Boolean).join(" · "),
	};
}

export function shareTargetForAlbum(album: Album): ShareTarget {
	return {
		kind: "album",
		resourceIds: [album.id],
		title: album.name,
		subtitle: ["Album", album.artist].filter(Boolean).join(" · "),
	};
}

export function shareTargetForPlaylist(playlist: Playlist): ShareTarget {
	const count = playlist.songCount;
	return {
		kind: "playlist",
		resourceIds: [playlist.id],
		title: playlist.name,
		subtitle: ["Playlist", count != null ? trackCountLabel(count) : ""]
			.filter(Boolean)
			.join(" · "),
	};
}

export function shareTargetForArtist(artist: Artist): ShareTarget {
	return {
		kind: "artist",
		resourceIds: [artist.id],
		title: artist.name,
		subtitle: "Artist",
	};
}

function queueSnapshotTarget(songs: Song[]): ShareTarget {
	return {
		kind: "queue",
		resourceIds: songs.map((song) => song.id),
		title: "Queue",
		subtitle: `Queue snapshot · ${trackCountLabel(songs.length)}`,
		snapshot: true,
	};
}

function sameSongs(left: Song[], right: Song[]): boolean {
	return (
		left.length === right.length &&
		left.every((song, index) => song.id === right[index]?.id)
	);
}

async function sourceTarget(
	origin: QueueOrigin,
	client: ShareSourceClient
): Promise<{ target: ShareTarget; songs: Song[] } | null> {
	try {
		if (origin.kind === "album") {
			const { album, songs } = await client.getAlbum(origin.id);
			return { target: shareTargetForAlbum(album), songs };
		}
		const { playlist, songs } = await client.getPlaylist(origin.id);
		return { target: shareTargetForPlaylist(playlist), songs };
	} catch {
		return null;
	}
}

async function albumMatch(
	songs: Song[],
	client: ShareSourceClient
): Promise<ShareTarget | null> {
	if (songs.length < 2) return null;
	const albumIds = new Set(
		songs.map((song) => song.albumId).filter((id): id is string => !!id)
	);
	if (albumIds.size !== 1) return null;
	const albumId = [...albumIds][0];
	if (!albumId) return null;
	try {
		const { album, songs: sourceSongs } = await client.getAlbum(albumId);
		return sameSongs(songs, sourceSongs) ? shareTargetForAlbum(album) : null;
	} catch {
		return null;
	}
}

async function playlistMatch(
	songs: Song[],
	client: ShareSourceClient
): Promise<ShareTarget | null> {
	if (songs.length < 2) return null;
	try {
		const playlists = await client.getPlaylists();
		const candidates = playlists
			.filter((playlist) => playlist.songCount === songs.length)
			.slice(0, 20);
		if (candidates.length === 0) return null;

		const matches: ShareTarget[] = [];
		for (const playlist of candidates) {
			try {
				const { playlist: loaded, songs: sourceSongs } =
					await client.getPlaylist(playlist.id);
				if (sameSongs(songs, sourceSongs)) {
					matches.push(shareTargetForPlaylist(loaded));
				}
			} catch {
				// A playlist that cannot be loaded cannot be the source.
			}
		}
		return matches.length === 1 ? matches[0] ?? null : null;
	} catch {
		return null;
	}
}

/**
 * Resolve what a queue share should point at. A tracked album/playlist origin
 * wins only when the queue still matches it exactly; otherwise the link is a
 * snapshot of the current tracks. Older queues without an origin get a
 * best-effort album/playlist match.
 */
export async function resolveQueueShareTarget(
	queue: Song[],
	origin: QueueOrigin | null,
	client: ShareSourceClient
): Promise<ShareTarget | null> {
	const songs = queue.filter((song) => !song.streamUrl && !!song.id);
	if (songs.length === 0) return null;

	if (origin) {
		const source = await sourceTarget(origin, client);
		if (source) {
			return sameSongs(songs, source.songs)
				? source.target
				: queueSnapshotTarget(songs);
		}
	}

	return (
		(await albumMatch(songs, client)) ??
		(await playlistMatch(songs, client)) ??
		queueSnapshotTarget(songs)
	);
}

function parseBase(raw: string): URL | null {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	try {
		return new URL(withScheme);
	} catch {
		return null;
	}
}

function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "0.0.0.0" ||
		host === "::1" ||
		host.endsWith(".local")
	) {
		return true;
	}
	if (/^10\./.test(host)) return true;
	if (/^192\.168\./.test(host)) return true;
	const match = /^172\.(\d+)\./.exec(host);
	if (match) {
		const second = Number(match[1]);
		if (second >= 16 && second <= 31) return true;
	}
	return false;
}

/**
 * Build a public share URL.
 *
 * An explicit per-server share base is authoritative and always produces
 * `<base>/share/<id>`. Without one we trust the path returned by Navidrome
 * (important behind reverse-proxy prefixes) and only rewrite local origins to
 * the server's WAN origin.
 */
export function normalizeShareUrl(
	rawUrl: string | undefined,
	id: string,
	shareBaseUrl: string,
	wanUrl: string
): string {
	const raw = rawUrl?.trim() ?? "";
	const explicit = parseBase(shareBaseUrl);
	if (explicit) {
		const basePath = explicit.pathname
			.replace(/\/+$/, "")
			.replace(/\/share$/, "");
		return `${explicit.origin}${basePath}/share/${encodeURIComponent(id)}`;
	}

	const fallback = parseBase(wanUrl);
	if (!fallback) {
		return raw || `${wanUrl.replace(/\/+$/, "")}/share/${encodeURIComponent(id)}`;
	}
	const fallbackPath = fallback.pathname.replace(/\/+$/, "");

	if (!raw) {
		return `${fallback.origin}${fallbackPath}/share/${encodeURIComponent(id)}`;
	}

	try {
		const parsed = new URL(raw, `${fallback.origin}${fallbackPath}/`);
		const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
		const local = isLocalHost(parsed.hostname);
		const sameHost = parsed.hostname === fallback.hostname;

		if (absolute && !local && !(sameHost && parsed.protocol !== fallback.protocol)) {
			return parsed.toString();
		}
		if (!absolute && !raw.startsWith("/")) {
			return parsed.toString();
		}
		return `${fallback.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return `${fallback.origin}${fallbackPath}/share/${encodeURIComponent(id)}`;
	}
}

export function describeShareError(error: unknown): string {
	if (!(error instanceof SubsonicError)) {
		return "Could not create the share link.";
	}
	switch (error.kind) {
		case "config":
			return "Fill in the server URL, username, and password first.";
		case "auth":
			return "The server rejected the account credentials.";
		case "unreachable":
			if (error.code === 501) {
				return "Sharing is disabled on the server (EnableSharing).";
			}
			if (error.code === 404) {
				return "This server does not support share links.";
			}
			return `Could not reach the server. ${error.message}`;
		case "server":
			return error.message;
	}
}

function ttlMs(preset: ShareTtlPreset): number {
	return (
		SHARE_TTL_PRESETS.find((option) => option.value === preset)?.ms ??
		SHARE_TTL_PRESETS[2]?.ms ??
		7 * 24 * 60 * 60 * 1000
	);
}

function toDateTimeLocal(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate()
	)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(value: Date | string | undefined): string {
	if (!value) return "Unknown";
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

async function copyText(text: string, notice: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(notice);
	} catch {
		new Notice("Could not copy to the clipboard.");
	}
}

function shareUrlFor(plugin: StereoPlugin, share: ShareLink): string {
	const server = activeServer(plugin.settings);
	return normalizeShareUrl(
		share.url,
		share.id,
		server?.shareBaseUrl ?? "",
		server?.wanUrl || server?.lanUrl || ""
	);
}

function activeUsername(plugin: StereoPlugin): string {
	return activeServer(plugin.settings)?.username ?? "";
}

/** Create a link for one item or a queue snapshot. */
export class ShareCreateModal extends Modal {
	private plugin: StereoPlugin;
	private target: ShareTarget;
	private expiry: ShareTtlPreset | "custom";
	private customExpiry: string;
	private customRow: Setting | null = null;
	private description = "";
	private allowDownloads: boolean;
	private errorEl!: HTMLElement;
	private createButton: ButtonComponent | null = null;
	private closed = false;

	constructor(app: App, plugin: StereoPlugin, target: ShareTarget) {
		super(app);
		this.plugin = plugin;
		this.target = target;
		this.expiry = plugin.settings.shareDefaultTtl;
		this.allowDownloads = plugin.settings.shareDownloadsByDefault;
		this.customExpiry = toDateTimeLocal(
			new Date(Date.now() + ttlMs(this.expiry))
		);
	}

	onOpen(): void {
		this.closed = false;
		this.setTitle(
			this.target.kind === "queue"
				? "Share queue"
				: `Share ${this.target.title}`
		);
		this.contentEl.addClass("stereo-share-modal");

		const summary = this.contentEl.createDiv({ cls: "stereo-share-target" });
		const icon = summary.createSpan({ cls: "stereo-share-target-icon" });
		setIcon(icon, SHARE_KIND_ICONS[this.target.kind]);
		const text = summary.createDiv({ cls: "stereo-share-target-text" });
		text.createDiv({
			cls: "stereo-share-target-title",
			text: this.target.title,
		});
		if (this.target.subtitle) {
			text.createDiv({
				cls: "stereo-share-target-sub",
				text: this.target.subtitle,
			});
		}

		this.contentEl.createEl("p", {
			cls: "stereo-share-hint",
			text: this.target.snapshot
				? "This is a snapshot of the current queue. Later queue changes will not affect the link."
				: "Anyone with this link can listen until it expires. Links use the original files.",
		});

		new Setting(this.contentEl)
			.setName("Lifetime")
			.addDropdown((dropdown) => {
				for (const preset of SHARE_TTL_PRESETS) {
					dropdown.addOption(preset.value, preset.label);
				}
				dropdown.addOption("custom", "Custom…");
				dropdown.setValue(this.expiry).onChange((value) => {
					this.expiry = value as ShareTtlPreset | "custom";
					this.customRow?.settingEl.toggleClass(
						"stereo-hidden",
						value !== "custom"
					);
				});
			});

		this.customRow = new Setting(this.contentEl)
			.setName("Custom expiry")
			.setDesc("Local date and time.")
			.addText((input) => {
				input.inputEl.type = "datetime-local";
				input.setValue(this.customExpiry).onChange((value) => {
					this.customExpiry = value;
				});
			});
		this.customRow.settingEl.toggleClass(
			"stereo-hidden",
			this.expiry !== "custom"
		);

		new Setting(this.contentEl)
			.setName("Description")
			.setDesc("Optional message shown in the share manager.")
			.addText((input) => {
				input
					.setPlaceholder("Optional")
					.onChange((value) => {
						this.description = value.trim();
					});
			});

		new Setting(this.contentEl)
			.setName("Allow downloads")
			.setDesc("Let anyone with the link download the shared files.")
			.addToggle((toggle) => {
				toggle.setValue(this.allowDownloads).onChange((value) => {
					this.allowDownloads = value;
				});
			});

		this.errorEl = this.contentEl.createDiv({ cls: "stereo-share-error" });

		const actions = this.contentEl.createDiv({ cls: "stereo-share-actions" });
		new ButtonComponent(actions)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		this.createButton = new ButtonComponent(actions)
			.setButtonText("Create link")
			.setCta()
			.onClick(() => {
				void this.create();
			});
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	private resolveExpiry(): Date | null {
		if (this.expiry === "custom") {
			const date = new Date(this.customExpiry);
			return Number.isNaN(date.getTime()) || date.getTime() <= Date.now()
				? null
				: date;
		}
		return new Date(Date.now() + ttlMs(this.expiry));
	}

	private async create(): Promise<void> {
		if (this.closed) return;
		const expiresAt = this.resolveExpiry();
		if (!expiresAt) {
			this.showError("Choose an expiry date in the future.");
			return;
		}
		this.errorEl.setText("");
		this.createButton?.setDisabled(true).setButtonText("Creating…");
		try {
			const share = await this.plugin.client.createShare({
				ids: this.target.resourceIds,
				description: this.description || undefined,
				expiresAt,
				downloadable: this.allowDownloads,
			});
			if (this.closed) return;
			this.showResult(share, expiresAt);
		} catch (error) {
			if (this.closed) return;
			this.showError(describeShareError(error));
			this.createButton?.setDisabled(false).setButtonText("Create link");
		}
	}

	private showError(message: string): void {
		this.errorEl.setText(message);
		this.errorEl.addClass("stereo-share-error-visible");
	}

	private showResult(share: ShareLink, expiresAt: Date): void {
		this.contentEl.empty();
		this.setTitle("Share link created");
		const result = this.contentEl.createDiv({ cls: "stereo-share-result" });
		const heading = result.createDiv({ cls: "stereo-share-result-heading" });
		const icon = heading.createSpan({ cls: "stereo-share-result-icon" });
		setIcon(icon, "check");
		heading.createSpan({ text: "Link created" });

		const input = result.createEl("input", {
			cls: "stereo-share-link-input",
			attr: {
				type: "text",
				readonly: "true",
				"aria-label": "Share link",
			},
		});
		input.value = shareUrlFor(this.plugin, share);
		input.addEventListener("focus", () => input.select());

		const actions = result.createDiv({ cls: "stereo-share-actions" });
		new ButtonComponent(actions)
			.setButtonText("Copy link")
			.setCta()
			.onClick(() => {
				void copyText(input.value, "Link copied.");
			});
		new ButtonComponent(actions)
			.setButtonText("Open")
			.onClick(() => {
				window.open(input.value, "_blank");
			});
		new ButtonComponent(actions)
			.setButtonText("Done")
			.onClick(() => this.close());

		const details = result.createDiv({ cls: "stereo-share-result-details" });
		details.createDiv({ text: `Expires ${formatDateTime(expiresAt)}` });
		details.createDiv({
			text: this.allowDownloads ? "Downloads allowed" : "Downloads off",
		});
		if (this.target.snapshot) {
			details.createDiv({ text: "Snapshot of the current queue." });
		}
	}
}

/** Edit an existing share link. */
export class ShareEditModal extends Modal {
	private plugin: StereoPlugin;
	private share: ShareLink;
	private onSaved: () => void;
	private description: string;
	private initialDescription: string;
	private expiry: string;
	private initialExpiry: string;
	private downloads: "keep" | "allow" | "deny" = "keep";
	private errorEl!: HTMLElement;
	private saveButton: ButtonComponent | null = null;

	constructor(
		app: App,
		plugin: StereoPlugin,
		share: ShareLink,
		onSaved: () => void
	) {
		super(app);
		this.plugin = plugin;
		this.share = share;
		this.onSaved = onSaved;
		this.description = share.description ?? "";
		this.initialDescription = this.description;
		const expires = share.expires ? new Date(share.expires) : null;
		this.expiry =
			expires && !Number.isNaN(expires.getTime())
				? toDateTimeLocal(expires)
				: "";
		this.initialExpiry = this.expiry;
	}

	onOpen(): void {
		this.setTitle("Edit share link");
		this.contentEl.addClass("stereo-share-modal");

		const summary = this.contentEl.createDiv({ cls: "stereo-share-target" });
		const icon = summary.createSpan({ cls: "stereo-share-target-icon" });
		setIcon(icon, "link");
		const text = summary.createDiv({ cls: "stereo-share-target-text" });
		text.createDiv({
			cls: "stereo-share-target-title",
			text: this.share.description || "Shared item",
		});
		text.createDiv({
			cls: "stereo-share-target-sub",
			text: shareUrlFor(this.plugin, this.share),
		});

		new Setting(this.contentEl)
			.setName("Description")
			.setDesc("Leave empty to remove the description.")
			.addText((input) => {
				input.setValue(this.description).onChange((value) => {
					this.description = value.trim();
				});
			});

		new Setting(this.contentEl)
			.setName("Expires")
			.setDesc("Local date and time. Leave unchanged to keep the current expiry.")
			.addText((input) => {
				input.inputEl.type = "datetime-local";
				input.setValue(this.expiry).onChange((value) => {
					this.expiry = value;
				});
			});

		new Setting(this.contentEl)
			.setName("Downloads")
			.setDesc("Downloads require Navidrome 0.64+ with downloads enabled.")
			.addDropdown((dropdown) => {
				dropdown.addOption("keep", "Keep current");
				dropdown.addOption("allow", "Allow downloads");
				dropdown.addOption("deny", "Disable downloads");
				dropdown.setValue(this.downloads).onChange((value) => {
					this.downloads = value as "keep" | "allow" | "deny";
				});
			});

		this.errorEl = this.contentEl.createDiv({ cls: "stereo-share-error" });
		const actions = this.contentEl.createDiv({ cls: "stereo-share-actions" });
		new ButtonComponent(actions)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		this.saveButton = new ButtonComponent(actions)
			.setButtonText("Save")
			.setCta()
			.onClick(() => {
				void this.save();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async save(): Promise<void> {
		const changes: {
			description?: string;
			expiresAt?: Date;
			downloadable?: boolean;
		} = {};

		if (this.description !== this.initialDescription) {
			changes.description = this.description;
		}

		if (this.expiry !== this.initialExpiry) {
			if (this.expiry.trim()) {
				const parsed = new Date(this.expiry);
				if (
					Number.isNaN(parsed.getTime()) ||
					parsed.getTime() <= Date.now()
				) {
					this.errorEl.setText(
						"Choose an expiry date in the future, or leave it unchanged."
					);
					return;
				}
				changes.expiresAt = parsed;
			} else if (this.initialExpiry.trim()) {
				this.errorEl.setText(
					"Navidrome cannot clear an expiry. Choose a new future date."
				);
				return;
			}
		}

		if (this.downloads === "allow") changes.downloadable = true;
		if (this.downloads === "deny") changes.downloadable = false;

		this.errorEl.setText("");
		this.saveButton?.setDisabled(true).setButtonText("Saving…");
		try {
			await this.plugin.client.updateShare(this.share.id, changes);
			new Notice("Share link updated.");
			this.close();
			this.onSaved();
		} catch (error) {
			this.errorEl.setText(describeShareError(error));
			this.saveButton?.setDisabled(false).setButtonText("Save");
		}
	}
}

/** List and manage the account's existing share links. */
export class SharesModal extends Modal {
	private plugin: StereoPlugin;
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private loadToken = 0;
	private closed = false;

	constructor(app: App, plugin: StereoPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.closed = false;
		this.setTitle("Share links");
		this.contentEl.addClass("stereo-share-modal");
		this.contentEl.createEl("p", {
			cls: "stereo-share-hint",
			text: "Anyone with a link can listen until it expires. Links are stored on the server.",
		});

		const toolbar = this.contentEl.createDiv({ cls: "stereo-share-toolbar" });
		new ButtonComponent(toolbar)
			.setButtonText("Refresh")
			.setIcon("refresh-cw")
			.onClick(() => {
				void this.load();
			});

		this.statusEl = this.contentEl.createDiv({ cls: "stereo-share-status" });
		this.listEl = this.contentEl.createDiv({ cls: "stereo-share-list" });
		void this.load();
	}

	onClose(): void {
		this.closed = true;
		this.loadToken += 1;
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		const token = ++this.loadToken;
		this.listEl.empty();
		this.statusEl.removeClass("stereo-share-error");
		this.statusEl.setText("Loading…");
		try {
			const shares = await this.plugin.client.getShares();
			if (this.closed || token !== this.loadToken) return;
			shares.sort(
				(left, right) =>
					Date.parse(right.created) - Date.parse(left.created)
			);
			if (shares.length === 0) {
				this.statusEl.setText(
					"No share links yet. Right-click a track, album, or playlist and choose Share…"
				);
				return;
			}
			this.statusEl.setText("");
			for (const share of shares) this.renderRow(share);
		} catch (error) {
			if (this.closed || token !== this.loadToken) return;
			this.statusEl.setText(describeShareError(error));
			this.statusEl.addClass("stereo-share-error");
			new ButtonComponent(this.statusEl)
				.setButtonText("Retry")
				.onClick(() => {
					void this.load();
				});
		}
	}

	private renderRow(share: ShareLink): void {
		const url = shareUrlFor(this.plugin, share);
		const expires = share.expires ? new Date(share.expires) : null;
		const expired = !!expires && expires.getTime() <= Date.now();
		const row = this.listEl.createDiv({ cls: "stereo-share-row" });
		if (expired) row.addClass("stereo-share-expired");

		const info = row.createDiv({ cls: "stereo-share-row-main" });
		const entries = share.entry ?? [];
		info.createDiv({
			cls: "stereo-share-row-title",
			text: share.description || "Shared item",
		});

		const meta = info.createDiv({ cls: "stereo-share-row-meta" });
		const metaParts = [
			entryCountLabel(entries),
			`Created ${formatDateTime(share.created)}`,
			expires
				? `${expired ? "Expired" : "Expires"} ${formatDateTime(expires)}`
				: "No expiry",
			`${share.visitCount ?? 0} visits`,
		].filter(Boolean);
		if (share.username && share.username !== activeUsername(this.plugin)) {
			metaParts.push(`by ${share.username}`);
		}
		meta.setText(metaParts.join(" · "));

		const urlEl = info.createDiv({ cls: "stereo-share-row-url", text: url });
		urlEl.setAttr("title", url);

		const actions = row.createDiv({ cls: "stereo-share-row-actions" });
		this.iconAction(actions, "copy", "Copy link", () => {
			void copyText(url, "Link copied.");
		});
		this.iconAction(actions, "external-link", "Open link", () => {
			window.open(url, "_blank");
		});
		this.iconAction(actions, "pencil", "Edit link", () => {
			new ShareEditModal(this.app, this.plugin, share, () => {
				void this.load();
			}).open();
		});
		this.iconAction(actions, "trash-2", "Delete link", () => {
			this.confirmDelete(share);
		});
	}

	private iconAction(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): void {
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon stereo-share-icon-button",
			attr: { "aria-label": label, title: label },
		});
		setIcon(button, icon);
		button.addEventListener("click", onClick);
	}

	private confirmDelete(share: ShareLink): void {
		const owner =
			share.username && share.username !== activeUsername(this.plugin)
				? ` This link belongs to ${share.username}.`
				: "";
		new ConfirmModal(
			this.app,
			"Delete share link",
			`Delete this link? The URL will stop working immediately.${owner}`,
			"Delete",
			() => {
				void this.remove(share);
			}
		).open();
	}

	private async remove(share: ShareLink): Promise<void> {
		try {
			await this.plugin.client.deleteShare(share.id);
			new Notice("Share link deleted.");
			await this.load();
		} catch (error) {
			new Notice(describeShareError(error));
		}
	}
}
