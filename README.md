# Mission Log

An offline, iPad-first version of the CAP Observer Mission Log kneeboard card. It runs as a
single-page web app, installs to the iPad home screen, autosaves on the device, and prints a
two-page mission log to PDF (long logs can add a continuation page).

**Live app:** https://cap-efb.github.io/cap-mission-log/

## What it does

The tabs follow a sortie from briefing to signature: **Plan → Fly → Notes → Debrief → Sign**.

- **Missions and sorties** — a mission holds one or more sorties. The header's sortie switcher (or
  Menu → + Sortie) starts the next sortie with the same crew, aircraft, frequencies and search area;
  mission number, base, mission date and your name and CAPID are shared by every sortie.
- **Plan** — mission and sortie, crew, flight profile, the search area (corners, entry and exit points,
  ForeFlight FPL import), the planned column of the SAR worksheet (CAPF 104a), frequencies and nav aids.
- **Fly** — checkpoint buttons that stamp UTC time and GPS position and ask for Hobbs (and tach at Engine
  Start and Shut Down), the flight log, observations with up to six photos each, and OPS checks with a
  next-due reminder.
- **Notes** — free text plus a graph-paper sketch pad for Apple Pencil or a finger.
- **Debrief** — flight times and totals, Hobbs and tach end/start/total with Hobbs split into In Area and
  To/From, the actual column of the SAR worksheet, effectiveness, visibility and crew remarks.
- **Sign** — printed name, CAPID, UTC date/time, a signature pad and Share signed log (PDF).
- **GPS** — live position, accuracy, CAP sectional grid and lat/long cell in the header. Switch Live GPS
  off in Settings to save battery.
- **Send sortie to crew** — Menu → Send sortie to crew (or the header's sortie switcher) shares only the
  current sortie by AirDrop, Messages or Mail. The crew member saves it to Files and uses Menu → Import
  backup; it joins their copy of the mission (matched by mission number) as its own sortie, with the
  sign-off left for them to complete.
- **Output** — Print / Save PDF. On iPad this builds a PDF and opens the share sheet (Save to Files or
  Print); on a computer it uses the browser print dialog. Also JSON backup/import and a flight-log CSV.
- **Disclaimer & terms** — shown on first use and must be accepted to continue; available afterwards
  from the menu.
- **Feedback** — Menu → Send feedback opens the feedback form (https://forms.gle/EBEkXN8LNWNPL8VG7).
- **Offline** — a service worker caches the whole app. After the first load it works with no
  signal. Data never leaves the iPad unless you export it.

## Install on the iPad

1. Open the live URL in **Safari** on the iPad.
2. Tap **Share → Add to Home Screen**.
3. Launch it from the new icon.
4. When prompted, allow **Location** if you want GPS. (Settings → Privacy & Security →
   Location Services must be on. On a Wi-Fi-only iPad the fix comes from Wi-Fi positioning and
   may be coarse; cellular iPads have a real GPS receiver.)

The first load requires a connection so Safari can install the service worker. Everything after
that, including the sketch pad and GPS *after* permission is granted, works offline.

## Data and backups

Logs are stored in IndexedDB, with a localStorage mirror as a fallback. There is no account and
no server; nothing is uploaded. Autosave runs about half a second after each change.

Safari can evict website data after long periods of disuse. Export a JSON backup after each
mission from **Menu → Export backup**, and save the PDF to Files. The JSON backup can be
re-imported on the same or another iPad. Photos are compressed to at most 1600 px and are
included in both the backup and the PDF.

## Printing

**Menu → Print / Save PDF**, then choose **Save to Files** or **Print** in the share sheet. On a computer,
the browser print dialog opens. The PDF has:

1. Mission/crew/frequency block, flight times and totals, the flight log table and OPS checks.
2. Notes, sketch, observations (including photos) and the certification/signature block.

The layout is tuned for US Letter portrait; a long flight log can add a continuation page.
The app icon and emblem appear in the app header and on printed headers.

## Development

No build step. Serve the folder over HTTP (the service worker and GPS need a secure origin;
`localhost` counts):

```sh
cd observer-log
python3 -m http.server 4173
# open http://localhost:4173
```

On an iPad on the same network, use an HTTPS host (GitHub Pages, Netlify, Cloudflare Pages,
etc.) — plain `http://192.168.x.x` will not register the service worker or allow GPS.

### Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell, top bar, tab bar |
| `styles.css` | Screen layout, dark mode, print stylesheet |
| `app.js` | State, storage, GPS, sketch/signature, rendering, PDF builder |
| `sw.js` | Offline cache (bump `CACHE` when shipping changes) |
| `vendor/` | Bundled jsPDF + AutoTable for in-app PDF export |
| `manifest.webmanifest` | Home-screen metadata |
| `icons/` | App icons and the header emblem |

## Deployment

`main` holds the source. The live site is served from the **`gh-pages`** branch root
(`CAP-EFB/cap-mission-log`), because the legacy Pages builder on `main` was unreliable after the repo move.

Edit and commit on `main`, then publish the static files:

```sh
git add .
git commit -m "Mission Log 1.3.0"
git push origin main
./deploy-pages.sh
```

The script copies `index.html`, `app.js`, `styles.css`, `sw.js`, the manifest and `icons/` to
`gh-pages` and pushes it. Pages then serves `https://cap-efb.github.io/cap-mission-log/`.

When you change the app, bump `CACHE` in `sw.js` (for example `observer-log-v1.1.6`) so
installed copies pick up the new files. The `deploy-pages.sh` script also copies `vendor/`.

## Trademark note

This is a personal mission-log tool, not an official Civil Air Patrol product. It is not affiliated
with or endorsed by Civil Air Patrol, Inc. CAP names and emblems are trademarks of Civil Air Patrol,
Inc.; this app uses its own airplane icon, not the CAP emblem.

PDF generation uses [jsPDF](https://github.com/parallax/jsPDF) and
[jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable), both MIT licensed.
