import chokidar, { FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { relative, resolve } from 'path';

const DEBOUNCE_MS = 100;

export interface FileChangeEvent {
  path: string;
  event: 'add' | 'change' | 'unlink';
  content?: string;
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private recentWrites: Map<string, number> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(projectRoot: string) {
    super();
    this.projectRoot = resolve(projectRoot);
  }

  /**
   * Record a write to prevent self-edit loop
   */
  recordWrite(filePath: string): void {
    const absolutePath = filePath.startsWith('/')
      ? filePath
      : resolve(this.projectRoot, filePath);
    const relativePath = relative(this.projectRoot, absolutePath);

    this.recentWrites.set(relativePath, Date.now());

    // Clean up after debounce window
    setTimeout(() => {
      this.recentWrites.delete(relativePath);
    }, DEBOUNCE_MS * 2);
  }

  /**
   * Check if a file was recently written by us
   */
  private wasRecentlyWritten(relativePath: string): boolean {
    const writeTime = this.recentWrites.get(relativePath);
    if (!writeTime) return false;

    return Date.now() - writeTime < DEBOUNCE_MS * 2;
  }

  /**
   * Start watching the project directory
   */
  start(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(this.projectRoot, {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/coverage/**',
        '**/*.log',
        '**/.DS_Store',
        '**/Thumbs.db',
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });

    const handleEvent = async (event: 'add' | 'change' | 'unlink', absolutePath: string) => {
      const relativePath = relative(this.projectRoot, absolutePath);

      // Skip if we just wrote this file
      if (this.wasRecentlyWritten(relativePath)) {
        return;
      }

      // Cancel any pending debounce for this file
      const existingTimer = this.debounceTimers.get(relativePath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Debounce the event
      const timer = setTimeout(async () => {
        this.debounceTimers.delete(relativePath);

        const changeEvent: FileChangeEvent = {
          path: relativePath,
          event,
        };

        // Read content for add/change events
        if (event !== 'unlink') {
          try {
            changeEvent.content = await readFile(absolutePath, 'utf-8');
          } catch {
            // File might have been deleted between event and read
            return;
          }
        }

        this.emit('change', changeEvent);
      }, DEBOUNCE_MS);

      this.debounceTimers.set(relativePath, timer);
    };

    this.watcher
      .on('add', (path) => handleEvent('add', path))
      .on('change', (path) => handleEvent('change', path))
      .on('unlink', (path) => handleEvent('unlink', path))
      .on('error', (error) => {
        console.error('File watcher error:', error);
        this.emit('error', error);
      })
      .on('ready', () => {
        console.log('File watcher ready');
        this.emit('ready');
      });
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // Clear all pending timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.recentWrites.clear();
  }

  /**
   * Check if watcher is running
   */
  get isWatching(): boolean {
    return this.watcher !== null;
  }
}

// Singleton instance
let instance: FileWatcher | null = null;

export function getFileWatcher(projectRoot: string): FileWatcher {
  if (!instance) {
    instance = new FileWatcher(projectRoot);
  }
  return instance;
}

export function stopFileWatcher(): Promise<void> {
  if (instance) {
    const watcher = instance;
    instance = null;
    return watcher.stop();
  }
  return Promise.resolve();
}
