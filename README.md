# PizzaPi

A self-hosted web interface and relay server for the [pi coding agent](https://github.com/badlogic/pi-mono). Stream live AI coding sessions to any browser and interact remotely from mobile or desktop — no terminal required.

## Quick Start

```bash
# Run without installing
npx @pizzapi/pizza

# — or — install globally
npm install -g @pizzapi/pizza
pizzapi
```

The first time you run `pizzapi`, a setup wizard walks you through connecting to a relay server. It takes about 30 seconds.

## Self-Host the Relay

```bash
pizzapi web
```

One command clones the repo, builds a Docker image, and starts the relay + web UI at **http://localhost:7492**.

## Documentation

Full docs are at **[pizzaface.github.io/PizzaPi](https://pizzaface.github.io/PizzaPi/)** — including:

- **[Getting Started](https://pizzaface.github.io/PizzaPi/getting-started/)** — up and running in 5 minutes
- **[Installation](https://pizzaface.github.io/PizzaPi/guides/installation/)** — platform-specific notes and install methods
- **[CLI Reference](https://pizzaface.github.io/PizzaPi/guides/cli-reference/)** — all commands and flags
- **[Configuration](https://pizzaface.github.io/PizzaPi/guides/configuration/)** — config files, env vars, model defaults
- **[Self-Hosting](https://pizzaface.github.io/PizzaPi/guides/self-hosting/)** — production Docker setup with HTTPS
- **[Runner Daemon](https://pizzaface.github.io/PizzaPi/guides/runner-daemon/)** — headless agent sessions from the web UI
- **[Development](https://pizzaface.github.io/PizzaPi/guides/development/)** — local dev setup, testing, and contributing
- **[Architecture](https://pizzaface.github.io/PizzaPi/reference/architecture/)** — relay protocol, event flow, and component design

## License

MIT
