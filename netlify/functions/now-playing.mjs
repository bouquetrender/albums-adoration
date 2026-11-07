import { getNowPlaying } from "../../server/spotify.mjs";

export default getNowPlaying;

export const config = { path: "/api/now-playing" };
