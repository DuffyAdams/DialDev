/* DialDev live transcription helper. BSD-3-Clause.
 *
 * Transcribes both sides of a call on this Mac with Apple's SpeechAnalyzer and detects in-band DTMF tones in the remote
 * party's audio. Nothing leaves the computer.
 *
 *   dialdev-transcribe --check [--locale en-US]     Prints availability and supported languages as one JSON object.
 *   dialdev-transcribe --input <prefix> [--locale]  Creates <prefix>-0.fifo (this phone) and <prefix>-1.fifo (remote).
 *
 * Each FIFO carries frames of "DDA1", sample rate (u32 LE), channels (u16 LE), reserved (u16), byte count (u32 LE),
 * then signed 16-bit little-endian interleaved samples. Results are JSON lines on stdout. Writing "stop" or closing
 * stdin ends the session once buffered audio has been transcribed.
 */
import Foundation
@preconcurrency import AVFoundation
import Speech

struct Failure: Error { let message: String; init(_ message: String) { self.message = message } }

let outputLock = NSLock()
func send(_ message: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: message), let line = String(data: data, encoding: .utf8) else { return }
  outputLock.lock(); fputs(line + "\n", stdout); fflush(stdout); outputLock.unlock()
}
func milliseconds(_ seconds: Double) -> Int { Int((seconds * 1000).rounded()) }
func languageName(_ id: String) -> String { Locale.current.localizedString(forIdentifier: id) ?? id }

/** Maps positions in the audio fed to the recognizer back to wall-clock time, across gaps in the call's audio. */
final class Timeline {
  private let lock = NSLock(); private var anchors: [(stream: Double, wall: Double)] = []
  func anchor(stream: Double, wall: Double) { lock.lock(); anchors.append((stream, wall)); lock.unlock() }
  func wall(_ stream: Double) -> Double {
    lock.lock(); defer { lock.unlock() }
    guard let anchor = anchors.last(where: { $0.stream <= stream + 0.0005 }) ?? anchors.first else { return Date().timeIntervalSince1970 }
    return anchor.wall + (stream - anchor.stream)
  }
}

/** Goertzel DTMF detector. A digit must hold for two consecutive ~26 ms blocks and dominate the block's energy. */
final class DTMFDetector {
  private static let frequencies = [697.0, 770.0, 852.0, 941.0, 1209.0, 1336.0, 1477.0, 1633.0]
  private static let keys = [["1", "2", "3", "A"], ["4", "5", "6", "B"], ["7", "8", "9", "C"], ["*", "0", "#", "D"]]
  private var rate = 0.0, size = 0, coefficients: [Double] = [], block: [Double] = [], blockStart = 0.0
  private var candidate: String?, candidateStart = 0.0, hits = 0, active: String?, misses = 0
  func reset() { block.removeAll(keepingCapacity: true); candidate = nil; hits = 0; active = nil; misses = 0 }
  func process(_ samples: [Int16], rate: Double, start: Double, detected: (String, Double) -> Void) {
    if rate != self.rate { self.rate = rate; size = max(64, Int((rate * 0.0256).rounded())); coefficients = Self.frequencies.map { 2 * cos(2 * .pi * $0 / rate) }; reset() }
    for (i, sample) in samples.enumerated() {
      if block.isEmpty { blockStart = start + Double(i) / rate }
      block.append(Double(sample))
      if block.count == size { analyze(detected); block.removeAll(keepingCapacity: true) }
    }
  }
  private func analyze(_ detected: (String, Double) -> Void) {
    let energy = block.reduce(0) { $0 + $1 * $1 }
    var digit: String?
    // Ignore blocks quieter than about -45 dBFS.
    if energy / Double(size) > 30_000 {
      // Share of the block's energy at each DTMF frequency: 1.0 for a pure tone, 0.5 each for an even two-tone pair.
      let shares = coefficients.map { c -> Double in
        var s1 = 0.0, s2 = 0.0
        for x in block { let s = x + c * s1 - s2; s2 = s1; s1 = s }
        return 2 * (s1 * s1 + s2 * s2 - c * s1 * s2) / (Double(size) * energy)
      }
      let rows = Array(shares[0..<4]), cols = Array(shares[4..<8])
      let r = rows.indices.max { rows[$0] < rows[$1] }!, c = cols.indices.max { cols[$0] < cols[$1] }!
      let nextRow = rows.enumerated().filter { $0.offset != r }.map(\.element).max()!, nextCol = cols.enumerated().filter { $0.offset != c }.map(\.element).max()!
      let twist = cols[c] / rows[r]
      if rows[r] > 0.15, cols[c] > 0.15, rows[r] + cols[c] > 0.6, nextRow < rows[r] / 4, nextCol < cols[c] / 4, twist > 0.12, twist < 3 { digit = Self.keys[r][c] }
    }
    if let digit, digit == candidate { hits += 1 } else { candidate = digit; hits = digit == nil ? 0 : 1; candidateStart = blockStart }
    if let digit, digit == active { misses = 0 } else if active != nil { misses += 1; if misses >= 2 { active = nil; misses = 0 } }
    if active == nil, let candidate, hits >= 2 { active = candidate; misses = 0; detected(candidate, candidateStart) }
  }
}

protocol Engine: AnyObject {
  func append(_ samples: [Int16], rate: Double)
  func finish() async
}

/** One side of the call: reads its FIFO, keeps time, and feeds the recognizer. */
final class Side: @unchecked Sendable {
  let index: Int, name: String, path: String
  var fd: Int32 = -1
  let timeline = Timeline()
  private let detector: DTMFDetector?
  private let lock = NSLock(); private var engine: Engine?, discard = false, pending: [([Int16], Double)] = [], pendingSeconds = 0.0
  /** RMS level of every 10 ms of audio fed to the recognizer, used to find where speech starts and ends. */
  private var envelope: [Float] = [], envelopeSum = 0.0, envelopeCount = 0
  private let queue = DispatchQueue(label: "dialdev.transcript")
  private var volatile: (text: String, start: Double, end: Double)?, flushScheduled = false, finalizedThrough = 0.0, shownVolatile = false

  init(index: Int, prefix: String) { self.index = index; name = index == 0 ? "local" : "remote"; path = "\(prefix)-\(index).fifo"; detector = index == 1 ? DTMFDetector() : nil }

  func attach(_ engine: Engine?) {
    lock.lock(); defer { lock.unlock() }
    guard let engine else { discard = true; pending.removeAll(); return }
    for (samples, rate) in pending { engine.append(samples, rate: rate) }
    pending.removeAll(); self.engine = engine
  }
  var attachedEngine: Engine? { lock.lock(); defer { lock.unlock() }; return engine }
  private func feed(_ samples: [Int16], rate: Double) {
    lock.lock(); defer { lock.unlock() }
    let block = max(1, Int(rate / 100))
    for sample in samples {
      envelopeSum += Double(sample) * Double(sample); envelopeCount += 1
      if envelopeCount == block { envelope.append(Float((envelopeSum / Double(block)).squareRoot() / 32768)); envelopeSum = 0; envelopeCount = 0 }
    }
    if let engine { engine.append(samples, rate: rate); return }
    // Hold up to ten minutes of audio while the speech model loads or downloads.
    if discard || pendingSeconds > 600 { return }
    pending.append((samples, rate)); pendingSeconds += Double(samples.count) / rate
  }

  /** Reads frames until the writer closes the FIFO, or until a stop request finds it idle. */
  func read(stopping: @escaping () -> Bool) {
    var buffer: [UInt8] = [], chunk = [UInt8](repeating: 0, count: 65536), connected = false, idleSince: Date?
    var stream = 0.0, started = false
    while true {
      let n = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if n > 0 {
        connected = true; idleSince = nil; buffer.append(contentsOf: chunk[0..<n])
        var offset = 0
        while buffer.count - offset >= 16 {
          let header = Array(buffer[offset..<offset + 16])
          let u32 = { (i: Int) in UInt32(header[i]) | UInt32(header[i + 1]) << 8 | UInt32(header[i + 2]) << 16 | UInt32(header[i + 3]) << 24 }
          let rate = Double(u32(4)), channels = Int(UInt16(header[8]) | UInt16(header[9]) << 8), bytes = Int(u32(12))
          guard header[0..<4].elementsEqual("DDA1".utf8), rate >= 8000, rate <= 192_000, (1...8).contains(channels), bytes <= 1_000_000, bytes % (2 * channels) == 0 else {
            send(["type": "error", "message": "The call audio stream was malformed."]); return
          }
          guard buffer.count - offset >= 16 + bytes else { break }
          let frames = bytes / (2 * channels)
          var samples = [Int16](repeating: 0, count: frames)
          buffer.withUnsafeBytes { raw in
            let base = raw.baseAddress!.advanced(by: offset + 16)
            for f in 0..<frames {
              var sum = 0
              for ch in 0..<channels { sum += Int(Int16(littleEndian: base.loadUnaligned(fromByteOffset: (f * channels + ch) * 2, as: Int16.self))) }
              samples[f] = Int16(sum / channels)
            }
          }
          offset += 16 + bytes
          let now = Date().timeIntervalSince1970, duration = Double(frames) / rate, arrived = now - duration
          if !started { started = true; timeline.anchor(stream: 0, wall: arrived) }
          else {
            // Audio pauses during hold, silence suppression, or dropped frames. Pad a short stretch of silence so phrases
            // on either side stay separate, and re-anchor the timeline so timestamps match the wall clock.
            let gap = arrived - timeline.wall(stream)
            if gap > 0.25 {
              let fill = min(gap, 1.0); feed([Int16](repeating: 0, count: Int(fill * rate)), rate: rate); stream += fill
              timeline.anchor(stream: stream, wall: arrived); detector?.reset()
            } else if gap < -0.5 { timeline.anchor(stream: stream, wall: arrived) }
          }
          detector?.process(samples, rate: rate, start: stream) { digit, at in send(["type": "dtmf", "side": name, "digit": digit, "time": milliseconds(timeline.wall(at))]) }
          feed(samples, rate: rate); stream += duration
        }
        if offset > 0 { buffer.removeFirst(offset) }
        continue
      }
      if n < 0 && errno == EINTR { continue }
      if n < 0 && errno != EAGAIN { break }
      // n == 0 means no writer: either it has not connected yet, or it has finished.
      if n == 0 && connected { break }
      if stopping() {
        if !connected { break }
        if let since = idleSince { if Date().timeIntervalSince(since) > 0.4 { break } } else { idleSince = Date() }
      }
      if n < 0 { var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0); _ = poll(&poller, 1, 50) } else { usleep(20_000) }
    }
  }

  /** Narrows a result's span to where the audio is within 16 dB of its loudest point; the recognizer's word timing starts up to a second early. */
  private func speechSpan(_ start: Double, _ end: Double) -> (Double, Double) {
    lock.lock(); defer { lock.unlock() }
    let first = max(0, Int(start * 100)), last = min(Int(end * 100), envelope.count - 1)
    guard last > first, let peak = envelope[first...last].max(), peak > 0.003 else { return (start, end) }
    let threshold = peak * 0.15
    guard let on = envelope[first...last].firstIndex(where: { $0 >= threshold }), let off = envelope[first...last].lastIndex(where: { $0 >= threshold }) else { return (start, end) }
    return (Double(on) / 100, Double(off + 1) / 100)
  }

  func report(text raw: String, start rawStart: Double, end rawEnd: Double, final: Bool) {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines), (start, end) = speechSpan(rawStart, rawEnd)
    queue.async { [self] in
      if final {
        finalizedThrough = max(finalizedThrough, rawEnd); volatile = nil
        if !text.isEmpty { send(["type": "text", "side": name, "final": true, "text": text, "start": milliseconds(timeline.wall(start)), "end": milliseconds(timeline.wall(end))]) }
        else if shownVolatile { send(["type": "text", "side": name, "final": false, "text": ""]) }
        shownVolatile = false; return
      }
      if rawEnd <= finalizedThrough { return }
      volatile = (text, start, end)
      // Volatile results arrive in word-by-word bursts; pass on the latest a few times a second.
      if flushScheduled { return }
      flushScheduled = true
      queue.asyncAfter(deadline: .now() + 0.15) { [self] in
        flushScheduled = false
        guard let v = volatile else { return }
        shownVolatile = !v.text.isEmpty
        send(["type": "text", "side": name, "final": false, "text": v.text, "start": milliseconds(timeline.wall(v.start)), "end": milliseconds(timeline.wall(v.end))])
      }
    }
  }
  func drain() async { await withCheckedContinuation { continuation in queue.async { continuation.resume() } } }
}

@available(macOS 26.0, *)
final class AppleEngine: Engine, @unchecked Sendable {
  private let analyzer: SpeechAnalyzer, format: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation
  private var converter: AVAudioConverter?, inputFormat: AVAudioFormat?, results: Task<Void, Never>?

  init(locale: Locale, side: Side) async throws {
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [.audioTimeRange])
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw Failure("No audio format is compatible with the speech model.") }
    self.format = format
    analyzer = SpeechAnalyzer(modules: [transcriber], options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime))
    let (sequence, input) = AsyncStream<AnalyzerInput>.makeStream(); self.input = input
    try await analyzer.start(inputSequence: sequence)
    results = Task {
      do {
        for try await result in transcriber.results {
          // A result's range runs from the end of the previous one; the word timings say when speech actually starts and ends.
          let words = result.text.runs.compactMap(\.audioTimeRange)
          side.report(text: String(result.text.characters), start: words.first?.start.seconds ?? result.range.start.seconds, end: words.last?.end.seconds ?? result.range.end.seconds, final: result.isFinal)
        }
      }
      catch { send(["type": "error", "message": "Transcription stopped: \(error.localizedDescription)"]) }
    }
  }
  func append(_ samples: [Int16], rate: Double) {
    if inputFormat?.sampleRate != rate {
      inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: false)
      converter = inputFormat.map { $0.sampleRate == format.sampleRate && $0.commonFormat == format.commonFormat && format.channelCount == 1 ? nil : AVAudioConverter(from: $0, to: format) } ?? nil
    }
    guard let inputFormat, !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { buffer.int16ChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    guard let converter else { input.yield(AnalyzerInput(buffer: buffer)); return }
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(samples.count) * format.sampleRate / rate) + 64) else { return }
    var supplied = false, error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true; status.pointee = .haveData; return buffer
    }
    if output.frameLength > 0 { input.yield(AnalyzerInput(buffer: output)) }
  }
  func finish() async {
    input.finish()
    do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { send(["type": "error", "message": "Transcription could not finish: \(error.localizedDescription)"]) }
    await results?.value
  }
}

/** Resolves the requested language (or the system language) to one the on-device model supports, installing it if needed. */
@available(macOS 26.0, *)
func prepareLocale(_ requested: String?, install: Bool) async throws -> (locale: Locale, installed: Bool) {
  guard SpeechTranscriber.isAvailable else { throw Failure("This Mac doesn’t support on-device transcription.") }
  var locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested.map { Locale(identifier: $0) } ?? Locale.current)
  if locale == nil, requested == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
  guard let locale else { throw Failure("On-device transcription doesn’t support \(languageName(requested ?? Locale.current.identifier)).") }
  let probe = SpeechTranscriber(locale: locale, preset: .transcription)
  if await AssetInventory.status(forModules: [probe]) == .installed { return (locale, true) }
  guard install else { return (locale, false) }
  let name = languageName(locale.identifier(.bcp47))
  send(["type": "status", "message": "Downloading the \(name) speech model…"])
  do { if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) { try await request.downloadAndInstall() } }
  catch { throw Failure("The \(name) speech model could not be downloaded: \(error.localizedDescription)") }
  send(["type": "status", "message": "\(name) speech model installed"])
  return (locale, true)
}

func check(_ requested: String?) async {
  guard #available(macOS 26.0, *) else { send(["available": false, "reason": "Live transcription requires macOS 26 or later."]); return }
  do {
    let (locale, installed) = try await prepareLocale(requested, install: false)
    let locales = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
    let list = Set(locales).map { ["id": $0, "name": languageName($0)] }.sorted { $0["name"]!.localizedStandardCompare($1["name"]!) == .orderedAscending }
    send(["available": true, "engine": "Apple Speech", "locale": locale.identifier(.bcp47), "language": languageName(locale.identifier(.bcp47)), "installed": installed, "locales": list])
  } catch let failure as Failure { send(["available": false, "reason": failure.message]) }
  catch { send(["available": false, "reason": error.localizedDescription]) }
}

func transcribe(prefix: String, requested: String?) async -> Int32 {
  let sides = [Side(index: 0, prefix: prefix), Side(index: 1, prefix: prefix)]
  defer { for side in sides { if side.fd >= 0 { close(side.fd) }; unlink(side.path) } }
  for side in sides {
    unlink(side.path)
    guard mkfifo(side.path, 0o600) == 0 else { send(["type": "error", "message": "Could not create the audio channel (\(String(cString: strerror(errno))))."]); return 1 }
    side.fd = open(side.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
    guard side.fd >= 0 else { send(["type": "error", "message": "Could not open the audio channel."]); return 1 }
  }
  send(["type": "ready"])

  let stopLock = NSLock(); var stopRequested = false
  let stopping = { stopLock.lock(); defer { stopLock.unlock() }; return stopRequested }
  Thread.detachNewThread { while let line = readLine(), line.trimmingCharacters(in: .whitespaces) != "stop" {}; stopLock.lock(); stopRequested = true; stopLock.unlock() }

  let setup = Task { () -> Bool in
    guard #available(macOS 26.0, *) else { send(["type": "error", "message": "Live transcription requires macOS 26 or later."]); return false }
    do {
      let (locale, _) = try await prepareLocale(requested, install: true)
      for side in sides { side.attach(try await AppleEngine(locale: locale, side: side)) }
      send(["type": "started", "engine": "Apple Speech", "locale": locale.identifier(.bcp47), "language": languageName(locale.identifier(.bcp47))])
      return true
    } catch {
      send(["type": "error", "message": (error as? Failure)?.message ?? "Transcription could not start: \(error.localizedDescription)"])
      return false
    }
  }

  await withTaskGroup(of: Void.self) { group in
    for side in sides { group.addTask { await withCheckedContinuation { continuation in Thread.detachNewThread { side.read(stopping: stopping); continuation.resume() } } } }
  }
  if await setup.value == false { for side in sides { side.attach(nil) }; send(["type": "end"]); return 1 }
  for side in sides { await side.attachedEngine?.finish(); await side.drain() }
  send(["type": "end"])
  return 0
}

@main struct Transcriber {
  static func main() async {
    let args = CommandLine.arguments
    let value = { (flag: String) -> String? in args.firstIndex(of: flag).flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil } }
    let locale = value("--locale").flatMap { $0.isEmpty ? nil : $0 }
    if args.contains("--check") { await check(locale); exit(0) }
    guard let prefix = value("--input") else { fputs("usage: dialdev-transcribe --check | --input <fifo prefix> [--locale <BCP-47>]\n", stderr); exit(64) }
    exit(await transcribe(prefix: prefix, requested: locale))
  }
}
