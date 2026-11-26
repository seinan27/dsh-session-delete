# Changelog

## 1.0.0 — 2026-11-26

First release.

- Default delete moves the session directory into the **Windows Recycle Bin**, so it is restored or
  emptied where the owner already looks. Falls back to `$DSH_HOME/.trash-sessions/` on volumes with
  no recycle bin, and says so in the warnings.
- `permanent: true` destroys the directory **and sweeps every other reference to the session id**
  out of `main-session.json`, `session-send-delivered.json`, `storages/workspace.json`,
  `qq-bridge/transcript.jsonl`, `prompt-inherit.log` and `subagent-policy.log`. Measured motive: a
  deleted session's reply was still sitting verbatim in a transcript.
- The sweep removes whole lines from `.jsonl`/`.log` and keys or array elements from `.json`; a file
  it cannot parse produces a warning, never a silent skip.
- The registry is written through the live storage domain — `workspace.json` is never hand-edited.
- One audit line per operation in `$DSH_HOME/session-delete.log`, including whether the sweep ran.
- 14 offline checks over the sweep logic.

## Pre-release history

Built as a local plugin between 2026-10-18 and 2026-11-26; the two kinds of delete were split by the
owner on 2026-10-18 ("permanent must ask, recoverable must not"), and the recycle-bin default plus
the reference sweep were added on 2026-11-26.