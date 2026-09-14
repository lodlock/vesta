# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Vesta, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **rinaldo@cosmico.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix or mitigation**: Depends on severity, but we aim for prompt resolution

## Scope

Vesta runs inference, retrieval and every tool action on-device. It is not,
however, a network-silent app — there are exactly two ways bytes cross the
device boundary, both user-initiated and both listed here:

### Outbound: model downloads (`huggingface.co`)

`lib/models/hf-client.ts` is the only outbound HTTP in the app. It talks to
`https://huggingface.co` — the tree API to list a repo's `.gguf` files, and
`/resolve/main/...` to fetch one (which redirects to HuggingFace's CDN for the
bytes). Requests are made only when the user browses a repo or starts a
download. Anonymous; no account, no token, no cookies.

There is **no telemetry, no analytics, no crash reporting and no cloud
inference** — no third-party SDK that could add any is installed, and none may
be added. Conversations, documents, memories and tool arguments never leave the
device.

Downloaded models are verified before use: the finished file is hashed
(SHA-256, natively and streaming) and compared against HuggingFace's published
LFS oid **before** it is renamed into the model directory. Size alone is never
accepted as proof.

Verification **fails closed**. When a digest was published, the file is
committed only on a match — a mismatch, a hashing error, and hashing being
unavailable on the build all quarantine the file and fail the download. That is
not the same as a repo publishing no digest at all: with nothing authoritative
to check against, the model installs and is labelled unverified.

A `.gguf` you import yourself is supported as a first-class model and is not
required to come from HuggingFace. You can supply its SHA-256 (pasted, or an
adjacent `.sha256`), in which case it must match or nothing is imported; with
no checksum the import proceeds — choosing the file is your decision — and
Vesta still hashes it and keeps that as a baseline, so a later unexpected change
to the file is detectable. Each model records which of these applies rather than
a flat verified/unverified, and imports get a cheap GGUF header sanity check
before llama.cpp opens them (early rejection of obviously-bad files, not a
safety boundary).

### Inbound: the local MCP server (off by default)

The optional MCP server (Settings → MCP Server) exposes three read-only tools —
`get_calendar_events`, `search_contacts`, `query_document` — to an agent on the
user's own machine. It is **off by default**, and when on it **binds
127.0.0.1**: nothing on the network can reach it. A laptop connects through
`adb reverse tcp:8420 tcp:8420`.

Binding the LAN instead is a separate, explicitly confirmed opt-in. It should
be understood for what it is: **plaintext HTTP on the local network**. The
per-client bearer token crosses the Wi-Fi in the clear and the exposed tools
return calendar entries, contact numbers and document passages. Tokens are
per-client and revocable instantly from the same screen. TLS is not implemented
— treat LAN mode as suitable for a trusted home network only.

### Remaining attack surface

- Local data storage (SQLite database, model files). No encryption at rest; the
  DB is in the app-private directory and relies on Android FBE/FDE.
- Native module interfaces (the Kotlin bridge).
- Input handling — prompt injection via chat input, imported documents, or
  knowledge files. Injected text cannot execute an action on its own: every
  destructive tool call passes the confirmation gate before it runs.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x (current) | Yes |

## Recognition

We appreciate responsible disclosure and will credit security researchers in our release notes (with your permission).
