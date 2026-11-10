/**
 * Zero-Token Doubt Board Watcher & Escalation Bridge
 *
 * Listens for edits to _queries.md using kernel inotify (fs.watch in Bun).
 * When a worker adds an unresolved question, it alerts the user via Linux
 * notify-send and provides a callback for the Master to resolve or escalate.
 */

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

export type QueryWatcherCallback = (queryText: string, queryFile: string) => void

export class QueryWatcher {
  private watcher: fs.FSWatcher | null = null
  private projectRoot: string
  private callback: QueryWatcherCallback | null = null
  private queryFileNames = ['_QUERIES.MD', '_queries.md']
  private lastModifiedTime = 0

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  public getQueryFilePath(): string {
    for (const name of this.queryFileNames) {
      const p = path.join(this.projectRoot, name)
      if (fs.existsSync(p)) return p
    }
    return path.join(this.projectRoot, '_QUERIES.MD')
  }

  /**
   * Starts watching for _QUERIES.MD changes using Linux kernel inotify
   */
  public start(onQueryFound: QueryWatcherCallback): void {
    this.callback = onQueryFound

    // Watch the directory so we detect when _QUERIES.MD is first created dynamically
    try {
      this.watcher = fs.watch(this.projectRoot, (eventType, filename) => {
        if (filename && this.queryFileNames.includes(filename)) {
          this.handleFileChange(path.join(this.projectRoot, filename))
        }
      })
    } catch {
      // Non-fatal if directory watch is unavailable
    }
  }

  private handleFileChange(filePath: string): void {
    if (!fs.existsSync(filePath)) return

    try {
      const stats = fs.statSync(filePath)
      if (stats.mtimeMs <= this.lastModifiedTime) return
      this.lastModifiedTime = stats.mtimeMs

      const content = fs.readFileSync(filePath, 'utf-8')
      // Look for unresolved questions marked with [QUERY], [DOUBT], or status: pending
      if (content.includes('[QUERY') || content.includes('[DOUBT') || content.includes('status: pending') || content.includes('status: open')) {
        this.triggerDesktopAlert('Tau: Servant Worker has a Question', 'A worker logged a doubt in _queries.md awaiting input.')
        if (this.callback) {
          this.callback(content, filePath)
        }
      }
    } catch {}
  }

  /**
   * Fires a native Linux desktop notification on Hyprland / Omarchy
   */
  public triggerDesktopAlert(title: string, message: string): void {
    try {
      const proc = spawn('notify-send', ['-u', 'critical', '-a', 'oio', title, message], {
        detached: true,
        stdio: 'ignore',
      })
      proc.unref()
    } catch {
      // notify-send optional
    }
  }

  public stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}
