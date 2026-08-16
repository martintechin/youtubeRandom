# 🎲 Random YouTube Video Picker

A single static web page that picks a random video from a YouTube channel — from anywhere in
its back catalog, not just the recent uploads.

- No server, no build step, no dependencies. Three files and a browser.
- Pages through the channel's entire uploads playlist, so a channel's first video is as likely
  as its latest.
- Remembers the channels you've used and reopens the last one automatically.
- Caches each channel's video list locally, so re-rolling is instant and costs no API quota.
- Avoids repeats: it won't show you the same video again until the recent-picks buffer cycles.

## Running it

```bash
git clone https://github.com/martintechin/youtubeRandom.git
cd youtubeRandom
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` directly also works, but serving over
`http://` lets you test HTTP-referrer key restrictions the same way GitHub Pages will.

To publish it: push to GitHub, then **Settings → Pages → Deploy from a branch**, and pick the
branch and `/ (root)`.

## Getting an API key

The page talks to the YouTube Data API from your browser, so it needs your own key. It's free.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project
   (or pick an existing one).
2. **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Restrict the key before using it — this is what makes it safe to use in a public page:
   - **Application restrictions → Websites**, and add the addresses that will use it, e.g.
     `http://localhost:8000/*` and `https://martintechin.github.io/*`.
   - **API restrictions → Restrict key**, and select only **YouTube Data API v3**.
5. Paste the key into the page. It is stored in your browser's `localStorage` and is sent only
   to `googleapis.com`. It is never committed to this repo — there is no key in the source.

A restricted key can still be read out of any browser's dev tools; the restrictions are what
stop someone else from using it. Anyone else running the page supplies their own key.

## Quota

The free tier is 10,000 units per day, which is a lot for this:

| Action | Cost |
| --- | --- |
| Resolve `@handle`, channel URL, or `UC…` ID | 1 unit |
| Resolve a legacy `/c/name` URL or a plain channel name (search fallback) | 100 units |
| Load a channel's video list | 1 unit per 50 videos (a 1,000-video channel = 20) |
| Roll a random video | 0 — served from the local cache |

Video lists are re-fetched at most every 12 hours, or when you press **Refresh**. If you do
hit the quota, cached channels keep working; the quota resets at midnight Pacific Time.

## What you can paste as a channel

`@handle` · `https://youtube.com/@handle` · `https://youtube.com/channel/UC…` ·
`https://youtube.com/user/name` · `https://youtube.com/c/name` · a bare `UC…` ID · or just the
channel's name (uses the expensive search fallback, so prefer a handle or URL).

## Files

| File | What's in it |
| --- | --- |
| `index.html` | The whole UI. |
| `styles.css` | Styling. No framework. |
| `app.js` | Channel resolution, catalog fetching and caching, the random pick, persistence. |

## Notes and limits

- **Shorts are included.** The uploads playlist doesn't distinguish them, and filtering would
  need an extra API pass over every video's duration.
- **Private and deleted videos are skipped** — they linger in uploads playlists with no
  publish date, and are filtered out.
- **Very large channels** (roughly 10,000+ videos) may exceed the browser's storage limit. The
  list still works for the session; it just gets re-fetched on your next visit, and the page
  tells you when that's the case.
- **Private browsing** disables saving. Everything still works, it just won't remember
  anything between visits.
- Fetching stops at 20,000 videos as a safety net.
