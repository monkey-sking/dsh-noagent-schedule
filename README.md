# dsh-noagent-schedule

<!-- badges:start -->
[![License](https://img.shields.io/github/license/monkey-sking/dsh-noagent-schedule?style=flat-square)](https://github.com/monkey-sking/dsh-noagent-schedule/blob/main/LICENSE) [![Last commit](https://img.shields.io/github/last-commit/monkey-sking/dsh-noagent-schedule?style=flat-square)](https://github.com/monkey-sking/dsh-noagent-schedule/commits/main) [![JavaScript](https://img.shields.io/github/languages/top/monkey-sking/dsh-noagent-schedule?style=flat-square)](https://github.com/monkey-sking/dsh-noagent-schedule/search?l=JavaScript) [![Release](https://img.shields.io/github/v/release/monkey-sking/dsh-noagent-schedule?style=flat-square)](https://github.com/monkey-sking/dsh-noagent-schedule/releases) [![views](https://hits.sh/github.com/monkey-sking/dsh-noagent-schedule.svg?style=flat-square&label=views&color=0e75b6)](https://github.com/monkey-sking/dsh-noagent-schedule) [![Stars](https://img.shields.io/github/stars/monkey-sking/dsh-noagent-schedule?style=flat-square)](https://github.com/monkey-sking/dsh-noagent-schedule/stargazers) [![Forks](https://img.shields.io/github/forks/monkey-sking/dsh-noagent-schedule?style=flat-square)](https://github.com/monkey-sking/dsh-noagent-schedule/network/members)
<!-- badges:end -->

**Run shell scripts on a schedule inside DeepSeek Harness — with no model call and no token cost.**

Every scheduling plugin in the DSH ecosystem delivers a message to a session or starts a new one,
so a cron tick always means a model wake-up. This plugin takes the other path: the Host runs the
command itself, the way `systemd` or `launchd` would. The model is only involved when you actually
want it to be — see [wake on change](#wake-on-change).

[简体中文](README.zh.md)

## What it gives you

| | |
|---|---|
| **Zero token** | A tick that runs a script costs nothing. The plugin never touches the LLM services. |
| **Cron or interval** | Five-field Vixie cron (`*/15 9-17 * * 1-5`, `sun..sat`, `jan..dec`) or `everySeconds`. |
| **Explicit time zones** | IANA zones per job, so the schedule means what it says regardless of where the Host runs. |
| **Logs you can read** | One file per run with argv, exit code, stdout and stderr; a `runs.jsonl` ledger beside it. |
| **Overlap protection** | A job whose previous run is still going is skipped, not stacked. |
| **Timeout** | Oversized jobs are terminated at `timeoutSeconds`. |
| **Qinglong-style task page** (open it from the sidebar; not duplicated in Settings) | Overview cards, search and status filter, one row per job with a status dot, a human-readable schedule ("daily 18:30" instead of `30 18 * * *`), last and next run, a strip of the last 8 results, and a log drawer. |
| **Edit from the page** | Enable or disable a job, change its cron or interval, timeout, name or command, and delete it. Every write is validated, backed up, and re-parsed before it lands, so `jobs.json` can never be left unloadable. |
| **Agent tools** | `noagent_status`, `noagent_run`, `noagent_log`, `noagent_update` — the same operations the UI uses. |
| **Wake on change** | Turn a polling script into an event source: the model is woken only when its output changes. |

## Install

### From the plugin market (Discover)

Open **Plugins > Discover > Manage index sources** and add:

```
https://raw.githubusercontent.com/monkey-sking/dsh-noagent-schedule/main/index.json
```

The bundle then appears in the Discover list with its description and icon, and installs like any other entry. (The Discover tab needs the experimental plugin-market bundle enabled.)

### From a checkout

```
git clone https://github.com/monkey-sking/dsh-noagent-schedule.git
plugin_manager({ action: "install_bundle", target: "<cloned directory>" })
```

Or point `target` at a checkout of this repository.

Nothing is scheduled until you write a job file.

## Where things live

| | Default | Configure |
|---|---|---|
| Job list | `~/.dsh/noagent/jobs.json` | `jobsFile` |
| State and logs | `~/.dsh/noagent/state/` | `stateDir` |

The job file is re-read every 10 seconds, so adding, editing or disabling a job needs no restart.

```
state/
├── state.json              # per job: last start, exit code, duration, fingerprint
├── runs.jsonl              # one line per run
└── runs/<job-id>/<ts>.log  # full stdout/stderr of that run
```

## Jobs

```json
{
  "jobs": [
    {
      "id": "nightly-backup",
      "name": "Nightly backup",
      "enabled": true,
      "cron": "0 3 * * *",
      "timeZone": "Asia/Shanghai",
      "cwd": "/srv/app",
      "command": "bash scripts/backup.sh",
      "timeoutSeconds": 600
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Unique, also the log directory name. Required. |
| `cron` | Five fields: minute hour day-of-month month day-of-week. Supports `*/n`, `a-b`, `a-b/n`, lists, `sun..sat`, `jan..dec`. |
| `everySeconds` | Fixed interval, minimum 30. Use instead of `cron`. |
| `timeZone` | IANA zone. Defaults to the plugin's `defaultTimeZone`. |
| `cwd` | Working directory. Defaults to the user's home. |
| `command` | Run through `/bin/bash -lc`. Alternatively use `argv` for an exact process. |
| `argv` | Array form; no shell involved. |
| `env` | Extra environment variables, merged over the inherited environment. |
| `timeoutSeconds` | Terminate after this long. Default 300. |
| `enabled` | `false` keeps the job in the file but does not schedule it. |
| `wakeOnChange` | See below. |

### Why `bash -lc`

A GUI-launched Host inherits a minimal `PATH` — often just `/usr/bin:/bin`. A login shell picks up
the user's profile, so `git`, `node`, `python3` and friends resolve the way they do in a terminal.
Homebrew's standard prefixes are prepended as a fallback.

If you would rather not depend on shell startup files, use `argv` with absolute paths.

## Wake on change

A polling script usually answers one question: *did anything change?* Running it on a timer is
free; waking a model to ask the same question every few minutes is not.

`wakeOnChange` separates the two:

```json
{
  "id": "inbox-watch",
  "everySeconds": 120,
  "command": "bash scripts/probe-inbox.sh",
  "wakeOnChange": {
    "sessionId": "session-…",
    "title": "New mail",
    "prompt": "The probe found something new:\n\n{{output}}\n\nHandle it per the usual routine; reply [SILENT] if nothing needs doing.",
    "ignoreLines": ["^ts=", "progress: \\d+%"]
  }
}
```

How it behaves:

- The probe runs every 120 seconds. **No change means no model call at all.**
- Output is normalised (lines matching `ignoreLines` are dropped), then fingerprinted.
- A changed fingerprint schedules a one-shot delivery to `sessionId` about a second later, carrying
  the probe output through `{{output}}`.
- The first run only records a baseline, so installing the plugin does not immediately wake anyone.
  Set `notifyOnFirstRun: true` to opt in.
- A non-zero exit is never treated as "something changed" — failures show up in the log and the
  status, not as false wakes.
- Every wake is a one-shot scheduled delivery, and one-shot rows stay in the Host's task table
  after delivery. The plugin deletes each wake row once it has been delivered (the previous row is
  removed before the next wake, delivered rows are swept every 30 seconds, and leftovers from an
  earlier version are cleaned on the first tick), so "automation tasks" keeps listing only the real
  recurring jobs instead of a wall of identical one-shot entries.
- Empty output means nothing to report.
- `onlyOnNew` can be narrowed with `keyPattern`: only the matched part of each line identifies an
  entry, so a conversation whose last message changes (including our own reply) is not "new"; only a
  genuinely new conversation wakes the session. Lines unmatched by the pattern fall back to the
  whole line.

Placeholders in `prompt` and `title`: `{{job}}` (name), `{{id}}` (id), `{{output}}` (truncated to
4000 characters).

The target session receives an ordinary scheduled message, so anything that already works with a
scheduled delivery works here.

## UI

- **Settings → No-Agent Schedule** — one page listing every job.
- **Sidebar → clock icon** — the same list as a panel.

Both show the schedule, time zone, command, last run (time, exit code, duration), a *Run now*
button and a *Show last log* toggle. The panel refreshes every five seconds while open.

## Agent tools

| Tool | Does |
|---|---|
| `noagent_status` | List jobs with their last run. Pass `id` for one job. |
| `noagent_run` | Run one job immediately, outside its schedule. |
| `noagent_log` | Read the tail of a job's most recent log. |

The UI and the tools call the same Host implementation.

## Limits

- **Runs only while DSH is running.** A tick missed because the Host was closed is not caught up on
  restart. For a watchdog that must survive the app being closed, use `launchd`, `systemd` or
  `cron` instead — that is what they are for.
- **Not a sandbox.** Jobs run with the Host's own permissions. Treat the job file as executable
  configuration.
- **macOS may still refuse access.** A Host process inherits the app's TCC grants; a job touching a
  protected location can fail where a terminal would succeed, and vice versa. Read the log rather
  than assuming.

## Related

- [agent-cron-kit](https://github.com/monkey-sking/agent-cron-kit) — the scripts this scheduler was
  built to run: a stdout→Feishu/Telegram delivery bridge, git autopush and dirty-repo watchdog,
  log/backup cleanup, network and desktop-app watchdogs — with an audit of which of them are safe
  to publish and which never are.

## Licence

MIT.
