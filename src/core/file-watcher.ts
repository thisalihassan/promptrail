import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { FileChange } from '../models/types';

interface TimestampedChange {
	relPath: string;
	before: string;
	after: string;
	timestamp: number;
}

export const ALWAYS_IGNORE = ['.git/', '.promptrail/'];
export const NEVER_IGNORE = ['.cursor/', '.claude/'];

export interface IgnorePatterns {
	prefixes: string[];
	suffixes: string[];
	exactFiles: string[];
}

export function loadGitignorePatterns(wsRoot: string): IgnorePatterns {
	const prefixes = [...ALWAYS_IGNORE];
	const suffixes: string[] = [];
	const exactFiles: string[] = [];

	try {
		const raw = fs.readFileSync(path.join(wsRoot, '.gitignore'), 'utf-8');
		for (let line of raw.split('\n')) {
			line = line.trim();
			if (!line || line.startsWith('#')) continue;

			const clean = line.replace(/\/$/, '');

			if (NEVER_IGNORE.some((n) => clean === n.replace(/\/$/, ''))) continue;

			if (line.startsWith('*.')) {
				suffixes.push(line.slice(1));
			} else if (line.endsWith('/')) {
				prefixes.push(line);
			} else {
				exactFiles.push(clean);
			}
		}
	} catch {}

	prefixes.push('node_modules/');
	return {
		prefixes: [...new Set(prefixes)],
		suffixes: [...new Set(suffixes)],
		exactFiles: [...new Set(exactFiles)],
	};
}

export function shouldTrackFile(
	relPath: string,
	patterns: IgnorePatterns
): boolean {
	if (relPath.startsWith('/')) return false;
	if (relPath.includes('.tmp.')) return false;
	if (patterns.exactFiles.includes(relPath)) return false;
	for (const prefix of patterns.prefixes) {
		if (relPath.startsWith(prefix)) return false;
	}
	for (const suffix of patterns.suffixes) {
		if (relPath.endsWith(suffix)) return false;
	}
	return true;
}

export class FileWatcher {
	private workspaceRoot: string;
	private contentCache = new Map<string, string>();
	private changes: TimestampedChange[] = [];
	private snapshotsDir: string;
	private disposables: vscode.Disposable[] = [];
	private ignorePatterns: ReturnType<typeof loadGitignorePatterns>;

	constructor(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot;
		this.snapshotsDir = path.join(workspaceRoot, '.promptrail', 'snapshots');
		this.ignorePatterns = loadGitignorePatterns(workspaceRoot);

		this.loadExistingChanges();
		this.warmCache();
		this.startWatching();
	}

	private startWatching(): void {
		const pattern = new vscode.RelativePattern(this.workspaceRoot, '**/*');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);

		watcher.onDidChange((uri) => this.onFileChanged(uri));
		watcher.onDidCreate((uri) => this.onFileCreated(uri));
		watcher.onDidDelete((uri) => this.onFileDeleted(uri));

		this.disposables.push(watcher);
	}

	private async warmCache(): Promise<void> {
		try {
			const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/dist/**,**/.git/**,**/.promptrail/**}', 2000);
			for (const uri of files) {
				const relPath = this.toRelPath(uri.fsPath);
				if (!this.shouldTrack(relPath)) continue;
				try {
					const content = fs.readFileSync(uri.fsPath, 'utf-8');
					if (content.length <= 512 * 1024) {
						this.contentCache.set(relPath, content);
					}
				} catch {}
			}
		} catch {}
	}

	private shouldTrack(relPath: string): boolean {
		return shouldTrackFile(relPath, this.ignorePatterns);
	}

	private toRelPath(absPath: string): string {
		if (absPath.startsWith(this.workspaceRoot + '/')) {
			return absPath.slice(this.workspaceRoot.length + 1);
		}
		return absPath;
	}

	private onFileChanged(uri: vscode.Uri): void {
		const relPath = this.toRelPath(uri.fsPath);
		if (!this.shouldTrack(relPath)) return;

		const before = this.contentCache.get(relPath) ?? '';
		let after: string;
		try {
			const stat = fs.statSync(uri.fsPath);
			if (stat.size > 512 * 1024) return;
			after = fs.readFileSync(uri.fsPath, 'utf-8');
		} catch {
			return;
		}

		if (before === after) return;

		this.changes.push({
			relPath,
			before,
			after,
			timestamp: Date.now()
		});

		this.contentCache.set(relPath, after);
	}

	private onFileCreated(uri: vscode.Uri): void {
		const relPath = this.toRelPath(uri.fsPath);
		if (!this.shouldTrack(relPath)) return;

		let content: string;
		try {
			const stat = fs.statSync(uri.fsPath);
			if (stat.size > 512 * 1024) return;
			content = fs.readFileSync(uri.fsPath, 'utf-8');
		} catch {
			return;
		}

		this.changes.push({
			relPath,
			before: '',
			after: content,
			timestamp: Date.now()
		});

		this.contentCache.set(relPath, content);
	}

	private onFileDeleted(uri: vscode.Uri): void {
		const relPath = this.toRelPath(uri.fsPath);
		if (!this.shouldTrack(relPath)) return;

		const before = this.contentCache.get(relPath) ?? '';
		this.changes.push({
			relPath,
			before,
			after: '',
			timestamp: Date.now()
		});

		this.contentCache.delete(relPath);
	}

	/**
	 * Returns files changed between startTs and endTs.
	 * For the same file edited multiple times in the window,
	 * uses the first "before" and last "after".
	 */
	getChangesInWindow(
		startTs: number,
		endTs: number,
		excludeWindows?: Array<{ start: number; end: number }>
	): { files: string[]; changes: FileChange[] } {
		const inWindow = this.changes.filter((c) => {
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
		const changes: FileChange[] = [];

		for (const [relPath, data] of merged) {
			if (data.before === data.after) continue;
			files.push(relPath);

			let type: FileChange['type'] = 'modified';
			if (data.before === '' && data.after !== '') type = 'added';
			else if (data.before !== '' && data.after === '') type = 'deleted';

			changes.push({
				relativePath: relPath,
				type,
				before: data.before,
				after: data.after
			});
		}

		return { files, changes };
	}

	getRollbackForWindow(
		startTs: number,
		endTs: number,
		excludeWindows?: Array<{ start: number; end: number }>
	): FileChange[] {
		const { changes } = this.getChangesInWindow(startTs, endTs, excludeWindows);
		return changes.map((c) => ({
			relativePath: c.relativePath,
			type: c.before === '' ? 'deleted' : ('modified' as FileChange['type']),
			before: c.after,
			after: c.before
		}));
	}

	persistChanges(): void {
		if (this.changes.length === 0) return;
		try {
			fs.mkdirSync(this.snapshotsDir, { recursive: true });
			fs.writeFileSync(path.join(this.snapshotsDir, 'changes.json'), JSON.stringify(this.changes), 'utf-8');
		} catch {}
	}

	private loadExistingChanges(): void {
		const filePath = path.join(this.snapshotsDir, 'changes.json');
		if (!fs.existsSync(filePath)) return;
		try {
			this.changes = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		} catch {}
	}

	dispose(): void {
		this.persistChanges();
		for (const d of this.disposables) d.dispose();
	}
}
