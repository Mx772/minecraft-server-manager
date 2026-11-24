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
- **Schedule**: a cron expression (five fields: minute, hour, day of month, month, day of week). The editor previews the next three times as you type. Times follow the panel's time zone, set in **Settings**.
- **Steps**: what happens, in order. Every step has a **time**, an **action**, and an **On Failure** choice.

### Step timing

A step's time is relative to the schedule time: **Before**, **At**, or **After** it, by a number of seconds, minutes, or hours (up to 24 hours either way). The panel sorts the steps by time when you save.

When a step is set before the schedule time, the automation starts early. With a first step 5 minutes before, the automation begins 5 minutes ahead of each schedule time. That lead time has to be shorter than the gap between two runs: a schedule that runs every 2 minutes cannot have a step 5 minutes before it, and the panel tells you so when you save.

**On Failure** decides what happens to the rest of a server's steps when one fails: **Stop** ends them, **Continue** carries on with the next step.

### Step actions

For servers:

- **Restart Server**, **Stop Server**, **Start Server**.
- **Backup**: a snapshot tagged `scheduled` on the [Backups](backups.md) page, verified right after it is written. It can **Trim Unused Chunks After Backup** ([shrinking a world](world-shrink.md)), which only happens while the server is stopped. A stopped server that is already backed up is skipped.
- **Send Message**: a chat message to players, as **Say** (a plain server announcement) or **Tellraw** (formatted chat). It is skipped, not failed, when the server is not running.
- **Run Command**: any server command.

For the panel:

- **Update Check**: refresh what is out of date. The scheduled check is also what applies updates for servers set to [Auto-Update](modpacks.md#update-policy).
- **Back Up All Servers** and **Restart All Running Servers**: admin-only. Each server is handled on its own, one failure does not stop the rest, and any failure fails the run at the end. Servers that are still starting up or stopped are left out of the restart.
- **Storage Re-Scan**, **Clear Temporary Files**, **Ban Expiry Sweep** (lifts temporary bans that have run out), and **Content Metadata Backfill** (fills in missing mod names and icons).

## Examples

**Restart every 4 hours with 5- and 1-minute warnings.** Runs On: pick the server. Schedule: `0 */4 * * *`. Steps:

1. 5 minutes **Before**: Send Message, "Restarting in 5 minutes."
2. 1 minute **Before**: Send Message, "Restarting in 1 minute."
3. **At**: Restart Server.

**Nightly backup, then bring the server back.** Schedule: `0 4 * * *`. Steps: **At** Stop Server, 1 minute **After** Backup, 10 minutes **After** Start Server.

**One backup job for every server.** Runs On: Panel, with a single **Back Up All Servers** step (admin-only).

## Panel maintenance

The panel seeds its own maintenance automations on first boot, which you can retime, turn off, or delete: a daily update check, a storage re-scan every six hours, a daily clear of old temporary files, a ban expiry sweep every 15 minutes, and a nightly content metadata backfill. They live under **Panel Maintenance** on the page. Every new server also gets a daily backup automation, staggered between 02:00 and 05:59.

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

Every change and run is recorded in the [activity log](activity.md): `automation-created`, `automation-updated`, `automation-toggled`, `automation-deleted`, `automation-fired` (once per run), and `automation-failed` (once per failed step, naming the automation and the step). `automation-failed` is also an alert for [Discord](integrations.md#the-alerts-category). The older `schedule-*` events from before the change stay in the log.
