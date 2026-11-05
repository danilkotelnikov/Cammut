---
title: Quickstart
order: 2
kicker: Ten minutes
description: From a fresh server to a connected agent with Docker and Caddy.
---

# Quickstart

You need a Linux server with Docker, and a hostname pointing at it if you want public HTTPS. All commands run from the unpacked release folder (see [Download](/download/)). Replace `cammut.example.org` with your own name.

## 1. Build the image and create the vault key

The vault key encrypts every secret Cammut stores. Create it **inside the image** so the container user (uid 65532) owns it. Do not create it with `touch` or `head`, and do not start the container before the file exists, or Docker will put a directory in its place.

```bash
sudo install -d -m 700 /root/private
sudo touch /root/private/cammut.env && sudo chmod 600 /root/private/cammut.env
docker compose -f deploy/compose.yaml build
sudo docker run --rm --user 0:0 -v /root/private:/keys --entrypoint /cammut \
  cammut:0.4.0 admin vault-init -key /keys/cammut-vault.key
sudo chown 65532:65532 /root/private/cammut-vault.key
```

Back up `cammut-vault.key` somewhere separate. Without it every stored secret is unreadable.

## 2. Set your public origin and start

Edit `deploy/compose.yaml` and set `-site-origin` to your public URL, then:

```bash
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml logs --tail 5 cammut
```

The log should show `cammut listening` with `version 0.4.0`. The gateway listens on `127.0.0.1:7421` and the private console listener on `127.0.0.1:7422`; neither is public yet.

## 3. Put HTTPS in front

Any reverse proxy works. With Caddy:

```text
cammut.example.org {
	encode zstd gzip
	reverse_proxy 127.0.0.1:7421
}
```

```bash
curl -fsS https://cammut.example.org/healthz
```

## 4. Create your console account

The password is typed in the terminal, never over the web. Scan the QR code with an authenticator app and keep the recovery codes offline.

```bash
docker compose -f deploy/compose.yaml run --rm -it cammut admin create -username you
```

Public login is off by default. Reach the console through an SSH tunnel:

```bash
ssh -L 7422:127.0.0.1:7422 you@your-server
# then open http://cammut.localhost:7422/console/
```

## 5. Register an upstream

An upstream is any MCP server reachable over HTTP. Put its bearer secret in the environment file, name the variable when you register it, and recreate the container so it picks the variable up.

```bash
echo 'GITHUB_PAT=ghp_your_token_here' | sudo tee -a /root/private/cammut.env >/dev/null
docker compose -f deploy/compose.yaml run --rm cammut \
  upstream add -name github -url https://api.githubcopilot.com/mcp/ -bearer-env GITHUB_PAT
docker compose -f deploy/compose.yaml up -d --force-recreate
```

## 6. Connect an agent

Open the [Setup guide](/setup/). It builds the exact token command, environment variable and config snippet for Claude Code, Codex CLI or Warp, and runs entirely in your browser.

## 7. Check

Ask the agent to call `cammut_servers`. It should list `github`. If you get `401`, the token is wrong or expired; if the list is empty, the token's scopes do not include that upstream. See [Operations](/docs/operations/).
