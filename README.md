<p align="center">
  <img src="web/public/favicon.svg" width="96" height="96" alt="Cammut logo">
</p>

# Cammut

Cammut is one door for all the tools an AI agent uses. You register your MCP servers once, give each agent its own token, and the agent reaches everything through one address. It sees four small tools instead of hundreds: `cammut_servers`, `cammut_search`, `cammut_describe` and `cammut_call`.

We built it because every agent had its own copy of every tool list and every secret. Now the secrets live in one place, each token sees only what it may use, and every call is logged.

## Tools

An agent first asks `cammut_servers` what is connected. It finds a tool with `cammut_search`, reads its inputs with `cammut_describe` and runs it with `cammut_call`. Tool lists load only when an agent asks, so a slow server never holds the others back.

Each token has scopes, for example `github/*` or `hindsight/recall`. A call outside its scopes is refused before it reaches the server.

## Memory

Cammut gives every agent one shared memory, kept in Hindsight. Agents save and recall notes through the same door. [docs/memory.md](docs/memory.md) explains how recall works and which parts run today.

## Console

The console is a small web page at `/console/` for tokens, servers, secrets and the call log. Sign-in uses a password and an authenticator code; GitHub sign-in is optional.

## Install

Cammut is one Go program in a small container. It needs Docker and a host for the public name.

```
git clone <this repository> && cd cammut
export CAMMUT_SITE_ORIGIN=https://cammut.example
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml run --rm -it cammut admin create -username <your-name>
```

The last command asks for a password and shows a QR code for your authenticator app. Secrets for your servers go in with `deploy/cammut-secret NAME`, which asks for the value without echoing it.

## Connect

Create a token in the console, then point your app at `https://cammut.example/mcp` with `Authorization: Bearer <token>`. Apps that sign in by OAuth, such as Claude, ChatGPT and Gemini, use the front door in [edge/](edge/README.md).

## Documents

- [docs/CAMMUT-CORE.md](docs/CAMMUT-CORE.md): the design of the gateway
- [docs/PUBLIC-ENDPOINT.md](docs/PUBLIC-ENDPOINT.md): running Cammut on a public name
- [docs/memory.md](docs/memory.md) and [docs/MEMORY-GATES.md](docs/MEMORY-GATES.md): memory
- [docs/archive.md](docs/archive.md): the encrypted transcript archive
- [docs/HOOKS-AUTOTRIGGER.md](docs/HOOKS-AUTOTRIGGER.md): agent hooks
- [adapters/](adapters/): Claude Code, Codex and Warp

## Licence

See [LICENSE](LICENSE) and [NOTICE](NOTICE).
