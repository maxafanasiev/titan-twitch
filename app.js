const CLIENT_ID = window.TWITCH_CLIENT_ID;
const SCOPES = "user:read:follows";
const ID = "https://id.twitch.tv/oauth2";
const API = "https://api.twitch.tv/helix";
const STORE = "twitch_auth";
const BACK = [8, 461];
const RED = 403;
const BLUE = 406;
const PLAY_PAUSE = 179;
const PLAY = 415;
const PAUSE = 19;
const STOP = 413;
const SEEK = 30;
const GAP = 32;

const onTitan = navigator.userAgent.includes("TitanOS/");
document.documentElement.classList.toggle("tv", onTitan);

const STRINGS = window.STRINGS;
let lang = "en";
let T = STRINGS.en;

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const exitDialog = $("exit");
const searchEl = $("search");
const exitButtons = [...exitDialog.querySelectorAll(".btn")];

function applyStrings() {
  document.documentElement.lang = lang;
  $("login-title").textContent = T.signIn;
  $("login-hint").innerHTML = T.hint;
  searchEl.placeholder = T.search;
  $("exit-title").textContent = T.exitQ;
  exitButtons[0].textContent = T.stay;
  exitButtons[1].textContent = T.exit;
}

function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `scale(${s})`;
}
addEventListener("resize", fit);
fit();

let screen = "login";
let page = null;
const pages = [];
let rows = [];
let r = 0;
let cols = [];
let exitIndex = 0;
let loginRunning = false;
let heroItem = null;
let player = null;
let playing = null;
let seekTo = null;
let seekTimer = 0;

function show(name) {
  screen = name;
  for (const id of ["login", "browse", "player"]) $(id).hidden = id !== name;
}

function loadAuth() {
  try {
    return JSON.parse(localStorage.getItem(STORE));
  } catch {
    return null;
  }
}

let auth = loadAuth();

function saveAuth(next) {
  auth = next;
  if (next) localStorage.setItem(STORE, JSON.stringify(next));
  else localStorage.removeItem(STORE);
}

async function post(url, params) {
  const res = await fetch(url, { method: "POST", body: new URLSearchParams(params) });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// the verification link already carries the code, so scanning it skips typing
function showQr(url) {
  const box = $("login-qr");
  box.replaceChildren();
  if (!url || !window.qrcode) return;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
}

async function login() {
  if (loginRunning) return;
  loginRunning = true;
  show("login");
  const status = (text) => ($("login-status").textContent = text);
  $("login-code").textContent = "";
  $("login-hint").hidden = true;
  showQr(null);

  try {
    if (!CLIENT_ID) return status(T.noClient);
    status(T.requesting);
    const { ok, data } = await post(`${ID}/device`, { client_id: CLIENT_ID, scopes: SCOPES });
    if (!ok) return status(T.twitchError(data.message || "error"));

    $("login-hint").hidden = false;
    $("login-code").textContent = data.user_code;
    showQr(data.verification_uri);
    status(T.waiting);

    let wait = data.interval * 1000;
    const deadline = Date.now() + data.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(wait);
      const res = await post(`${ID}/token`, {
        client_id: CLIENT_ID,
        scopes: SCOPES,
        device_code: data.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (res.ok) {
        saveAuth({ access: res.data.access_token, refresh: res.data.refresh_token });
        return browse();
      }
      if (res.data.message === "slow_down") wait += 5000;
      else if (res.data.message !== "authorization_pending") {
        return status(T.twitchError(res.data.message || "error"));
      }
    }
    status(T.expired);
  } catch (e) {
    status(T.noConnection(e.message));
  } finally {
    loginRunning = false;
  }
}

// public-client refresh tokens are single use, so parallel 401s must share one refresh
let refreshing = null;

function refresh() {
  refreshing ??= post(`${ID}/token`, {
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: auth.refresh,
  })
    .then(({ ok, data }) => {
      if (ok) saveAuth({ ...auth, access: data.access_token, refresh: data.refresh_token });
      return ok;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

async function helix(path, retried) {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${auth.access}`, "Client-Id": CLIENT_ID },
  });
  if (res.status === 401 && !retried && (await refresh())) return helix(path, true);
  if (res.status === 401) {
    saveAuth(null);
    throw new Error("signed out");
  }
  if (!res.ok) throw new Error(`Twitch API ${res.status}`);
  return res.json();
}

// streams use {width}x{height}, videos %{width}x%{height}
const sized = (url, w, h) =>
  (url || "").replace("%{width}", w).replace("%{height}", h).replace("{width}", w).replace("{height}", h);

function fmtDuration(text) {
  const [, h = 0, m = 0, s = 0] = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(text || "").map((v) => Number(v) || 0);
  return fmtSeconds(h * 3600 + m * 60 + s);
}

function fmtSeconds(total) {
  const t = Math.round(total);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short" });

const streamItem = (s) => ({
  type: "stream",
  login: s.user_login,
  name: s.user_name,
  title: s.title,
  game: s.game_name,
  viewers: s.viewer_count,
  live: true,
  image: sized(s.thumbnail_url, 400, 225),
});

const searchItem = (c) => ({
  type: "channel",
  login: c.broadcaster_login,
  name: c.display_name,
  title: c.title,
  game: c.game_name,
  live: c.is_live,
  image: c.thumbnail_url,
});

const followedItem = (f, user, liveIds) => ({
  type: "channel",
  login: f.broadcaster_login,
  name: f.broadcaster_name,
  title: user?.description,
  live: liveIds.has(f.broadcaster_id),
  image: user?.profile_image_url,
});

const gameItem = (g) => ({ type: "game", id: g.id, name: g.name, image: sized(g.box_art_url, 285, 380) });

const videoItem = (v) => ({
  type: "video",
  id: v.id,
  name: v.title,
  title: v.user_name,
  viewers: v.view_count,
  duration: fmtDuration(v.duration),
  date: fmtDate(v.created_at),
  image: sized(v.thumbnail_url, 400, 225),
});

const clipItem = (c) => ({
  type: "clip",
  id: c.id,
  name: c.title,
  title: c.broadcaster_name,
  viewers: c.view_count,
  duration: fmtSeconds(c.duration),
  date: fmtDate(c.created_at),
  image: c.thumbnail_url,
});

function card(item) {
  const el = document.createElement("div");
  el.className = `card ${item.type}`;
  if (item.type === "live") {
    const button = document.createElement("div");
    button.className = "action glass";
    const icon = document.createElement("span");
    icon.className = "play-icon";
    button.append(icon, T.watchLive);
    const hint = document.createElement("div");
    hint.className = "name";
    hint.textContent = T.chatHint;
    el.append(button, hint);
  } else if (item.type === "signout") {
    const button = document.createElement("div");
    button.className = "action glass";
    button.textContent = item.name;
    el.append(button);
  } else {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (item.image) {
      const img = document.createElement("img");
      img.alt = "";
      // a broadcast that is still running has no thumbnail yet and its URL 404s
      img.onerror = () => img.remove();
      img.src = item.image;
      thumb.append(img);
    }
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.name;
    el.append(thumb, name);
  }
  el.item = item;
  return el;
}

function buildRows(defs) {
  const container = $("rows");
  container.replaceChildren();
  container.style.transform = "";
  rows = [];
  for (const def of defs) {
    if (def.label) {
      const title = document.createElement("h2");
      title.className = "row-title";
      title.textContent = def.label;
      container.append(title);
    }
    if (!def.items.length) {
      if (def.empty) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = def.empty;
        container.append(empty);
      }
      continue;
    }
    const row = document.createElement("div");
    row.className = "row";
    const cards = def.items.map(card);
    row.append(...cards);
    container.append(row);
    rows.push(cards);
  }
}

function skeleton() {
  const container = $("rows");
  container.replaceChildren();
  container.style.transform = "";
  const title = document.createElement("div");
  title.className = "skeleton-title";
  const row = document.createElement("div");
  row.className = "row";
  for (let i = 0; i < 5; i++) {
    const el = document.createElement("div");
    el.className = "card skeleton";
    el.innerHTML = '<div class="thumb"></div><div class="name"></div>';
    row.append(el);
  }
  container.append(title, row);
}

function showPage(p) {
  page = p;
  show("browse");
  searchEl.hidden = p.kind !== "home";
  buildRows(p.defs);
  r = p.r ?? (rows.length ? 0 : p.kind === "home" ? -1 : 0);
  cols = p.cols ?? rows.map(() => 0);
  if (p.hero) setHero(p.hero);
  render();
}

async function loadInto(load) {
  show("browse");
  skeleton();
  rows = [];
  try {
    showPage(await load());
  } catch (e) {
    if (!auth) return login();
    page = { kind: "error", defs: [], retry: load };
    rows = [];
    const msg = document.createElement("div");
    msg.className = "empty";
    msg.textContent = T.retry(e.message);
    $("rows").replaceChildren(msg);
  }
}

function openPage(load) {
  if (page) {
    page.r = r;
    page.cols = cols;
    pages.push(page);
  }
  return loadInto(load);
}

function goBack() {
  showPage(pages.pop());
}

async function homePage() {
  if (!auth.userId) saveAuth({ ...auth, userId: (await helix("/users")).data[0].id });
  const [live, top, games, follows] = await Promise.all([
    helix(`/streams/followed?user_id=${auth.userId}&first=40`),
    helix("/streams?first=20"),
    helix("/games/top?first=20"),
    helix(`/channels/followed?user_id=${auth.userId}&first=100`),
  ]);
  const ids = follows.data.map((f) => `id=${f.broadcaster_id}`);
  const users = ids.length ? await helix(`/users?${ids.join("&")}`) : { data: [] };
  const byId = new Map(users.data.map((u) => [u.id, u]));
  const liveIds = new Set(live.data.map((s) => s.user_id));
  const base = [
    { label: T.followed, items: live.data.map(streamItem), empty: T.nobody },
    { label: T.popular, items: top.data.map(streamItem), empty: T.nobody },
    { label: T.categories, items: games.data.map(gameItem) },
    {
      label: T.followedChannels,
      items: follows.data.map((f) => followedItem(f, byId.get(f.broadcaster_id), liveIds)),
      empty: T.nobodyFollowed,
    },
    { label: T.account, items: [{ type: "signout", name: T.signOut }] },
  ];
  return { kind: "home", base, defs: base };
}

async function channelPage(login) {
  const q = encodeURIComponent(login);
  const [users, streams] = await Promise.all([helix(`/users?login=${q}`), helix(`/streams?user_login=${q}`)]);
  const user = users.data[0];
  if (!user) throw new Error(login);
  const stream = streams.data[0];
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const [videos, recent] = await Promise.all([
    helix(`/videos?user_id=${user.id}&type=archive&first=20`),
    helix(`/clips?broadcaster_id=${user.id}&started_at=${encodeURIComponent(weekAgo)}&first=20`),
  ]);
  const clips = recent.data.length ? recent : await helix(`/clips?broadcaster_id=${user.id}&first=20`);
  const hero = {
    type: "channel",
    login: user.login,
    name: user.display_name,
    title: stream ? stream.title : user.description,
    game: stream?.game_name,
    viewers: stream?.viewer_count,
    live: !!stream,
    image: stream ? sized(stream.thumbnail_url, 400, 225) : user.profile_image_url,
  };
  const defs = [];
  if (stream) defs.push({ items: [{ ...streamItem(stream), type: "live" }] });
  defs.push({ label: T.pastBroadcasts, items: videos.data.map(videoItem), empty: T.noVideos });
  defs.push({ label: T.popularClips, items: clips.data.map(clipItem), empty: T.noClips });
  return { kind: "channel", defs, hero };
}

async function categoryPage(game) {
  const streams = await helix(`/streams?game_id=${game.id}&first=40`);
  return { kind: "category", defs: [{ label: T.liveNow, items: streams.data.map(streamItem), empty: T.nobody }], hero: game };
}

function browse() {
  if (!auth) return login();
  pages.length = 0;
  page = null;
  return loadInto(homePage);
}

async function search(query) {
  const home = page;
  if (query) {
    let row;
    try {
      const res = await helix(`/search/channels?query=${encodeURIComponent(query)}&first=20`);
      row = { label: T.matching(query), items: res.data.map(searchItem), empty: T.noChannels };
    } catch (e) {
      if (!auth) return login();
      row = { label: T.searchFailed(e.message), items: [] };
    }
    home.defs = [row, ...home.base];
  } else {
    home.defs = home.base;
  }
  home.r = home.cols = undefined;
  showPage(home);
}

function setHero(item) {
  if (item === heroItem) return;
  heroItem = item;
  const hero = $("hero");
  $("hero-name").textContent = item.name;
  $("hero-title").textContent = item.title || "";
  const meta = $("hero-meta");
  meta.replaceChildren();
  if (item.live !== undefined) {
    const badge = document.createElement("span");
    badge.className = item.live ? "badge" : "badge off";
    badge.textContent = item.live ? T.live : T.offline;
    meta.append(badge);
  }
  if (item.viewers != null) {
    const viewers = document.createElement("span");
    viewers.className = "viewers";
    viewers.textContent = item.viewers.toLocaleString(lang);
    meta.append(viewers);
  }
  const rest = [item.game, item.duration, item.date].filter(Boolean).join(" · ");
  if (rest) meta.append(rest);
  hero.classList.remove("swap");
  void hero.offsetWidth;
  hero.classList.add("swap");
  if (item.image) $("backdrop").style.backgroundImage = `url("${item.image}")`;
}

// Starting muted is the only autoplay browsers always allow; asking for sound up front makes
// Twitch sit on its play button first. Sound goes on once playback starts.
// Loudness is left to the TV remote, which Titan OS handles itself.
function openPlayer(kind, item) {
  show("player");
  playing = { kind, item };
  player = null;
  clearTimeout(seekTimer);
  seekTo = null;
  $("seek-hud").hidden = true;
  $("frame").replaceChildren();
  setChat(false);
}

function twitchPlayer(options) {
  player = new Twitch.Player("frame", {
    parent: [location.hostname],
    width: "100%",
    height: "100%",
    autoplay: true,
    muted: true,
    ...options,
  });
  const p = player;
  p.addEventListener(Twitch.Player.READY, () => {
    p.setVolume(1);
    p.play();
  });
  p.addEventListener(Twitch.Player.PLAYING, () => {
    if (p.getMuted()) p.setMuted(false);
  });
}

function playLive(item) {
  openPlayer("live", item);
  twitchPlayer({ channel: item.login });
}

function playVideo(item) {
  openPlayer("video", item);
  twitchPlayer({ video: item.id });
}

// clips have no player API, only the plain embed
function playClip(item) {
  openPlayer("clip", item);
  const frame = document.createElement("iframe");
  frame.allow = "autoplay; fullscreen";
  frame.src = `https://clips.twitch.tv/embed?${new URLSearchParams({
    clip: item.id,
    parent: location.hostname,
    autoplay: "true",
    muted: "false",
  })}`;
  $("frame").append(frame);
}

// the chat sits next to the video, never on top of it: Twitch stops autoplay when the player is covered
function setChat(on) {
  $("player").classList.toggle("chat", on);
  $("chat").src = on
    ? `https://www.twitch.tv/embed/${playing.item.login}/chat?parent=${location.hostname}&darkpopout`
    : "about:blank";
}

// presses add up and the player seeks once they stop: it reports its position late, so reading
// it on every press would count each step from the same stale time
let seekFrom = 0;

function seekBy(delta) {
  const end = player.getDuration() || Infinity;
  if (seekTo === null) seekFrom = player.getCurrentTime();
  seekTo = Math.min(end, Math.max(0, (seekTo ?? seekFrom) + delta));
  const shift = seekTo - seekFrom;
  const hud = $("seek-hud");
  hud.textContent = `${shift < 0 ? "−" : "+"}${fmtSeconds(Math.abs(shift))}  →  ${fmtSeconds(seekTo)}`;
  hud.hidden = false;
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => {
    player.seek(seekTo);
    seekTimer = setTimeout(() => {
      seekTo = null;
      hud.hidden = true;
    }, 1200);
  }, 400);
}

function stop() {
  clearTimeout(seekTimer);
  seekTo = null;
  $("seek-hud").hidden = true;
  $("frame").replaceChildren();
  setChat(false);
  player = null;
  playing = null;
  show("browse");
  render();
}

function onPlayerKey(e, back) {
  const k = e.keyCode;
  if (back || k === STOP) return stop();
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (playing.kind === "clip") {
    if (!step || !rows[r]) return;
    const next = Math.min(rows[r].length - 1, Math.max(0, cols[r] + step));
    if (next === cols[r]) return;
    cols[r] = next;
    return playClip(rows[r][next].item);
  }
  if (!player) return;
  if (k === PLAY) player.play();
  else if (k === PAUSE) player.pause();
  else if (e.key === "Enter" || k === PLAY_PAUSE) player.isPaused() ? player.play() : player.pause();
  else if (k === BLUE && playing.kind === "live") setChat(!$("player").classList.contains("chat"));
  else if (step && playing.kind === "video") seekBy(step * SEEK);
}

function render() {
  document.querySelectorAll(".focus").forEach((el) => el.classList.remove("focus"));
  if (!exitDialog.hidden) return exitButtons[exitIndex].classList.add("focus");
  if (screen !== "browse") return;
  if (r === -1) {
    searchEl.classList.add("focus");
    $("rows").style.transform = "";
    return;
  }
  if (!rows.length) return;
  const el = rows[r][cols[r]];
  el.classList.add("focus");
  const step = el.offsetWidth + GAP;
  el.parentElement.style.transform = `translateX(${-Math.max(0, cols[r] - 1) * step}px)`;
  const first = rows[0][0].parentElement;
  $("rows").style.transform = `translateY(${first.offsetTop - el.parentElement.offsetTop}px)`;
  setHero(el.item);
}

function exitApp() {
  // opened from titan-home: go back to it instead of closing the whole app
  if (history.length > 1) history.back();
  else if (window.SmartTvA_API?.exit) SmartTvA_API.exit();
  else window.close();
}

function activate(item) {
  if (item.type === "stream" || item.type === "channel") openPage(() => channelPage(item.login));
  else if (item.type === "game") openPage(() => categoryPage(item));
  else if (item.type === "live") playLive(item);
  else if (item.type === "video") playVideo(item);
  else if (item.type === "clip") playClip(item);
  else if (item.type === "signout") signOut();
}

function signOut() {
  saveAuth(null);
  pages.length = 0;
  page = null;
  login();
}

function onBrowseKey(e) {
  if (r === -1) {
    if (e.key === "Enter") searchEl.focus();
    if (e.key === "ArrowDown" && rows.length) r = 0;
    return;
  }
  if (!rows.length) {
    if (e.key === "Enter" && page?.retry) loadInto(page.retry);
    return;
  }
  if (e.key === "ArrowLeft") cols[r] = Math.max(0, cols[r] - 1);
  if (e.key === "ArrowRight") cols[r] = Math.min(rows[r].length - 1, cols[r] + 1);
  if (e.key === "ArrowUp") r = page.kind === "home" ? r - 1 : Math.max(0, r - 1);
  if (e.key === "ArrowDown") r = Math.min(rows.length - 1, r + 1);
  if (e.key === "Enter") activate(rows[r][cols[r]].item);
}

// while typing, Backspace (keyCode 8, also Philips Back) deletes text and only acts as Back once the field is empty
function onSearchKey(e, back) {
  if (e.key === "Enter") {
    e.preventDefault();
    searchEl.blur();
    search(searchEl.value.trim());
  } else if (back || e.key === "ArrowDown") {
    searchEl.blur();
    if (e.key === "ArrowDown" && rows.length) r = 0;
  }
  render();
}

document.addEventListener("keydown", (e) => {
  const typing = document.activeElement === searchEl;
  const back = BACK.includes(e.keyCode) && !(typing && e.keyCode === 8 && searchEl.value);
  if (back) e.preventDefault();
  if (typing) return onSearchKey(e, back);

  if (!exitDialog.hidden) {
    if (back) exitDialog.hidden = true;
    if (e.key === "ArrowLeft") exitIndex = 0;
    if (e.key === "ArrowRight") exitIndex = 1;
    if (e.key === "Enter") {
      if (exitButtons[exitIndex].dataset.action === "exit") exitApp();
      exitDialog.hidden = true;
    }
    return render();
  }

  if (screen === "player") {
    e.preventDefault();
    return onPlayerKey(e, back);
  }
  if (screen === "login") {
    if (back) {
      exitIndex = 0;
      exitDialog.hidden = false;
      return render();
    }
    if (e.key === "Enter") login();
    return;
  }
  if (back) {
    if (page?.kind === "home" && page.defs !== page.base) {
      searchEl.value = "";
      return search("");
    }
    if (pages.length) return goBack();
    exitIndex = 0;
    exitDialog.hidden = false;
    return render();
  }
  if (e.keyCode === RED) return signOut();
  onBrowseKey(e);
  render();
}, true);

// a mouse click inside the player moves focus into the cross-origin iframe, where our keys can't
// reach; take it straight back so Back and the arrows keep working
addEventListener("blur", () =>
  setTimeout(() => {
    if (document.activeElement?.tagName === "IFRAME") document.activeElement.blur();
  }, 0),
);

// navigator.language on the TV can differ from the language set in TV settings, so ask the SDK first
async function tvLanguage() {
  if (onTitan && window.TitanSDK?.deviceInfo) {
    try {
      const info = await Promise.race([TitanSDK.deviceInfo.getDeviceInfo(), sleep(1500)]);
      if (info?.Product?.language) return info.Product.language;
    } catch {}
  }
  return navigator.language;
}

async function start() {
  const code = (await tvLanguage()).slice(0, 2).toLowerCase();
  lang = STRINGS[code] ? code : "en";
  T = STRINGS[lang];
  applyStrings();
  browse();
}

start();
