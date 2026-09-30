import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** AG-12: user-defined subagents (Markdown + frontmatter) + parallel runs + reviewer. */

export interface SubagentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: string;
}

const BUILTIN_REVIEWER = `You are a Reviewer Subagent. Read the provided diff/context and report issues only.
Format:
### Issues
<blocking issues with file:line>
### Nits
<non-blocking>
### Verdict
<approve | request-changes>`;

export function builtinSubagents(): SubagentDef[] {
  return [
    { name: "explore", description: "Read-only codebase explorer", systemPrompt: "You are an Explorer Subagent. Read-only tools only.", source: "builtin" },
    { name: "plan", description: "Architecture planner", systemPrompt: "You are a Planning Subagent. Design implementation plans.", source: "builtin" },
    { name: "reviewer", description: "Code reviewer (issues + verdict)", systemPrompt: BUILTIN_REVIEWER, source: "builtin" },
  ];
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)\s*$/);
    if (kv) data[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { data, body: m[2] ?? "" };
}

export async function loadSubagentDefs(repoRoot: string, homeDir: string = os.homedir()): Promise<SubagentDef[]> {
  const defs = builtinSubagents();
  const dirs = [
    path.join(homeDir, ".codeagent", "agents"),
    path.join(repoRoot, ".codeagent", "agents"),
  ];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8");
        const { data, body } = parseFrontmatter(raw);
        const name = (data.name ?? path.basename(file, ".md")).trim();
        if (!name || defs.some((d) => d.name === name)) continue;
        defs.push({
          name,
          description: (data.description ?? body.slice(0, 120)).trim(),
          tools: data.tools ? data.tools.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          model: data.model?.trim() || undefined,
          systemPrompt: body.trim(),
          source: path.join(dir, file),
        });
      } catch {
        // skip unreadable defs
      }
    }
  }
  return defs;
}

export function describeSubagents(defs: SubagentDef[]): string {
  return defs.map((d) => `- ${d.name}: ${d.description}${d.model ? ` (model: ${d.model})` : ""}`).join("\n");
}
