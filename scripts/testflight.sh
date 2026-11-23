#!/bin/sh
# Build the iPad app for the App Store and upload it to App Store Connect,
# where it appears under TestFlight once Apple has processed it.
#
#   scripts/testflight.sh             build and upload
#   scripts/testflight.sh --no-upload build the signed package only (in build/testflight/)
#
# The store version is the app's own APP_VERSION from app.js; the build number
# is the date and time (YYYYMMDDHHMM), so every upload is higher than the last.
# Signing uses the team in Xcode (G3Q54YD3D3), with Xcode's automatic signing.
set -eu
cd "$(dirname "$0")/.."

VERSION=$(sed -n "s/^const APP_VERSION = '\([0-9.]*\)';/\1/p" app.js)
BUILD=$(date -u +%Y%m%d%H%M)
[ -n "$VERSION" ] || { echo "APP_VERSION not found in app.js" >&2; exit 1; }
OUT=build/testflight
ARCHIVE="$OUT/MissionLog-$VERSION-$BUILD.xcarchive"
OPTIONS=scripts/ExportOptions-testflight.plist
mkdir -p "$OUT"
if [ "${1:-}" = "--no-upload" ]; then
  # the same signing, written to a folder instead of sent to Apple
  sed 's#<string>upload</string>#<string>export</string>#' "$OPTIONS" > "$OUT/export-options.plist"
  OPTIONS="$OUT/export-options.plist"
fi

echo "Mission Log $VERSION ($BUILD)"
bash scripts/build-web.sh
npx cap sync ios >/dev/null

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$OUT/derived" \
  -archivePath "$ARCHIVE" -allowProvisioningUpdates \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  archive > "$OUT/archive.log" 2>&1 || { tail -20 "$OUT/archive.log"; exit 1; }
echo "Archived"

xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OPTIONS" -allowProvisioningUpdates > "$OUT/export.log" 2>&1 \
  || { grep -v '^\s*$' "$OUT/export.log" | tail -10; exit 1; }
if [ "${1:-}" = "--no-upload" ]; then
  echo "Signed package: $OUT/export/App.ipa"
else
  echo "Uploaded Mission Log $VERSION ($BUILD) to App Store Connect; it shows under TestFlight once processed."
fi
