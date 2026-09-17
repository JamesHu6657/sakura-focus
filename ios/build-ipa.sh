#!/usr/bin/env bash
# Build an unsigned SakuraFocus.ipa for sideloading (Sideloadly / AltStore).
#
#   ./ios/build-ipa.sh
#
# Produces: ios/out/SakuraFocus.ipa
#
# Requirements (macOS): Xcode, Node 20+, Homebrew (for xcodegen).
# Unsigned IPAs cannot run as-is — they must be re-signed by the sideload
# tool (a free Apple ID works, with the usual 7-day re-sign limit).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/ios"

# 1. Static web bundle (ios/web -> ios/web/dist)
cd "$ROOT"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
npx vite build --config ios/web/vite.config.ts

# 2. Stage the bundle as the app's Web folder (folder reference -> copied verbatim)
# NOTE: staged under AppResources/ — a top-level ios/Web collides with ios/web
# on macOS's case-insensitive filesystem and wipes the web sources.
rm -rf "$IOS/AppResources"
mkdir -p "$IOS/AppResources"
cp -R "$ROOT/ios/web/dist/" "$IOS/AppResources/Web"

# 3. App icon: upscale the PWA icon to the single 1024 universal slot
APPICON="$IOS/SakuraFocus/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$APPICON"
sips -z 1024 1024 "$ROOT/public/icon-512.png" --out "$APPICON/AppIcon-1024.png" >/dev/null

# 4. Generate the Xcode project (brew install xcodegen if missing)
command -v xcodegen >/dev/null 2>&1 || brew install xcodegen
cd "$IOS"
xcodegen generate

# 5. Unsigned device build
xcodebuild \
  -project SakuraFocus.xcodeproj \
  -scheme SakuraFocus \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$IOS/build" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  clean build

# 6. Wrap the .app into an .ipa (Payload/<name>.app zipped)
APP="$IOS/build/Build/Products/Release-iphoneos/SakuraFocus.app"
[ -d "$APP" ] || { echo "missing $APP" >&2; exit 1; }
rm -rf "$IOS/out"
mkdir -p "$IOS/out/Payload"
cp -R "$APP" "$IOS/out/Payload/"
cd "$IOS/out"
rm -f SakuraFocus.ipa
/usr/bin/zip -qr SakuraFocus.ipa Payload

echo "OK: $IOS/out/SakuraFocus.ipa"
