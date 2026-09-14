// Expo config plugin: trim the Android permission set.
//
// app.json declares only what Vesta uses, but the generated manifest is bigger
// than app.json: Expo's bare template ships a block of "OPTIONAL PERMISSIONS,
// REMOVE WHATEVER YOU DO NOT NEED", and autolinked libraries merge in their
// own. `npx expo config --type introspect` showed four permissions no Vesta
// code path can reach. This plugin removes them, and can additionally drop the
// one permission that no SCHEDULING feature needs.
//
// Two lists, because they are two different decisions:
//
// ALWAYS_REMOVED — nothing in Vesta uses these, in any build:
//   SYSTEM_ALERT_WINDOW  draw-over-other-apps. From the bare template's
//                        optional block. The widget and quick-chat are normal
//                        activities; nothing draws an overlay.
//   WRITE_CONTACTS       merged in by expo-contacts. Vesta only ever reads
//                        contacts (lib/native/contacts.ts) — it never writes.
//   READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE (maxSdkVersion 32)
//                        legacy broad storage, from the template's optional
//                        block. Documents and models are imported through the
//                        Storage Access Framework (expo-document-picker hands
//                        back a content:// URI and copies through the
//                        ContentResolver) and live in the app-private
//                        directory, neither of which needs these. They only
//                        affect Android 12L and older; if document import ever
//                        regresses there, this is the first thing to re-add.
//
// SCHEDULING_ONLY_REMOVED — used by a real feature, but not by any scheduling
// feature. Removed only when VESTA_SCHEDULING_ONLY is set:
//
//   VESTA_SCHEDULING_ONLY=1 npx expo prebuild --platform android --clean
//
//   READ_CONTACTS        search_contacts / make_call / send_sms. Without it
//                        those degrade honestly rather than breaking: the
//                        expo-contacts permission request returns denied and
//                        the tools already answer "I need permission to access
//                        your contacts". Nothing in the timer / alarm /
//                        reminder / calendar path touches contacts.
//
// What stays, and why (see docs/ARCHITECTURE.md §8.2 for the full table):
// SET_ALARM (alarms + timers), READ/WRITE_CALENDAR (events), POST_NOTIFICATIONS
// (reminders + the service notification), RECEIVE_BOOT_COMPLETED (re-arms
// scheduled reminders after a reboot), VIBRATE (reminder notifications),
// FOREGROUND_SERVICE(+SPECIAL_USE) (keeps the model resident), RECORD_AUDIO
// (the system speech recognizer), INTERNET (model downloads — the only egress).

const { withAndroidManifest } = require("expo/config-plugins");

const ALWAYS_REMOVED = [
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.WRITE_CONTACTS",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];

const SCHEDULING_ONLY_REMOVED = ["android.permission.READ_CONTACTS"];

function isSchedulingOnly() {
  const flag = process.env.VESTA_SCHEDULING_ONLY;
  return flag === "1" || flag === "true";
}

module.exports = function withPermissionProfile(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const remove = [
      ...ALWAYS_REMOVED,
      ...(isSchedulingOnly() ? SCHEDULING_ONLY_REMOVED : []),
    ];

    const declared = manifest["uses-permission"] ?? [];
    manifest["uses-permission"] = declared.filter(
      (p) => !remove.includes(p.$?.["android:name"]),
    );

    // Dropping our own declaration isn't enough: an autolinked library merges
    // its manifest at BUILD time, where this plugin can't see it.
    // `tools:node="remove"` instructs the manifest merger to drop the
    // permission no matter who asked for it.
    manifest.$ = manifest.$ ?? {};
    manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    for (const name of remove) {
      manifest["uses-permission"].push({
        $: { "android:name": name, "tools:node": "remove" },
      });
    }

    if (isSchedulingOnly()) {
      console.log(
        "[with-permission-profile] scheduling-only build: also removing " +
          SCHEDULING_ONLY_REMOVED.join(", "),
      );
    }
    return cfg;
  });
};
