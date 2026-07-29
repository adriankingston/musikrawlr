# musikrawlr

Who played with whom — an interactive knowledge graph of bands and musicians,
built on the [MusicBrainz](https://musicbrainz.org) database.

Search for any band or musician and it becomes a node on the canvas.
**Double-click a node** (or use the panel's *Expand connections* button) to pull
in its relationships: a band expands into its members, a musician expands into
all the bands they've played in — plus family ties, collaborations and side
projects. Keep expanding and the web of a whole scene appears, Pete
Frame-family-tree style.

- **Membership edges** are solid, labelled with years active, and carry
  instrument/role attributes where MusicBrainz has them.
- **Family links** (siblings, parents, spouses, alter egos) are dotted.
- **Collaborations** (side projects, supporting musicians, founders) are dashed.
- The detail panel shows dates, country, genres, full membership lists and
  outbound links (Wikidata, Discogs, official site…).

## Running

No dependencies, no build step, no API key:

```
node server.js     →  http://localhost:4700
```

Copy `.env.example` to `.env` and set `MB_CONTACT` (an email or project URL) —
MusicBrainz asks all API clients to identify themselves in their User-Agent.

## How it talks to MusicBrainz

`server.js` serves `public/` and proxies two endpoints (`/api/search`,
`/api/artist`) to the MusicBrainz web service. All outbound requests share one
queue spaced ≥1.1 s apart (MusicBrainz allows 1 request/second), retry politely
on 429/503, and every response is cached on disk in `.cache/` (gitignored) so
repeat lookups never hit the network.

## Data licence

MusicBrainz core data (artists and their relationships) is released under
**CC0**. Supplementary data such as genre tags is **CC BY-NC-SA 3.0**. This
project is not affiliated with MusicBrainz.
