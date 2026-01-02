# Yuan Voice-to-Code Orchestrator

This workspace now supports routing requests to either Claude Code or ChatGPT Codex.
Use wake words like `codex, ...` or `claude, ...` in your text/voice instructions to
pick the agent. Codex runs via a local CLI (default command: `codex`); configure with
`CODEX_CLI_COMMAND` and optional `CODEX_CLI_ARGS`. Claude still uses the `claude`
CLI and requires `ANTHROPIC_API_KEY`.
