import AppKit
import Foundation
import ImageIO
import PDFKit
import Vision

let maxImagePixels = 40_000_000
let maxOutputBytes = 400 * 1024 * 1024
enum ExtractionError: Error { case outputTooLarge }

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    fputs("usage: attachment-extract.swift <image|pdf> <path>\n", stderr)
    exit(2)
}

let mode = arguments[1]
let path = arguments[2]
guard mode == "image" || mode == "pdf", !path.isEmpty else {
    fputs("unsupported extraction mode\n", stderr)
    exit(2)
}

var isDirectory: ObjCBool = false
guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
      !isDirectory.boolValue else {
    fputs("input must be an existing file\n", stderr)
    exit(3)
}
let url = URL(fileURLWithPath: path)

func appendComplete(
    _ value: String,
    separator: String,
    to output: inout String,
    remaining: inout Int
) throws {
    if !output.isEmpty && !separator.isEmpty {
        guard separator.utf8.count <= remaining else { throw ExtractionError.outputTooLarge }
        output.append(separator)
        remaining -= separator.utf8.count
    }
    guard value.utf8.count <= remaining else { throw ExtractionError.outputTooLarge }
    output.append(value)
    remaining -= value.utf8.count
}

func writeOutput(_ output: String) {
    if let data = output.data(using: .utf8) {
        FileHandle.standardOutput.write(data)
    }
}

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    var output = ""
    var remaining = maxOutputBytes
    for result in request.results ?? [] {
        guard let text = result.topCandidates(1).first?.string, !text.isEmpty else { continue }
        try appendComplete(text, separator: "\n", to: &output, remaining: &remaining)
    }
    return output
}

do {
    if mode == "image" {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let rawProperties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) else {
            exit(3)
        }
        let properties = rawProperties as NSDictionary
        guard let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.intValue > 0,
              height.intValue > 0 else {
            exit(3)
        }
        if width.intValue > maxImagePixels / height.intValue {
            fputs("image exceeds 40 million pixel limit\n", stderr)
            exit(5)
        }
        guard let imageData = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            exit(3)
        }
        if imageData.width > maxImagePixels / imageData.height {
            fputs("image exceeds 40 million pixel limit\n", stderr)
            exit(5)
        }
        writeOutput(try recognize(imageData))
    } else {
        guard let document = PDFDocument(url: url) else {
            exit(3)
        }
        var output = ""
        var remaining = maxOutputBytes
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            if let text = page.string,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try appendComplete(text, separator: "\n\n", to: &output, remaining: &remaining)
            }
        }
        writeOutput(output)
    }
} catch {
    fputs("\(error)\n", stderr)
    exit(4)
}
