# titan-twitch

A Twitch client for Titan OS: live channels you follow, popular streams, channel search, and the official
embedded player.
Plain HTML5, no build step, no backend.

## Setup

1. Register an app at https://dev.twitch.tv/console/apps with **Client Type: Public**.
   Any OAuth redirect URL works (e.g. `http://localhost`), the device flow doesn't use it.
2. Put its Client ID in `config.js`.

```sh
python3 -m http.server 9181
```

Open http://localhost:9181, then enter the code shown on screen at twitch.tv/activate.

## Remote

Browsing:

| Key | Action |
|---|---|
| Arrows | Move (Up from the first row reaches search) |
| OK | Play stream / start typing in search |
| Back | Clear search / exit |
| Red | Sign out of Twitch |

In the player:

| Key | Action |
|---|---|
| Left / Right, Channel -/+ | Previous / next stream in the same row |
| Back, Stop | Close the player |

Stream sound stays at 100%. Volume and mute are the TV's own remote keys.

## Notes

- Sign-in uses the OAuth device code flow, so no client secret is shipped. Tokens are kept in
  `localStorage` and refreshed on 401.
- UI languages: English, Ukrainian, German, French, Spanish, Italian, Dutch, Polish, Portuguese
  (`strings.js`). On the TV the language comes from `TitanSDK.deviceInfo.getDeviceInfo()`, elsewhere
  from `navigator.language`. Anything else falls back to English.
- The Twitch player only embeds on `localhost` or an HTTPS domain, and `parent` is taken from
  `location.hostname`. Host the app over HTTPS for the TV.
