import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PermissionManager } from "../agent/permissions.js";
import {
  executeTool,
  toolRegistry,
  type ToolExecutionContext,
} from "../tools/index.js";
import { Semaphore } from "./tasks.js";
import { workspaceState } from "./workspace.js";
import { isSecretPath } from "../repo/ignore.js";
import { resolveInsideRepo } from "../utils/paths.js";
import type { HookConfig, HookName } from "../agent/hooks.js";
export type Emit = (
  type: string,
  data: Record<string, unknown>,
  correlationId?: string,
) => void;
const locks = new Map<string, Semaphore>();
export class ToolGateway {
  constructor(
    public root: string,
    public permissions: PermissionManager,
    private context: ToolExecutionContext,
    private emit: Emit,
    private allowed?: Set<string>,
  ) {}
  async authorize(name: string, args: Record<string, unknown>): Promise<void> {
    if (this.allowed && !this.allowed.has(name))
      throw new Error(
        `Tool ${name} is not allowed for this agent (read-only permissions or a restricted tool set)`,
      );
    const def = toolRegistry.get(name);
    if (!def && !name.startsWith("mcp__"))
      throw new Error(`Unknown tool: ${name}`);
    if (def) def.schema.parse(args);
    if (name.startsWith("mcp__")) {
      const schema = this.context.mcpSchemas?.get(name);
      if (!schema) throw new Error("MCP tool was not discovered for this run");
      schema.parse(args);
    }
    const readOnly =
      this.permissions.getMode() === "plan" ||
      this.context.planModeManager?.isActive();
    if (
      readOnly &&
      (def?.effect === "write" ||
        def?.effect === "command" ||
        def?.effect === "external" ||
        name.startsWith("mcp__") ||
        name === "worker_integrate")
    )
      throw new Error("Plan mode forbids this action");
    if (typeof args.path === "string") {
      const relativePath =
        path
          .relative(this.root, resolveInsideRepo(this.root, args.path))
          .split(path.sep)
          .join("/") || ".";
      // Resolve nearest existing ancestor too: new paths through symlinks must not escape.
      let candidate = path.resolve(this.root, relativePath);
      for (;;) {
        try {
          const actual = await fs.realpath(candidate);
          const base = await fs.realpath(this.root);
          if (actual !== base && !actual.startsWith(base + path.sep))
            throw new Error("Path escapes workspace through a symlink");
          const resolvedPath = path
            .relative(
              base,
              path.join(
                actual,
                path.relative(candidate, path.resolve(this.root, relativePath)),
              ),
            )
            .split(path.sep)
            .join("/");
          if (!this.permissions.checkRead(resolvedPath))
            throw new Error(`Read permission denied: ${resolvedPath}`);
          const { isSecretPath } = await import("../repo/ignore.js");
          if (isSecretPath(resolvedPath))
            throw new Error(`Refusing potential secret file: ${resolvedPath}`);
          if (
            def?.effect === "write" &&
            resolvedPath !== relativePath &&
            !(await this.permissions.checkEdit(resolvedPath, name))
          )
            throw new Error(`Edit permission denied: ${resolvedPath}`);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          const parent = path.dirname(candidate);
          if (parent === candidate) throw e;
          candidate = parent;
        }
      }
      if (!this.permissions.checkRead(relativePath))
        throw new Error(`Read permission denied: ${relativePath}`);
    }
    if (
      def?.effect === "write" &&
      typeof args.path === "string" &&
      !(await this.permissions.checkEdit(
        args.path,
        `${name}: ${JSON.stringify(args)}`,
      ))
    )
      throw new Error(`Edit permission denied: ${args.path}`);
    if (
      (name === "run_command" || name === "verify") &&
      !(await this.permissions.checkCommand(String(args.command ?? "")))
    )
      throw new Error("User denied execution: command permission denied");
    if (name.startsWith("mcp__")) {
      const { parseNamespacedTool } = await import("../mcp/client.js");
      const p = parseNamespacedTool(name);
      if (
        !p ||
        !(await this.permissions.checkMcp(
          p.server,
          p.tool,
          JSON.stringify(args),
        ))
      )
        throw new Error("MCP permission denied");
    }
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    callId: string = randomUUID(),
    skipHooks = false,
    alreadyLocked = false,
  ): Promise<string> {
    await this.authorize(name, args);
    signal?.throwIfAborted();
    const def = toolRegistry.get(name);
    const action = async (locked = false) => {
      signal?.throwIfAborted();
      if (!skipHooks)
        await this.hooks("PreToolUse", { tool: name, args }, signal, locked);
      if (
        def?.effect !== "read" &&
        (def?.effect !== "coordination" || name === "worker_integrate")
      )
        await this.context.checkpoint?.();
      const before =
        def?.concurrency === "shared"
          ? undefined
          : await workspaceState(this.root);
      this.emit(
        "tool_intent",
        {
          name,
          args,
          before: before?.hash,
          recovery: def?.recovery ?? "reconcile",
        },
        callId,
      );
      const started = Date.now();
      try {
        const out = await executeTool(this.root, name, args, signal, {
          ...this.context,
          hooks: undefined,
          readAllowed: (file) =>
            this.permissions.checkRead(file) && !isSecretPath(file),
          readDenyGlobs: this.permissions.readDenyGlobs(),
        });
        const after = before ? await workspaceState(this.root) : undefined;
        this.emit(
          "tool_result",
          {
            name,
            output: out,
            ok: true,
            before: before?.hash,
            after: after?.hash,
            ms: Date.now() - started,
          },
          callId,
        );
        if (!skipHooks)
          await this.hooks(
            "PostToolUse",
            { tool: name, output: out.slice(0, 2000) },
            signal,
            locked,
          );
        return out;
      } catch (e) {
        this.emit(
          "tool_result",
          { name, ok: false, error: String(e), ms: Date.now() - started },
          callId,
        );
        throw e;
      }
    };
    // Delegation awaits other workspaces; it must not hold the parent's edit lock.
    if (alreadyLocked) return action(true);
    if (
      name === "verify" ||
      def?.concurrency === "shared" ||
      (def?.effect === "coordination" && name !== "worker_integrate")
    )
      return action();
    const key = await fs.realpath(this.root);
    let lock = locks.get(key);
    if (!lock) {
      lock = new Semaphore(1);
      locks.set(key, lock);
    }
    return lock.run(() => action(true));
  }
  async hooks(
    name: HookName,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    alreadyLocked = false,
  ): Promise<void> {
    const config = this.context.hooks as HookConfig | undefined;
    for (const h of config?.[name] ?? []) {
      const enforcement = h.enforcement === true;
      try {
        if (
          h.matcher &&
          !new RegExp(h.matcher).test(String(payload.tool ?? ""))
        )
          continue;
        this.emit("hook_intent", {
          hook: name,
          command: h.command,
          enforcement,
        });
        const gateway = new ToolGateway(
          this.root,
          this.permissions,
          {
            ...this.context,
            hooks: undefined,
            commandStdin: JSON.stringify({ hook: name, ...payload }),
          },
          this.emit,
          this.allowed,
        );
        const output = await gateway.execute(
          "run_command",
          {
            command: h.command,
            timeout_ms: h.timeoutMs ?? 15000,
          },
          signal,
          randomUUID(),
          true,
          alreadyLocked,
        );
        const result = {
          output,
          exitCode: Number(output.match(/^exit code:\s*(-?\d+)/m)?.[1] ?? 1),
        };
        this.emit("hook_result", { hook: name, ...result });
        if (enforcement) {
          if (result.exitCode !== 0) throw new Error("Enforcement hook failed");
          const raw = result.output.replace(/^exit code:.*\n?/, "").trim();
          const decision = JSON.parse(raw) as {
            decision?: string;
            reason?: string;
          };
          if (decision.decision !== "allow")
            throw new Error(
              decision.reason ?? "Enforcement hook denied action",
            );
        }
      } catch (e) {
        if (enforcement) throw e;
        this.emit("hook_warning", { hook: name, error: String(e) });
      }
    }
  }
}
