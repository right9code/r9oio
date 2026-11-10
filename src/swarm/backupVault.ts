import * as fs from 'fs';
import * as path from 'path';

export interface BackupEntry {
  originalPath: string;
  backupPath: string;
  timestamp: string;
  modifiedByAgent?: string;
}

export interface BackupSessionManifest {
  sessionId: string;
  createdTime: string;
  entries: BackupEntry[];
}

export class SwarmBackupVault {
  private baseDir: string;
  private sessionId: string;
  private sessionDir: string;
  private manifestPath: string;
  private entries: Map<string, BackupEntry> = new Map();

  constructor(projectRoot: string = process.cwd(), sessionId?: string) {
    this.sessionId = sessionId || `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.baseDir = path.join(projectRoot, '.oio', 'swarm-backups');
    this.sessionDir = path.join(this.baseDir, this.sessionId);
    this.manifestPath = path.join(this.sessionDir, 'manifest.json');
    this.init();
  }

  private init() {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Captures a pristine backup copy before any servant agent modifies it.
   * If already backed up in this session, retains the earliest pristine version.
   */
  public backupFile(targetFilePath: string, agentName?: string): BackupEntry | null {
    const resolvedPath = path.resolve(targetFilePath);
    if (!fs.existsSync(resolvedPath)) {
      return null;
    }

    if (this.entries.has(resolvedPath)) {
      return this.entries.get(resolvedPath)!;
    }

    const relativeSub = resolvedPath.replace(/^[/\\]+/, '').replace(/[:]/g, '_');
    const destPath = path.join(this.sessionDir, relativeSub);
    const destDir = path.dirname(destPath);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    fs.copyFileSync(resolvedPath, destPath);

    const entry: BackupEntry = {
      originalPath: resolvedPath,
      backupPath: destPath,
      timestamp: new Date().toISOString(),
      modifiedByAgent: agentName,
    };

    this.entries.set(resolvedPath, entry);
    this.saveManifest();
    return entry;
  }

  /**
   * Reverts a file to its pristine state captured at the beginning of the swarm run.
   */
  public restoreFile(targetFilePath: string): boolean {
    const resolvedPath = path.resolve(targetFilePath);
    const entry = this.entries.get(resolvedPath);
    if (!entry || !fs.existsSync(entry.backupPath)) {
      return false;
    }
    fs.copyFileSync(entry.backupPath, resolvedPath);
    return true;
  }

  /**
   * Reverts specific files modified by a specific task or agent back to pristine state.
   */
  public restoreFiles(filePaths: string[]): number {
    let restored = 0;
    for (const f of filePaths) {
      if (this.restoreFile(f)) {
        restored++;
      }
    }
    return restored;
  }

  /**
   * Reverts all files modified during this session.
   */
  public restoreAll(): number {
    let restored = 0;
    for (const [_, entry] of this.entries) {
      if (fs.existsSync(entry.backupPath)) {
        fs.copyFileSync(entry.backupPath, entry.originalPath);
        restored++;
      }
    }
    return restored;
  }

  /**
   * Generates a unified diff summary between backed up pristine files and their current disk state.
   */
  public getDiffSummary(targetFilePath?: string): Array<{ filePath: string; hasChanges: boolean; originalLines: number; currentLines: number }> {
    const diffs: Array<{ filePath: string; hasChanges: boolean; originalLines: number; currentLines: number }> = [];

    const candidates = targetFilePath
      ? [this.entries.get(path.resolve(targetFilePath))].filter(Boolean) as BackupEntry[]
      : Array.from(this.entries.values());

    for (const entry of candidates) {
      if (!fs.existsSync(entry.backupPath) || !fs.existsSync(entry.originalPath)) {
        continue;
      }
      const origContent = fs.readFileSync(entry.backupPath, 'utf-8');
      const currContent = fs.readFileSync(entry.originalPath, 'utf-8');
      const hasChanges = origContent !== currContent;
      diffs.push({
        filePath: entry.originalPath,
        hasChanges,
        originalLines: origContent.split('\n').length,
        currentLines: currContent.split('\n').length,
      });
    }

    return diffs;
  }

  /**
   * Permanently cleans up the backup files for this session after the user reviews & approves.
   */
  public purge(): void {
    if (fs.existsSync(this.sessionDir)) {
      fs.rmSync(this.sessionDir, { recursive: true, force: true });
    }
  }

  public getEntries(): BackupEntry[] {
    return Array.from(this.entries.values());
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getSessionDir(): string {
    return this.sessionDir;
  }

  private saveManifest() {
    const manifest: BackupSessionManifest = {
      sessionId: this.sessionId,
      createdTime: new Date().toISOString(),
      entries: Array.from(this.entries.values()),
    };
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }
}
