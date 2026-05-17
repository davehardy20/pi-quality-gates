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
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewConfig } from "../types.js";
/** Callback to get the current reviewer config at runtime. */
export type ConfigGetter = () => ReviewConfig;
/** Callback to update the reviewer config in memory. */
export type ConfigSetter = (updater: (config: ReviewConfig) => ReviewConfig) => void;
export interface ReviewerModelCommandOptions {
    getConfig: ConfigGetter;
    setConfig: ConfigSetter;
}
export declare function createReviewerModelHandler(opts: ReviewerModelCommandOptions): (args: string, ctx: ExtensionCommandContext) => Promise<void>;
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
export declare function registerReviewerModelCommand(pi: ExtensionAPI, opts: ReviewerModelCommandOptions): void;
