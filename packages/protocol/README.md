# @pizzapi/protocol

Typed Socket.IO event contracts shared by [PizzaPi](https://github.com/Pizzaface/PizzaPi)'s
server, CLI, web UI and extensions: namespace event maps (`/relay`, `/viewer`, `/runner`,
`/terminal`, `/hub`, `/runners`), the unified trigger system (source → event → route →
delivery), session/meta state shapes, and small runtime guards (payload parsing, password
validation, semver compatibility checks) used at process boundaries.

This package has no runtime dependencies and ships only type declarations plus a handful of
pure helper functions — it does not start a server or open a socket itself.

## Install

```sh
npm install @pizzapi/protocol
```

## Usage

```ts
import type { RunnerClientToServerEvents } from "@pizzapi/protocol";
import { isValidEventType, validatePassword } from "@pizzapi/protocol";
```

See the [PizzaPi repository](https://github.com/Pizzaface/PizzaPi) for how these contracts are
used across packages. This package is versioned and released independently of the PizzaPi CLI.

## License

Apache-2.0
