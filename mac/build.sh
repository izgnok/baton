#!/bin/bash
# Claude Rooms.app 을 swiftc 로 직접 빌드해 ~/Applications 에 설치한다(Xcode·SwiftPM 없이)
set -euo pipefail
cd "$(dirname "$0")"
MAC="$PWD"
ROOT="$(cd .. && pwd)"
OUT="$MAC/.build/app"
APP="$OUT/Claude Rooms.app"
FONTS="$ROOT/node_modules/pretendard/dist/public/static"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

rm -rf "$OUT" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Fonts"

SRC=()
while IFS= read -r f; do SRC+=("$f"); done < <(find "$MAC/Sources/RoomsKit" "$MAC/Sources/ClaudeRooms" -name '*.swift' | sort)
swiftc -O -swift-version 6 -parse-as-library -target arm64-apple-macos14.0 -module-name ClaudeRooms \
  -o "$APP/Contents/MacOS/ClaudeRooms" "${SRC[@]}"

for w in Regular Medium SemiBold Bold; do
  cp "$FONTS/Pretendard-$w.otf" "$APP/Contents/Resources/Fonts/"
done

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Rooms</string>
  <key>CFBundleDisplayName</key><string>Claude Rooms</string>
  <key>CFBundleIdentifier</key><string>dev.claude-rooms.app</string>
  <key>CFBundleExecutable</key><string>ClaudeRooms</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$COMMIT</string>
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>CFBundleLocalizations</key><array><string>ko</string><string>en</string></array>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>RoomsSource</key><string>$ROOT</string>
  <key>RoomsCommit</key><string>$COMMIT</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null 2>&1 || true

DEST="$HOME/Applications/Claude Rooms.app"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
echo "설치: $DEST ($COMMIT)"
