#!/bin/sh
# Copy the web app into www/, the folder Capacitor bundles into the iPad app.
# The service worker stays out: the app ships its files, so it needs no cache.
set -eu
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www
cp index.html app.js styles.css manifest.webmanifest www/
cp -R icons vendor www/
echo "Built www/ for the iPad app"
