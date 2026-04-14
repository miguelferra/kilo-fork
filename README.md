# kilo-fork

Personal fork workspace for my CLI setup, releases, and multi-device workflow.

## Repo setup

- Fork remote (`origin`): `https://github.com/miguelferra/kilo-fork.git`
- Upstream remote (`upstream`): `https://github.com/Kilo-Org/kilocode.git`

```bash
git remote rename origin upstream
git remote add origin https://github.com/miguelferra/kilo-fork.git
```

## Keep fork in sync

```bash
git fetch upstream
git checkout main
git rebase upstream/main
git push origin main
```

## Local development

```bash
bun install
bun run --cwd packages/opencode dev
```

## Build a Linux x64 binary

```bash
bun run --cwd packages/opencode build --single
```

Output binary path:

`packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo`

## Package and publish release asset

```bash
mkdir -p /tmp/kilo-release && cp packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo /tmp/kilo-release/cli && tar -C /tmp/kilo-release -czf /tmp/cli-linux-x64.tar.gz cli
```

```bash
gh release create v0.1.0-fork --repo miguelferra/kilo-fork --title "v0.1.0-fork" --notes "Fork CLI build" || true; gh release upload v0.1.0-fork /tmp/cli-linux-x64.tar.gz --repo miguelferra/kilo-fork --clobber
```

## Install on another Linux x64 machine (one line)

```bash
mkdir -p "$HOME/.local/bin" && curl -fL "https://github.com/miguelferra/kilo-fork/releases/download/v0.1.0-fork/cli-linux-x64.tar.gz" | tar -xzO cli > "$HOME/.local/bin/cli" && chmod +x "$HOME/.local/bin/cli" && "$HOME/.local/bin/cli" --version
```

Optional PATH persistence:

```bash
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```
