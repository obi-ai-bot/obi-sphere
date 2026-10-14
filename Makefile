# Obi Sphere: the spec's checks. Node 22 or later and pnpm are needed.
.PHONY: spec-check spec-generate spec-conformance

# Compile and lint the schemas, check the fixtures are reproducible and judged as they say.
spec-check:
	cd spec && pnpm install --frozen-lockfile && pnpm run check

# Regenerate spec/conformance/fixtures from spec/conformance/generate.mjs.
spec-generate:
	cd spec && pnpm install --frozen-lockfile && pnpm run generate

# Judge an implementation: make spec-conformance IMPL='node path/to/checker.mjs'
spec-conformance:
	cd spec && pnpm install --frozen-lockfile && node conformance/run.mjs --impl "$(IMPL)"
