# .harness/ — harness artifact root

| Zone | Git | Lifetime | Safe to... |
|---|---|---|---|
| `knowledge/` | committed | forever — the repo's memory | edit via curator or /learn only |
| `<spec>/` | gitignored | dies with the worktree | delete freely — reviewers read artifacts out-of-band |

`knowledge/INDEX.md` is DERIVED from lesson/standard frontmatter — never hand-edit or
hand-merge it. On merge conflict: delete both sides and run
`node <plugin>/skills/_shared/knowledge.mjs reindex`.
