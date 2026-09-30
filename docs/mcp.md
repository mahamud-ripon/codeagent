# MCP

Configure in settings (`mcpServers`):

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "docs": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  }
}
```

CLI:

```bash
codeagent mcp list
codeagent mcp add github -- npx -y @modelcontextprotocol/server-github
codeagent mcp remove github
```

- Tools surface as `mcp__server__tool`; per-tool rules use `MCP(server:tool)` or `MCP(server:*)`.
- Unreachable servers are skipped, never fatal.
- `/mcp` in the REPL lists servers/tools.
