# GitHub Action

Minimal CI usage (headless, fail-closed):

```yaml
name: codeagent
on: [push]
jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run typecheck && npm test
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - run: node dist/index.js --print "Run verification and summarize." --output-format json
```
