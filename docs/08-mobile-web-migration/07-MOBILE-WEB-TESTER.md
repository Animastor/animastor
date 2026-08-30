# 07. Mobile Web Tester (`tools/mobile-web-tester`)

Developer tool for visual testing of the Animastor mobile web version
(`frontends/mobile`) on an Android tablet.

Opens the mobile frontend in a "phone frame" sized like a typical smartphone
to catch layout problems:

- elements overlapping each other;
- buttons/selectors not fitting width;
- text truncated;
- bottom panels extending beyond screen;
- incorrect vertical scrolling behavior;
- generator elements requiring too much width.

This is **not** a browser and **not** emulation of a specific Samsung/iPhone: only
CSS emulation — narrow viewport, mobile user-agent, touch, vertical
orientation, limited viewing area.

## How it works

- Inside — standard Android `WebView` (no third-party dependencies, only
  framework + Kotlin).
- Frame width in dp sets CSS viewport: in Android WebView **1 CSS px = 1 dp**,
  so WebView 390 dp wide renders page exactly 390 CSS px.
- Mobile frontend already contains `<meta name="viewport" content="width=device-width, ...">`,
  and `useWideViewPort=true` makes WebView genuinely respond to this viewport.
- Mobile user-agent forced (`mobileUA` in `MainActivity.kt`).
- Frame automatically recalculates on container size change
  (panel collapse, keyboard appearance) — nothing gets clipped.

## Capabilities

| Element | What it does |
|---|---|
| Size buttons | Switch viewport: **360×800 / 390×844 / 430×932** (default 390×844). Page reloads on switch. |
| URL bar | Mobile version URL; persists between launches. Can enter without scheme — `http://` prepended. |
| ⟳ | Reload current URL. **Long press** — clear cookies/cache/HTTP-auth and reload. |
| "Back" | Navigate back in WebView history. |
| Page Fullscreen API | **Disabled**: `requestFullscreen`/`webkitEnterFullscreen` blocked by injection (player "fullscreen" button inactive) — tester cannot get "stuck" in fullscreen with no way to exit. |

Supports JS, localStorage (IndexedDB), cookies, touch, scroll,
video/audio without user gesture, mixed content (for dev server via http).

## Basic Auth (`m.animastor.in`)

`m.animastor.in` protected by Basic Auth (`proxy/conf/.htpasswd`). Tester
authorizes **automatically**: `onReceivedHttpAuthRequest` → `handler.proceed(...)`
with hardcoded `AUTH_USER` / `AUTH_PASS` constants in `MainActivity.kt`.
If server password changes — edit constants (single location), or clear
auth cache by long-pressing ⟳.

## Build and install

```bash
./tools/mobile-web-tester/build-apk.sh
```

Script creates `local.properties` if needed, builds
`app/build/outputs/apk/debug/app-debug.apk` and copies it to
`/home/sureg/net-disk/mobile-web-tester.apk`.

Install on tablet (as usual):
`https://animastor.in/net-disk/mobile-web-tester.apk`

### Default URL

- Default: `https://m.animastor.in` (production mobile frontend).
- Override at build:
  ```bash
  cd tools/mobile-web-tester
  ./gradlew assembleDebug -PTESTER_URL=http://192.168.1.50:5174
  ```
- Or simply change URL in the input field in the app — it persists in
  SharedPreferences (`mobile_web_tester`). Important: saved URL overrides
  default, so after updating default, clear app data.

## Build requirements

- Android SDK (`/home/sureg/Android/Sdk`, android-35), JDK 17,
  local Gradle 8.12 from `frontend/gradle-8.12` (`gradlew` wrapper, like `frontend/`).
- minSdk 26, targetSdk 34, compileSdk 35, AGP 8.7.3, Kotlin 1.9.22 (matches `frontend/`).

## Limitations

1. **Viewport height may be less than 844 CSS px.** If tablet screen in dp
   is shorter than 844, frame compresses vertically to available space (width always
   fixed); page scrolls normally inside. On 8-inch tablets with density ≥ 2.0
   (e.g., 1920×1200), full 390×844 fits.
2. **Physical image size smaller than on real phone** — tablet has lower
   pixel density than flagship smartphone. This tests layout,
   not physical size.
3. **No hardware emulation**: touch is real tablet (`pointer: coarse`
   matches phone).
4. **minSdk 26** — for tablets on Android ≤ 7, need to lower minSdk
   and add PNG icon.
