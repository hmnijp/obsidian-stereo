import type { Song, SubsonicClient } from "./subsonic";

/** Shared 1–5 star ratings for songs, mirroring FavoritesIndex without refetching lists. */
export class RatingsIndex {
	private ratings = new Map<string, number>();
	/** Explicit local results win over stale `userRating` fields on other copies. */
	private overrides = new Map<string, number>();
	private connection: string;
	private listeners = new Set<() => void>();

	constructor(
		private client: Pick<SubsonicClient, "setRating">,
		private getConnection: () => string
	) {
		this.connection = getConnection();
	}

	/** Drop session state when the active server or account changes. */
	syncConnection(): void {
		const next = this.getConnection();
		if (next === this.connection) return;
		this.connection = next;
		this.ratings.clear();
		this.overrides.clear();
		this.changed();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Remember a rating supplied by an already loaded list or queue entry. */
	learn(song: Song): void {
		const value = normalize(song.userRating);
		if (value === 0) return;
		if (this.overrides.has(song.id)) return;
		this.ratings.set(song.id, value);
	}

	learnSongs(songs: readonly Song[]): void {
		for (const song of songs) this.learn(song);
	}

	rating(song: Song): number {
		this.learn(song);
		return this.ratingById(song.id);
	}

	ratingById(id: string): number {
		return this.overrides.get(id) ?? this.ratings.get(id) ?? 0;
	}

	/**
	 * Apply a star click. Clicking the current value clears the rating, and 0
	 * always clears. Returns the rating now stored locally.
	 */
	async toggleRating(song: Song, value: number): Promise<number> {
		const current = this.rating(song);
		if (song.streamUrl) return current;
		const requested = normalize(value);
		const target = requested === current ? 0 : requested;
		if (target === current) return current;
		await this.client.setRating(song.id, target);
		this.overrides.set(song.id, target);
		if (target > 0) this.ratings.set(song.id, target);
		else this.ratings.delete(song.id);
		song.userRating = target > 0 ? target : undefined;
		this.changed();
		return target;
	}

	destroy(): void {
		this.listeners.clear();
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}

function normalize(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	const rating = Math.round(value);
	return rating >= 1 && rating <= 5 ? rating : 0;
}
