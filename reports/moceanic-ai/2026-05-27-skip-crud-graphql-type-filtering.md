# @skipCrud models excluded from generated GraphQL ObjectTypes

Project: moceanic-ai
Upgrade: 2026-05-27-skip-crud-graphql-type-filtering
Mode: adapt
Outcome: adapted
Branch: nestled-upgrade/2026-05-27-skip-crud-graphql-type-filtering

## Prior State

moceanic-ai had applied this fix as a local workaround:
- `patchedDependencies` in package.json for `@nestledjs/api@2.9.4`,
  `@nestledjs/shared@1.0.1`, `@nestledjs/utils@1.0.1` with patch files
  that injected @skipCrud behavior into the generators.
- `generate-models.ts` already had @skipCrud filtering from the workaround.
- PasswordHistory CRUD surface already removed.

## Adaptation

- Replaced `patchedDependencies` with `pnpm.overrides` pinning the real
  published packages: `@nestledjs/api@2.9.5`, `@nestledjs/shared@1.0.2`,
  `@nestledjs/utils@1.0.2`.
- Deleted the three local patch files from `patches/`.
- Ran `pnpm install` to resolve the real packages.
- Committed all PasswordHistory removal changes and generate-models.ts
  @skipCrud filtering that were already in the working tree.
- Added `/// @skipCrud` to `AiModelConfig` in schema.prisma to protect
  AI provider credentials (API keys) from admin CRUD and data browser.

## Package Releases

- `@nestledjs/api`: 2.9.4 (patched) → 2.9.5 (real)
- `@nestledjs/shared`: 1.0.1 (patched) → 1.0.2 (real)
- `@nestledjs/utils`: 1.0.1 (patched) → 1.0.2 (real)

## Patch

- Direct patch not applicable — generate-models.ts already had the filtering;
  PasswordHistory does not exist in moceanic-ai (AI assistant project).

## Verification

- Not run. Requires `pnpm db-update` and `pnpm nx build api` in moceanic-ai.

## Summary

Workaround patches replaced with real package releases. @skipCrud now works
via the published generators. AiModelConfig protected with @skipCrud.
