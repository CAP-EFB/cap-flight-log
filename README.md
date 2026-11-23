# Mission Log

An offline, iPad-first version of the CAP Observer Mission Log kneeboard card. It runs as a
single-page web app, installs to the iPad home screen, autosaves on the device, and prints a
two-page mission log to PDF (long logs can add a continuation page).

**Live app:** https://missionlog.io/cap-mission-log/

## What it does

It follows WMIRS: a **mission** (Mission No., Name and Symbol, e.g. 27-T-3852 / A31) holds **air
sorties** (Sortie No., e.g. A0009). The tabs are **Missions**, then one sortie from brief to signature:
**Brief → Fly → Notes → Debrief → Close**.

- **Missions** — the first tab: the picked mission at the top with its sorties and + Add sortie, then the
  other open missions, then Closed missions and totals (sorties, Hobbs, tracked distance). Closing a
  mission moves it to Closed missions; tapping a closed mission brings it back up to look at or reopen. Tapping a mission picks it; tapping a sortie opens its Brief. The sortie name in the header switches between the mission's sorties and stays on the same tab. The +
  button adds a mission from WMIRS (number required; symbol, name and date optional). Mission
  details can close a mission once it is closed in WMIRS.
- **Adding a sortie** — the WMIRS Air Sortie Add/Edit fields: Sortie No. (the next one is suggested),
  Sortie Type (the WMIRS list), Tail No., Call Sign, Dep. and Dest. Airport (the next sortie starts from the last one's destination). A mission's next sortie
  copies the crew, frequencies, nav aids and search area from its last one. Brief…Close open once a
  sortie is open.
- **Brief** — everything on the CAPF 104 briefing pages: the sortie's WMIRS fields (Sortie Objective, Area
  of Operations, ETD/ETE), crew (MP, MO, MS, AP, RO, PAX) with each seat's CAPF 104 qualification boxes and
  the crew contact, the aircraft (type, TAS, colour, owner, fuel, home base, equipment), Sortie Objectives,
  Deliverables, Actions To Be Taken and Route Of Flight, altitude and airspeed with their restrictions,
  safety (separation, alternates, MTRs, hazards, other aircraft and ground teams), current and forecast
  weather, flight plan and risk assessment with special instructions, the briefer and FRO, the search
  area (corners, entry and exit points, ForeFlight FPL import), offline maps, the planned column of the
  SAR worksheet (CAPF 104a), frequencies (including Air/Ground, Air/Air, base, base telephone and required
  radio checks) and nav aids.
- **Fly** — a moving map (Sectional, Topo or Terrain) between the header and the tab bar, following the
  aircraft, with the track, checkpoints, ForeFlight plan and search area on it. Over the map on dark glass:
  the position (grid, cell, accuracy) and OPS status top left; the checkpoint buttons and + Observation down the right (stamped
  ones green with their time, the next one outlined), which stamp UTC time and GPS position and open a Hobbs keypad
  beside the button, as a popover pointing at it (with tach at Engine Start and Shut Down); zoom and centre; OPS check and Log bottom left. Log
  slides up the timeline of entries and observations (up to six photos each) and the OPS checks with their
  next-due reminder. Tapping the header's position opens Fly centred on the aircraft.
- **Notes** — free text, the whole page, shrinking above the keyboard.
- **Sketch** — a sketch pad filling everything between the header and the tab bar, with its tools
  (backgrounds, Undo/Redo, Clear, pages) in a row of the header. Each page is a canvas you pan and zoom,
  anchored to a piece of the map around the search area (Web Mercator pixels at zoom 12, about 330 km
  square). Its background is a layer under the drawing: endless graph paper (Grid), white (Plain), the FAA
  sectional, the USGS topographic map, or Esri's shaded relief with lakes and rivers (Terrain). Switching
  background keeps the drawing where it is, so a sketch made on the grid lands on the chart in place.
  - In the iPad app the drawing is PencilKit: Apple's tool palette (pens, marker, pencil, eraser, lasso,
    ruler, colours), pressure and tilt, palm rejection, Undo/Redo. The canvas takes the fingers (two to
    move, or one with Only Draw with Apple Pencil on) and reports its pan and zoom on every frame; the
    web map under it follows.
  - In a browser, lines are kept in latitude and longitude, with a hand tool, three pens and an eraser.
  - Each page's PDF picture is the view on screen. Saved offline maps work here too.
  - Pages drawn before 1.35.0 on fixed-size paper keep that page (grid or plain); a map for one starts a
    new page.
- **Flight track** — recorded from Engine Start to Shut Down (in the iPad app also in the background), with
  REC in the header while it records. Shown on the chart (Sectional, Topo or Terrain) with each checkpoint marked by its Fly button
  icon, over the ForeFlight plan the search area was filled from (dashed, waypoints named on tap); summed
  up on Debrief, and exportable as GPX.
- **Offline maps** — Brief › Offline maps saves the Sectional (and, if wanted, Topo and Terrain) around the
  search area, entry and exit points and ForeFlight route, 10 nm around them, in the app's own storage
  (IndexedDB, not in backups). The chart and sketch pad use saved tiles first, then the network, then a
  saved tile from a zoom level or more up, enlarged. A sectional saved more than 56 days ago is flagged
  for a fresh save. Deleting a sortie deletes its maps; tiles are shared between sorties.
- **Debrief** — in the order of the WMIRS Air Sortie Debrief: Flight Plan Closed, ATD/ATA (Engine Start
  and Shut Down) and the checkpoint times, Hobbs and tach end/start/total with Hobbs In Area and To/From,
  fuel and oil used, cost and receipt #, then Summary, Results/Deliverables, Weather Conditions and Remarks
  (with WMIRS's character limits), Sortie Effectiveness and the reason if not successful, Wing Paid,
  attachments and documentation, and the debriefing officer. The CAPF 104a actual column and search
  effectiveness follow.
- **Close** — sign the sortie off (printed name, CAPID, UTC date/time and a signature), then Close sortie.
  A closed sortie shows Closed on Missions and can be reopened. Closing a mission's last open sortie
  offers to close the mission. Share signed log (PDF) is here too, and **CAPF 104 (PDF)**: the CAP's own
  fillable form (`vendor/capf104.pdf`) with every field filled in from Missions, Brief, Notes and Debrief by
  pdf-lib, the layout unchanged and the fields still editable. The bundled blank form is the Dec 21
  edition with its owner-password encryption removed (it opens without a password and permits form
  filling), because pdf-lib cannot write to an encrypted file.
- **GPS** — live position, accuracy, CAP sectional grid and lat/long cell in the header, once the open
  sortie has its first checkpoint. Switch Live GPS
  off in Settings to save battery.
- **Send sortie to crew** — Menu → Send sortie to crew shares only the
  current sortie by AirDrop, Messages or Mail. The crew member saves it to Files and uses Menu → Import
  backup; it joins their copy of the mission (matched by mission number) as its own sortie, with the
  sign-off left for them to complete.
- **Output** — Print / Save PDF. On iPad this builds a PDF and opens the share sheet (Save to Files or
  Print); on a computer it uses the browser print dialog. The PDF includes the WMIRS brief and debrief fields. Also JSON backup/import and a sortie-log CSV.
- **Disclaimer & terms** — shown on first use and must be accepted to continue; available afterwards
  from the menu.
- **Feedback** — Menu → Send feedback opens the feedback form (https://forms.gle/EBEkXN8LNWNPL8VG7).
- **Offline** — a service worker caches the whole app. After the first load it works with no
  signal. Maps work offline where they were saved (see Offline maps). Data never leaves the iPad unless you export it.

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
| `vendor/` | Bundled jsPDF + AutoTable for in-app PDF export; pdf-lib and the blank CAPF 104 for the form |
| `manifest.webmanifest` | Home-screen metadata |
| `icons/` | App icons and the header emblem |

## iPad app (Capacitor)

The same web code also ships as a native iPad app built with [Capacitor](https://capacitorjs.com).
The Xcode project is in `ios/`; the web files are copied into it, so the app works offline without a
service worker. Inside the app, GPS, the share sheet and files go through native plugins
(`@capacitor/geolocation`, `@capacitor/share`, `@capacitor/filesystem`); in a browser the same code
uses the web APIs.

Needs Xcode (from the Mac App Store) and Node.

```sh
npm install          # Capacitor and its plugins, pinned versions
npm run sync         # copy the web files into www/ and update the Xcode project
npm run open         # open ios/App in Xcode, then build and run on a simulator or iPad
```

### Native features

- **OPS check reminder:** a local notification at the next OPS check time while the sortie is running
  (after Engine Start, before Shut Down), so it reaches the crew in ForeFlight or on the Lock Screen.
- **Haptics** when a checkpoint or OPS check is recorded; **keep screen awake** through
  `ios/App/App/MissionLogPlugin.swift`; light **status bar** text; **launch screen** with the logo;
  the keyboard's previous / next / Done bar; the app resizes above the keyboard.
- **Open in Mission Log:** `.fpl` flight plans (ForeFlight → Send To) fill the search area, and `.json`
  backups or shared sorties (AirDrop, Files) import directly.
- **Live Activity:** from Engine Start to Shut Down the Lock Screen shows the phase, time since wheels up,
  the next OPS check and the CAP grid. The app side is in `MissionLogPlugin.swift` and
  `SortieActivityAttributes.swift`; the widget is `ios/App/SortieActivity/SortieActivityWidget.swift`,
  which needs a Widget Extension target (see below).

### Adding the Live Activity widget target (once, in Xcode)

1. File → New → Target… → **Widget Extension**. Product name `SortieActivity`; tick **Include Live
   Activity**; untick Configuration App Intent. Activate the scheme if asked.
2. Delete the Swift files Xcode generated in the new `SortieActivity` group, then drag
   `ios/App/SortieActivity/SortieActivityWidget.swift` into that group (target: SortieActivity only).
3. Select `App/SortieActivityAttributes.swift`; in the File inspector tick both **App** and
   **SortieActivity** under Target Membership.
4. Set the SortieActivity target's iOS deployment target to 16.2 and its signing team to yours.

Run `npm run sync` after every change to `index.html`, `app.js`, `styles.css`, `icons/` or `vendor/`.
App ID: `io.missionlog.app`. Location, camera and photo permission texts are in
`ios/App/App/Info.plist`.

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
`gh-pages` and pushes it. Pages then serves `https://missionlog.io/cap-mission-log/`
(the organization site's custom domain applies to this project site too).

When you change the app, bump `CACHE` in `sw.js` (for example `observer-log-v1.1.6`) so
installed copies pick up the new files. The `deploy-pages.sh` script also copies `vendor/`.

## Trademark note

This is a personal mission-log tool, not an official Civil Air Patrol product. It is not affiliated
with or endorsed by Civil Air Patrol, Inc. CAP names and emblems are trademarks of Civil Air Patrol,
Inc.; this app uses its own airplane icon, not the CAP emblem.

PDF generation uses [jsPDF](https://github.com/parallax/jsPDF) and
[jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable), both MIT licensed.
