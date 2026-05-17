/**
 * /reviewer-model Command
 *
 * Mid-session model switching for the post-turn-reviewer.
 *
 * Usage:
 *   /reviewer-model                  - Show interactive model selector
 *   /reviewer-model <provider/id>    - Switch directly to a model
 *   /reviewer-model --show           - Show the current reviewer model
 *   /reviewer-model --default        - Reset to session default (null)
 *   /reviewer-model --persist <id>   - Switch and save to config file
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ReviewConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback to get the current reviewer config at runtime. */
export type ConfigGetter = () => ReviewConfig;

/** Callback to update the reviewer config in memory. */
export type ConfigSetter = (
  updater: (config: ReviewConfig) => ReviewConfig,
) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a model as "provider/model-id" for display and matching. */
function modelSpecifier(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}
/** Show the current reviewer model as a status line. */
function showCurrentModel(
  config: ReviewConfig,
  ctx: ExtensionCommandContext,
): void {
  if (config.model === null) {
    ctx.ui.notify(
      "🔍 Reviewer model: session default (follows active model)",
      "info",
    );
  } else {
    ctx.ui.notify(`🔍 Reviewer model: ${config.model}`, "info");
  }
}

/** Persist the model field to `.pi/reviewer.config.json`. */
function persistModel(cwd: string, model: string | null): void {
  const configPath = join(cwd, ".pi", "reviewer.config.json");

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // File missing or invalid JSON — start fresh
  }

  existing.model = model;
  writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Interactive model selector (reuses Pi's ctx.ui.custom like theme-switcher)
// ---------------------------------------------------------------------------

async function _showModelSelector(
  ctx: ExtensionCommandContext,
  currentModel: string | null,
  onConfirm: (modelSpecifier: string) => void,
): Promise<void> {
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) {
    ctx.ui.notify("No models available in the registry.", "warning");
    return;
  }

  const items = available.map((m) => {
    const spec = modelSpecifier(m);
    const isCurrent = spec === currentModel;
    return {
      value: spec,
      label: isCurrent ? `${spec} (active)` : spec,
      description: isCurrent
        ? `Currently used by reviewer — ${m.name}`
        : m.name,
    };
  });

  // Add a "session default" option at the top
  const allItems = [
    {
      value: "__default__",
      label: "session default (null)",
      description:
        currentModel === null
          ? "Currently active — follows the session model"
          : "Follow the session's active model for reviews",
    },
    ...items,
  ];

  const result = await ctx.ui.select(
    "Select Reviewer Model",
    allItems.map((i) => i.value),
  );

  if (result === undefined) {
    // User cancelled
    return;
  }

  if (result === "__default__") {
    onConfirm("__default__");
    return;
  }

  onConfirm(result);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export interface ReviewerModelCommandOptions {
  getConfig: ConfigGetter;
  setConfig: ConfigSetter;
}

export function createReviewerModelHandler(
  opts: ReviewerModelCommandOptions,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args: string, ctx: ExtensionCommandContext) => {
    const trimmed = args.trim();

    // --show: display current model
    if (trimmed === "--show") {
      showCurrentModel(opts.getConfig(), ctx);
      return;
    }

    // --default: reset to session default
    if (trimmed === "--default") {
      opts.setConfig((config) => ({ ...config, model: null }));
      ctx.ui.notify("🔍 Reviewer model reset to session default", "info");
      return;
    }

    // --persist <model>: switch and save to config file
    if (trimmed.startsWith("--persist")) {
      const modelArg = trimmed.replace(/^--persist\s+/, "").trim();
      if (!modelArg || modelArg === "--persist") {
        ctx.ui.notify(
          "Usage: /reviewer-model --persist <provider/model-id>",
          "warning",
        );
        return;
      }

      const available = ctx.modelRegistry.getAvailable();
      const match = available.find(
        (m) => modelSpecifier(m) === modelArg || m.id === modelArg,
      );

      if (!match) {
        ctx.ui.notify(
          `Unknown model "${modelArg}". Use /reviewer-model (no args) to see available models.`,
          "error",
        );
        return;
      }

      const spec = modelSpecifier(match);
      opts.setConfig((config) => ({ ...config, model: spec }));
      persistModel(ctx.cwd, spec);
      ctx.ui.notify(
        `🔍 Reviewer model switched to ${spec} (saved to config)`,
        "info",
      );
      return;
    }

    // Direct model argument: /reviewer-model <provider/id>
    if (trimmed) {
      const available = ctx.modelRegistry.getAvailable();
      const match = available.find(
        (m) => modelSpecifier(m) === trimmed || m.id === trimmed,
      );

      if (!match) {
        ctx.ui.notify(
          `Unknown model "${trimmed}". Use /reviewer-model (no args) to see available models.`,
          "error",
        );
        return;
      }

      const spec = modelSpecifier(match);
      opts.setConfig((config) => ({ ...config, model: spec }));
      ctx.ui.notify(`🔍 Reviewer model switched to ${spec}`, "info");
      return;
    }

    // No args: show interactive selector when UI is available, otherwise
    // fall back to the current model status line.
    if (!ctx.hasUI) {
      showCurrentModel(opts.getConfig(), ctx);
      return;
    }

    await _showModelSelector(ctx, opts.getConfig().model, (selection) => {
      if (selection === "__default__") {
        opts.setConfig((config) => ({ ...config, model: null }));
        ctx.ui.notify("🔍 Reviewer model reset to session default", "info");
        return;
      }

      opts.setConfig((config) => ({ ...config, model: selection }));
      ctx.ui.notify(`🔍 Reviewer model switched to ${selection}`, "info");
    });
  };
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Register the `/reviewer-model` command on the Pi extension API.
 *
 * Usage from index.ts:
 * ```ts
 * import { registerReviewerModelCommand } from "./commands/reviewer-model.js";
 *
 * export default function postTurnReviewer(pi: ExtensionAPI) {
 *   const state = { config: loadReviewerConfig(cwd) };
 *   registerReviewerModelCommand(pi, {
 *     getConfig: () => state.config,
 *     setConfig: (updater) => { state.config = updater(state.config); },
 *   });
 * }
 * ```
 */
export function registerReviewerModelCommand(
  pi: ExtensionAPI,
  opts: ReviewerModelCommandOptions,
): void {
  const handler = createReviewerModelHandler(opts);

  pi.registerCommand("reviewer-model", {
    description:
      "Switch the reviewer model mid-session. Use --show to display current, --default to reset, or pass a model id.",
    getArgumentCompletions: (prefix: string) => {
      // This is called outside of command context, so we can't access ctx.modelRegistry
      // directly here. Return a static list of common flags + let the handler validate.
      const flags = ["--show", "--default", "--persist"];
      const modelPrefix = prefix.toLowerCase();

      // Match flag completions
      const flagMatches = flags.filter((f) =>
        f.toLowerCase().startsWith(modelPrefix),
      );
      if (flagMatches.length > 0) {
        return flagMatches.map((f) => ({ value: f, label: f }));
      }

      // If it looks like a model prefix, return null to let the user type freely.
      // Actual model validation happens in the handler.
      return null;
    },
    handler,
  });
}
