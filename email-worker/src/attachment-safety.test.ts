import { describe, expect, it } from "vitest";
import { isExecutable } from "./attachment-safety";

describe("isExecutable", () => {
  it("flags dangerous extensions regardless of MIME", () => {
    expect(isExecutable("setup.exe", "application/octet-stream")).toBe(true);
    expect(isExecutable("script.bat", "text/plain")).toBe(true);
    expect(isExecutable("payload.JAR", "application/zip")).toBe(true);
    expect(isExecutable("install.dmg", null)).toBe(true);
    expect(isExecutable("note.lnk", "")).toBe(true);
  });

  it("flags executable MIMEs even when filename looks innocuous", () => {
    expect(isExecutable("readme", "application/x-msdownload")).toBe(true);
    expect(isExecutable("noext", "application/x-mach-binary")).toBe(true);
    expect(isExecutable("a.txt", "application/x-sh")).toBe(true);
  });

  it("only flags application/octet-stream when paired with a dangerous extension", () => {
    expect(isExecutable("data.bin", "application/octet-stream")).toBe(false);
    expect(isExecutable("document.pdf", "application/octet-stream")).toBe(false);
    expect(isExecutable("trojan.exe", "application/octet-stream")).toBe(true);
  });

  it("ignores benign files", () => {
    expect(isExecutable("photo.jpg", "image/jpeg")).toBe(false);
    expect(isExecutable("invoice.pdf", "application/pdf")).toBe(false);
    expect(isExecutable("notes.txt", "text/plain")).toBe(false);
    expect(isExecutable(null, "text/plain")).toBe(false);
    expect(isExecutable("", "")).toBe(false);
  });

  it("strips Content-Type parameters before matching", () => {
    expect(isExecutable("a", "application/x-sh; charset=utf-8")).toBe(true);
  });

  it("handles path-like filenames", () => {
    expect(isExecutable("C:\\\\Users\\\\me\\\\evil.exe", "")).toBe(true);
    expect(isExecutable("../something/run.cmd", "")).toBe(true);
  });
});
