# Contributing to Promptrail

## From Source

```bash
git clone https://github.com/thisalihassan/promptrail
cd promptrail
npm install
npm run build
npm run package
```

Install the generated `.vsix`:

```bash
cursor --install-extension promptrail-<version>.vsix
```

## Development

Open the repo in Cursor/VS Code and press `F5` to launch the Extension Development Host.

## Build Commands

| Command | What it builds |
|---------|---------------|
| `npm run build` | Extension + CLI |
| `npm run build:ext` | Extension only |
| `npm run build:cli` | CLI only |
| `npm run watch` | Watch both |
| `npm run watch:ext` | Watch extension only |
| `npm run watch:cli` | Watch CLI only |
| `npm run package` | Create `.vsix` for distribution |
| `npm run release` | Build, package, and bump version |
