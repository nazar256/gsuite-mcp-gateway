# Contributing

Thanks for contributing.

## Development

```bash
npm install
npm run typecheck
npm test
```

For local Worker development:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

## Pull requests

- keep changes focused
- add or update tests for behavior changes
- avoid committing secrets, local deploy config, or downloaded OAuth credential files
- prefer docs updates when changing setup, scopes, or operator workflows

## Issues

- use GitHub issues for bugs, docs, and feature requests
- use `SECURITY.md` guidance for sensitive security reports
