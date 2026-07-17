# Scope Web

Scope Web is a local-first browser companion to the native iOS app. It is intentionally isolated in `/web`; it does not replace or bundle any Swift source.

## Run locally

The app has no third-party runtime dependencies.

```sh
node scripts/dev.mjs
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

## Verify

```sh
node --test tests/*.test.mjs
node scripts/build.mjs
```

The production-ready static output is written to `web/dist`.

## Storage architecture

- IndexedDB database: `scope-web`
- One object store per portable Scope collection
- Receipts stored as local `Blob` records
- All normal finance calculations read only active transactions
- Portable backup restore uses one read/write transaction across all object stores
- Full restore downloads a safety backup before replacing browser records
- No API, analytics, cloud OCR, or remote AI service is used

Browser storage belongs to the current browser profile and origin. Clearing site data removes it, so regular portable backups are important.

## Portable backup compatibility

The web app reads and writes the same ZIP format as Scope for iPhone. See [the shared schema](../docs/scope-backup-schema.md).

## Hosting

The app is static and can be hosted by GitHub Pages or another static host. Hosting the application shell does not upload a user's IndexedDB records; financial data remains in that user's browser unless they explicitly download or select a backup.

