#!/bin/bash
# BatonKit 단위 테스트. SwiftPM 없이 swiftc 로 빌드한다(Command Line Tools 만 있으면 됨)
set -euo pipefail
cd "$(dirname "$0")"
MAC="$PWD"
OUT="$MAC/.build/test"
DEV="$(xcode-select -p)"
FW="$DEV/Library/Developer/Frameworks"         # Testing.framework
PLUGINS="$DEV/usr/lib/swift/host/plugins/testing" # @Test·@Suite 매크로
INTEROP="$DEV/Library/Developer/usr/lib"        # lib_TestingInterop.dylib

rm -rf "$OUT" && mkdir -p "$OUT"

swiftc -parse-as-library -swift-version 6 -warnings-as-errors -enable-testing \
  -module-name BatonKit -emit-library -emit-module -emit-module-path "$OUT/BatonKit.swiftmodule" \
  -o "$OUT/libBatonKit.dylib" "$MAC"/Sources/BatonKit/*.swift

printf 'import Testing\n@main struct Runner { static func main() async { await Testing.__swiftPMEntryPoint() as Never } }\n' > "$OUT/main.swift"

# 테스트는 #filePath 로 Fixtures 를 찾으므로 절대 경로로 넘긴다
swiftc -parse-as-library -swift-version 6 -plugin-path "$PLUGINS" -F "$FW" -I "$OUT" -L "$OUT" -lBatonKit \
  -Xlinker -rpath -Xlinker "$FW" -Xlinker -rpath -Xlinker "$OUT" -Xlinker -rpath -Xlinker "$INTEROP" \
  -o "$OUT/tests" "$MAC"/Tests/BatonKitTests/*.swift "$OUT/main.swift"

"$OUT/tests" "$@"
