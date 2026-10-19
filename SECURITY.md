# Security

byoa runs model-generated commands, so the sandbox is the product. Treat every model as untrusted.

## Reporting a vulnerability

Please **do not open a public issue** for a sandbox escape, a policy bypass, a secret leak, or
anything that lets a model reach data it should not. Report it privately to the maintainers (see
the repository's Security tab / contact address), with:

- the policy in effect (or the command line),
- the exact command or tool call,
- what you expected and what happened,
- `bwrap --version` and your kernel version.

You will get an acknowledgement as soon as possible, and credit in the fix unless you ask
otherwise.

## Threat model (what the sandbox is expected to stop)

- A prompt-injected model reading files outside the workspace, including credentials and other
  agents' data.
- A model reaching the network when the policy denies it.
- A model escalating privileges inside the sandbox.
- A model writing outside the workspace.

## Known limitations (by design, documented on purpose)

- The command deny-list is a **speed bump**, not a boundary. It understands shell words, not shell
  semantics. The namespace is the boundary.
- `--no-sandbox` is **unsandboxed**: full environment, full filesystem. It warns loudly and is
  never the default.
- `--net allow-all` shares the host network, including loopback services.
- The session database stores tool output, which may include whatever the model read. Credentials
  are pattern-redacted at the tool boundary, but redaction is a floor, not a guarantee.
- A compromised *host* account is out of scope: byoa assumes the user running it is trusted.

## Hardening checklist

- Keep `strict` on (the default).
- Keep the read roots minimal; do not add `$HOME`.
- Keep `--net deny` unless the task genuinely needs the network.
- Prefer `apiKeyEnv` over a literal key in `config.json`, and keep that file `0600`.
