# Godmother Panel Example

Tracked copy of the Godmother runner panel source.

## Layout

- `index.ts` — panel service + MCP bridge
- `panel/` — static UI
- `manifest.json` — runner-service manifest
- `sigils.json` — sigil definitions
- `settings.json` — local panel defaults
- `index.test.ts` — source-level regression tests

## Notes

The panel expects the `godmother` MCP server to be configured in `~/.pizzapi/config.json`.
Relative `command` and `cwd` values are resolved against that config file's directory.
