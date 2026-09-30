import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * EX-4: skills (SKILL.md). Description is always in context; body loads on demand.
 */

export interface Skill {
  name: string;
  description: string;
  body: string;
  source: string;
}

export async function loadSkills(repoRoot: string, homeDir: string = os.homedir()): Promise<Skill[]> {
  const dirs = [
    path.join(homeDir, ".codeagent", "skills"),
    path.join(repoRoot, ".codeagent", "skills"),
  ];
  const out: Skill[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillFile = path.join(dir, entry, "SKILL.md");
      try {
        const raw = await fs.readFile(skillFile, "utf8");
        const desc = raw.match(/description\s*:\s*(.+)/i)?.[1]?.trim().slice(0, 200) ?? entry;
        out.push({ name: entry, description: desc, body: raw, source: skillFile });
      } catch {
        // not a skill dir
      }
    }
  }
  return out;
}

/** Descriptions always in context; bodies load when the model names the skill. */
export function skillContextBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `<skills>\n${lines.join("\n")}\nWhen a skill applies, read its SKILL.md body before acting.\n</skills>`;
}

export function skillBody(skills: Skill[], name: string): string | null {
  return skills.find((s) => s.name === name)?.body ?? null;
}
