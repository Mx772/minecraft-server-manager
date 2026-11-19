# Backups

[← Back to docs index](README.md)

The **Backups** page is every snapshot across your fleet, with size, reason, and age, filterable by server and by reason. Each server's card on the [dashboard](dashboard.md) also shows when it was last backed up, and warns once that is over 7 days ago.

![Backups](images/backups.png)

## Creating a backup

From a server's **Backups** tab (or via a [schedule](schedules.md)) you can snapshot the whole server directory in one click. The panel quiesces the world first (`save-off` → `save-all`), zips the data, then re-enables saving (`save-on`), so backups are consistent even on a running server. Compression runs in a background worker thread so it doesn't stall the panel. A backup started through the API can carry a note.

Every archive is **integrity-checked** the moment it's written: the panel reopens the zip and reads its directory. A torn or unopenable archive is deleted and the backup call fails there and then, rather than the problem surfacing months later when a restore is the only thing between you and data loss. A zero-entry archive (a server that has never started) is allowed but flagged on the event.

Tick **"Shrink World Afterwards"** (on the Backups tab) or **"Shrink the World After Each Backup"** (in a backup schedule) to remove rarely-visited chunks once the archive is safely written (see **[Shrinking a world](world-shrink.md)**). The shrink only runs while the server is stopped; on a running server the backup still happens and the shrink is skipped.

![Server backups](images/server-backups.png)

## Backup reasons

Backups are tagged by why they were taken:

- **manual**: you clicked **Back Up Now**. Replacing a server's active world with one from the library also takes a `manual` backup first.
- **scheduled**: created by a [schedule](schedules.md). Every new server is also seeded a daily scheduled backup automatically (staggered between 02:00 and 05:59), so a server has automatic coverage from day one, not just before updates.
- **pre-update**: taken automatically before a pack upgrade or a Minecraft version change, so an upgrade is always reversible.
- **pre-restore**: taken automatically right before a restore or a world reset, as a safety net in case the restore isn't what you wanted.

## Retention

Retention is capped **per server, per reason**: the newest in each group are kept, older ones are pruned automatically after each successful backup:

| Reason      | Kept by default |
| ----------- | --------------- |
| scheduled   | 10              |
| pre-update  | 10              |
| manual      | 20              |
| pre-restore | 5               |

`pre-restore` (called safety backups in the panel) has its own small bucket precisely so an automatic safety backup can never evict a `manual` backup you deliberately kept.

Two optional ceilings apply on top of the per-reason counts, both off by default: a **maximum age** (backups older than N days are pruned, whatever their reason) and a **maximum total size** per server (the oldest are pruned until the total fits: safety backups first, then scheduled ones, then the rest). The newest backup of a server is never pruned by either ceiling.

### Changing it

Admins set the panel-wide policy in the **Backup Retention** card on the **Settings** page (**Fill In Built-ins** puts the defaults above back into the form, ready to save). A server can differ on any of the six values: open its **Backups** tab and expand **Retention for This Server**. Each field there is blank unless that server sets it, and a blank field follows the panel-wide value (shown inside it). So a server can, for example, keep 3 scheduled backups and use the panel-wide values for everything else; clearing a field puts it back on the panel-wide value.

![The Backup Retention card in Settings](images/settings-retention.png)

![Retention for This Server on a server's Backups tab](images/server-retention.png)

Saving never deletes anything by itself. If the new limits would leave existing backups over the limit, the panel lists, per server, how many backups of each kind would go, how much space that frees and how old the oldest one is. It also says when a server was already over its limits before this change (for example after an earlier **From Next Backup**), since applying now trims everything over the limit, not only what this edit adds. Then it asks how to apply them:

- **Remove Now** deletes exactly the backups it just listed, nothing more: a backup made in the meantime waits for the next trim. From the Settings page, a server in the middle of a restore, backup or similar action is skipped and trims after its next backup; on a server's own Backups tab you are asked to try again once that action finishes. While a server's old backups are being deleted (usually seconds), other actions on that server have to wait: a scheduled backup or start that lands then tries again every minute until it can (for up to 30 minutes), a crashed server is restarted within about 20 seconds of it finishing (for up to 30 minutes), and a scheduled restart or stop that collides with it is skipped until its next time.
- **From Next Backup** keeps them for now; each server trims its backups the next time it makes one, as it always has.

![The dialog listing what new limits would remove](images/retention-preview.png)

A backup that is being restored is never removed while the restore runs: retention leaves it alone (and does not delete other backups to make room for it), and deleting it by hand is refused until the restore finishes.

The same settings are available to scripts as admin API endpoints: `GET`/`POST /api/backups/retention` and `/api/servers/:id/backups/retention`. Panel-wide values cannot be `null`. For a server, a value of `null` (or `""`) removes that one key, so it follows the panel-wide value again, and `{ "reset": true }` removes them all. Under each of those two paths, `POST …/preview` reports what a change would remove without removing it (`backups`, `bytes`, `servers`, `ids` and a per-server `byServer` breakdown), and `POST …/apply` applies the saved policy now and answers `{ deleted, skipped }` panel-wide (`skipped` counts busy servers) or `{ deleted }` for one server. Send the preview's `{ "token": "..." }` (kept for 10 minutes) or its `{ "ids": [...] }` to delete only those; with neither, everything over the limit goes. A per-server apply on a busy server answers 409.

Any backup can be **verified** on demand (the shield button on each row, or `POST /api/backups/:id/verify`): the panel reads every file in the archive and checks its checksum, exactly the bytes a restore would extract, without stopping the server or writing anything. **Scheduled backups are verified automatically** right after they are written. A damaged archive is reported as an error (a failed run for a schedule) and logged to the activity history, so you find out before you need it.

Backups can be **renamed** from the backup list (the rename button on each row). The archive on disk and the panel's record move together, so download, restore, and retention keep working with the new name.

![Rename a backup](images/backup-rename.png)

> Retention is bounded automatically, but large modded archives still count toward a server's [disk quota](storage.md), so keep an eye on the total for big packs.

## Restoring

Restoring a backup stops the server (verifying the container really stopped before touching any files), takes a `pre-restore` safety backup, replaces the **whole server directory** with the snapshot, and leaves it stopped for you to start again. The archive is unpacked to the side first and swapped in only once it has fully extracted, so a restore that fails partway leaves the current files untouched. Because pack upgrades always take a `pre-update` backup first, you can always roll back a bad upgrade.

## The panel's own database

Server backups only cover each server's own folder. The panel's own state is backed up separately. That means the database (`panel.db`, holding users, roles, 2FA secrets, schedules, pack pins, settings, and history) plus the two key files it can't be used without: `.secret-key` (decrypts stored secrets such as API keys and chat-bridge tokens) and `.session-secret` (keeps people signed in). Server worlds are not included, so these snapshots are only a few MB.

Each snapshot is a folder under `backups/_panel/` in the data folder, holding those files and a `manifest.json` that says when and why it was taken and which panel version took it. There are three kinds:

| Kind          | When                                                                                       | Kept      |
| ------------- | ------------------------------------------------------------------------------------------ | --------- |
| `pre-upgrade` | Automatically, when a new panel version needs to update the database, just before it does. | Newest 5  |
| `nightly`     | On the daily maintenance timer.                                                            | Newest 14 |
| `manual`      | When you run the backup command below.                                                     | Newest 10 |

The pre-upgrade snapshot means updating the usual way (`docker compose pull && docker compose up -d`) is always reversible. You don't have to remember a step beforehand.

To take one yourself, for example before trying a test build:

```bash
docker exec <panel container> node scripts/panel-backup.js          # take a snapshot
docker exec <panel container> node scripts/panel-backup.js --list   # list snapshots
```

Outside Docker, run `node scripts/panel-backup.js` from the panel folder. It is safe to run while the panel is running.

On boot the panel runs `PRAGMA integrity_check` and logs loudly if it fails, pointing you at `backups/_panel` for the newest good copy.

### Rolling back an update

If a new image misbehaves and you want the previous one back:

1. Stop the panel: `docker compose down` (your Minecraft servers are separate containers and keep running).
2. In the data folder, open `backups/_panel/` and pick the newest `…-pre-upgrade` folder. Its `manifest.json` shows the panel version it was taken from.
3. Copy `panel.db`, `.secret-key`, and `.session-secret` from that folder into the top of the data folder, replacing the current ones, and delete `panel.db-wal` and `panel.db-shm` if they exist.
4. Set `image:` in your compose file back to the previous tag (for example `:edge` or a `:v<version>` / `:sha-<commit>` tag) and run `docker compose up -d`.

Anything changed in the panel since that snapshot (new users, edited schedules, history) is lost; server worlds are not affected. The same steps restore a `nightly` or `manual` snapshot.

To back up absolutely everything, including server worlds and their backups, copy the whole data folder.
