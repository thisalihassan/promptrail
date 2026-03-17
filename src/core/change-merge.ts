import type { FileChange } from '../models/types';

export interface TimestampedChange {
	relPath: string;
	before: string;
	after: string;
	timestamp: number;
}

export function mergeChangesInWindow(
	changes: TimestampedChange[],
	startTs: number,
	endTs: number,
	excludeWindows?: Array<{ start: number; end: number }>
): { files: string[]; changes: FileChange[] } {
	const inWindow = changes.filter((c) => {
		if (c.timestamp < startTs || c.timestamp >= endTs) return false;
		if (excludeWindows) {
			for (const w of excludeWindows) {
				if (c.timestamp >= w.start && c.timestamp < w.end) return false;
			}
		}
		return true;
	});

	const merged = new Map<string, { before: string; after: string }>();

	for (const c of inWindow) {
		const existing = merged.get(c.relPath);
		if (!existing) {
			merged.set(c.relPath, { before: c.before, after: c.after });
		} else {
			existing.after = c.after;
		}
	}

	const files: string[] = [];
	const result: FileChange[] = [];

	for (const [relPath, data] of merged) {
		if (data.before === data.after) continue;
		files.push(relPath);

		let type: FileChange['type'] = 'modified';
		if (data.before === '' && data.after !== '') type = 'added';
		else if (data.before !== '' && data.after === '') type = 'deleted';

		result.push({
			relativePath: relPath,
			type,
			before: data.before,
			after: data.after
		});
	}

	return { files, changes: result };
}
