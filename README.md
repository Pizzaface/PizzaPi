<img width="1280" height="575" alt="PizzaPi-Header" src="https://github.com/user-attachments/assets/a362a452-9b09-49c4-896e-424a6325317e" />

A self-hosted web interface and relay server for the [pi coding agent](https://pi.dev/). Stream live AI coding sessions to any browser and interact remotely from mobile or desktop — no terminal required.

## Quick Start

```bash
# Run without installing
npx @pizzapi/pizza

# — or — install globally
npm install -g @pizzapi/pizza
pizzapi
```

The first time you run `pizzapi`, a setup wizard walks you through connecting to a relay server. It takes about 30 seconds.

## Self-Host the Relay (One Command)

```bash
pizzapi local
```

One command starts the local relay, web UI, and runner and opens your browser at **http://localhost:7492**. Re-running is safe and idempotent. The relay stays running after the command exits; stop it with `pizzapi web stop`.

For production Docker hosting with persistent config and HTTPS, use `pizzapi web`:

```bash
pizzapi web
```

One command clones the repo, builds a Docker image, and starts the relay + web UI at **http://localhost:7492**.

## Documentation

Full docs are at **[pizzaface.github.io/PizzaPi](https://pizzaface.github.io/PizzaPi/)** — including:

- **[Getting Started](https://pizzaface.github.io/PizzaPi/start-here/getting-started/)** — up and running in 5 minutes
- **[Installation](https://pizzaface.github.io/PizzaPi/start-here/installation/)** — platform-specific notes and install methods
- **[CLI Reference](https://pizzaface.github.io/PizzaPi/running/cli-reference/)** — all commands and flags
- **[Configuration](https://pizzaface.github.io/PizzaPi/customization/configuration/)** — config files, env vars, model defaults
- **[Self-Hosting](https://pizzaface.github.io/PizzaPi/deployment/self-hosting/)** — production Docker setup with HTTPS
- **[Runner Daemon](https://pizzaface.github.io/PizzaPi/running/runner-daemon/)** — headless agent sessions from the web UI
- **[Development](https://pizzaface.github.io/PizzaPi/reference/development/)** — local dev setup, testing, and contributing
- **[Architecture](https://pizzaface.github.io/PizzaPi/reference/architecture/)** — relay protocol, event flow, and component design


# Screenshots:
<img width="2558" height="1275" alt="An image of the PizzaPi UI" src="https://github.com/user-attachments/assets/9797d3bc-8dcf-4bb2-af71-3bfce8a6a222" />


<img width="2556" height="666" alt="An image of one of the runner configuration panes" src="https://github.com/user-attachments/assets/494aad7d-9ffe-4a82-847f-c7379e4c17ce" />


## License

Apache 2.0
