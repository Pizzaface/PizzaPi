# @pizzapi/extension-sdk

Public authoring contract for [PizzaPi](https://github.com/Pizzaface/PizzaPi) overlay packages
(`pi` extensions that add runner services, panels, triggers and sigils to PizzaPi). Provides:

- Host detection helpers (`detectPizzaPiHost`, `onPizzaPiHost`, `sendServiceMessage`,
  `requestApproval`) for code running inside a PizzaPi-hosted `pi` session.
- Type-only overlay manifest shapes (`PizzaPiOverlayV1`, `PizzaPiServiceDeclaration`,
  panel/trigger/sigil declaration types) re-exported from `@pizzapi/protocol`.

## Install

```sh
npm install @pizzapi/extension-sdk
```

This package has a peer dependency on `@earendil-works/pi-coding-agent`, since overlay
packages are authored as `pi` extensions.

## Usage

```ts
import { detectPizzaPiHost, onPizzaPiHost } from "@pizzapi/extension-sdk";
import type { PizzaPiOverlayV1 } from "@pizzapi/extension-sdk";
```

See `docs/specs/pi-pizzapi-overlay.md` in the PizzaPi repository for the normative overlay spec.

## License

Apache-2.0
