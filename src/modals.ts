import {
	App,
	ConfirmationModal,
	FuzzySuggestModal,
	Notice,
	Setting,
} from "obsidian";
import type StereoPlugin from "./main";
import {
	CONNECTION_MODE_OPTIONS,
	createServerId,
	normalizeServerConfig,
	type ConnectionMode,
	type ServerConfig,
} from "./servers";
import type { Playlist } from "./subsonic";

interface PlaylistNameOptions {
	title?: string;
	cta?: string;
	initial?: string;
}

/** Playlist name prompt: saving the queue, creating, and renaming. */
export class PlaylistNameModal extends ConfirmationModal {
	private onSubmit: (name: string) => void;
	private name: string;
	private options: Required<PlaylistNameOptions>;

	constructor(
		app: App,
		onSubmit: (name: string) => void,
		options: PlaylistNameOptions = {}
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.options = {
			title: options.title ?? "Save queue as playlist",
			cta: options.cta ?? "Save",
			initial: options.initial ?? "",
		};
		this.name = this.options.initial;
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.modalEl.addClass("mod-narrow");

		new Setting(this.contentEl).setName("Name").addText((text) => {
			text
				.setPlaceholder("Playlist name")
				.setValue(this.options.initial)
				.onChange((value) => {
					this.name = value.trim();
				});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					this.submit();
				}
			});
			text.inputEl.focus();
			text.inputEl.select();
		});

		this.addButton((button) =>
			button
				.setButtonText(this.options.cta)
				.setCta()
				.onClick(() => this.submit())
		);
		this.addCancelButton("Cancel");
	}

	onClose(): void {
		this.contentEl.empty();
		super.onClose();
	}

	/** Keeps the modal open while the name is empty. */
	private submit(): boolean {
		if (!this.name) return true;
		this.close();
		this.onSubmit(this.name);
		return false;
	}
}

export type PlaylistChoice =
	| { kind: "new" }
	| { kind: "existing"; playlist: Playlist };

/** Fuzzy picker over the user's playlists, with a "New playlist" entry. */
export class PlaylistPickerModal extends FuzzySuggestModal<PlaylistChoice> {
	private choices: PlaylistChoice[];
	private onPick: (choice: PlaylistChoice) => void;

	constructor(
		app: App,
		playlists: Playlist[],
		onPick: (choice: PlaylistChoice) => void
	) {
		super(app);
		this.setPlaceholder("Add to playlist…");
		this.choices = [
			{ kind: "new" },
			...playlists.map((playlist) => ({
				kind: "existing" as const,
				playlist,
			})),
		];
		this.onPick = onPick;
	}

	getItems(): PlaylistChoice[] {
		return this.choices;
	}

	getItemText(choice: PlaylistChoice): string {
		return choice.kind === "new" ? "New playlist…" : choice.playlist.name;
	}

	onChooseItem(choice: PlaylistChoice): void {
		this.onPick(choice);
	}
}

/** Fuzzy picker over playlists when sharing one from the player. */
export class PlaylistSharePickerModal extends FuzzySuggestModal<Playlist> {
	private playlists: Playlist[];
	private onPick: (playlist: Playlist) => void;

	constructor(
		app: App,
		playlists: Playlist[],
		onPick: (playlist: Playlist) => void
	) {
		super(app);
		this.setPlaceholder("Share playlist…");
		this.playlists = playlists;
		this.onPick = onPick;
	}

	getItems(): Playlist[] {
		return this.playlists;
	}

	getItemText(playlist: Playlist): string {
		return playlist.name;
	}

	onChooseItem(playlist: Playlist): void {
		this.onPick(playlist);
	}
}

export interface RadioStationInput {
	name: string;
	streamUrl: string;
	homePageUrl?: string;
}

/** Add/edit form for a server-side radio station. */
export class RadioStationModal extends ConfirmationModal {
	private onSubmit: (station: RadioStationInput) => void;
	private values: RadioStationInput;
	private isEdit: boolean;

	constructor(
		app: App,
		initial: RadioStationInput | null,
		onSubmit: (station: RadioStationInput) => void
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.isEdit = initial !== null;
		this.values = {
			name: initial?.name ?? "",
			streamUrl: initial?.streamUrl ?? "",
			homePageUrl: initial?.homePageUrl ?? "",
		};
	}

	onOpen(): void {
		this.setTitle(this.isEdit ? "Edit radio station" : "Add radio station");
		this.modalEl.addClass("mod-narrow");

		new Setting(this.contentEl).setName("Name").addText((text) => {
			text.setValue(this.values.name).onChange((value) => {
				this.values.name = value.trim();
			});
			text.inputEl.placeholder = "Station name";
			text.inputEl.focus();
		});

		new Setting(this.contentEl)
			.setName("Stream URL")
			.setDesc("Direct stream, or an .m3u/.pls playlist URL.")
			.addText((text) => {
				text.setValue(this.values.streamUrl).onChange((value) => {
					this.values.streamUrl = value.trim();
				});
				text.inputEl.placeholder = "https://…";
			});

		new Setting(this.contentEl)
			.setName("Homepage")
			.setDesc("Optional.")
			.addText((text) => {
				text.setValue(this.values.homePageUrl ?? "").onChange((value) => {
					this.values.homePageUrl = value.trim();
				});
				text.inputEl.placeholder = "https://…";
			});

		this.addButton((button) =>
			button
				.setButtonText(this.isEdit ? "Save" : "Add")
				.setCta()
				.onClick(() => this.submit())
		);
		this.addCancelButton("Cancel");
	}

	onClose(): void {
		this.contentEl.empty();
		super.onClose();
	}

	/** Keeps the modal open while the name or stream URL is invalid. */
	private submit(): boolean {
		if (!this.values.name || !this.values.streamUrl) return true;
		if (!/^https?:\/\//i.test(this.values.streamUrl)) return true;
		this.close();
		this.onSubmit({
			name: this.values.name,
			streamUrl: this.values.streamUrl,
			homePageUrl: this.values.homePageUrl || undefined,
		});
		return false;
	}
}

/** Danger confirm used before destructive server-side actions. */
export class ConfirmModal extends ConfirmationModal {
	private message: string;
	private confirmLabel: string;
	private onConfirm: () => void;

	constructor(
		app: App,
		title: string,
		message: string,
		confirmLabel: string,
		onConfirm: () => void
	) {
		super(app);
		this.setTitle(title);
		this.message = message;
		this.confirmLabel = confirmLabel;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.modalEl.addClass("mod-narrow");
		this.contentEl.createEl("p", { text: this.message });
		this.addButton((button) =>
			button
				.setButtonText(this.confirmLabel)
				.setDestructive()
				.setCta()
				.onClick(() => {
					this.close();
					this.onConfirm();
				})
		);
		this.addCancelButton("Cancel");
	}

	onClose(): void {
		this.contentEl.empty();
		super.onClose();
	}
}

/** Add or edit one server configuration. */
export class ServerEditModal extends ConfirmationModal {
	private plugin: StereoPlugin;
	private values: ServerConfig;
	private isEdit: boolean;
	private onSubmit: (server: ServerConfig) => void;

	constructor(
		app: App,
		plugin: StereoPlugin,
		initial: ServerConfig | null,
		onSubmit: (server: ServerConfig) => void
	) {
		super(app);
		this.plugin = plugin;
		this.isEdit = initial !== null;
		this.values = normalizeServerConfig(
			initial ?? {
				id: createServerId(),
				name: "",
				wanUrl: "",
				lanUrl: "",
				shareBaseUrl: "",
				username: "",
				password: "",
				connectionMode: "auto",
			}
		);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.setTitle(this.isEdit ? "Edit server" : "Add server");
		this.modalEl.addClass("mod-narrow");

		new Setting(this.contentEl).setName("Name").addText((text) => {
			text
				.setPlaceholder("Home")
				.setValue(this.values.name)
				.onChange((value) => {
					this.values.name = value.trim();
				});
			text.inputEl.focus();
		});

		new Setting(this.contentEl)
			.setName("WAN URL")
			.setDesc("Public address of the server, used for share-link fallback.")
			.addText((text) => {
				text
					.setPlaceholder("https://music.example.com")
					.setValue(this.values.wanUrl)
					.onChange((value) => {
						this.values.wanUrl = value.trim();
					});
			});

		new Setting(this.contentEl)
			.setName("LAN URL")
			.setDesc("Optional local address, preferred in Auto mode.")
			.addText((text) => {
				text
					.setPlaceholder("http://192.168.1.10:4533")
					.setValue(this.values.lanUrl)
					.onChange((value) => {
						this.values.lanUrl = value.trim();
					});
			});

		new Setting(this.contentEl)
			.setName("Share base URL")
			.setDesc("Public base used for share links, without /share. Empty uses the WAN URL.")
			.addText((text) => {
				text
					.setPlaceholder("https://music.example.com/navidrome")
					.setValue(this.values.shareBaseUrl)
					.onChange((value) => {
						this.values.shareBaseUrl = value.trim();
					});
			});

		new Setting(this.contentEl).setName("Username").addText((text) => {
			text.setValue(this.values.username).onChange((value) => {
				this.values.username = value.trim();
			});
		});

		new Setting(this.contentEl).setName("Password").addText((text) => {
			text.inputEl.type = "password";
			text.setValue(this.values.password).onChange((value) => {
				this.values.password = value;
			});
		});

		new Setting(this.contentEl)
			.setName("Connection mode")
			.setDesc("Auto prefers LAN and falls back to WAN when it is unreachable.")
			.addDropdown((dropdown) => {
				for (const option of CONNECTION_MODE_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				dropdown
					.setValue(this.values.connectionMode)
					.onChange((value) => {
						this.values.connectionMode = value as ConnectionMode;
					});
			});

		this.addButton((button) =>
			button
				.setButtonText(this.isEdit ? "Save" : "Add")
				.setCta()
				.onClick(() => this.submit())
		);
		this.addCancelButton("Cancel");
	}

	onClose(): void {
		this.contentEl.empty();
		super.onClose();
	}

	/** Keeps the modal open while the required fields are missing. */
	private submit(): boolean {
		if (!this.values.wanUrl) {
			new Notice("WAN URL is required.");
			return true;
		}
		if (!this.values.name) this.values.name = this.values.wanUrl;
		const server = normalizeServerConfig(this.values);
		this.close();
		this.onSubmit(server);
		return false;
	}
}
