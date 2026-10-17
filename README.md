# Stereo

Stream music from your Navidrome or Subsonic-compatible server inside Obsidian.
Stereo is a full music player in the sidebar: browse your library, queue albums,
run stations, read synced lyrics, and keep the music going while you work in
your notes.

<p align="center">
  <img src="images/stereo-nowplaying.png" width="30%" alt="Now Playing">
  <img src="images/stereo-lyrics.png" width="30%" alt="Synced lyrics with follow-along highlighting">
  <img src="images/stereo-library.png" width="30%" alt="Album page in the library">
</p>
<p align="center">
  <img src="images/stereo-boombox.png" width="30%" alt="Boom box visualizer">
  <img src="images/stereo-bars.png" width="30%" alt="Frequency bars visualizer">
  <img src="images/stereo-radio.png" width="30%" alt="Radio tower visualizer on internet radio">
</p>

## Features

**Player**
- Now Playing view with selectable art treatments: album art, spinning record,
  or audio-reactive visualizers.
- Full transport (seek, previous/next, volume) with a compact mini player that
  takes over when you navigate elsewhere.
- Lyrics with follow-along highlighting for synced lyrics — click a line to
  seek. Plain lyrics scroll normally.
- Repeat, shuffle, and random playback modes. Repeat cycles through off, queue,
  and track; shuffle has on/off states and restores the original order when
  turned off; the dice toggle keeps generating random songs. It does not
  interrupt a track already past three seconds, and the generated tracks form a
  queue: Previous and Next walk it, with a new random fetched only at its end.
  Repeat-one works in random mode.
- The extras row fits the pane width: buttons stay at their historical maximum
  and shrink together when space is tight.
- Media keys and the system playback overlay control Stereo and show the
  current track.
- Scrobbles plays back to your server so play counts stay accurate.

**Library**
- Recently played lists the latest 200 song plays, newest first. Use the history
  icon in Library to play a track again, add it to the queue, or clear history.
- Browse albums, artists, playlists, and internet radio, with drill-in
  navigation (artist → album → track) and an A–Z scrubber for long lists.
- Right-click context menus everywhere: play, play next, add to queue, add to
  playlist, go to artist/album, favorite, start station, share. The player's
  track title menu can add the current track or its whole album/playlist.
- Favorites synced with your server — heart tracks, albums, and artists from
  the player, menus, or detail pages, and browse them all on a Favorites page.
  Track rows in albums, playlists, search, history, and the queue have their own
  heart: filled favorites stay visible, outline controls appear on hover, and
  every open list and both players update together.
- Navidrome star ratings: the current rating printed on each track's heart in
  song lists (hover the heart for five stars), rating and favorite icons at the
  corners of the album-art box, and a star button in the extras row with an
  upward picker. Rating and favorite cover overlays are controlled in settings.
- Share links for tracks, albums, playlists, artists, and the current queue.
  Links use original files; choose a lifetime and optional downloads, then copy
  the public URL. Right-click the player's share button to share the current
  album, artist, or choose a playlist. Manage existing links from the link icon
  next to Favorites and Recently played.
- Manage internet radio stations from the player: add, edit, and remove
  (requires an admin account on the server).

**Servers**
- Save multiple servers and accounts, each with its own WAN URL, optional LAN
  URL, share URL, and login.
- Connection mode per server: Auto (LAN first), WAN only, or LAN only. Auto falls
  back to WAN when LAN is unreachable and retries LAN periodically.
- Servers on the same host with the same username share one playback queue and
  history, so switching between endpoints does not stop playback.
- Share links always use the server's share URL, falling back to its WAN URL.
- Edit existing links from the share manager: description, expiry, and downloads.
- `Allow downloads` requires Navidrome 0.64+ with `EnableDownloads` enabled.

**Queue & stations**
- Full-page queue with playback modes, add-to-playlist for the whole queue, and
  persistence across Obsidian restarts. Right-click any queue entry to add that
  track to a playlist.
- Repeat and shuffle also live on the player. Repeat cycles through off, queue,
  and track; shuffle keeps the mode and restores the previous order. The choice
  survives restarts; Next skips ahead even with repeat track. Live radio does not repeat.
- Drag tracks to reorder, or right-click a queue entry to move it next without
  interrupting playback. Duplicate entries can be moved independently.
- Undo the last queue clear or replacement, including station changes. Undo
  lasts until another queue edit or plugin restart.
- Stations: seed from any song, album, or artist to build a batch of similar
  tracks, then extend it or save it as a playlist.

**Search**
- As-you-type fuzzy search across artists, albums, and tracks.

## Setup

1. Install and enable the plugin.
2. Open **Settings → Stereo** and add a server with its WAN URL, optional
   LAN/share URLs, username, and password. The radio button selects the active
   server; the pencil edits it.
3. Use **Retest** to confirm the server is reachable, then open the player from
   the ribbon icon or the **Open player** command.

Settings also cover player buttons (random, repeat, shuffle, favorite, add to
playlist, station, share, volume, and whether repeat/shuffle sit in the
transport row), star ratings and cover overlays, track click behavior, sharing,
Now Playing view, lyrics font, and search tuning.

## Requirements

- Obsidian desktop (this plugin is desktop-only).
- A server that speaks the Subsonic API — Navidrome, Airsonic-Advanced, Gonic,
  and others.
- Share links require a Navidrome server with `EnableSharing` enabled.

## Data and network transparency

- Music playback, browsing, favorites, scrobbling, and station building talk
  **only** to the server URLs you configure. Nothing is sent anywhere until you
  configure a server.
- Lyrics are fetched from your server first; if your server has none for the
  current track, Stereo queries [LRCLIB](https://lrclib.net) (a free, public
  lyrics database) with the track's title, artist, album, and duration. No
  account data is sent.
- Your server URLs, usernames, and **passwords are stored in plain text** in
  `.obsidian/plugins/stereo/data.json` inside your vault. If you sync or share
  your vault, that file goes with it. Consider dedicated, limited accounts on
  your music servers.
- No telemetry, no analytics.
- Share links are public: anyone with the URL can listen until it expires.
  Links are stored on your server, not in the plugin. Each server can define a
  share base URL; without one, links use its WAN URL.
- Recently played stores track IDs, display metadata (title, artist, album,
  artwork ID, genre, duration, favorite status, and star rating), and play timestamps locally
  in the same `data.json`, limited to 200 entries for the configured
  server/account. History records actual song starts, including replays and
  repeats, and excludes radio. It contains no passwords or authenticated
  stream/artwork URLs. Clear history removes these entries without changing
  playback or the queue. Changing the active server or account clears history and
  the previous account's queue/undo once you leave the field.
  There is no background history import or cloud history sync feature; vault
  syncing can copy `data.json` along with your other vault files.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # type-check + production build
npm test       # playback store regression tests
```

## Support

If you enjoy Stereo, you can [buy me a coffee](https://buymeacoffee.com/romanmurray).

## License

[GPL-3.0](LICENSE)
