# Contributing

Thank you for helping make Ecuador's public procurement easier to understand.

1. Open an issue describing a bug or proposed improvement. For data discrepancies, include the public SERCOP process link and dataset period.
2. Fork the repository and create a branch for your change.
3. Follow the README to install dependencies and generate a dataset.
4. Run `npm run typecheck` and `npx wrangler deploy --dry-run`. For API or MCP changes, start Wrangler locally and run `npm run test:mcp -- http://localhost:8787`.
5. For UI changes, check both narrow and wide layouts, keyboard navigation, search, and entity details.
6. Open a pull request explaining the behavior change and how you verified it. Screenshots help for visual changes.

Keep interface copy in Spanish. Keep source attribution and interpretation limits visible. Describe signals neutrally; avoid implying wrongdoing from a pattern alone. Do not add supplier identifiers, credentials, raw downloaded archives, or generated datasets to Git.

Changes to aggregation should explain their effect on totals and cite relevant source fields. Source files can be revised upstream, so do not rely on a fixed historical entity count in tests.

Contributions to project code are provided under the repository's MIT license. Source data retains its separate license.
