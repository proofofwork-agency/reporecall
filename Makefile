SHELL := /bin/bash

.PHONY: ci-precheck lint test build smoke audit pack-check

ci-precheck: lint test build smoke audit pack-check
	@echo "ci-precheck passed"

lint:
	npm run lint

test:
	npm test -- --run

build:
	npm run build

smoke:
	npm run smoke

audit:
	npm audit --omit=dev --audit-level=high

pack-check:
	npm pack --dry-run
