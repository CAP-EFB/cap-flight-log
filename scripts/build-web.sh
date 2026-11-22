#!/bin/sh
# Copy the web app into www/, the folder Capacitor bundles into the iPad app.
# The service worker stays out: the app ships its files, so it needs no cache.
set -eu
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www
cp index.html app.js styles.css manifest.webmanifest www/
cp -R icons vendor www/
# Capacitor's core script gives the app's web view registerPlugin(); the browser
# version does not load it.
cp node_modules/@capacitor/core/dist/capacitor.js www/vendor/capacitor.js
sed -i.bak 's#<script src="vendor/jspdf.umd.min.js"></script>#<script src="vendor/capacitor.js"></script>\n  <script src="vendor/jspdf.umd.min.js"></script>#' www/index.html
rm -f www/index.html.bak
grep -q 'vendor/capacitor.js' www/index.html || { echo "capacitor.js was not added to www/index.html" >&2; exit 1; }
echo "Built www/ for the iPad app"
