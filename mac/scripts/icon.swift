// 사용: swift icon.swift <svg> <out.iconset>
// SVG 를 NSImage 로 읽어 iconutil 규격 PNG 10장을 만든다. SVG 를 못 읽으면 같은 도형을 NSBezierPath 로 그린다.
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write(Data("usage: icon.swift <svg> <out.iconset>\n".utf8)); exit(2) }
let outDir = args[2]
try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

// SVG 를 못 읽거나 크기가 0 이면 nil → 대체 경로
let svg: NSImage? = {
    guard let img = NSImage(contentsOf: URL(fileURLWithPath: args[1])), img.size.width > 0, img.size.height > 0 else { return nil }
    return img
}()

func hex(_ v: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}

// icon.svg 와 같은 도형(1024 좌표, y 아래로 증가)
func drawFallback(px: CGFloat) {
    guard let cg = NSGraphicsContext.current?.cgContext else { return }
    cg.saveGState()
    cg.translateBy(x: 0, y: px)
    cg.scaleBy(x: px / 1024, y: -px / 1024)
    let card = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185)
    hex(0xFFFDF8).setFill(); card.fill()
    hex(0xDDD5C5).setStroke(); card.lineWidth = 4; card.stroke()
    cg.translateBy(x: 512, y: 512)
    cg.rotate(by: -35 * .pi / 180)
    cg.translateBy(x: -512, y: -512)
    hex(0x2F6F5E).setFill()
    NSBezierPath(roundedRect: NSRect(x: 392, y: 462, width: 380, height: 100), xRadius: 50, yRadius: 50).fill()
    NSBezierPath(ovalIn: NSRect(x: 256, y: 456, width: 112, height: 112)).fill()
    cg.restoreGState()
}

func render(px: Int, to name: String) throws {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { throw CocoaError(.fileWriteUnknown) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high
    if let svg { svg.draw(in: NSRect(x: 0, y: 0, width: px, height: px)) } else { drawFallback(px: CGFloat(px)) }
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(name))
}

for base in [16, 32, 128, 256, 512] {
    try render(px: base, to: "icon_\(base)x\(base).png")
    try render(px: base * 2, to: "icon_\(base)x\(base)@2x.png")
}
print(svg != nil ? "icon: SVG 경로" : "icon: 대체(NSBezierPath) 경로")
