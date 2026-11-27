#!/bin/bash
# Baton.app 을 swiftc 로 직접 빌드해 ~/Applications(env DEST_DIR 로 바꿈)에 설치한다(Xcode·SwiftPM 없이)
set -euo pipefail
cd "$(dirname "$0")"
MAC="$PWD"
ROOT="$(cd .. && pwd)"
OUT="$MAC/.build/app"
APP="$OUT/Baton.app"
FONTS="$ROOT/node_modules/pretendard/dist/public/static"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

rm -rf "$OUT" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Fonts"

SRC=()
while IFS= read -r f; do SRC+=("$f"); done < <(find "$MAC/Sources/BatonKit" "$MAC/Sources/Baton" -name '*.swift' | sort)
swiftc -O -swift-version 6 -parse-as-library -target arm64-apple-macos14.0 -module-name Baton \
  -o "$APP/Contents/MacOS/Baton" "${SRC[@]}"

for w in Regular Medium SemiBold Bold; do
  cp "$FONTS/Pretendard-$w.otf" "$APP/Contents/Resources/Fonts/"
done

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Baton</string>
  <key>CFBundleDisplayName</key><string>Baton</string>
  <key>CFBundleIdentifier</key><string>dev.baton.app</string>
  <key>CFBundleExecutable</key><string>Baton</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$COMMIT</string>
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>CFBundleLocalizations</key><array><string>ko</string><string>en</string></array>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>BatonSource</key><string>$ROOT</string>
  <key>BatonCommit</key><string>$COMMIT</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null 2>&1 || true

# 설치. 옛 이름 앱(Claude Rooms.app)이 실제 폴더로 남아 있으면 Baton.app 을 가리키는 링크로 바꾼다
# (옛 앱의 다시 켜기가 자기 번들 경로를 열기 때문에, 업데이트 뒤에도 새 앱이 뜨게). 이미 링크면 그대로 둔다
install_app() {
  local dir="${DEST_DIR:-$HOME/Applications}"
  mkdir -p "$dir"
  rm -rf "$dir/Baton.app"
  cp -R "$APP" "$dir/Baton.app"
  local old="$dir/Claude Rooms.app"
  if [ -d "$old" ] && [ ! -L "$old" ]; then
    rm -rf "$old"
    ln -s "$dir/Baton.app" "$old"
  fi
  echo "설치: $dir/Baton.app ($COMMIT)"
}
install_app
