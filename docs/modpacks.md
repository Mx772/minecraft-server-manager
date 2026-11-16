# Modpacks

[← Back to docs index](README.md)

The **Modpacks** page (and the **From Modpack** tab in the [creation wizard](servers.md)) installs a modpack as a server, always **pinned to an exact pack version** so a restart can never silently upgrade the pack out from under you.

![Modpacks](images/modpacks.png)

## Supported platforms

- **CurseForge**: search by name. Needs a CurseForge API key (add it under **Settings → API Keys**).
- **Modrinth**: search by name.
- **FTB**: Feed The Beast packs, through the API only (a numeric pack ID plus an explicit version ID). The panel does not check FTB packs for updates yet.
- **GT New Horizons**: the 1.7.10 expert pack, installed from GTNH's own release index. GTNH picks its Java runtime per pack version (2.8.0+ runs on **Java 25** via bundled lwjgl3ify patches, older releases on Java 21 or 17), and the wizard raises the server's RAM and disk to sensible minimums for it.
- **Custom zip**: not a published pack at all. Upload a **CurseForge modpack export** (the zip with `manifest.json` that CurseForge's app produces for a hand-picked mod set), a **Modrinth `.mrpack`**, or **any zip of mod jars**. The panel resolves the manifest in bulk (or identifies each jar by hash/fingerprint/metadata), previews what fits, and installs everything in one task, including the pack's `overrides/` configs if you opt in. Mods whose authors disallow automated downloads are listed with a browser link and a manual-upload slot instead of failing the install.

## How pinning works

When you pick a pack, the panel resolves the exact version, records it, and installs that. On the **Updates** page you'll be told when a newer version is available (unless the server's [update policy](#update-policy) is **Manual Only**); upgrading is a deliberate, guarded action with a pre-update backup and rollback. Stable-tracking servers are never offered a beta. A server's own **Versions** tab answers the other half of the question: which future Minecraft versions the mods it actually has can follow ([updates](updates.md#minecraft-version-compatibility)).

Servers created on very old panel versions (before 0.9.7) could be left _unpinned_, meaning the container image would quietly install the newest pack version on every start. The panel now repairs these at boot: it locks each one to the version that is actually installed (read from the panel's own records or the image's install manifest, never a freshly resolved "latest") and logs an event. If it can't tell what's installed, the server's Settings page shows a warning asking you to pick the version manually, and any attempt to save an unpinned modpack configuration is rejected outright.

## Update policy

Each server has an **Update Policy** card on its **Settings → Configuration** tab, and all three options mean what they say:

- **Manual Only** (default): nothing ever changes on its own, and the server is left out of the update badge and Updates page entirely. The "leave me alone" mode: ideal for a hand-tuned or imported pack you never want touched.
- **Notify Me**: the daily check surfaces available updates as a badge and on the Updates page; applying them is always your click.
- **Auto-Update**: after the scheduled daily check, pending **pack** updates are applied through the same guarded path as a manual upgrade: pre-update backup, health monitoring, and an automatic rollback if the new version fails to boot. Updates that would move the server to a different Minecraft version are always skipped with an event instead: converting a world permanently is a decision the panel refuses to make for you. The manual **Check Now** buttons only check; they never trigger auto-updates.

## Upgrading a pack

From a pinned server you can upgrade to a newer version in one action. The panel takes a backup first, swaps the pinned version, rebuilds the server (re-resolving Java if the new version needs a different runtime), and monitors the first boot, with a generous window for large packs like GTNH that download a couple of gigabytes and build a several-hundred-mod world on first start.

## Keeping your changes across pack updates

A pack update can overwrite the configs and scripts the pack ships. To keep your own version of a file, add it to the server's **customizations**:

1. Open the server's **Files** tab.
2. Use a row's overflow menu and choose **Add To Customizations** (or **Update Customization** if the file is already customized). To add several at once, select them and use **Add To Customizations** in the bar that appears. Adding a folder adds every file inside it.

The panel keeps a copy of each file in a `customizations/` folder in the server's data folder, and copies that folder back over the server's files **every time the server starts**. Your version wins over the pack's, including after a pack upgrade. If the server was already running when you added a file, rebuild it to start applying the copy.

- **The badge:** files with a copy show a **Customized** badge in the Files tab, and folders that contain one show **Has Customizations**.
- **The Modpacks card:** the **Customizations** card on the server's **Mods** tab lists every customized file, with a status of **Applied**, **Applies At Next Start**, or **Changed Since Captured**, when it was captured and from which pack version. **Open** jumps to the file's folder in Files.
- **Editing:** saving a customized file in the Files editor updates your copy too, so the next start does not undo your edit. Saving a file inside `customizations/` edits only the copy.
- **Changed Since Captured:** the file on the server is newer than your saved copy and differs from it. An upload, a mod rewriting its own config at startup, or an edit outside the editor can cause this. Until you choose, your saved copy replaces the server's file at the next start. **Keep Current** saves the server's version as your customization. **Restore My Copy** puts your saved version over the server's file now (the current version is not kept; a running server may rewrite it again).
- **Secrets filled in at start:** a file the panel fills in with a secret when the server starts (like the Discord bridge config) can only be edited inside the `customizations/` folder. The panel will not save the server's filled-in version over it.
- **Removing one:** choose **Remove** on the card, or delete the file from inside the `customizations/` folder. Only your copy is deleted, and the pack's version comes back at the next pack update.
- **Upgrades:** when a server has customizations, the pack upgrade confirmation tells you how many files will be copied back over the new version.
- **Backups:** backups include the `customizations/` folder, so restoring a backup restores your changes too.

## Recommended setup (pack profiles)

Some packs have a **profile**: a short list of reviewed config changes, such as fewer mob spawns or a safer chunk-loading limit, that suit servers better than the pack's defaults. When a server's pinned pack has a profile, the **Recommended Setup** card appears on the server's **Mods** tab, above **Customizations**.

Profiles ship with the panel. Contributions are welcome as pull requests to the `pack-profiles/` folder; the format is described in [`pack-profiles/README.md`](../pack-profiles/README.md). A profile can only change values in config files.

- **Presets:** a profile is split into presets, each a small group of related changes with a description and a **Why**. Turn each one on or off with its switch. **Show Changes** lists every file and setting a preset touches, with the value it sets.
- **When they apply:** the panel applies your enabled presets before each start, again after a pack update, and after the first start (when the pack's config files first exist). **Apply Now** applies them immediately; if the server is running, restart it to load the changes.
- **Turning one off:** this stops future changes. It does not undo what the preset already did. Those values stay until you change them or the pack updates the file.
- **Needs review:** the panel holds back a change when it is not safe to make. This happens when the pack's value is no longer the one the profile was written against, or when the file's format is one the panel cannot edit safely. Nothing is written for that setting. Check the file and the message on the card, then adjust it yourself if you want it.
- **Waiting for first start:** the file does not exist until the server has started once. The change applies after that start.
- **Customized files win:** if a file is in your **Customizations**, the profile skips it and says so on the card. See the section above.
