import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { FileChange } from '../models/types';
import { mergeChangesInWindow, type TimestampedChange } from './change-merge';
import type { PromptRailDB } from './promptrail-db';

export { mergeChangesInWindow, type TimestampedChange } from './change-merge';

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
	private pendingChanges: TimestampedChange[] = [];
	private db: PromptRailDB | undefined;
	private disposables: vscode.Disposable[] = [];
	private ignorePatterns: ReturnType<typeof loadGitignorePatterns>;

	constructor(workspaceRoot: string, db?: PromptRailDB) {
		this.workspaceRoot = workspaceRoot;
		this.db = db;
		this.ignorePatterns = loadGitignorePatterns(workspaceRoot);

		this.migrateChangesJson();
		this.warmCache();
		this.startWatching();
	}

	private migrateChangesJson(): void {
		const jsonPath = path.join(this.workspaceRoot, '.promptrail', 'snapshots', 'changes.json');
		if (!fs.existsSync(jsonPath)) return;
		if (!this.db) return;
		if (this.db.getFileChangeCount() > 0) return;

		try {
			const raw: TimestampedChange[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
			if (raw.length > 0) {
				this.db.insertFileChangesBatch(raw);
				fs.renameSync(jsonPath, jsonPath + '.migrated');
			}
		} catch {}
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

		this.pendingChanges.push({
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

		this.pendingChanges.push({
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
		this.pendingChanges.push({
			relPath,
			before,
			after: '',
			timestamp: Date.now()
		});

		this.contentCache.delete(relPath);
	}

	getChangesInWindow(
		startTs: number,
		endTs: number,
		excludeWindows?: Array<{ start: number; end: number }>
	): { files: string[]; changes: FileChange[] } {
		const dbChanges = this.db
			? this.db.getChangesInRange(startTs, endTs)
			: [];
		const pendingInRange = this.pendingChanges.filter(
			(c) => c.timestamp >= startTs && c.timestamp < endTs
		);
		const allChanges = [...dbChanges, ...pendingInRange];
		return mergeChangesInWindow(allChanges, startTs, endTs, excludeWindows);
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
		if (this.pendingChanges.length === 0) return;
		if (this.db) {
			this.db.insertFileChangesBatch(this.pendingChanges);
			this.pendingChanges = [];
		}
	}

	dispose(): void {
		this.persistChanges();
		for (const d of this.disposables) d.dispose();
	}
}
