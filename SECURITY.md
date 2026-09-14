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
LFS oid **before** it is renamed into the model directory. A mismatch is
quarantined and the download fails — size alone is never accepted as proof.
When a repo publishes no oid, the model is installed but the app says plainly
that it could not be verified.

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
