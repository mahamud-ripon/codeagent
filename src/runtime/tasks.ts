import { randomUUID } from "node:crypto";
import type { TaskRecord } from "./contracts.js";
export interface Mail {
  id: string;
  from: string;
  to: string;
  text: string;
  acknowledged: boolean;
}
export class TaskGraph {
  private tasks = new Map<string, TaskRecord>();
  private mail = new Map<string, Mail>();
  constructor(
    initial: TaskRecord[] = [],
    private changed: (tasks: TaskRecord[]) => void = () => {},
  ) {
    this.replace(initial);
  }
  list(): TaskRecord[] {
    return structuredClone([...this.tasks.values()]);
  }
  replace(tasks: TaskRecord[]): void {
    const next = new Map(tasks.map((t) => [t.id, structuredClone(t)]));
    if (next.size !== tasks.length) throw new Error("Duplicate task id");
    const visited = new Set<string>();
    const visit = (id: string, stack = new Set<string>()): void => {
      if (visited.has(id)) return;
      if (stack.has(id)) throw new Error("Task dependency cycle");
      const t = next.get(id);
      if (!t) throw new Error(`Unknown dependency: ${id}`);
      for (const d of t.dependencies) visit(d, new Set([...stack, id]));
      visited.add(id);
    };
    for (const id of next.keys()) visit(id);
    this.tasks = next;
    this.changed(this.list());
  }
  claim(id: string, owner: string): TaskRecord {
    const t = this.tasks.get(id);
    if (!t || !["pending", "blocked", "failed"].includes(t.status))
      throw new Error("Task is not available");
    if (t.dependencies.some((d) => this.tasks.get(d)?.status !== "completed"))
      throw new Error("Task dependencies are incomplete");
    t.owner = owner;
    t.status = "running";
    this.changed(this.list());
    return structuredClone(t);
  }
  finish(
    id: string,
    owner: string,
    status: "completed" | "blocked" | "failed",
    result: string,
    artifacts: string[] = [],
  ): void {
    const t = this.tasks.get(id);
    if (!t || t.owner !== owner || t.status !== "running")
      throw new Error("Task ownership mismatch");
    if (status === "completed" && !result.trim())
      throw new Error("Completion requires acceptance evidence");
    Object.assign(t, { status, result, artifacts });
    this.changed(this.list());
  }
  send(
    from: string,
    to: string,
    text: string,
    id: string = randomUUID(),
  ): Mail {
    const prev = this.mail.get(id);
    if (prev) {
      if (prev.from !== from || prev.to !== to || prev.text !== text)
        throw new Error("Message id reused with different content");
      return prev;
    }
    const m = { id, from, to, text, acknowledged: false };
    this.mail.set(id, m);
    return m;
  }
  inbox(to: string): Mail[] {
    return [...this.mail.values()]
      .filter((m) => m.to === to && !m.acknowledged)
      .map((m) => ({ ...m }));
  }
  acknowledge(id: string, to: string): void {
    const m = this.mail.get(id);
    if (!m || m.to !== to) throw new Error("Message recipient mismatch");
    m.acknowledged = true;
  }
  incomplete(): boolean {
    return this.list().some((t) => t.status !== "completed");
  }
}
export class Semaphore {
  private running = 0;
  private waiters: Array<() => void> = [];
  constructor(private limit = 3) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit)
      await new Promise<void>((r) => this.waiters.push(r));
    else this.running++;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running--;
    }
  }
}
