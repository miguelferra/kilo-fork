# kilo-fork

Personal fork for Kilo CLI releases and multi-device setup.

## Set up

Use this repo to track fork-specific workflow, build Linux binaries, and publish personal releases.

- Fork remote: `https://github.com/miguelferra/kilo-fork.git`
- Upstream remote: `https://github.com/Kilo-Org/kilocode.git`

```bash
git remote rename origin upstream
git remote add origin https://github.com/miguelferra/kilo-fork.git
```

## Sync

Rebase `main` on top of upstream before building a new release.

```bash
git fetch upstream
git checkout main
git rebase upstream/main
git push origin main
```

## Develop

Install deps and run the CLI in dev mode from the repo root.

```bash
bun install
bun run --cwd packages/opencode dev
```

## Build

Create the Linux x64 single-binary build.

```bash
bun run --cwd packages/opencode build --single
```

Built binary:

`packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo`

## Package

Bundle the release asset expected by the install and update commands.

```bash
mkdir -p /tmp/kilo-release && \
cp packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo /tmp/kilo-release/cli && \
tar -C /tmp/kilo-release -czf /tmp/cli-linux-x64.tar.gz cli
```

## Publish

Publish the current fork release as `v0.1.1-fork`.

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

## Install

Install `kilo` on another Linux x64 machine from the published release.

```bash
mkdir -p "$HOME/.local/bin" && \
curl -fL "https://github.com/miguelferra/kilo-fork/releases/download/v0.1.1-fork/cli-linux-x64.tar.gz" | \
tar -xzO cli > "$HOME/.local/bin/kilo" && \
chmod +x "$HOME/.local/bin/kilo" && \
"$HOME/.local/bin/kilo" --version
```

Add `~/.local/bin` to `PATH` if needed.

```bash
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' ~/.bashrc || \
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

## Update

Use this on the other PC to update to the new release.

```bash
mkdir -p "$HOME/.local/bin" && \
curl -fL "https://github.com/miguelferra/kilo-fork/releases/download/v0.1.1-fork/cli-linux-x64.tar.gz" | \
tar -xzO cli > "$HOME/.local/bin/kilo" && \
chmod +x "$HOME/.local/bin/kilo" && \
"$HOME/.local/bin/kilo" --version
```
