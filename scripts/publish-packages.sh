#!/usr/bin/env bash
set -e

(cd packages/app-builder-lib && pnpm publish --access public --no-git-checks --tag slim) || true
(cd packages/builder-util-runtime && pnpm publish --access public --no-git-checks --tag slim) || true
(cd packages/builder-util && pnpm publish --access public --no-git-checks --tag slim) || true
(cd packages/dmg-builder && pnpm publish --access public --no-git-checks --tag slim) || true

(cd packages/electron-updater && pnpm publish --access public --no-git-checks --tag slim) || true
