Recordings from a live pi 1.5.2 on 14 Nov 2026 (scratch herdr-core, local model, a probe extension).

- `session-<case>.jsonl`: the session file as it stood after the case. Cases build on each other: `b-tools` contains `a-plain`, and so on up to `f-tree`.
  `g-new` and `h-model-thinking` are the second session (after `/new`).
- `events-<case>.jsonl`: the extension events seen in that case, one `{name, t, payload}` per line, trimmed: no streaming events, no system prompts, no provider details, tool and message payloads cut down to the fields our extension reads.
- Cases: `b-tools` (two tool calls, one failing), `c-escape` (a reply stopped), `d-steer` (a message sent while working; events only), `e-compact` (a compaction), `e0-compact-too-small` (`/compact` refused), `f-tree` (`/tree` back to an earlier message, then a new turn), `g-new` (`/new`), `h-model-thinking`, `i-reload` (`/reload`).
- No secrets: they hold prompts, model names and /tmp paths only.
