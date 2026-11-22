import fs from "node:fs";
import path from "node:path";
import { rushclawHome } from "./config";

/** Minimal .env parser: KEY=VALUE, optional quotes, # comments. */
export function parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2]!.trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, "");
        out[m[1]!] = v;
    }
    return out;
}

/**
 * Bun only loads .env from the current directory. When RushClaw runs inside
 * another project (after `bun link`), also read ~/.rushclaw/.env and the .env
 * next to RushClaw's own install. Existing variables are never overridden.
 */
export function loadExtraEnv(installDir: string): string[] {
    const loaded: string[] = [];
    for (const file of [path.join(rushclawHome(), ".env"), path.join(installDir, ".env")]) {
        if (path.resolve(file) === path.resolve(process.cwd(), ".env")) continue;
        try {
            if (!fs.existsSync(file)) continue;
            const vars = parseEnv(fs.readFileSync(file, "utf8"));
            for (const [k, v] of Object.entries(vars)) {
                if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
            }
            loaded.push(file);
        } catch { }
    }
    return loaded;
}
