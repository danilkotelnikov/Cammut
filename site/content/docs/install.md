---
title: Install and configure
order: 4
kicker: Server
description: Server flags, volumes, console access, GitHub sign-in and recovery.
---

# Install and configure

## Requirements

- Docker with Compose. The image is a static Go binary plus the built console; it runs as uid 65532 with a read-only root filesystem, all capabilities dropped and `no-new-privileges`.
- About 256 MB of memory is enough for the gateway (the shipped compose file sets a 256 MB limit; idle use is around 17 MB). Memory features and archives need disk, not RAM.
- A reverse proxy for public HTTPS. Cammut itself speaks plain HTTP on loopback.

## Server flags

`cammut serve` takes these flags (shown with their defaults):

| Flag | Default | Meaning |
|---|---|---|
| `-db` | `/var/lib/cammut/cammut.db` (env `CAMMUT_DB`) | SQLite file |
| `-listen` | `127.0.0.1:7421` | Gateway address; the console API for your reverse proxy also lives here |
| `-admin-listen` | empty | Private console listener, loopback only, reach it through SSH (for example `127.0.0.1:7422`) |
| `-site-origin` | empty | Public origin of the console, for example `https://cammut.example.org` |
| `-rate`, `-burst` | `20`, `40` | Requests per second and burst, per token |
| `-vault-key` | default key path | Vault key file. If it cannot be loaded the console is off and the log says why |
| `-archive-dir` | `/data/archive` | Where age-encrypted archive segments live |
| `-archive-max-bytes` | 20 GiB | Archive quota |
| `-archive-min-free` | 5 GiB | Refuse archive writes if free disk would drop below this |
| `-tei-url` | empty | text-embeddings-inference base URL for note vectors; key in env `TEI_API_KEY`. Empty means full-text recall only |
| `-tei-model` | `paraphrase-multilingual-MiniLM-L12-v2` | Label stored with each vector. Vectors with another label are ignored |
| `-public-login` | off | Allow password and GitHub login on `-listen`. Only safe once real client addresses reach the server |
| `-public-login-github-only` | off | Allow GitHub sign-in, not the password form, on `-listen`. Safe behind a proxy that hides client addresses, because no password can be guessed. The authenticator code is still asked unless `GITHUB_SIGNIN=direct` is set |

## Volumes

| Path in the container | Holds |
|---|---|
| `/data` | The SQLite database and `archive/` segments. The only writable place |
| `/etc/cammut/vault.key` | The vault key, mounted read-only from the host |

## Console access

The console lives at `/console/` and has two doors.

1. **Private listener (default).** Start with `-admin-listen 127.0.0.1:7422`, then `ssh -L 7422:127.0.0.1:7422 you@server` and open `http://cammut.localhost:7422/console/`. Using `127.0.0.1` also works, but then the cookie is shared with every other local web app on that address.
2. **Public name.** Turn on `-public-login` only after real client addresses reach the server. Behind a reverse proxy every request otherwise looks like `127.0.0.1`, and failed logins cannot be limited per client.

Login is a password plus a six-digit authenticator code.

### Optional GitHub sign-in

GitHub only proves who you are; the authenticator code is still asked.

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage `https://cammut.example.org`, callback `https://cammut.example.org/auth/github/callback`. Generate a client secret.
3. On the server store both values and link your account:

```bash
cammut admin secret set GITHUB_OAUTH_CLIENT_ID
cammut admin secret set GITHUB_OAUTH_CLIENT_SECRET
cammut admin github-link -username you -login YOUR_GITHUB_NAME
```

### Recovery

Lost password or authenticator: `cammut admin passwd` and `cammut admin totp-reset`, both on the server over SSH.

## Behind a reverse proxy

Cammut turns off the SDK's localhost Host-header guard for public use, because the bearer token is the gate. Terminate TLS in the proxy and forward to `127.0.0.1:7421`. Keep port 80 open if your proxy obtains certificates over HTTP-01.

## Upgrading

Build the new image under a new tag, `up -d`, and read the log line `cammut listening ... version X`. Keep the previous image tag so you can roll back. Database migrations run at start. See [Operations](/docs/operations/).
