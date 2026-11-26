# dsh-session-delete[会话删除]

[English](./README.md) | [简体中文](./README.中文.md)

A real DELETE button for every Session row in DeepSeek Harness — and two honest kinds of delete.

**Default: the Windows Recycle Bin.** The session directory moves there, where you already look for
deleted things. Restore it from Explorer, or empty the bin when you mean it.

**Permanent: no trace.** The directory is destroyed, and so is every other reference to that session
id that DSH keeps in plain text.

---

## Why the "permanent" sweep exists

Measured 2026-11-26 on a real profile. One session was deleted the ordinary way — registry entry
removed, directory gone, title cache gone. The id still appeared in five files:

```
main-session.json                     the session registry this plugin's neighbours keep
session-send-delivered.json           delivery bookkeeping
storages/workspace.json               the workspace's sessionIds array
qq-bridge/transcript.jsonl            ← held a whole reply, verbatim
prompt-inherit.log / subagent-policy.log
```

A "deleted" session whose reply is still sitting in a transcript is not deleted. So `permanent`
now sweeps those stores: whole lines out of `.jsonl` and `.log`, keys and array elements out of
`.json`.

**What it does not do:** it cannot rewrite what third-party plugins wrote outside `$DSH_HOME`, and it
does not touch `.zstd` backups or disk images you made yourself. It cleans the stores it knows about
by name, and reports a warning for any it cannot parse — never a silent skip.

## The registry is never hand-edited

`storages/workspace.json` is written through the live storage domain (`unarchive`, `unpin`,
`remove`), not by editing the file. Editing it behind the host's back is how a workspace loses its
sessions on the next write.

## Install

```bash
dsh plugin --profile <profile> add github:seinan27/dsh-session-delete#v1.0.0
```

Requires the web server and the storage domain; a headless profile simply does not load this
bundle. Restart DSH afterwards — plugin code and the client half load at start.

## Use

1. Tick the sessions you want (click the checkbox in a row; selection survives scrolling).
2. A bar appears at the bottom: pick **彻底删除 / permanent** or leave it off.
3. Delete.

Without the box ticked, nothing asks — the action is recoverable, and asking would imply otherwise.
With it ticked, it asks once and lists what will go.

## What one delete does

| Step | Default | Permanent |
|---|---|---|
| Stop a live agent on that session | yes | yes |
| Remove from archive / pins | yes | yes |
| Remove from the workspace registry | yes | yes |
| Session directory | → Windows Recycle Bin | destroyed |
| Title cache (`session_projcache`) | removed | removed |
| References in other files | left alone | swept |
| One audit line in `session-delete.log` | yes | yes |

If the volume has no Recycle Bin (network share, some external disks), the default falls back to this
plugin's own `$DSH_HOME/.trash-sessions/` and says so in the warnings rather than failing the delete.

## Test

```bash
node test/basic.mjs     # 14 checks, no framework, no network
```

The sweep is the part that can be tested without a running host: it is file surgery. Registry
removal, the live-agent stop and the web route need the storage domain and are verified by hand.

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with or endorsed by DeepSeek.
