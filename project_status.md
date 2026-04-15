# Project status

Quick reference for this fork workflow.

## Track

This fork exists to keep a personal Kilo CLI setup, publish self-managed releases, and make updates easy across machines.

## Keep

Current custom agents are `life` and `finance`, and both share the `R2D2` persona for tone and behavior.

## Use

Personal workspace lives at `/home/ferra/Documents/personal`.

Use that location for personal tasks and cross-project work that should stay outside this repo.

## Build

Releases are built from `packages/opencode` with the Linux x64 single-binary target.

```bash
bun run --cwd packages/opencode build --single
```

The built binary is:

`packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo`

## Publish

Release assets are packaged as `cli-linux-x64.tar.gz`, with the binary stored inside the archive as `cli`.

```bash
mkdir -p /tmp/kilo-release && \
cp packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo /tmp/kilo-release/cli && \
tar -C /tmp/kilo-release -czf /tmp/cli-linux-x64.tar.gz cli
```

Publish with GitHub Releases. Current release tag is `v0.1.1-fork`.

```bash
gh release create v0.1.1-fork \
  --repo miguelferra/kilo-fork \
  --title "v0.1.1-fork" \
  --notes "Personal agents update" || true

gh release upload v0.1.1-fork \
  /tmp/cli-linux-x64.tar.gz \
  --repo miguelferra/kilo-fork \
  --clobber
```

## Update

Another Linux x64 PC updates by downloading the latest release asset and writing it to `~/.local/bin/kilo`.

```bash
mkdir -p "$HOME/.local/bin" && \
curl -fL "https://github.com/miguelferra/kilo-fork/releases/download/v0.1.1-fork/cli-linux-x64.tar.gz" | \
tar -xzO cli > "$HOME/.local/bin/kilo" && \
chmod +x "$HOME/.local/bin/kilo" && \
"$HOME/.local/bin/kilo" --version
```
