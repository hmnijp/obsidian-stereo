import type { Song, SubsonicClient } from "./subsonic";

/**
 * Shared favorite state for songs. This is not a network cache: list endpoints
 * already return `starred`, so the index only remembers what the UI has seen
 * and the explicit toggles made in this session. Subscribers keep every open
 * list and player in sync without refetching pages.
 */
export class FavoritesIndex {
	private starred = new Set<string>();
	/** Explicit local results win over stale `starred` fields on other copies. */
	private overrides = new Map<string, boolean>();
	private connection: string;
	private listeners = new Set<() => void>();

	constructor(
		private client: Pick<SubsonicClient, "star" | "unstar">,
		private getConnection: () => string
	) {
		this.connection = getConnection();
	}

	/** Drop session state when the active server or account changes. */
	syncConnection(): void {
		const next = this.getConnection();
		if (next === this.connection) return;
		this.connection = next;
		this.starred.clear();
		this.overrides.clear();
		this.changed();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Remember a status supplied by an already loaded list or queue entry. */
	learn(song: Song): void {
		if (!song.starred) return;
		if (this.overrides.get(song.id) === false) return;
		this.starred.add(song.id);
	}

	learnSongs(songs: readonly Song[]): void {
		for (const song of songs) this.learn(song);
	}

	isStarred(song: Song): boolean {
		this.learn(song);
		return this.isStarredById(song.id);
	}

	isStarredById(id: string): boolean {
		const override = this.overrides.get(id);
		if (override !== undefined) return override;
		return this.starred.has(id);
	}

	/** Star or unstar a song, update the shared index and notify open views. */
	async toggle(song: Song): Promise<string | undefined> {
		if (song.streamUrl) return song.starred;
		const starred = !this.isStarred(song);
		if (starred) await this.client.star({ id: song.id });
		else await this.client.unstar({ id: song.id });
		this.overrides.set(song.id, starred);
		if (starred) this.starred.add(song.id);
		else this.starred.delete(song.id);
		const value = starred ? new Date().toISOString() : undefined;
		song.starred = value;
		this.changed();
		return value;
	}

	destroy(): void {
		this.listeners.clear();
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}
