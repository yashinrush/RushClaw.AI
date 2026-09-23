import { select, isCancel } from "@clack/prompts";
import chalk from "chalk";
import figlet from "figlet";

const BANNER_FONT = 'ANSI Shadow';
const SHADOW = chalk.hex('#5b4d9e');
const FACE = chalk.hex('#f3ebfc').bold;

function printBannerWithShadow(ascii: string) {

    const bannerLines = ascii.replace(/\s+$/, '').split('\n');
    const maxLen = Math.max(...bannerLines.map((l) => l.length), 0);
    const rowWidth = maxLen + 2;

    for (const line of bannerLines) {
        console.log(SHADOW(('  ' + line).padEnd(rowWidth)));
    }
    process.stdout.write(`\x1b[${bannerLines.length}A`);
    for (const line of bannerLines) {
        console.log(FACE(line.padEnd(rowWidth)));
    }
    console.log();
}


export async function runWakeup() {

    let ascii: string;
    try {
        ascii = figlet.textSync("rushclaw", { font: BANNER_FONT })
    } catch (error) {
        ascii = figlet.textSync("rushclaw", { font: "Standard" })
    }

    printBannerWithShadow(ascii);

    const mode = await select({
        message: "How you want to use RushClaw?",
        options: [
            { value: 'cli', label: 'CLI' },
            { value: 'telegram', label: 'Telegram' }
            // { value: 'bot', label: 'Bot' }
        ]
    });
    if (isCancel(mode)) {
        console.log(chalk.red("You cancelled the operation"));
        process.exit(0);
    }

    if (mode === "cli") {
        console.log(chalk.dim("Starting cli mode..."))
    } else {
        console.log(chalk.dim("Starting Telegram mode..."))
    }
}
