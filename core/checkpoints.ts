import fs from "node:fs";
import path from "node:path";
import { projectDataDir } from "./config";

/** State of one file before RushClaw changed it. */
export interface FileSnapshot {
    path: string;
    existed: boolean;
    content?: string;
}

export interface Checkpoint {
    id: string;
    createdAt: string;
    label: string;
    files: FileSnapshot[];
}

export interface RestoreResult {
    restored: string[];
    removed: string[];
    errors: string[];
}

const KEEP = 50;

/**
 * Checkpoints are saved under ~/.rushclaw/projects/<project>/checkpoints before
 * any change hits the disk, so /undo can put files back exactly as they were
 * (and delete files the agent created).
 */
export class CheckpointStore {
    readonly dir: string;

    constructor(readonly root: string) {
        this.dir = path.join(projectDataDir(root), "checkpoints");
    }

    begin(label: string): CheckpointBuilder {
        return new CheckpointBuilder(this, label);
    }

    list(): Checkpoint[] {
        if (!fs.existsSync(this.dir)) return [];
        return fs
            .readdirSync(this.dir)
            .filter((f) => f.endsWith(".json"))
            .sort()
            .reverse()
            .map((f) => {
                try {
                    return JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Checkpoint;
                } catch {
                    return null;
                }
            })
            .filter((c): c is Checkpoint => !!c);
    }

    latest(): Checkpoint | null {
        return this.list()[0] ?? null;
    }

    /** @internal */
    write(cp: Checkpoint): void {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, `${cp.id}.json`), JSON.stringify(cp), "utf8");
        const all = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort();
        for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
            try {
                fs.rmSync(path.join(this.dir, old));
            } catch { }
        }
    }

    restore(cp: Checkpoint): RestoreResult {
        const res: RestoreResult = { restored: [], removed: [], errors: [] };
        for (const f of cp.files) {
            const abs = path.resolve(this.root, f.path);
            const rel = path.relative(path.resolve(this.root), abs);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
                res.errors.push(`skipped path outside workspace: ${f.path}`);
                continue;
            }
            try {
                if (f.existed) {
                    fs.mkdirSync(path.dirname(abs), { recursive: true });
                    fs.writeFileSync(abs, f.content ?? "", "utf8");
                    res.restored.push(f.path);
                } else if (fs.existsSync(abs)) {
                    fs.rmSync(abs, { force: true });
                    res.removed.push(f.path);
                }
            } catch (e) {
                res.errors.push(`${f.path}: ${(e as Error).message}`);
            }
        }
        return res;
    }

    /** Restore and delete the most recent checkpoint. */
    undoLast(): (RestoreResult & { checkpoint: Checkpoint }) | null {
        const cp = this.latest();
        if (!cp) return null;
        const res = this.restore(cp);
        try {
            fs.rmSync(path.join(this.dir, `${cp.id}.json`), { force: true });
        } catch { }
        return { ...res, checkpoint: cp };
    }
}

export class CheckpointBuilder {
    private readonly files = new Map<string, FileSnapshot>();

    constructor(
        private readonly store: CheckpointStore,
        readonly label: string,
    ) { }

    /** Snapshot a file the first time it is about to change. */
    record(relPath: string): void {
        if (this.files.has(relPath)) return;
        const abs = path.resolve(this.store.root, relPath);
        let existed = false;
        let content: string | undefined;
        try {
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                existed = true;
                content = fs.readFileSync(abs, "utf8");
            }
        } catch { }
        this.files.set(relPath, { path: relPath, existed, content });
    }

    get size(): number {
        return this.files.size;
    }

    paths(): string[] {
        return [...this.files.keys()];
    }

    /** Persist (no-op when nothing was recorded). */
    save(): Checkpoint | null {
        if (this.files.size === 0) return null;
        const cp: Checkpoint = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
            label: this.label,
            files: [...this.files.values()],
        };
        this.store.write(cp);
        return cp;
    }
}
