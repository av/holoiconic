import type { Ctx } from "./ctx.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Node source code ──────────────────────────────────────────────
// Each value is a valid AsyncFunction body receiving (ctx, args).
// Nodes CANNOT use import statements. They CAN use Bun globals.
// Sources are loaded from src/nodes/ at seed time; edit them there.

const nodesDir = join(dirname(fileURLToPath(import.meta.url)), "nodes");

// Guard: fail fast with actionable message if the nodes/ tree is missing
// (e.g. after bundling, wrong CWD, or install that did not preserve src/nodes).
try {
  const st = statSync(nodesDir);
  if (!st.isDirectory()) throw new Error("not a directory");
} catch {
  throw new Error(
    "[template] nodes/ directory not found next to template.ts (" +
      nodesDir +
      "). Was the package installed or bundled correctly? The runtime requires the src/nodes/ tree for seeding."
  );
}

function loadNodes(dir: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      Object.assign(result, loadNodes(path, prefix + entry + ":"));
    } else if (entry.endsWith(".ts")) {
      const name = prefix + entry.slice(0, -3);
      let content = readFileSync(path, "utf-8");

      // Strip leading JSDoc header blocks (single-line or multi-line /** ... */)
      // and blank lines at the top of the file. These provide IDE type hints
      // (via `import('../ctx')`) when editing node sources in the src/nodes/ tree;
      // they are not part of the runtime AsyncFunction body.
      const lines = content.split("\n");
      let startIdx = 0;
      while (startIdx < lines.length) {
        const trimmed = lines[startIdx].trim();
        if (trimmed === "") {
          startIdx++;
          continue;
        }
        if (trimmed.startsWith("/**")) {
          // Consume the full block, including internal lines, until closing */
          do {
            startIdx++;
          } while (startIdx < lines.length && !lines[startIdx - 1].trim().endsWith("*/"));
          continue;
        }
        break;
      }
      content = lines.slice(startIdx).join("\n");

      result[name] = content;
    }
  }
  return result;
}

const nodes = loadNodes(nodesDir);

// ── Seeder ────────────────────────────────────────────────────────

export async function seedTemplate(ctx: Ctx): Promise<void> {
  console.log("[template] seeding graph with primitive nodes...");

  for (const [name, source] of Object.entries(nodes)) {
    await ctx.insert(name, "source", source);
    await ctx.insert(name, "type", "Function");
  }

  console.log(`[template] seeded ${Object.keys(nodes).length} nodes`);
}
