// Executable / dangerous-attachment detection.
//
// Conservative by default: anything that could plausibly run code on the
// recipient's machine when double-clicked is tagged. The UI uses this flag to
// surface a warning badge and gate the download behind an explicit confirm —
// users who really need the file can still get it, they just can't do so by
// accident.
//
// Trigger if EITHER:
//   - the filename's extension is in the dangerous list, OR
//   - the Content-Type matches an executable MIME, OR
//   - the Content-Type is application/octet-stream (a common evasion) AND
//     the filename's extension is dangerous.
//
// Rules are intentionally simple and case-insensitive.

const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "scr",
  "msi",
  "pif",
  "ps1",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "jar",
  "app",
  "dmg",
  "pkg",
  "iso",
  "lnk",
  "reg",
  "hta",
  "cpl",
  "gadget",
  "ws",
  "lib",
]);

const EXECUTABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-mach-binary",
  "application/x-sh",
]);

// Generic-binary MIME — only flagged when the filename also looks dangerous.
// Lots of legitimate attachments (random binary blobs, exports) ship with
// this type, so on its own it's not enough.
const GENERIC_BINARY_MIME = "application/octet-stream";

export function isExecutable(
  filename: string | null | undefined,
  contentType: string | null | undefined,
): boolean {
  const ext = extensionOf(filename);
  const mime = (contentType ?? "").trim().toLowerCase().split(";")[0].trim();

  if (ext && DANGEROUS_EXTENSIONS.has(ext)) return true;
  if (mime && EXECUTABLE_MIME_TYPES.has(mime)) return true;
  if (mime === GENERIC_BINARY_MIME && ext && DANGEROUS_EXTENSIONS.has(ext)) {
    return true;
  }
  return false;
}

function extensionOf(filename: string | null | undefined): string | null {
  if (!filename) return null;
  // Strip any path-ish prefix and leading/trailing whitespace before
  // grabbing the final dot-component. Lowercased so the match table can
  // stay simple.
  const trimmed = filename.trim().replace(/[\\/]+/g, "/").split("/").pop() ?? "";
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0 || dot === trimmed.length - 1) return null;
  return trimmed.slice(dot + 1).toLowerCase();
}
