import AppKit
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let rect = NSRect(x: 64, y: 64, width: 896, height: 896)
let background = NSBezierPath(roundedRect: rect, xRadius: 206, yRadius: 206)
let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.18); shadow.shadowBlurRadius = 22; shadow.shadowOffset = NSSize(width: 0, height: -8); shadow.set()
NSGradient(starting: NSColor(calibratedRed: 0.933, green: 0.945, blue: 0.941, alpha: 1), ending: NSColor.white)!.draw(in: background, angle: 85)
NSShadow().set()
NSColor(calibratedRed: 0.86, green: 0.89, blue: 0.87, alpha: 1).setStroke(); background.lineWidth = 2; background.stroke()
let circle = NSBezierPath(ovalIn: NSRect(x: 194, y: 194, width: 636, height: 636))
NSGradient(starting: NSColor(calibratedRed: 0.125, green: 0.682, blue: 0.345, alpha: 1), ending: NSColor(calibratedRed: 0.224, green: 0.808, blue: 0.463, alpha: 1))!.draw(in: circle, angle: 90)
let p = NSBezierPath()
func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: 512 + (x - 32) * 11.2, y: 512 - (y - 32) * 11.2) }
p.move(to: pt(22,16)); p.curve(to:pt(16,25),controlPoint1:pt(18,16),controlPoint2:pt(15,20)); p.curve(to:pt(39,48),controlPoint1:pt(19,37),controlPoint2:pt(27,45)); p.curve(to:pt(48,42),controlPoint1:pt(44,49),controlPoint2:pt(48,46)); p.line(to:pt(48,37)); p.line(to:pt(38,33)); p.line(to:pt(34,38)); p.curve(to:pt(24,28),controlPoint1:pt(29,36),controlPoint2:pt(26,33)); p.line(to:pt(29,24)); p.line(to:pt(25,16)); p.close()
NSColor.white.setFill(); p.fill()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "build/icon.png"))
