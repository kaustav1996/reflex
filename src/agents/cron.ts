/**
 * Tiny 5-field cron matcher: minute hour day-of-month month day-of-week.
 * Supports *, lists (1,2), ranges (1-5), steps (*\/15, 1-30/5), names for months/days.
 */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(field: string, min: number, max: number, names?: string[]): Set<number> {
	const out = new Set<number>();
	const norm = (s: string) => {
		const lower = s.toLowerCase();
		const i = names?.indexOf(lower.slice(0, 3)) ?? -1;
		if (i >= 0) return i + (names === MONTHS ? 1 : 0);
		const n = Number(s);
		if (!Number.isInteger(n)) throw new Error(`bad cron value "${s}"`);
		return n;
	};
	for (const part of field.split(",")) {
		const [rangeStr, stepStr] = part.split("/");
		const step = stepStr ? Number(stepStr) : 1;
		if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step "${part}"`);
		let lo = min;
		let hi = max;
		if (rangeStr !== "*") {
			const [a, b] = rangeStr.split("-");
			lo = norm(a);
			hi = b !== undefined ? norm(b) : stepStr ? max : lo;
		}
		if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range "${part}"`);
		for (let v = lo; v <= hi; v += step) out.add(v === 7 && names === DAYS ? 0 : v);
	}
	return out;
}

export interface CronSpec {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	source: string;
}

const ALIASES: Record<string, string> = {
	"@hourly": "0 * * * *",
	"@daily": "0 9 * * *",
	"@weekly": "0 9 * * 1",
	"@monthly": "0 9 1 * *",
	"@weekdays": "0 9 * * 1-5",
};

export function parseCron(expr: string): CronSpec {
	const source = expr.trim();
	const text = ALIASES[source] ?? source;
	const fields = text.split(/\s+/);
	if (fields.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got "${expr}"`);
	return {
		minute: parseField(fields[0], 0, 59),
		hour: parseField(fields[1], 0, 23),
		dom: parseField(fields[2], 1, 31),
		month: parseField(fields[3], 1, 12, MONTHS),
		dow: parseField(fields[4], 0, 7, DAYS),
		source,
	};
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
	return spec.minute.has(date.getMinutes()) && spec.hour.has(date.getHours()) && spec.dom.has(date.getDate()) && spec.month.has(date.getMonth() + 1) && spec.dow.has(date.getDay());
}

/** Next matching minute after `from` (scans up to a year). */
export function nextCronRun(spec: CronSpec, from: Date = new Date()): Date | undefined {
	const d = new Date(from);
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + 1);
	for (let i = 0; i < 366 * 24 * 60; i++) {
		if (cronMatches(spec, d)) return d;
		d.setMinutes(d.getMinutes() + 1);
	}
	return undefined;
}

export function describeCron(expr: string): string {
	try {
		const next = nextCronRun(parseCron(expr));
		return next ? `next ${next.toLocaleString()}` : "never";
	} catch (err) {
		return `invalid: ${err instanceof Error ? err.message : String(err)}`;
	}
}
