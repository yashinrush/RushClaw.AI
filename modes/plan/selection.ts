import { multiselect, isCancel } from '@clack/prompts';
import type { Plan, PlanStep } from './types.ts';
import { renderTerminalMarkdown } from '../../tui/terminal-md.ts';
import { BRAND_GRADIENT, box, gradient, sym, t, termWidth, wrap } from '../../tui/theme.ts';

const COMPLEXITY: Record<NonNullable<PlanStep['complexity']>, string> = {
    low: t.ok('● low'),
    medium: t.warn('● medium'),
    high: t.err('● high'),
};

export function printPlan(plan: Plan): void {
    if (plan.researchSummary?.trim()) {
        console.log(`\n${t.info(sym.dot)} ${t.bold('Research summary')}`);
        console.log(renderTerminalMarkdown(plan.researchSummary));
    }
    const inner = Math.min(termWidth() - 10, 90);
    const lines: string[] = [t.muted(wrap(plan.goal, inner).join(' ')), ''];
    for (const [i, s] of plan.steps.entries()) {
        const num = t.brand(String(i + 1).padStart(2) + '.');
        const tag = s.complexity ? `  ${COMPLEXITY[s.complexity]}` : '';
        lines.push(`${num} ${t.bold(s.title)}${tag}`);
        for (const l of wrap(s.description, inner - 4).slice(0, 2)) lines.push(`    ${t.dim(l)}`);
    }
    console.log('\n' + box(lines, { title: gradient(`Plan · ${plan.steps.length} steps`, BRAND_GRADIENT, true), padding: 2 }) + '\n');
}

export async function selectSteps(plan: Plan): Promise<PlanStep[]> {
    const options = plan.steps.map((s, i) => ({
        value: s.id,
        label: `${i + 1}. ${s.title}`,
        hint: s.complexity ?? '',
    }));

    const picked = await multiselect<string>({
        message: 'Select steps to execute (space toggles, enter confirms)',
        options,
        initialValues: plan.steps.map((s) => s.id),
        required: false,
    });

    if (isCancel(picked)) return [];
    const set = new Set<string>(picked);
    return plan.steps.filter((s) => set.has(s.id));
}
