import type { Album, ItemDate, Song } from "./subsonic";

/** Album name plus release year, using the requested "album - year" shape. */
export function albumLabel(
	name: string | undefined,
	year: number | undefined
): string {
	const title = name?.trim() ?? "";
	if (!title) return "";
	return year ? `${title} - ${year}` : title;
}

function dateValue(date: ItemDate | undefined): number {
	if (!date?.year) return 0;
	return date.year * 10000 + (date.month ?? 0) * 100 + (date.day ?? 0);
}

/** Prefer the concrete release date, then the original release date, then year. */
export function albumDateValue(album: Album): number {
	return (
		dateValue(album.releaseDate) ||
		dateValue(album.originalReleaseDate) ||
		(album.year ?? 0) * 10000
	);
}

export function albumYear(album: Album): number | undefined {
	return (
		album.releaseDate?.year ??
		album.originalReleaseDate?.year ??
		album.year
	);
}

export function albumLabelFor(album: Album): string {
	return albumLabel(album.name, albumYear(album));
}

export function songAlbumLabel(song: Song): string {
	return albumLabel(song.album, song.year);
}

/** Artist and album-year metadata for compact list rows. */
export function songMeta(song: Song): string {
	const artist = song.artist?.trim() || "Unknown artist";
	const album = songAlbumLabel(song);
	return [artist, album].filter(Boolean).join(" · ");
}
