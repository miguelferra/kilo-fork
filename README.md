# kilo-fork

Personal fork for Kilo CLI releases and multi-device setup.

## Install on another PC

One-shot install of the latest release on a Linux x64 machine. Drops the binary into `~/.local/bin/kilo` and creates a `cli` shortcut.

```bash
mkdir -p "$HOME/.local/bin" && \
curl -fL "https://github.com/miguelferra/kilo-fork/releases/download/v7.2.1-acp.1/cli-linux-x64.tar.gz" | \
  tar -xzO cli > "$HOME/.local/bin/kilo" && \
chmod +x "$HOME/.local/bin/kilo" && \
ln -sf "$HOME/.local/bin/kilo" "$HOME/.local/bin/cli"
```

Add `~/.local/bin` to `PATH` if it isn't already, then reload your shell.

```bash
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' ~/.bashrc || \
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
exec "$SHELL"
cli --version
```

For the `gemini-cli` provider (ACP transport — visible thoughts, persistent sessions) you also need the `gemini` CLI logged in on that machine:

```bash
npm install -g @google/gemini-cli
gemini   # one-time interactive login
```

## Update

Re-run the install one-liner above against a newer release tag. Replace `v7.2.1-acp.1` with whatever's current.

---

## Maintainer workflow

Everything below is for building and publishing new fork releases from this machine.

### Set up

- Fork remote: `https://github.com/miguelferra/kilo-fork.git`
- Upstream remote: `https://github.com/Kilo-Org/kilocode.git`

```bash
git remote rename origin upstream
git remote add origin https://github.com/miguelferra/kilo-fork.git
```

### Sync

Rebase `main` on top of upstream before building a new release.

```bash
git fetch upstream
git checkout main
git rebase upstream/main
git push origin main
```

### Develop

Install deps and run the CLI in dev mode from the repo root.

```bash
bun install
bun run --cwd packages/opencode dev
```

### Build

Create the Linux x64 single-binary build.

```bash
bun run --cwd packages/opencode build --single
```

Built binary: `packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo`

### Package

Bundle the release asset expected by the install one-liner.

```bash
mkdir -p /tmp/kilo-release && \
cp packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo /tmp/kilo-release/cli && \
tar -C /tmp/kilo-release -czf /tmp/cli-linux-x64.tar.gz cli
```

### Publish

Tag, create the release, and upload the binary. Replace `v7.2.1-acp.1` with the new version.

```bash
git tag v7.2.1-acp.1
git push origin v7.2.1-acp.1

gh release create v7.2.1-acp.1 \
  --repo miguelferra/kilo-fork \
  --title "v7.2.1-acp.1" \
  --notes "Release notes here"

gh release upload v7.2.1-acp.1 \
  /tmp/cli-linux-x64.tar.gz \
  --repo miguelferra/kilo-fork \
  --clobber
```
