import simpleGit, { SimpleGit, StatusResult } from 'simple-git';

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}

export class GitOperations {
  private git: SimpleGit;

  constructor(projectRoot: string) {
    this.git = simpleGit(projectRoot);
  }

  /**
   * Check if the project is a git repository
   */
  async isRepo(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get git status
   */
  async getStatus(): Promise<GitStatus> {
    const isRepo = await this.isRepo();
    if (!isRepo) {
      return {
        isRepo: false,
        branch: '',
        staged: [],
        unstaged: [],
        untracked: [],
        ahead: 0,
        behind: 0,
      };
    }

    const status: StatusResult = await this.git.status();

    // Get staged files (index changes)
    const staged = [
      ...status.created,
      ...status.staged,
      ...status.renamed.map(r => r.to),
      ...status.deleted.filter(f => status.staged.includes(f) || !status.not_added.includes(f)),
    ].filter((v, i, a) => a.indexOf(v) === i); // Dedupe

    // Get unstaged files (working directory changes)
    const unstaged = [
      ...status.modified.filter(f => !status.staged.includes(f)),
      ...status.deleted.filter(f => !staged.includes(f)),
    ].filter((v, i, a) => a.indexOf(v) === i); // Dedupe

    // Get untracked files
    const untracked = status.not_added;

    return {
      isRepo: true,
      branch: status.current || 'HEAD',
      staged,
      unstaged,
      untracked,
      ahead: status.ahead,
      behind: status.behind,
    };
  }

  /**
   * Stage files
   */
  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git.add(paths);
  }

  /**
   * Unstage files
   */
  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git.reset(['HEAD', '--', ...paths]);
  }

  /**
   * Commit staged changes
   */
  async commit(message: string): Promise<string> {
    if (!message.trim()) {
      throw new Error('Commit message cannot be empty');
    }
    const result = await this.git.commit(message);
    return result.commit;
  }

  /**
   * Get diff for a file (unstaged changes)
   */
  async diff(path: string): Promise<string> {
    const result = await this.git.diff([path]);
    return result;
  }

  /**
   * Get line-level diff info for a file vs HEAD
   * Returns arrays of line numbers that are added, modified, or deleted
   */
  async getLineDiff(path: string): Promise<{ added: number[]; modified: number[]; deleted: number[] }> {
    try {
      // Get diff vs HEAD (includes both staged and unstaged)
      const result = await this.git.diff(['HEAD', '--', path]);

      if (!result) {
        return { added: [], modified: [], deleted: [] };
      }

      const addedSet = new Set<number>();
      const deletedSet = new Set<number>();

      // Parse unified diff format
      const lines = result.split('\n');
      let currentLine = 0;
      let pendingDeletes = 0; // Track consecutive deletes to pair with adds

      for (const line of lines) {
        // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          currentLine = parseInt(hunkMatch[1], 10);
          pendingDeletes = 0;
          continue;
        }

        // Skip diff header lines
        if (line.startsWith('diff ') || line.startsWith('index ') ||
            line.startsWith('--- ') || line.startsWith('+++ ')) {
          continue;
        }

        // Deleted line - track it but don't advance line number
        if (line.startsWith('-')) {
          pendingDeletes++;
        }
        // Added line
        else if (line.startsWith('+')) {
          // This is a new/modified line in the current file
          addedSet.add(currentLine);
          if (pendingDeletes > 0) {
            pendingDeletes--;
          }
          currentLine++;
        }
        // Context line
        else if (line.startsWith(' ')) {
          // If we had pending deletes without matching adds, mark deletion point
          if (pendingDeletes > 0) {
            deletedSet.add(currentLine);
            pendingDeletes = 0;
          }
          currentLine++;
        }
      }

      // Handle trailing deletes at end of hunk
      if (pendingDeletes > 0) {
        deletedSet.add(currentLine);
      }

      return {
        added: Array.from(addedSet),
        modified: [],
        deleted: Array.from(deletedSet),
      };
    } catch {
      return { added: [], modified: [], deleted: [] };
    }
  }

  /**
   * Get diff for staged changes
   */
  async diffStaged(path?: string): Promise<string> {
    const args = ['--cached'];
    if (path) args.push(path);
    const result = await this.git.diff(args);
    return result;
  }

  /**
   * Get log of recent commits
   */
  async log(maxCount: number = 10): Promise<Array<{ hash: string; message: string; date: string; author: string }>> {
    const result = await this.git.log({ maxCount });
    return result.all.map(commit => ({
      hash: commit.hash,
      message: commit.message,
      date: commit.date,
      author: commit.author_name,
    }));
  }

  /**
   * Discard changes to a file
   */
  async discardChanges(path: string): Promise<void> {
    await this.git.checkout(['--', path]);
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(): Promise<string> {
    const result = await this.git.branch();
    return result.current;
  }

  /**
   * Get list of branches
   */
  async getBranches(): Promise<{ current: string; all: string[] }> {
    const result = await this.git.branch();
    return {
      current: result.current,
      all: result.all,
    };
  }

  /**
   * Check if a remote exists
   */
  async hasRemote(remote: string = 'origin'): Promise<boolean> {
    try {
      const remotes = await this.git.getRemotes();
      return remotes.some(r => r.name === remote);
    } catch {
      return false;
    }
  }

  /**
   * Push to remote
   */
  async push(remote: string = 'origin', branch?: string): Promise<void> {
    // Check if remote exists first
    const hasRemote = await this.hasRemote(remote);
    if (!hasRemote) {
      throw new Error(`No remote '${remote}' configured. Add one with: git remote add ${remote} <url>`);
    }

    const currentBranch = branch || await this.getCurrentBranch();
    try {
      await this.git.push(remote, currentBranch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Make common errors more user-friendly
      if (message.includes('Could not read from remote repository')) {
        throw new Error(`Cannot connect to remote '${remote}'. Check your SSH keys or repository URL.`);
      }
      if (message.includes('rejected') && message.includes('non-fast-forward')) {
        throw new Error(`Push rejected: remote has changes you don't have. Pull first, then push.`);
      }
      throw err;
    }
  }

  /**
   * Pull from remote
   */
  async pull(remote: string = 'origin', branch?: string): Promise<void> {
    // Check if remote exists first
    const hasRemote = await this.hasRemote(remote);
    if (!hasRemote) {
      throw new Error(`No remote '${remote}' configured. Add one with: git remote add ${remote} <url>`);
    }

    const currentBranch = branch || await this.getCurrentBranch();
    try {
      await this.git.pull(remote, currentBranch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Make common errors more user-friendly
      if (message.includes('Could not read from remote repository')) {
        throw new Error(`Cannot connect to remote '${remote}'. Check your SSH keys or repository URL.`);
      }
      if (message.includes('CONFLICT')) {
        throw new Error(`Pull failed: merge conflicts detected. Resolve conflicts manually.`);
      }
      if (message.includes('local changes')) {
        throw new Error(`Pull failed: you have uncommitted changes. Commit or stash them first.`);
      }
      throw err;
    }
  }
}

// Cache instances by path
const instances = new Map<string, GitOperations>();

export function getGitOperations(projectRoot: string): GitOperations {
  let instance = instances.get(projectRoot);
  if (!instance) {
    instance = new GitOperations(projectRoot);
    instances.set(projectRoot, instance);
  }
  return instance;
}
