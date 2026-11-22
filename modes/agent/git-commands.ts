import chalk from "chalk";
import { confirm, isCancel, multiselect, select, text } from "@clack/prompts";
import type { AgentEngine } from "../../core/engine";
import {
    currentBranch,
    defaultBranch,
    describeStatus,
    diffForFiles,
    generateCommitMessage,
    generatePrDescription,
    ghAvailable,
    git,
    isGitRepo,
    reviewDiff,
    statusEntries,
    workingDiff,
} from "../../core/git";
import { printError } from "../../core/errors";
import { Activity } from "../../tui/activity";
import { colorizePatch } from "./diff-view";
import { printMarkdown, registerSlash } from "./slash-commands";

function requireRepo(engine: AgentEngine): boolean {
    if (isGitRepo(engine.root)) return true;
    console.log(chalk.yellow("This directory is not a git repository."));
    return false;
}

/** Run an AI call with a spinner and count its tokens. */
async function withModel<T extends { usage?: any; modelId?: string }>(
    engine: AgentEngine,
    label: string,
    fn: () => Promise<T>,
): Promise<T | null> {
    const a = new Activity();
    a.start(label);
    try {
        const r = await fn();
        engine.usage.addStep(r.usage, r.modelId);
        return r;
    } catch (e) {
        printError(e, engine.modelSpec);
        return null;
    } finally {
        a.stop();
    }
}

registerSlash(
    {
        name: "diff",
        args: "[--stat]",
        description: "Show uncommitted changes in the working tree (git diff HEAD)",
        async run({ engine, args }) {
            if (!requireRepo(engine)) return;
            if (args.includes("stat")) {
                console.log(git(["diff", "HEAD", "--stat"], engine.root).stdout || chalk.dim("No changes."));
                return;
            }
            const d = workingDiff(engine.root);
            const untracked = statusEntries(engine.root).filter((e) => e.untracked);
            if (!d.trim() && !untracked.length) return void console.log(chalk.dim("No uncommitted changes."));
            if (d.trim()) console.log("\n" + colorizePatch(d));
            if (untracked.length) console.log(chalk.dim(`\nUntracked: ${untracked.map((e) => e.path).join(", ")}`));
            console.log();
        },
    },
    {
        name: "commit",
        description: "Commit changes with an AI-written commit message (you pick files and confirm)",
        agentOnly: true,
        async run({ engine }) {
            if (!requireRepo(engine)) return;
            if (engine.pending().length) return void console.log(chalk.yellow("Resolve the staged RushClaw changes first."));
            const entries = statusEntries(engine.root);
            if (!entries.length) return void console.log(chalk.dim("Nothing to commit — working tree clean."));

            const picked = await multiselect<string>({
                message: "Files to commit (space toggles; untracked files start unselected)",
                options: entries.map((e) => ({ value: e.path, label: e.path, hint: describeStatus(e.code) })),
                initialValues: entries.filter((e) => !e.untracked).map((e) => e.path),
                required: true,
            });
            if (isCancel(picked)) return;
            const chosen = entries.filter((e) => picked.includes(e.path));

            const diff = diffForFiles(engine.root, chosen);
            const log = git(["log", "--oneline", "-10"], engine.root).stdout.trim();
            const r = await withModel(engine, "Writing commit message…", () =>
                generateCommitMessage(engine.model(), diff, log),
            );
            if (!r) return;
            let message = r.text;

            while (true) {
                console.log(`\n${chalk.bold("Commit message")}\n${chalk.cyan(message)}\n`);
                const action = await select({
                    message: `Commit ${chosen.length} file(s)?`,
                    options: [
                        { value: "commit", label: "Commit" },
                        { value: "edit", label: "Edit subject line" },
                        { value: "regen", label: "Regenerate" },
                        { value: "cancel", label: "Cancel" },
                    ],
                });
                if (isCancel(action) || action === "cancel") return;
                if (action === "edit") {
                    const [subject, ...rest] = message.split("\n");
                    const t = await text({ message: "Subject", initialValue: subject });
                    if (!isCancel(t) && t.trim()) message = [t.trim(), ...rest].join("\n");
                    continue;
                }
                if (action === "regen") {
                    const again = await withModel(engine, "Writing commit message…", () =>
                        generateCommitMessage(engine.model(), diff, log),
                    );
                    if (again) message = again.text;
                    continue;
                }
                break;
            }

            const add = git(["add", "-A", "--", ...chosen.map((e) => e.path)], engine.root);
            if (!add.ok) return void console.log(chalk.red(`git add failed: ${add.stderr.trim()}`));
            const c = git(["commit", "-F", "-"], engine.root, message + "\n");
            if (!c.ok) return void console.log(chalk.red(`git commit failed:\n${(c.stderr || c.stdout).trim()}`));
            console.log(chalk.green(`✓ ${c.stdout.trim().split("\n")[0]}`));
        },
    },
    {
        name: "review",
        args: "[base-branch]",
        description: "AI code review of uncommitted changes, or of this branch vs base",
        async run({ engine, args }) {
            if (!requireRepo(engine)) return;
            let diff = workingDiff(engine.root);
            let scope = "uncommitted changes";
            if (!diff.trim() || args) {
                const base = args || defaultBranch(engine.root);
                const ref = git(["rev-parse", "--verify", "--quiet", base], engine.root).ok ? base : `origin/${base}`;
                diff = git(["diff", `${ref}...HEAD`], engine.root).stdout;
                scope = `${currentBranch(engine.root)} vs ${base}`;
            }
            if (!diff.trim()) return void console.log(chalk.dim("No changes to review."));
            if (diff.length > 60_000) diff = diff.slice(0, 60_000) + "\n…[truncated]";
            const r = await withModel(engine, `Reviewing ${scope}…`, () =>
                reviewDiff(engine.model(), diff, engine.memory.text),
            );
            if (!r) return;
            console.log(chalk.bold(`\n🔎 Review: ${scope}\n`));
            printMarkdown(r.text);
        },
    },
    {
        name: "pr",
        args: "[base-branch]",
        description: "Push this branch and open a GitHub pull request (needs gh CLI)",
        agentOnly: true,
        async run({ engine, args }) {
            if (!requireRepo(engine)) return;
            const branch = currentBranch(engine.root);
            const base = args || defaultBranch(engine.root);
            if (branch === base || branch === "HEAD") {
                console.log(chalk.yellow(`You're on ${branch}. Create a feature branch first (git checkout -b my-feature).`));
                return;
            }
            if (statusEntries(engine.root).some((e) => !e.untracked))
                console.log(chalk.yellow("Note: you have uncommitted changes; they won't be in the PR (use /commit first)."));

            const ref = git(["rev-parse", "--verify", "--quiet", base], engine.root).ok ? base : `origin/${base}`;
            const commits = git(["log", "--oneline", `${ref}..HEAD`], engine.root).stdout.trim();
            if (!commits) return void console.log(chalk.dim(`No commits on ${branch} that aren't on ${base}.`));

            const push = await confirm({ message: `Push ${branch} to origin?`, initialValue: true });
            if (isCancel(push) || !push) return;
            const p = git(["push", "-u", "origin", branch], engine.root);
            if (!p.ok) return void console.log(chalk.red(`git push failed:\n${p.stderr.trim()}`));
            console.log(chalk.green(`✓ Pushed ${branch}`));

            if (!ghAvailable()) {
                console.log(
                    chalk.yellow("GitHub CLI (gh) is not installed, so the PR can't be opened automatically.") +
                    chalk.dim(`\nInstall it from https://cli.github.com/ and run /pr again, or open the PR in the browser from the link git printed above.`),
                );
                return;
            }

            const diffStat = git(["diff", "--stat", `${ref}...HEAD`], engine.root).stdout;
            const diff = git(["diff", `${ref}...HEAD`], engine.root).stdout.slice(0, 50_000);
            const r = await withModel(engine, "Writing PR description…", () =>
                generatePrDescription(engine.model(), commits, diffStat, diff),
            );
            if (!r) return;
            console.log(`\n${chalk.bold(r.title)}\n\n${r.body}\n`);
            const t = await text({ message: "PR title", initialValue: r.title });
            if (isCancel(t) || !t.trim()) return;
            const ok = await confirm({ message: `Open PR ${branch} → ${base}?`, initialValue: true });
            if (isCancel(ok) || !ok) return;

            const gh = (await import("node:child_process")).spawnSync(
                "gh",
                ["pr", "create", "--base", base, "--head", branch, "--title", t.trim(), "--body-file", "-"],
                { cwd: engine.root, encoding: "utf8", input: r.body, windowsHide: true },
            );
            if (gh.status !== 0) return void console.log(chalk.red(`gh pr create failed:\n${(gh.stderr || gh.stdout).trim()}`));
            console.log(chalk.green(`✓ Pull request: ${gh.stdout.trim()}`));
        },
    },
);
