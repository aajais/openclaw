# Repository Guidelines

## Project Structure & Module Organization

`openclaw` is a pnpm monorepo centered on TypeScript services and clients.

- `src/`: core runtime (gateway, agents, channels, CLI, tools).
- `test/`: shared test setup and cross-module tests.
- `extensions/`: optional channel/platform extensions, each with local tests.
- `ui/`: Control UI app and UI-specific tests.
- `apps/`: native apps (`ios/`, `android/`, `macos/`).
- `scripts/`: build, release, lint, and policy automation scripts.
- `docs/`, `assets/`: docs and static assets.
- `dist/`: generated output; do not hand-edit.

## Build, Test, and Development Commands

Use Node `>=22.12` and `pnpm@10`.

- `pnpm install`: install workspace dependencies.
- `pnpm dev` or `pnpm gateway:watch`: run local dev loop with reload.
- `pnpm build`: compile TS and generate distributable artifacts.
- `pnpm check`: run formatter, type-aware lint, and policy checks.
- `pnpm test`: main parallel test suite.
- `pnpm test:fast`: unit-focused Vitest run.
- `pnpm test:e2e`: end-to-end suite.
- `pnpm test:coverage`: enforce coverage thresholds.
- `pnpm ui:dev` / `pnpm ui:build`: UI development and production build.

## Coding Style & Naming Conventions

- Language: ESM TypeScript with 2-space indentation.
- Formatter: `oxfmt`; linter: `oxlint --type-aware`.
- Run before PR: `pnpm format && pnpm lint` (or `pnpm check`).
- File names use kebab-case (examples: `tool-policy.ts`, `session-slug.test.ts`).
- Tests use `*.test.ts`; keep test files close to related code when practical.

## Testing Guidelines

Framework: Vitest (`vitest.*.config.ts` variants for unit/e2e/live/gateway).

- Minimum coverage thresholds from `vitest.config.ts`: lines/functions/statements `70%`, branches `55%` (core `src/**` scope).
- Add or update tests for every behavior change.
- For targeted work, run focused tests first, then `pnpm test`.

## Commit & Pull Request Guidelines

History follows Conventional Commit style (`feat(scope): ...`, `fix(ui): ...`, `test(gateway): ...`).

- Keep commits scoped and atomic; avoid mixed concerns.
- PRs should include: what changed, why, and validation steps/commands run.
- Run `pnpm build && pnpm check && pnpm test` before opening PR.
- Link issues/discussions when relevant; attach screenshots for UI changes.

