# Vendored dependencies

## `.agntdev-bot-toolkit.tgz`

This repository vendors the `@agntdev/bot-toolkit` package as a
binary tarball, pinned via `package.json` with `"@agntdev/bot-toolkit":
"file:./.agntdev-bot-toolkit.tgz"`. The toolkit is generated and signed
by the AGNTDEV platform and is the canonical dependency for every bot
project on the platform — it provides:

- `createBot()` — the curated entry point wrapping grammY with sessions
  + an error boundary.
- `MemorySessionStorage` — in-memory `StorageAdapter` for the harness.
- `inlineButton`, `inlineKeyboard`, `menuKeyboard`, `confirmKeyboard`,
  `paginate` — UI builders.
- The tokenless test-harness CLI (used by `npm test`).

The tarball is the SAME artifact every AGNTDEV-generated bot uses; it
is checked in here (rather than fetched from a registry) so the build
is reproducible offline and is not subject to npm-registry outages.

### Verifying the tarball

A SHA256 of the tarball is committed as
`.agntdev-bot-toolkit.SHA256`. To verify:

```sh
shasum -a 256 -c .agntdev-bot-toolkit.SHA256
```

To inspect the contents:

```sh
tar tzf .agntdev-bot-toolkit.tgz
```

Expected top-level layout:

```
package/dist/                — compiled JS + .d.ts
package/templates/Dockerfile — production container template
package/README.md
package/package.json
```

If the layout ever changes, the SHA256 will no longer match and
`shasum -a 256 -c` will fail loudly.

## `grammy`

`grammy` is fetched from the public npm registry. The exact version is
pinned via `package-lock.json`.
