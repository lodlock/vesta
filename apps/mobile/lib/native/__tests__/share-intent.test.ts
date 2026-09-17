// The share intent, asserted against the Kotlin that builds it.
//
// These are SOURCE-LEVEL assertions, and that is a deliberate, named
// compromise. The facts they pin down — ACTION_SEND, text/plain, a content://
// URI from our own FileProvider, FLAG_GRANT_READ_URI_PERMISSION on the intent
// that is actually started — live in Kotlin, and this project has no
// instrumented-test harness to observe a real Intent. The alternative was to
// assert nothing about them, and every one of these is a mistake that builds
// cleanly, runs cleanly, and fails only in someone's hand: a missing grant
// gives the recipient a SecurityException, a wrong MIME type hides every
// text-capable app from the chooser, and a file:// URI throws
// FileUriExposedException on anything since Android 7.
//
// So: a guard, not a proof. It cannot tell you the share works — the device
// check does that — but it will fail loudly if one of these is ever dropped.

import { readFileSync } from "fs";
import { join } from "path";

const NATIVE = join(__dirname, "../../../native/android/src/main/java/com/cosmico/vesta");
const RES = join(__dirname, "../../../native/android/src/main/res/xml");

const module_ = readFileSync(join(NATIVE, "SystemActionsModule.kt"), "utf8");
const paths = readFileSync(join(RES, "vesta_file_paths.xml"), "utf8");

/** Just the body of shareFile, so a match cannot come from another method. */
function shareFileBody(): string {
  const start = module_.indexOf("fun shareFile(");
  expect(start).toBeGreaterThan(-1);
  const next = module_.indexOf("\n    @ReactMethod", start);
  return module_.slice(start, next === -1 ? module_.length : next);
}

describe("the share intent", () => {
  const body = shareFileBody();

  it("is an ACTION_SEND", () => {
    expect(body).toContain("Intent(Intent.ACTION_SEND)");
  });

  // The MIME type decides which apps appear in the chooser at all. The caller
  // passes "text/plain" (see lib/diagnostics/__tests__/deliver.test.ts); this
  // asserts the native side puts it on the intent rather than hard-coding
  // something else or leaving it null.
  it("carries the MIME type it was given", () => {
    expect(body).toMatch(/type\s*=\s*mimeType/);
  });

  it("sends the file as a stream, not as text", () => {
    expect(body).toContain("putExtra(Intent.EXTRA_STREAM, uri)");
    expect(body).not.toContain("Intent.EXTRA_TEXT");
  });

  // A content:// URI, and one of ours. getUriForFile is what produces it;
  // handing Uri.fromFile a path instead is FileUriExposedException on API 24+.
  it("builds a content:// URI through our own FileProvider", () => {
    expect(body).toContain("FileProvider.getUriForFile(");
    expect(body).toContain("fileProviderAuthority()");
    expect(module_).toContain('"${reactApplicationContext.packageName}.fileprovider"');
    expect(body).not.toContain("Uri.fromFile");
  });

  // Both intents. The flag on the ACTION_SEND alone is not enough — the
  // chooser is the Intent actually started, and it forwards the grant.
  it("grants read permission on the send AND on the chooser", () => {
    const grants = body.match(/addFlags\(Intent\.FLAG_GRANT_READ_URI_PERMISSION\)/g);
    expect(grants).toHaveLength(2);
    expect(body).toContain("Intent.createChooser(send, title)");
  });

  // The grant is computed from getData()/getClipData(), not from EXTRA_STREAM.
  // The platform migrates the extra on the way out, but resting a permission on
  // a framework migration step is how this breaks on one OEM's share sheet.
  it("sets ClipData so the grant does not depend on the extra being migrated", () => {
    expect(body).toContain("ClipData.newUri(");
  });

  it("refuses to share anything outside the app cache", () => {
    expect(body).toContain("reactApplicationContext.cacheDir.canonicalFile");
    expect(body).toMatch(/startsWith\(cacheRoot\.path/);
  });

  // A private path is not something to put in front of a user or into a bug
  // report, and the error message is the one place it could leak.
  it("reports failures by file name, never by path", () => {
    expect(body).toContain("No such file: ${file.name}");
    expect(body).not.toContain("${file.path}");
    expect(body).not.toContain("${file.absolutePath}");
  });

  // The whole point. If this ever fails, the 3.38 MB
  // TransactionTooLargeException is back.
  //
  // Comments are stripped first: the module explains at length WHY it does not
  // use ClipboardManager, and a naive substring search would read that
  // explanation as the offence it warns about.
  it("never touches the clipboard", () => {
    const code = module_
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toContain("ClipboardManager");
    expect(code).not.toContain("setPrimaryClip");
  });

  it("asks for no permission", () => {
    expect(body).not.toContain("requestPermissions");
    expect(body).not.toContain("WRITE_EXTERNAL_STORAGE");
    expect(body).not.toContain("READ_EXTERNAL_STORAGE");
  });
});

describe("what the FileProvider is allowed to serve", () => {
  it("is one cache subdirectory and nothing else", () => {
    expect(paths).toContain('<cache-path name="diagnostics" path="diagnostics/" />');
    // files/ holds the models, the database and the prefix session cache.
    expect(paths).not.toContain("files-path");
    expect(paths).not.toContain("external-path");
    expect(paths).not.toContain('path="."');
  });
});
