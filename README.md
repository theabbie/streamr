# torrent-api

A self-hosted torrent search and streaming server. Searches multiple indexers via [Jackett](https://github.com/Jackett/Jackett), resolves titles through IMDB, and streams via [Seedr](https://www.seedr.cc/).

## Features

- Full-text torrent search across all configured Jackett indexers
- IMDB-powered autocomplete in the search box
- Dual results: IMDB-resolved search + raw query search shown side by side
- Season/episode search (`Breaking Bad S03E07`)
- In-browser video streaming via Seedr (filters results to ≤3 GB)
- Auto-cleanup of Seedr storage before adding new torrents (whitelisted folders are never deleted)
- Bencode parser to extract info hashes from `.torrent` files (for indexers that don't expose magnets)
- Rate limiting (5 requests / 10 s per IP)

## Requirements

- Node.js 18+
- [Jackett](https://github.com/Jackett/Jackett) running on `127.0.0.1:9117`
- A [Seedr](https://www.seedr.cc/) account

## Setup

```bash
cp .env.example .env
# Edit .env with your credentials
npm install
node server.js
```

The server listens on `127.0.0.1:3002` by default.

## Environment variables

| Variable | Description |
|---|---|
| `JACKETT_KEY` | Jackett API key (Settings → API Key) |
| `SEEDR_EMAIL` | Seedr account email |
| `SEEDR_PASS` | Seedr account password |

## API

| Endpoint | Description |
|---|---|
| `GET /` | Search homepage |
| `GET /results?q=<query>` | HTML results page (dual sections, ≤3 GB filter) |
| `GET /search?q=<query>` | JSON search API (no size filter) |
| `GET /search?imdb=tt0903747` | Search by IMDB ID |
| `GET /search?q=show&season=2&episode=5` | Episode search |
| `GET /imdb/suggest?q=<query>` | IMDB autocomplete suggestions |
| `GET /indexers` | List configured Jackett indexers |
| `GET /seedr/add?hash=<hash>&title=<title>` | Add magnet to Seedr |
| `GET /seedr/poll?hash=<hash>&title=<title>` | Poll until ready, returns streaming URL |

## Whitelisted Seedr folders

Folder IDs listed in `SEEDR_PROTECTED` in `server.js` are never deleted during auto-cleanup. Add your own folder IDs there.

## License

MIT
