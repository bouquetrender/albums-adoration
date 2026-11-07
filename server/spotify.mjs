import { Buffer } from "node:buffer";
import { env } from "node:process";

let accessToken;
let tokenExpiresAt = 0;
let refreshToken;
let cachedPlayback;
let cacheExpiresAt = 0;
let pendingPlayback;

const unavailable = (response, code) => ({
  status: response.status === 429 ? 429 : 503,
  retryAfter: response.status === 429
    ? Math.max(60, Number(response.headers.get("Retry-After")) || 0)
    : 60,
  body: { error: code },
});

async function loadPlayback() {
  const signal = AbortSignal.timeout(8000);
  if (!accessToken || Date.now() >= tokenExpiresAt) {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken || env.SPOTIFY_REFRESH_TOKEN,
      }),
      signal,
    });
    if (!response.ok) return unavailable(response, "spotify_authorization_failed");
    const token = await response.json();
    accessToken = token.access_token;
    tokenExpiresAt = Date.now() + (token.expires_in - 60) * 1000;
    refreshToken = token.refresh_token || refreshToken;
  }

  const response = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (response.status === 401) {
    accessToken = null;
    tokenExpiresAt = 0;
  }
  if (!response.ok) return unavailable(response, "spotify_playback_unavailable");
  const playback = response.status === 204 ? null : await response.json();
  const item = playback?.item;
  if (!playback?.is_playing || item?.type !== "track" || playback.device?.is_private_session) {
    return { status: 200, body: { isPlaying: false } };
  }

  return {
    status: 200,
    body: {
      isPlaying: true,
      track: {
        title: item.name,
        artist: item.artists.map((artist) => artist.name).join(", "),
        album: item.album.name,
        coverUrl: item.album.images[0]?.url || null,
        spotifyUrl: item.external_urls.spotify || null,
      },
    },
  };
}

export async function getNowPlaying(request) {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  }
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET || !env.SPOTIFY_REFRESH_TOKEN) {
    return Response.json({ error: "spotify_not_configured" }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }

  if (!cachedPlayback || Date.now() >= cacheExpiresAt) {
    if (!pendingPlayback) {
      pendingPlayback = loadPlayback()
        .catch(() => ({ status: 503, retryAfter: 60, body: { error: "spotify_unavailable" } }))
        .then((result) => {
          cachedPlayback = result;
          cacheExpiresAt = Date.now() + (result.retryAfter || 5) * 1000;
        })
        .finally(() => { pendingPlayback = null; });
    }
    await pendingPlayback;
  }

  const headers = { "Cache-Control": "no-store" };
  if (cachedPlayback.retryAfter) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil((cacheExpiresAt - Date.now()) / 1000)));
  }
  return Response.json(cachedPlayback.body, { status: cachedPlayback.status, headers });
}
