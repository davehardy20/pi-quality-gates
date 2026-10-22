import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { isBuiltin, registerHooks } from "node:module";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ReviewerModulePin {
	path: string;
	sha256: string;
	format: "module" | "commonjs" | "json" | "module-typescript";
}

/** Child-only, irreversible fence; never install in the foreground Pi process. */
export function installPinnedReviewerHooks(
	files: readonly ReviewerModulePin[],
	builtins: readonly string[],
): {
	guard(): void;
	loadedIndices(): number[];
	builtinImports(): string[];
	seal(onViolation: () => void): void;
} {
	let violated = false;
	let sealed = false;
	let notified = false;
	let onViolation: (() => void) | undefined;
	const refuse = (): never => {
		violated = true;
		if (sealed) {
			process.exitCode = 1;
			if (!notified) {
				notified = true;
				try {
					onViolation?.();
				} catch {
					// Failed audit writes still leave a nonzero child exit status.
				}
			}
		}
		throw new Error("Pinned reviewer import refused");
	};
	const formats = new Set(["module", "commonjs", "json", "module-typescript"]);
	if (!Array.isArray(files) || files.length === 0 || files.length > 2048) {
		refuse();
	}
	const pins = new Map<string, ReviewerModulePin & { index: number }>();
	for (const [index, file] of files.entries()) {
		if (
			typeof file.path !== "string" ||
			!isAbsolute(file.path) ||
			file.path.length > 4096 ||
			file.path.split("/").some((part) => part === "." || part === "..") ||
			realpathSync(file.path) !== file.path ||
			!/^[a-f0-9]{64}$/.test(file.sha256) ||
			!formats.has(file.format)
		) {
			refuse();
		}
		const url = pathToFileURL(file.path).href;
		if (pins.has(url)) refuse();
		pins.set(url, Object.freeze({ ...file, index }));
	}
	if (!Array.isArray(builtins) || builtins.length > 128) refuse();
	const allowed = new Set<string>();
	for (const builtin of builtins) {
		if (typeof builtin !== "string" || !isBuiltin(builtin)) refuse();
		allowed.add(builtin.startsWith("node:") ? builtin : `node:${builtin}`);
	}
	const imported = new Set<string>();
	const loaded = new Set<number>();
	const checkBuiltin = (name: string) => {
		if (typeof name !== "string") return refuse();
		const canonical = name.startsWith("node:") ? name : `node:${name}`;
		if (!allowed.has(canonical) || (sealed && !imported.has(canonical))) {
			refuse();
		}
		imported.add(canonical);
	};
	const pinFor = (url: string) => {
		const pin = pins.get(url);
		if (!pin || pathToFileURL(fileURLToPath(url)).href !== url) return refuse();
		if (sealed && !loaded.has(pin.index)) return refuse();
		return pin;
	};
	// getBuiltinModule bypasses ordinary import hooks. Fence it explicitly too.
	const getBuiltin = process.getBuiltinModule;
	Object.defineProperty(process, "getBuiltinModule", {
		configurable: false,
		writable: false,
		value: (name: string) => {
			checkBuiltin(name);
			return getBuiltin(name);
		},
	});
	registerHooks({
		resolve(specifier, context, nextResolve) {
			try {
				const result = nextResolve(specifier, context);
				if (isBuiltin(result.url)) checkBuiltin(result.url);
				else pinFor(result.url);
				return result;
			} catch {
				return refuse();
			}
		},
		load(url, context, nextLoad) {
			try {
				if (isBuiltin(url)) {
					checkBuiltin(url);
					return nextLoad(url, context);
				}
				if (sealed) refuse();
				const pin = pinFor(url);
				if (realpathSync(pin.path) !== pin.path) refuse();
				const fd = openSync(
					pin.path,
					constants.O_RDONLY | constants.O_NOFOLLOW,
				);
				try {
					const stat = fstatSync(fd);
					if (!stat.isFile() || stat.size > 16 * 1024 * 1024) refuse();
					const bytes = readFileSync(fd);
					if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) {
						refuse();
					}
					loaded.add(pin.index);
					// Supply the verified bytes, never re-open via the default loader.
					return { format: pin.format, source: bytes, shortCircuit: true };
				} finally {
					closeSync(fd);
				}
			} catch {
				return refuse();
			}
		},
	});
	return Object.freeze({
		guard: () => {
			if (violated) refuse();
		},
		loadedIndices: () => [...loaded].sort((a, b) => a - b),
		builtinImports: () => [...imported].sort(),
		seal: (notify: () => void) => {
			if (violated || sealed || typeof notify !== "function") refuse();
			onViolation = notify;
			sealed = true;
		},
	});
}
