import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, stat, mkdir } from 'fs/promises';
import { join, resolve, relative, dirname, normalize } from 'path';
import { existsSync } from 'fs';
import ignore, { Ignore } from 'ignore';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size: number;
  modifiedTime: string;
}

export class FileOperations {
  private projectRoot: string;
  private ignoreInstance: Ignore | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  /**
   * Validate that a path is within the project root
   * Prevents path traversal attacks
   *
   * Uses normalize() instead of resolve() to validate the LOGICAL path
   * (the path as the user navigated it) rather than the RESOLVED path
   * (where symlinks point). This allows symlinks within the project to
   * point to directories outside the project root, as long as the user
   * navigated there through the file tree.
   */
  private validatePath(inputPath: string): string {
    let logicalPath: string;

    if (inputPath.startsWith('/')) {
      // Absolute path - normalize it (handles .. without following symlinks)
      logicalPath = normalize(inputPath);
    } else {
      // Relative path - join with project root then normalize
      logicalPath = normalize(join(this.projectRoot, inputPath));
    }

    // Check if the logical path is within project root
    // Must either BE the project root or START WITH projectRoot + '/'
    if (logicalPath !== this.projectRoot &&
        !logicalPath.startsWith(this.projectRoot + '/')) {
      throw new Error('Path outside project root is not allowed');
    }

    return logicalPath;
  }

  /**
   * Load .gitignore rules from project root
   */
  private async loadGitignore(): Promise<Ignore> {
    if (this.ignoreInstance) {
      return this.ignoreInstance;
    }

    this.ignoreInstance = ignore();

    // Always ignore these
    this.ignoreInstance.add([
      '.git',
      'node_modules',
      '.DS_Store',
    ]);

    // Try to load .gitignore
    const gitignorePath = join(this.projectRoot, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const content = await fsReadFile(gitignorePath, 'utf-8');
        this.ignoreInstance.add(content);
      } catch {
        // Ignore read errors
      }
    }

    return this.ignoreInstance;
  }

  /**
   * List directory contents
   */
  async listDirectory(dirPath: string): Promise<FileEntry[]> {
    const absolutePath = this.validatePath(dirPath);

    const dirStat = await stat(absolutePath);
    if (!dirStat.isDirectory()) {
      throw new Error('Path is not a directory');
    }

    const ig = await this.loadGitignore();
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const results: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = join(absolutePath, entry.name);
      const relativePath = relative(this.projectRoot, entryPath);

      // Skip ignored files
      if (ig.ignores(relativePath) || ig.ignores(relativePath + '/')) {
        continue;
      }

      try {
        const entryStat = await stat(entryPath);
        // Use stat result (follows symlinks) instead of Dirent for type detection
        // This ensures symlinks to directories show as directories
        results.push({
          name: entry.name,
          type: entryStat.isDirectory() ? 'directory' : 'file',
          path: relativePath,
          size: entryStat.size,
          modifiedTime: entryStat.mtime.toISOString(),
        });
      } catch {
        // Skip entries we can't stat (broken symlinks, permission issues)
      }
    }

    // Sort: directories first, then alphabetically
    results.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return results;
  }

  /**
   * Read file content
   */
  async readFile(filePath: string): Promise<string> {
    const absolutePath = this.validatePath(filePath);

    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new Error('Path is not a file');
    }

    if (fileStat.size > MAX_FILE_SIZE) {
      throw new Error(`File too large (${(fileStat.size / 1024 / 1024).toFixed(2)}MB). Maximum size is 1MB`);
    }

    return fsReadFile(absolutePath, 'utf-8');
  }

  /**
   * Write file content
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const absolutePath = this.validatePath(filePath);

    // Create parent directories if needed
    const parentDir = dirname(absolutePath);
    await mkdir(parentDir, { recursive: true });

    await fsWriteFile(absolutePath, content, 'utf-8');
  }

  /**
   * Check if a path exists
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      const absolutePath = this.validatePath(filePath);
      await stat(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file/directory info
   */
  async getInfo(filePath: string): Promise<FileEntry> {
    const absolutePath = this.validatePath(filePath);
    const fileStat = await stat(absolutePath);
    const relativePath = relative(this.projectRoot, absolutePath);

    return {
      name: relativePath.split('/').pop() || relativePath,
      type: fileStat.isDirectory() ? 'directory' : 'file',
      path: relativePath,
      size: fileStat.size,
      modifiedTime: fileStat.mtime.toISOString(),
    };
  }
}

// Cache of FileOperations instances per project root
const instances: Map<string, FileOperations> = new Map();

export function getFileOperations(projectRoot: string): FileOperations {
  const resolved = resolve(projectRoot);
  let instance = instances.get(resolved);
  if (!instance) {
    instance = new FileOperations(resolved);
    instances.set(resolved, instance);
  }
  return instance;
}
