# Automation

[← Back to docs index](README.md)

The **Automation** page runs things for you on a schedule. An automation is a cron schedule plus an ordered list of **steps**, and each step happens at its own time relative to the schedule. No external cron, no scripts.

It replaces the old Schedules page. Every schedule you had carried over automatically as an automation with one step, and keeps its timing, its on/off state, and its last run.

## Anatomy of an automation

- **Name**: what the automation is called in the list and in the activity log.
- **Runs On**: the servers it acts on.
  - **Servers**: one or more servers you pick. Each server runs its own copy of the steps, side by side, and one failing does not stop the others.
  - **All Servers**: every server, including ones created later. Admin-only.
  - **Panel**: the panel itself, for maintenance and for actions that cover the whole fleet.
- **Trigger**: when it runs, either a **Schedule** or an **Event** (see [Triggers](#triggers)).
- **Schedule**: a cron expression (five fields: minute, hour, day of month, month, day of week). The editor previews the next three times as you type. Times follow the panel's time zone, set in **Settings**.
- **Steps**: what happens, in order. Every step has a **time**, an **action**, and an **On Failure** choice.

### Triggers

An automation starts from one trigger.

- **Schedule**: a cron expression, as above.
- **Event**: something that happens to a server. It runs once for each server it happened to, for the servers the automation names (or every server).

| Event                               | When it runs                                                                                                                                                                                                      | Actions you can use                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Before The Server Starts**        | Right before the panel starts the server, whether you start it, a restart, an update, or an automatic restart after a crash.                                                                                      | Send Discord Notification                                                              |
| **After The Server Starts**         | When a start finishes and the server reports healthy. Coming back from an unhealthy state does not count.                                                                                                         | Send Message, Run Command, Backup, Send Discord Notification                           |
| **After The Server Stops**          | After you, a schedule, or an automation stops the server. Not when the panel stops it as part of a restart, rebuild, restore, pack update, port change, or world shrink, and not for a stop from inside the game. | Backup, Send Discord Notification                                                      |
| **When The Server Crashes**         | Once for each crash.                                                                                                                                                                                              | Backup, Send Discord Notification                                                      |
| **After A Modpack Update Installs** | When a modpack update has been installed and the server is healthy on it.                                                                                                                                         | Send Message, Run Command, Backup, Copy Files, Delete Files, Send Discord Notification |

Rules for events:

- Event steps can wait up to 1 hour after the event, and never run before it. Steps on **Before The Server Starts** run right away, with no delay.
- **Before The Server Starts** is special: the start waits (up to 2 minutes) for the steps to finish. If a step fails with **On Failure** set to **Stop**, or the steps run out of time, the server is not started, and the person (or automation) starting it sees which automation stopped it. Use **Continue** on steps that must not block a start.
- Restart, Stop, and Start are never available on an event, since a lifecycle action on a lifecycle event could loop. Neither are the panel actions, so an event automation always runs on servers.
- The same automation never runs twice at once for the same server. An event that arrives while it is still running is skipped.
- **Run Now** runs an event automation once for each of its servers, without waiting for the event.
- Step conditions work the same as on a schedule.

### Step timing

A step's time is relative to the schedule time: **Before**, **At**, or **After** it, by a number of seconds, minutes, or hours (up to 24 hours either way). The panel sorts the steps by time when you save.

When a step is set before the schedule time, the automation starts early. With a first step 5 minutes before, the automation begins 5 minutes ahead of each schedule time. That lead time has to be shorter than the gap between two runs: a schedule that runs every 2 minutes cannot have a step 5 minutes before it, and the panel tells you so when you save.

**On Failure** decides what happens to the rest of a server's steps when one fails: **Stop** ends them, **Continue** carries on with the next step.

### Step conditions

A step can have an optional **Only If** condition for servers, checked right before the step runs. When it is not met, the step is skipped (not failed) and the run history says why.

- **Server Is Running**: skips the step when the server is stopped.
- **Players Online**: needs at least a chosen number of players (1 to 500) online.
- **No Players Online**: runs only on an empty server.

The two player conditions also skip a stopped server. If the player count cannot be read, the step is skipped too, since the panel can't tell whether anyone is on. Panel steps cannot have conditions.

### Step actions

For servers:

- **Restart Server**, **Stop Server**, **Start Server**.
- **Backup**: a snapshot tagged `scheduled` on the [Backups](backups.md) page, verified right after it is written. It can **Trim Unused Chunks After Backup** ([shrinking a world](world-shrink.md)), which only happens while the server is stopped. A stopped server that is already backed up is skipped.
- **Send Message**: a chat message to players, as **Say** (a plain server announcement) or **Tellraw** (formatted chat). It is skipped, not failed, when the server is not running.
- **Run Command**: any server command.
- **Copy Files** and **Delete Files**: change files inside the server's own folder (see [File steps](#file-steps)). They need the Files permission on the server.
- **Send Discord Notification**: posts a message to the server's Discord channel, titled with the automation's name. It needs the server's [Discord integration](integrations.md) to be set up and switched on, and fails with a clear message when it is not. It works on schedules and events, and needs the Settings permission on the server.

For the panel:

- **Update Check**: refresh what is out of date. The scheduled check is also what applies updates for servers set to [Auto-Update](modpacks.md#update-policy).
- **Back Up All Servers** and **Restart All Running Servers**: admin-only. Each server is handled on its own, one failure does not stop the rest, and any failure fails the run at the end. Servers that are still starting up or stopped are left out of the restart.
- **Storage Re-Scan**, **Clear Temporary Files**, **Ban Expiry Sweep** (lifts temporary bans that have run out), and **Content Metadata Backfill** (fills in missing mod names and icons).

## File steps

**Copy Files** and **Delete Files** work on files in the server's own folder, the same folder the Files tab shows. They run on a running server too, like the Files tab. Both can be used on a schedule and on every event.

- **Paths** are relative to the server's folder (`kubejs/startup_scripts`, not `/home/...`). A path cannot use `..`, cannot be absolute, and can be up to 300 characters. Leave it empty for the server folder itself. Links (symlinks) are never followed, so a link inside the folder cannot lead a step out of it.
- **Copy Files** copies the file or folder in **From** to **To**. A folder's contents are copied into the **To** folder, keeping their layout. **Mode** decides what happens to files that already exist: **Overwrite** replaces them, **Skip Existing** leaves them, and **Only If Newer** replaces a file only when the copy was changed more recently.
- **Delete Files** deletes the files under **Path** that match **Include**, which is required. **Path** must be a folder inside the server, such as `logs`: the server folder itself is never a valid path, whatever the pattern. Folders it leaves empty are removed too, but only folders this step emptied: a folder that was already empty stays, and so does the **Path** folder itself.
- **Include** is a pattern matched against each file's path inside the folder: `*` matches within one folder, `**` matches across folders, `?` matches one character, and `{a,b}` matches either one. `**/*.json` is every JSON file at any depth, while `*.json` is only the ones directly inside the folder. Copy Files defaults to `**` (everything). A pattern can be up to 200 characters, with up to 8 wildcards (`*` or `?`) and up to 8 choices from braces, which cannot be nested.
- **Limits**: a copy step handles up to 5,000 files and 2 GB, and a delete step up to 5,000 files. A step also gives up after looking at 50,000 files and folders. A step over a limit does not run and writes nothing, so narrow the folder or the pattern.
- **Links are never followed.** If any part of a path is a link (a symlink), the step is refused, even a link that points back inside the server folder. Links found inside a folder being copied or cleaned are left alone. The panel checks again just before it touches each file, in case something in the server swapped a folder for a link while the step was running.
- **Worlds are protected.** Any folder that holds a `level.dat`, a `level.dat_old`, or a `region` folder (in the server folder or one level down, such as `saves/old`), the world set in `server.properties` (even in a subfolder such as `saves/survival`), `world`, and each one's Nether and End folders are never copied from, copied into, or deleted from. Names are compared without regard to capital letters. Working on a folder that contains a world (a wider path) just leaves the world out. The panel's own files, such as the Discord bridge's token file, are protected too.
- **Waiting for the server**: a file step takes the server's operation lock, like a backup or a restore does, so it never changes files while a restore is swapping them. When another operation is running it waits and tries again every minute for up to 30 minutes. A step on **Before The Server Starts** runs inside the start, so it does not wait.
- **Stopping**: if you press Stop or Kill while a file step is running (an automation's own Stop step does not count, and waits like any other action), the step stops at its next file (a copy never leaves half a file behind) and the server is stopped without waiting for it. The run history shows the step as failed, "stopped before it finished, because the server is being stopped". A **Before The Server Starts** step that runs past the 2 minute limit is stopped the same way, and the start fails once it has stopped.
- **Sources are opened carefully**: a copy opens each source without following links and checks that the open file really lives inside the server folder, so something inside the server cannot swap a file for a link to a panel file between the check and the copy. A copy keeps each file's modified time. Each file is written under a hidden temporary name beside its destination and renamed into place when it is complete, so an interrupted copy never costs you the file that was already there.
- **History**: each run adds an entry to the activity log, such as "Automation Restore KubeJS copied 14 files." or "Automation Clean Up deleted 3 files."

### Dry run

Before relying on a file step, run it dry. A dry run shows, for one of the automation's servers, every file the step would create, overwrite, skip, or delete (the first 500, with a count of the rest), and writes nothing. The real run uses the same plan. The editor asks for a dry run before saving a Delete Files step. The server itself does not require one.

### Modpack servers

A modpack install rewrites some folders each time the server starts. If a **Before The Server Starts** Copy Files step writes into `config`, `kubejs`, `defaultconfigs`, or `mods` on a modpack server, the editor warns: "Pack installs overwrite the folder when the server starts, so this copy may be undone." Use **After A Modpack Update Installs**, or add the files to Customizations instead. The warning does not stop you from saving.

## Examples

**Restart every 4 hours with 5- and 1-minute warnings.** Runs On: pick the server. Schedule: `0 */4 * * *`. Steps:

1. 5 minutes **Before**: Send Message, "Restarting in 5 minutes."
2. 1 minute **Before**: Send Message, "Restarting in 1 minute."
3. **At**: Restart Server.

**Nightly backup, then bring the server back.** Schedule: `0 4 * * *`. Steps: **At** Stop Server, 1 minute **After** Backup, 10 minutes **After** Start Server.

**One backup job for every server.** Runs On: Panel, with a single **Back Up All Servers** step (admin-only).

## Templates

A template is an automation without its servers: a schedule and steps you can start from. **New Automation** opens a picker: **Start From Scratch**, or one of the templates (built-in ones are marked **Built-In**). Choose one, pick the servers, and adjust anything you like. A template does nothing until you use it, and using one goes through the same permission checks as creating an automation by hand.

- **Built-in templates**: Restart With Warnings, Restart When Empty, Nightly Backup, Backup Then Restart, and Scheduled Announcement. They cannot be edited or deleted.
- **Your own**: use **Save As Template** at the bottom of the editor. It saves the form as it is, under the name you typed. Anyone who is not a viewer can save templates. You can delete your own, and admins can delete any.

### Sharing templates

**Export** (in the template picker, or the download button on an automation's row) downloads a `.msm-automation.json` file, and **Import Template** on the Automation page reads one from another panel. Import shows every step in plain words first, including the full message or command text, and nothing is saved until you choose **Save Template**. Imported commands run on your servers as written, so read them. A file carries only the template: no server names, ids, user names, or dates. Files over 64 KB are refused.

```json
{
  "msm-automation": 1,
  "name": "Restart With Warning",
  "description": "Restarts the server every day at 4:00 with a 5 minute warning.",
  "targetsKind": "servers",
  "trigger": { "type": "schedule", "cron": "0 4 * * *" },
  "steps": [
    {
      "offsetSec": -300,
      "action": "message",
      "params": { "text": "Restarting in 5 minutes.", "mode": "say" },
      "onFailure": "continue"
    },
    { "offsetSec": 0, "action": "restart", "params": {}, "onFailure": "stop" }
  ]
}
```

A file is refused when it comes from a newer version of the panel, has settings this panel does not know, uses an action this panel does not have, or has a schedule that does not work.

## Panel maintenance

The panel seeds its own maintenance automations on first boot, which you can retime, turn off, or delete: a daily update check, a storage re-scan every six hours, a daily clear of old temporary files, a ban expiry sweep every 15 minutes, and a nightly content metadata backfill. They live under **Panel Maintenance** on the page. Every new server also gets a daily backup automation, staggered between 02:00 and 05:59.

## On a server's page

Each server has an **Automation** tab (under Console) listing the automations that act on it, including ones that run on all servers (marked **All Servers**). From there you can turn them on and off, **Run Now**, and edit them. **Add From Template** and **New Automation** open the editor with this server already chosen.

## Working with the list

- **Next Run** shows the next schedule time in the panel's time zone.
- **Last Result** shows **OK**, **Partial** (some servers failed), or **Failed**. Click it to see the recent runs, one per server, with each step's outcome.
- Use the switch to turn an automation off without deleting it.
- **Run Now** runs it straight away, even when it is switched off. Steps set before the schedule time run back to back, since their time has already passed.
- Only one run of an automation goes at a time. If the previous run is still going when the next time arrives, that time is skipped.

## Permissions

An automation acts as the panel, so changing one needs the same rights as doing its actions by hand.

- **Servers**: you need access to every server it names and the matching permission on each for every step: Power (restart, stop, start), Backups, or Console (message, command). Without access to a server, the automation does not show up for you at all.
- **All Servers**: admin-only.
- **Panel**: not for viewers. Admin-only actions (back up or restart all servers) need an admin.

Everyone signed in can see the **Panel Maintenance** list and the **All Servers** automations. See [Users and roles](users-and-roles.md).

## When the server is busy

A backup or start that finds its server in the middle of another action (a restore, a backup cleanup, a port change) waits and tries again every minute until that action finishes, for up to 30 minutes. A waiting start is dropped if someone starts or stops the server in the meantime. A restart or stop is not retried: it is skipped and runs again at its next time. In the two "all servers" actions, a server that is busy is not waited for: it counts as a failure for that run, and the other servers still go ahead.

## History

Every change and run is recorded in the [activity log](activity.md): `automation-created`, `automation-updated`, `automation-toggled`, `automation-deleted`, `automation-template-created`, `automation-template-deleted`, `automation-fired` (once per run), and `automation-failed` (once per failed step, naming the automation and the step). `automation-failed` is also an alert for [Discord](integrations.md#the-alerts-category). The older `schedule-*` events from before the change stay in the log.
