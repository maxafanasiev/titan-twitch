const CLIENT_ID = window.TWITCH_CLIENT_ID;
const SCOPES = "user:read:follows";
const ID = "https://id.twitch.tv/oauth2";
const API = "https://api.twitch.tv/helix";
const STORE = "twitch_auth";
const BACK = [8, 461];
const RED = 403;
const CARD_STEP = 432;

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
  $("signout-hint").textContent = T.signOut;
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
let rows = [];
let r = 0;
let cols = [];
let exitIndex = 0;
let loginRunning = false;
let followedStreams = [];
let topStreams = [];
let found = null;
let foundLabel = "";
let heroStream = null;

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

const thumbUrl = (stream, w, h) => stream.thumbnail_url.replace("{width}", w).replace("{height}", h);

function card(stream) {
  const el = document.createElement("div");
  el.className = "card";
  if (stream.live !== undefined) el.classList.add("channel");
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.src = thumbUrl(stream, 400, 225);
  img.alt = "";
  thumb.append(img);
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = stream.user_name;
  el.append(thumb, name);
  el.stream = stream;
  return el;
}

function addRow(container, label, streams, emptyText) {
  const title = document.createElement("h2");
  title.className = "row-title";
  title.textContent = label;
  container.append(title);
  if (!streams.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  const row = document.createElement("div");
  row.className = "row";
  const cards = streams.map(card);
  row.append(...cards);
  container.append(row);
  rows.push(cards);
}

function skeleton() {
  const container = $("rows");
  container.replaceChildren();
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

async function browse() {
  if (!auth) return login();
  show("browse");
  skeleton();
  try {
    if (!auth.userId) saveAuth({ ...auth, userId: (await helix("/users")).data[0].id });
    const [mine, popular] = await Promise.all([
      helix(`/streams/followed?user_id=${auth.userId}&first=20`),
      helix("/streams?first=20"),
    ]);
    followedStreams = mine.data;
    topStreams = popular.data;
    renderRows();
    render();
  } catch (e) {
    if (!auth) return login();
    rows = [];
    $("rows").replaceChildren();
    const msg = document.createElement("div");
    msg.className = "empty";
    msg.textContent = T.retry(e.message);
    $("rows").append(msg);
  }
}

function renderRows() {
  const container = $("rows");
  container.replaceChildren();
  rows = [];
  if (found) addRow(container, foundLabel, found, T.noChannels);
  addRow(container, T.followed, followedStreams, T.nobody);
  addRow(container, T.popular, topStreams, T.nobody);
  r = rows.length ? 0 : -1;
  cols = rows.map(() => 0);
}

async function search(query) {
  if (!query) {
    found = null;
    return renderRows();
  }
  try {
    const res = await helix(`/search/channels?query=${encodeURIComponent(query)}&first=20`);
    found = res.data.map((c) => ({
      user_login: c.broadcaster_login,
      user_name: c.display_name,
      title: c.title,
      game_name: c.game_name,
      thumbnail_url: c.thumbnail_url,
      live: c.is_live,
    }));
    foundLabel = T.matching(query);
  } catch (e) {
    if (!auth) return login();
    found = [];
    foundLabel = T.searchFailed(e.message);
  }
  renderRows();
}

function setHero(stream) {
  if (stream === heroStream) return;
  heroStream = stream;
  const hero = $("hero");
  $("hero-name").textContent = stream.user_name;
  $("hero-title").textContent = stream.title || "";
  const meta = $("hero-meta");
  meta.replaceChildren();
  const live = stream.live ?? true;
  const badge = document.createElement("span");
  badge.className = live ? "badge" : "badge off";
  badge.textContent = live ? T.live : T.offline;
  meta.append(badge);
  if (stream.viewer_count != null) {
    const viewers = document.createElement("span");
    viewers.className = "viewers";
    viewers.textContent = stream.viewer_count.toLocaleString(lang);
    meta.append(viewers);
  }
  if (stream.game_name) meta.append(stream.game_name);
  hero.classList.remove("swap");
  void hero.offsetWidth;
  hero.classList.add("swap");
  $("backdrop").style.backgroundImage = `url("${thumbUrl(stream, 320, 180)}")`;
}

function play(stream) {
  show("player");
  const params = new URLSearchParams({ channel: stream.user_login, parent: location.hostname, autoplay: "true" });
  $("frame").src = `https://player.twitch.tv/?${params}`;
  const info = $("player-info");
  info.textContent = [stream.user_name, stream.game_name].filter(Boolean).join(" · ");
  info.classList.remove("hide");
  clearTimeout(play.timer);
  play.timer = setTimeout(() => info.classList.add("hide"), 4000);
}

function stop() {
  $("frame").src = "about:blank";
  show("browse");
  render();
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
  el.parentElement.style.transform = `translateX(${-Math.max(0, cols[r] - 1) * CARD_STEP}px)`;
  const first = rows[0][0].parentElement;
  $("rows").style.transform = `translateY(${first.offsetTop - el.parentElement.offsetTop}px)`;
  setHero(el.stream);
}

function exitApp() {
  // opened from titan-home: go back to it instead of closing the whole app
  if (history.length > 1) history.back();
  else if (window.SmartTvA_API?.exit) SmartTvA_API.exit();
  else window.close();
}

function onBrowseKey(e) {
  if (r === -1) {
    if (e.key === "Enter") searchEl.focus();
    if (e.key === "ArrowDown" && rows.length) r = 0;
    return;
  }
  if (!rows.length) {
    if (e.key === "Enter") browse();
    return;
  }
  if (e.key === "ArrowLeft") cols[r] = Math.max(0, cols[r] - 1);
  if (e.key === "ArrowRight") cols[r] = Math.min(rows[r].length - 1, cols[r] + 1);
  if (e.key === "ArrowUp") r -= 1;
  if (e.key === "ArrowDown") r = Math.min(rows.length - 1, r + 1);
  if (e.key === "Enter") play(rows[r][cols[r]].stream);
}

// while typing, Backspace (keyCode 8, also Philips Back) deletes text and only acts as Back once the field is empty
function onSearchKey(e, back) {
  if (e.key === "Enter") {
    e.preventDefault();
    searchEl.blur();
    search(searchEl.value.trim()).then(render);
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
    if (back) stop();
    return;
  }
  if (back && found && screen === "browse") {
    found = null;
    searchEl.value = "";
    renderRows();
    return render();
  }
  if (back) {
    exitIndex = 0;
    exitDialog.hidden = false;
    return render();
  }
  if (screen === "login") {
    if (e.key === "Enter") login();
    return;
  }
  if (e.keyCode === RED) {
    saveAuth(null);
    return login();
  }
  onBrowseKey(e);
  render();
}, true);

// navigator.language on the TV can differ from the language set in TV settings, so ask the SDK first
async function tvLanguage() {
  if (navigator.userAgent.includes("TitanOS/") && window.TitanSDK?.deviceInfo) {
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
