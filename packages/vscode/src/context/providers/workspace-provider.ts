import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import ignore, { Ignore } from 'ignore'
import { ignored_extensions } from '../constants/ignored-extensions'
import { format_token_count, should_ignore_file } from '../utils/extension-utils'
import { natural_sort } from '../../utils/natural-sort'
import { Logger } from '@/helpers/logger'
import { BATCH_SIZE } from '../constants/workspace-processing'

export class WorkspaceProvider
  implements vscode.TreeDataProvider<FileItem>, vscode.Disposable {
  private _on_did_change_tree_data: vscode.EventEmitter<
    FileItem | undefined | null | void
  > = new vscode.EventEmitter<FileItem | undefined | null | void>()
  readonly onDidChangeTreeData: vscode.Event<
    FileItem | undefined | null | void
  > = this._on_did_change_tree_data.event
  private workspace_roots: string[] = []
  private workspace_names: string[] = []
  private checked_items: Map<string, vscode.TreeItemCheckboxState> = new Map()
  private combined_gitignore: Ignore = ignore()
  private ignored_extensions_config: Set<string> = new Set() // From vscode settings
  private watcher: vscode.FileSystemWatcher
  private gitignore_watcher: vscode.FileSystemWatcher

  // Caching layers (Solution 3)
  private file_token_counts: Map<string, number> = new Map()
  private directory_token_counts_cache: Map<string, number | 'loading'> = new Map();
  private directory_selected_token_counts_cache: Map<string, number | 'loading'> = new Map();
  private directory_children_cache: Map<string, FileItem[]> = new Map();
  private directory_stats_cache: Map<string, fs.Stats> = new Map();
  private readdir_cache: Map<string, string[]> = new Map();

  private config_change_handler: vscode.Disposable
  private _on_did_change_checked_files = new vscode.EventEmitter<void>()
  readonly onDidChangeCheckedFiles = this._on_did_change_checked_files.event
  private opened_from_workspace_view: Set<string> = new Set()
  private preview_tabs: Map<string, boolean> = new Map()
  private tab_change_handler: vscode.Disposable
  private partially_checked_dirs: Set<string> = new Set()
  private file_workspace_map: Map<string, string> = new Map()

  private _is_initialized = false;
  private _initialization_promise: Promise<void>;
  private _initial_scan_progress?: vscode.Progress<{ message?: string; increment?: number }>;


  constructor(workspace_folders: vscode.WorkspaceFolder[]) {
    this.workspace_roots = workspace_folders.map((folder) => folder.uri.fsPath)
    this.workspace_names = workspace_folders.map((folder) => folder.name)

    this.load_ignored_extensions_from_config(); // Load initial ignored extensions

    this._initialization_promise = this._initialize_async().catch(error => {
      Logger.error({ function_name: 'WorkspaceProvider.constructor', message: 'Initialization failed', data: error });
      vscode.window.showErrorMessage('WorkspaceProvider initialization failed. Some features might not work correctly.');
    });

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*')
    this.watcher.onDidCreate(async (uri) => this.on_file_system_changed(uri.fsPath, 'create'))
    this.watcher.onDidChange(async (uri) => this.on_file_system_changed(uri.fsPath, 'change'))
    this.watcher.onDidDelete(async (uri) => this.on_file_system_changed(uri.fsPath, 'delete'))

    this.gitignore_watcher =
      vscode.workspace.createFileSystemWatcher('**/.gitignore')
    this.gitignore_watcher.onDidCreate(async () => this.load_all_gitignore_files())
    this.gitignore_watcher.onDidChange(async () => this.load_all_gitignore_files())
    this.gitignore_watcher.onDidDelete(async () => this.load_all_gitignore_files())

    this.config_change_handler = vscode.workspace.onDidChangeConfiguration(
      async (event) => {
        if (event.affectsConfiguration('codeWebChat.ignoredExtensions')) {
          const old_ignored_extensions = new Set(this.ignored_extensions_config)
          this.load_ignored_extensions_from_config()
          await this.uncheck_ignored_files(old_ignored_extensions)
          this.refresh()
        }
      }
    )
    this.update_preview_tabs_state()
    this.tab_change_handler = vscode.window.tabGroups.onDidChangeTabs((e) => {
      this.handle_tab_changes(e)
    })
  }

  private async _initialize_async(): Promise<void> {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Initializing Workspace Context...",
      cancellable: false
    }, async (progress) => {
      this._initial_scan_progress = progress;
      progress.report({ message: "Loading .gitignore files..." });
      await this.load_all_gitignore_files();
      progress.report({ message: "Mapping files to workspaces..." });
      await this.update_file_workspace_mapping();
      this._is_initialized = true;
      progress.report({ message: "Initialization complete." });
      this.refresh(); // Initial full refresh after initialization
    });
  }

  private async update_file_workspace_mapping(): Promise<void> {
    this.file_workspace_map.clear()
    for (const workspace_root of this.workspace_roots) {
      this._initial_scan_progress?.report({ message: `Scanning ${path.basename(workspace_root)}...` });
      try {
        // find_all_files will now internally use batching and cache
        const files = await this.find_all_files(workspace_root, workspace_root);
        for (const file of files) {
          this.file_workspace_map.set(file, workspace_root)
        }
      } catch (error) {
        Logger.error({
          function_name: 'update_file_workspace_mapping',
          message: `Error mapping files for workspace ${workspace_root}`,
          data: error
        })
      }
    }
  }

  public async find_all_files(dir_path: string, workspace_root_for_gitignore: string): Promise<string[]> {
    const results: string[] = [];
    const queue: string[] = [dir_path];
    let processed_count = 0;

    while (queue.length > 0) {
      const current_dir = queue.shift()!;

      // Check cache for readdir
      let entries;
      const cached_entries = this.readdir_cache.get(current_dir);
      if (cached_entries) {
        entries = cached_entries.map(name => ({ name, path: path.join(current_dir, name) }));
      } else {
        try {
          const raw_entries = await fs.promises.readdir(current_dir);
          this.readdir_cache.set(current_dir, raw_entries);
          entries = raw_entries.map(name => ({ name, path: path.join(current_dir, name) }));
        } catch (error) {
          Logger.warn({ function_name: 'find_all_files', message: `Cannot read dir ${current_dir}`, data: error });
          continue;
        }
      }

      for (const entry_obj of entries) {
        const full_path = entry_obj.path;
        const relative_path_for_exclusion = path.relative(workspace_root_for_gitignore, full_path);

        if (this.is_excluded(relative_path_for_exclusion)) {
          continue;
        }

        let stats;
        const cached_stats = this.directory_stats_cache.get(full_path);
        if (cached_stats) {
          stats = cached_stats;
        } else {
          try {
            stats = await fs.promises.lstat(full_path); // Use lstat to handle symlinks properly
            this.directory_stats_cache.set(full_path, stats);
          } catch (error) {
            Logger.warn({ function_name: 'find_all_files', message: `Cannot stat ${full_path}`, data: error });
            continue;
          }
        }

        if (stats.isDirectory()) {
          queue.push(full_path);
        } else if (stats.isFile()) {
          results.push(full_path);
          this.file_workspace_map.set(full_path, workspace_root_for_gitignore); // Update map here
        }

        processed_count++;
        if (processed_count % BATCH_SIZE === 0) {
          this._initial_scan_progress?.report({ message: `Scanning... Found ${results.length} files` });
          await new Promise(resolve => setTimeout(resolve, 0)); // Yield control
        }
      }
    }
    return results;
  }


  public get_workspace_root_for_file(file_path: string): string | undefined {
    if (this.file_workspace_map.has(file_path)) {
      return this.file_workspace_map.get(file_path)
    }
    let matching_root: string | undefined
    for (const root of this.workspace_roots) {
      if (file_path.startsWith(root)) {
        if (!matching_root || root.length > matching_root.length) {
          matching_root = root
        }
      }
    }
    if (matching_root) {
      this.file_workspace_map.set(file_path, matching_root);
    }
    return matching_root
  }

  private async uncheck_ignored_files(old_ignored_extensions?: Set<string>): Promise<void> {
    const checked_files = this.get_checked_files()
    const files_to_uncheck = checked_files.filter((file_path) => {
      const is_now_ignored = should_ignore_file(file_path, this.ignored_extensions_config);
      if (old_ignored_extensions) {
        return !should_ignore_file(file_path, old_ignored_extensions) && is_now_ignored;
      }
      return is_now_ignored;
    });

    for (const file_path of files_to_uncheck) {
      this.checked_items.set(file_path, vscode.TreeItemCheckboxState.Unchecked)
      let dir_path = path.dirname(file_path)
      const workspace_root = this.get_workspace_root_for_file(file_path)
      while (workspace_root && dir_path.startsWith(workspace_root)) {
        await this.update_parent_state(dir_path)
        dir_path = path.dirname(dir_path)
      }
    }
    if (files_to_uncheck.length > 0) {
      this._on_did_change_checked_files.fire()
    }
  }

  public dispose(): void {
    this.watcher.dispose()
    this.gitignore_watcher.dispose()
    this.config_change_handler.dispose()
    this._on_did_change_checked_files.dispose()
    if (this.tab_change_handler) {
      this.tab_change_handler.dispose()
    }
  }

  private update_preview_tabs_state(): void {
    this.preview_tabs.clear()
    vscode.window.tabGroups.all.forEach((tabGroup) => {
      tabGroup.tabs.forEach((tab) => {
        if (tab.input instanceof vscode.TabInputText) {
          this.preview_tabs.set(tab.input.uri.fsPath, !!tab.isPreview)
        }
      })
    })
  }

  private handle_tab_changes(e: vscode.TabChangeEvent): void {
    for (const tab of e.changed) {
      if (tab.input instanceof vscode.TabInputText) {
        const file_path = tab.input.uri.fsPath
        const was_preview = this.preview_tabs.get(file_path)
        const is_now_preview = !!tab.isPreview
        if (was_preview && !is_now_preview) {
          // File transitioned from preview to non-preview (e.g., was edited)
          // Potentially auto-check if settings allow, and if not ignored, etc.
        }
        this.preview_tabs.set(file_path, is_now_preview)
      }
    }
    for (const tab of e.opened) {
      if (tab.input instanceof vscode.TabInputText) {
        this.preview_tabs.set(tab.input.uri.fsPath, !!tab.isPreview)
      }
    }
    // Clean up closed tabs
    e.closed.forEach(tab => {
      if (tab.input instanceof vscode.TabInputText) {
        this.preview_tabs.delete(tab.input.uri.fsPath);
      }
    });
  }

  mark_opened_from_workspace_view(file_path: string): void {
    this.opened_from_workspace_view.add(file_path)
  }

  private get_open_editors(): vscode.Uri[] {
    const open_uris: vscode.Uri[] = []
    vscode.window.tabGroups.all.forEach((tabGroup) => {
      tabGroup.tabs.forEach((tab) => {
        if (tab.input instanceof vscode.TabInputText) {
          open_uris.push(tab.input.uri)
        }
      })
    })
    return open_uris
  }

  public getWorkspaceRoots(): string[] {
    return this.workspace_roots
  }
  public getWorkspaceRoot(): string {
    return this.workspace_roots.length > 0 ? this.workspace_roots[0] : ''
  }
  public getWorkspaceName(root_path: string): string {
    const index = this.workspace_roots.indexOf(root_path)
    if (index !== -1) {
      return this.workspace_names[index]
    }
    return path.basename(root_path)
  }

  private async on_file_system_changed(changed_file_path: string, event_type: 'create' | 'change' | 'delete'): Promise<void> {
    const normalized_changed_path = path.normalize(changed_file_path);

    // Invalidate stat cache for the changed path
    this.directory_stats_cache.delete(normalized_changed_path);

    // Invalidate readdir cache for the parent directory
    const parent_dir = path.dirname(normalized_changed_path);
    this.readdir_cache.delete(parent_dir);

    if (event_type === 'create' || event_type === 'delete') {
      // For create/delete, children of parent might change
      this.directory_children_cache.delete(parent_dir);
      // also file_workspace_map needs update
      await this.update_file_workspace_mapping();
    }
    if (event_type === 'change') {
      this.file_token_counts.delete(normalized_changed_path);
      // If a file changes, its directory's children list doesn't change, but token counts do.
    }
    if (event_type === 'delete') {
      this.file_token_counts.delete(normalized_changed_path);
      this.directory_token_counts_cache.delete(normalized_changed_path); // If it was a dir
      this.directory_selected_token_counts_cache.delete(normalized_changed_path); // If it was a dir
      this.directory_children_cache.delete(normalized_changed_path); // If it was a dir
    }

    // Recalculate token counts for all affected parent directories
    let current_dir_to_invalidate = event_type === 'change' ? parent_dir : normalized_changed_path;
    if (event_type === 'delete' && !fs.existsSync(current_dir_to_invalidate)) { // If the path itself was deleted
      current_dir_to_invalidate = parent_dir;
    }

    const workspace_root = this.get_workspace_root_for_file(normalized_changed_path);
    while (workspace_root && current_dir_to_invalidate.startsWith(workspace_root)) {
      this.directory_token_counts_cache.delete(current_dir_to_invalidate);
      this.directory_selected_token_counts_cache.delete(current_dir_to_invalidate);
      if (current_dir_to_invalidate === workspace_root) break; // Stop at workspace root
      current_dir_to_invalidate = path.dirname(current_dir_to_invalidate);
    }

    this.refresh();
    this._on_did_change_checked_files.fire();
  }


  public async refresh(element?: FileItem): Promise<void> {
    if (element) {
      // If refreshing a specific directory, clear its children cache
      this.directory_children_cache.delete(element.resourceUri.fsPath);
    } else {
      // Full refresh, potentially clear more global caches if necessary
      // For now, this is handled by on_file_system_changed more granularly
    }
    this._on_did_change_tree_data.fire(element);
  }


  clear_checks(): void {
    const open_files = new Set(this.get_open_editors().map((uri) => uri.fsPath))
    const new_checked_items = new Map<string, vscode.TreeItemCheckboxState>()
    for (const [path_key, state_val] of this.checked_items.entries()) {
      if (open_files.has(path_key)) {
        new_checked_items.set(path_key, state_val)
      }
    }
    this.checked_items = new_checked_items
    this.partially_checked_dirs.clear()
    this.directory_selected_token_counts_cache.clear();


    for (const file_path of open_files) {
      if (this.checked_items.has(file_path)) {
        let dir_path = path.dirname(file_path)
        const workspace_root = this.get_workspace_root_for_file(file_path)
        while (workspace_root && dir_path.startsWith(workspace_root)) {
          this.update_parent_state(dir_path)
          dir_path = path.dirname(dir_path)
        }
      }
    }
    this.refresh()
    this._on_did_change_checked_files.fire()
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    const key = element.resourceUri.fsPath
    element.checkboxState =
      this.checked_items.get(key) ?? vscode.TreeItemCheckboxState.Unchecked

    const total_token_count = element.tokenCount
    const selected_token_count = element.selectedTokenCount
    let display_description = ''

    if (element.isDirectory) {
      if (total_token_count === 'loading') {
        display_description = 'Loading…';
      } else if (total_token_count !== undefined && total_token_count > 0) {
        const formatted_total = format_token_count(total_token_count);
        if (selected_token_count === 'loading') {
          display_description = `${formatted_total} (Loading…)`;
        } else if (selected_token_count !== undefined && selected_token_count > 0 && selected_token_count < total_token_count) {
          const formatted_selected = format_token_count(selected_token_count);
          display_description = `${formatted_total} (${formatted_selected})`;
        } else if (selected_token_count === total_token_count && total_token_count > 0) {
          display_description = formatted_total + ' ✓';
        } else {
          display_description = formatted_total;
        }
      }
    } else { // File
      if (total_token_count === 'loading') {
        // display_description = 'Loading…'; // Usually files load tokens fast
      } else if (total_token_count !== undefined && total_token_count > 0 && element.checkboxState === vscode.TreeItemCheckboxState.Checked) {
        display_description = format_token_count(total_token_count);
      }
    }

    const trimmed_description = display_description.trim();
    element.description = trimmed_description === "" ? undefined : trimmed_description;

    const tooltip_parts = [element.resourceUri.fsPath];
    if (total_token_count !== undefined && total_token_count !== 'loading') {
      tooltip_parts.push(`Total: ${format_token_count(total_token_count)} tokens`);
    }
    if (element.isDirectory && selected_token_count !== undefined && selected_token_count !== 'loading' && selected_token_count > 0) {
      tooltip_parts.push(`Selected: ${format_token_count(selected_token_count)} tokens`);
    }
    element.tooltip = tooltip_parts.join(' - ');

    if (element.isWorkspaceRoot) {
      element.contextValue = 'workspaceRoot'
      element.iconPath = new vscode.ThemeIcon('root-folder')
      let root_tooltip = `${element.label} (Workspace Root)`
      if (total_token_count !== undefined && total_token_count !== 'loading') {
        root_tooltip += ` - Total: ${format_token_count(total_token_count)} tokens`
        if (selected_token_count !== undefined && selected_token_count !== 'loading' && selected_token_count > 0) {
          root_tooltip += `, Selected: ${format_token_count(selected_token_count)} tokens`
        }
      }
      element.tooltip = root_tooltip;
    }
    return element
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    if (!this._is_initialized) {
      // Optionally, return a placeholder item or wait for the promise
      await this._initialization_promise;
    }
    if (this.workspace_roots.length == 0) {
      return []
    }

    if (!element) { // Root level
      if (this.workspace_roots.length == 1) {
        return this.get_files_and_directories(this.workspace_roots[0], true); // true for is_top_level
      }
      return this.getWorkspaceFolderItems();
    }

    // Directory level (element is a directory)
    const dir_path = element.resourceUri.fsPath;
    if (this.directory_children_cache.has(dir_path)) {
      return this.directory_children_cache.get(dir_path)!;
    }

    const children = await this.get_files_and_directories(dir_path, false); // false for not is_top_level
    this.directory_children_cache.set(dir_path, children);

    // Update parent's token count now that children are loaded.
    // This will trigger a refresh for the parent item if its description changes.
    if (element.isDirectory) {
      const total_tokens = await this.calculate_directory_tokens(dir_path);
      const selected_tokens = await this._calculate_directory_selected_tokens(dir_path);
      if (element.tokenCount !== total_tokens || element.selectedTokenCount !== selected_tokens) {
        element.tokenCount = total_tokens;
        element.selectedTokenCount = selected_tokens;
        this._on_did_change_tree_data.fire(element); // Refresh the parent item itself
      }
    }
    return children;
  }

  private async getWorkspaceFolderItems(): Promise<FileItem[]> {
    const items: FileItem[] = []
    for (let i = 0; i < this.workspace_roots.length; i++) {
      const root = this.workspace_roots[i]
      const uri = vscode.Uri.file(root)
      const name = this.workspace_names[i]

      const total_tokens = await this.calculate_directory_tokens(root)
      const selected_tokens = await this._calculate_directory_selected_tokens(root)

      items.push(
        new FileItem(
          name, uri, vscode.TreeItemCollapsibleState.Collapsed,
          true, this.checked_items.get(root) ?? vscode.TreeItemCheckboxState.Unchecked,
          false, false, false,
          total_tokens, selected_tokens,
          undefined, true // isWorkspaceRoot
        )
      )
    }
    return items
  }

  private async calculate_file_tokens(file_path: string): Promise<number> {
    if (this.file_token_counts.has(file_path)) {
      return this.file_token_counts.get(file_path)!
    }
    try {
      const content = await fs.promises.readFile(file_path, 'utf8')
      const token_count = Math.floor(content.length / 4)
      this.file_token_counts.set(file_path, token_count)
      return token_count
    } catch (error) {
      Logger.warn({ function_name: 'calculate_file_tokens', message: `Error reading ${file_path}`, data: error });
      return 0
    }
  }

  private async calculate_directory_tokens(dir_path: string): Promise<number | 'loading'> {
    const cached_total = this.directory_token_counts_cache.get(dir_path);
    if (cached_total !== undefined) return cached_total;

    // If children are not loaded yet, mark as loading and initiate async calculation
    if (!this.directory_children_cache.has(dir_path) && !this.is_top_level_or_workspace_root(dir_path)) {
      this.directory_token_counts_cache.set(dir_path, 'loading');
      // No need to return 'loading' from here, getChildren will load it.
      // When getChildren loads it, it will call this function again.
    }

    let total_tokens = 0;
    try {
      const workspace_root = this.get_workspace_root_for_file(dir_path);
      if (!workspace_root) return 0;
      const relative_dir_path = path.relative(workspace_root, dir_path);
      if (this.is_excluded(relative_dir_path)) {
        this.directory_token_counts_cache.set(dir_path, 0);
        return 0;
      }

      const children = this.directory_children_cache.get(dir_path) || await this.get_files_and_directories(dir_path, false, true); // Pass true to indicate internal call

      for (const child of children) {
        if (child.isDirectory) {
          const child_tokens = await this.calculate_directory_tokens(child.resourceUri.fsPath);
          if (child_tokens === 'loading') return 'loading'; // Propagate loading state
          total_tokens += child_tokens;
        } else {
          total_tokens += await this.calculate_file_tokens(child.resourceUri.fsPath);
        }
      }
      this.directory_token_counts_cache.set(dir_path, total_tokens);
      return total_tokens;
    } catch (error) {
      Logger.error({ function_name: 'calculate_directory_tokens', message: `Error for ${dir_path}`, data: error });
      this.directory_token_counts_cache.set(dir_path, 0); // Cache 0 on error
      return 0;
    }
  }

  private async _calculate_directory_selected_tokens(dir_path: string): Promise<number | 'loading'> {
    const cached_selected = this.directory_selected_token_counts_cache.get(dir_path);
    if (cached_selected !== undefined) return cached_selected;

    // If children are not loaded yet for a non-top-level directory, mark as loading
    if (!this.directory_children_cache.has(dir_path) && !this.is_top_level_or_workspace_root(dir_path)) {
      this.directory_selected_token_counts_cache.set(dir_path, 'loading');
      // Similar to total tokens, getChildren will trigger the full calculation.
    }

    let selected_tokens = 0;
    try {
      const workspace_root = this.get_workspace_root_for_file(dir_path);
      if (!workspace_root) return 0;

      const children = this.directory_children_cache.get(dir_path) || await this.get_files_and_directories(dir_path, false, true); // internal call

      for (const child of children) {
        const child_path = child.resourceUri.fsPath;
        const checkbox_state = this.checked_items.get(child_path) ?? vscode.TreeItemCheckboxState.Unchecked;

        if (child.isDirectory) {
          if (checkbox_state === vscode.TreeItemCheckboxState.Checked) {
            const dir_total_tokens = await this.calculate_directory_tokens(child_path);
            if (dir_total_tokens === 'loading') return 'loading';
            selected_tokens += dir_total_tokens;
          } else if (this.partially_checked_dirs.has(child_path)) {
            const dir_selected_tokens = await this._calculate_directory_selected_tokens(child_path);
            if (dir_selected_tokens === 'loading') return 'loading';
            selected_tokens += dir_selected_tokens;
          }
        } else { // File
          if (checkbox_state === vscode.TreeItemCheckboxState.Checked) {
            selected_tokens += await this.calculate_file_tokens(child_path);
          }
        }
      }
      this.directory_selected_token_counts_cache.set(dir_path, selected_tokens);
      return selected_tokens;
    } catch (error) {
      Logger.error({ function_name: '_calculate_directory_selected_tokens', message: `Error for ${dir_path}`, data: error });
      this.directory_selected_token_counts_cache.set(dir_path, 0);
      return 0;
    }
  }

  private is_top_level_or_workspace_root(dir_path: string): boolean {
    if (this.workspace_roots.includes(dir_path)) return true; // It's a workspace root
    // Check if it's a direct child of any workspace root (top-level)
    for (const root of this.workspace_roots) {
      if (path.dirname(dir_path) === root) return true;
    }
    return false;
  }


  private async get_files_and_directories(dir_path: string, is_top_level: boolean, is_internal_call: boolean = false): Promise<FileItem[]> {
    const items: FileItem[] = []
    try {
      const workspace_root = this.get_workspace_root_for_file(dir_path);
      if (!workspace_root) return [];

      const relative_dir_path = path.relative(workspace_root, dir_path);
      if (dir_path !== workspace_root && this.is_excluded(relative_dir_path)) {
        return [];
      }

      let dir_entries_names = this.readdir_cache.get(dir_path);
      if (!dir_entries_names) {
        try {
          dir_entries_names = await fs.promises.readdir(dir_path);
          this.readdir_cache.set(dir_path, dir_entries_names);
        } catch (e) {
          Logger.warn({ function_name: "get_files_and_directories", message: `Cannot readdir ${dir_path}`, data: e });
          return [];
        }
      }

      const dir_entries_with_types = await Promise.all(dir_entries_names.map(async (name) => {
        const full_path = path.join(dir_path, name);
        let stats = this.directory_stats_cache.get(full_path);
        if (!stats) {
          try {
            stats = await fs.promises.lstat(full_path);
            this.directory_stats_cache.set(full_path, stats);
          } catch (e) {
            Logger.warn({ function_name: "get_files_and_directories", message: `Cannot lstat ${full_path}`, data: e });
            return null; // Skip if cannot stat
          }
        }
        return { name, stats, isDirectory: () => stats!.isDirectory(), isSymbolicLink: () => stats!.isSymbolicLink() };
      }));

      const valid_entries = dir_entries_with_types.filter(e => e !== null) as { name: string; stats: fs.Stats; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];


      valid_entries.sort((a, b) => {
        const a_is_dir = a.isDirectory() || a.isSymbolicLink()
        const b_is_dir = b.isDirectory() || b.isSymbolicLink()
        if (a_is_dir && !b_is_dir) return -1
        if (!a_is_dir && b_is_dir) return 1
        return natural_sort(a.name, b.name)
      });

      for (let i = 0; i < valid_entries.length; i++) {
        const entry = valid_entries[i];
        const full_path = path.join(dir_path, entry.name);
        const relative_path_for_exclusion = path.relative(workspace_root, full_path);

        if (this.is_excluded(relative_path_for_exclusion) ||
          (!entry.isDirectory() && should_ignore_file(entry.name, this.ignored_extensions_config))) {
          continue;
        }

        const uri = vscode.Uri.file(full_path);
        let is_directory = entry.isDirectory();
        const is_symbolic_link = entry.isSymbolicLink();

        if (is_symbolic_link) {
          try {
            const link_target_stats = await fs.promises.stat(full_path); // stat resolves symlink
            is_directory = link_target_stats.isDirectory();
          } catch { continue; /* broken symlink */ }
        }

        const checkbox_state = this.checked_items.get(full_path) ?? vscode.TreeItemCheckboxState.Unchecked;

        let token_count: number | 'loading' | undefined;
        let selected_token_count: number | 'loading' | undefined;

        if (is_directory) {
          token_count = is_top_level ? await this.calculate_directory_tokens(full_path) : 'loading';
          selected_token_count = is_top_level ? await this._calculate_directory_selected_tokens(full_path) : 'loading';
        } else {
          token_count = await this.calculate_file_tokens(full_path);
        }

        items.push(new FileItem(
          entry.name, uri,
          is_directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          is_directory, checkbox_state, false, is_symbolic_link, false,
          token_count, selected_token_count
        ));

        if (!is_internal_call && (i + 1) % BATCH_SIZE === 0) {
          this._on_did_change_tree_data.fire(); // Refresh partial tree
          await new Promise(resolve => setTimeout(resolve, 0)); // Yield control
        }
      }
    } catch (error) {
      Logger.error({ function_name: 'get_files_and_directories', message: `Error for ${dir_path}`, data: error });
    }
    if (!is_internal_call) this._on_did_change_tree_data.fire(); // Final refresh for the current level
    return items;
  }


  async update_check_state(
    item: FileItem,
    state: vscode.TreeItemCheckboxState
  ): Promise<void> {
    const key = item.resourceUri.fsPath
    if (item.isDirectory && this.partially_checked_dirs.has(key)) {
      state = vscode.TreeItemCheckboxState.Checked
      this.partially_checked_dirs.delete(key)
    }
    this.checked_items.set(key, state)
    this.directory_selected_token_counts_cache.delete(key);

    if (item.isDirectory) {
      await this.update_directory_check_state(key, state, false)
    }
    let dir_path = path.dirname(key)
    const workspace_root = this.get_workspace_root_for_file(key)
    while (workspace_root && dir_path.startsWith(workspace_root)) {
      this.directory_selected_token_counts_cache.delete(dir_path);
      await this.update_parent_state(dir_path)
      if (dir_path === workspace_root) break;
      dir_path = path.dirname(dir_path)
    }
    this._on_did_change_checked_files.fire()
    this.refresh(item) // Refresh only the affected item and its parents potentially
  }

  private async update_parent_state(dir_path: string): Promise<void> {
    this.directory_selected_token_counts_cache.delete(dir_path);
    try {
      const workspace_root = this.get_workspace_root_for_file(dir_path);
      if (!workspace_root) return;

      const relative_dir_path = path.relative(workspace_root, dir_path);
      if (this.is_excluded(relative_dir_path)) {
        this.checked_items.set(dir_path, vscode.TreeItemCheckboxState.Unchecked);
        this.partially_checked_dirs.delete(dir_path);
        return;
      }

      // Use cached children if available, otherwise fetch them (lightweight without deep recursion)
      const children = this.directory_children_cache.get(dir_path) || await this.get_files_and_directories(dir_path, false, true); // internal call
      if (!this.directory_children_cache.has(dir_path) && children.length > 0) {
        //this.directory_children_cache.set(dir_path, children); // Cache if fetched
      }


      let all_checked = true;
      let any_checked = false;
      let has_non_ignored_child = false;

      if (children.length === 0 && fs.existsSync(dir_path) && fs.lstatSync(dir_path).isDirectory()) {
        // Empty directory that is not excluded
        has_non_ignored_child = true; // Treat as having a "conceptual" child for check state logic
        all_checked = false; // An empty directory cannot be "all checked" in terms of content
        any_checked = false;
      } else {
        for (const child_item of children) {
          const child_path = child_item.resourceUri.fsPath;
          // No need to re-check exclusion, get_files_and_directories already filters
          has_non_ignored_child = true;
          const state = this.checked_items.get(child_path) ?? vscode.TreeItemCheckboxState.Unchecked;
          const is_child_dir_partially_checked = child_item.isDirectory && this.partially_checked_dirs.has(child_path);

          if (state !== vscode.TreeItemCheckboxState.Checked) all_checked = false;
          if (state === vscode.TreeItemCheckboxState.Checked || is_child_dir_partially_checked) any_checked = true;
        }
      }


      if (has_non_ignored_child) {
        if (all_checked) {
          this.checked_items.set(dir_path, vscode.TreeItemCheckboxState.Checked);
          this.partially_checked_dirs.delete(dir_path);
        } else if (any_checked) {
          this.checked_items.set(dir_path, vscode.TreeItemCheckboxState.Unchecked); // Parent is Unchecked
          this.partially_checked_dirs.add(dir_path); // But marked as partial
        } else {
          this.checked_items.set(dir_path, vscode.TreeItemCheckboxState.Unchecked);
          this.partially_checked_dirs.delete(dir_path);
        }
      } else { // No non-ignored children
        this.checked_items.set(dir_path, vscode.TreeItemCheckboxState.Unchecked);
        this.partially_checked_dirs.delete(dir_path);
      }
    } catch (error) {
      Logger.error({ function_name: 'update_parent_state', message: `Error for ${dir_path}`, data: error });
    }
  }


  private async update_directory_check_state(
    dir_path: string,
    state: vscode.TreeItemCheckboxState,
    parent_is_excluded: boolean
  ): Promise<void> {
    try {
      const workspace_root = this.get_workspace_root_for_file(dir_path);
      if (!workspace_root) return;

      const relative_dir_path = path.relative(workspace_root, dir_path);
      if (this.is_excluded(relative_dir_path) || parent_is_excluded) {
        return;
      }

      if (state == vscode.TreeItemCheckboxState.Checked) {
        this.partially_checked_dirs.delete(dir_path);
      }

      // Use cached children if available, otherwise fetch them
      const children = this.directory_children_cache.get(dir_path) || await this.get_files_and_directories(dir_path, false, true); // internal call
      if (!this.directory_children_cache.has(dir_path) && children.length > 0) {
        // this.directory_children_cache.set(dir_path, children); // Cache if fetched
      }


      for (const child_item of children) {
        const full_path = child_item.resourceUri.fsPath;
        // No need to re-check exclusion, get_files_and_directories already filters
        this.checked_items.set(full_path, state);
        if (child_item.isDirectory) {
          await this.update_directory_check_state(full_path, state, false);
        }
      }
    } catch (error) {
      Logger.error({ function_name: 'update_directory_check_state', message: `Error for ${dir_path}`, data: error });
    }
  }


  get_checked_files(): string[] {
    return Array.from(this.checked_items.entries())
      .filter(
        ([file_path, state]) => {
          if (state !== vscode.TreeItemCheckboxState.Checked) return false;
          try {
            if (!fs.existsSync(file_path)) return false;
            const stats = fs.lstatSync(file_path); // Use lstat to handle symlinks correctly
            if (!stats.isFile() && !stats.isSymbolicLink()) return false; // Ensure it's a file or a symlink (which might point to a file)

            // For symlinks, ensure it resolves to a file and is not a directory symlink checked as a file
            if (stats.isSymbolicLink()) {
              const targetStats = fs.statSync(file_path); // stat resolves symlink
              if (!targetStats.isFile()) return false;
            }

            const workspace_root = this.get_workspace_root_for_file(file_path);
            return workspace_root ? !this.is_excluded(path.relative(workspace_root, file_path)) : false;
          } catch (error) {
            Logger.warn({ function_name: 'get_checked_files', message: `Error stating file ${file_path}`, data: error });
            return false;
          }
        }
      )
      .map(([path_key, _]) => path_key)
  }

  public async set_checked_files(file_paths: string[]): Promise<void> {
    await this._initialization_promise;
    this.checked_items.clear();
    this.partially_checked_dirs.clear();
    this.directory_selected_token_counts_cache.clear();
    this.directory_children_cache.clear(); // Clear children cache as we are doing a full reset

    const paths_to_process_as_files: string[] = [];

    for (const file_path_str of file_paths) {
      const workspace_root = this.get_workspace_root_for_file(file_path_str);
      if (!workspace_root || this.is_excluded(path.relative(workspace_root, file_path_str))) {
        continue;
      }
      try {
        if (!fs.existsSync(file_path_str)) continue;
        const stats = await fs.promises.lstat(file_path_str);
        if (stats.isDirectory()) {
          this.checked_items.set(file_path_str, vscode.TreeItemCheckboxState.Checked);
          // For directories, we will lazy load and check children when expanded or if explicitly asked.
          // Mark directory as checked, its children will be processed on expansion.
          // We need to ensure its token count is updated.
          await this.calculate_directory_tokens(file_path_str); // Ensure its tokens are calculated/cached
          await this._calculate_directory_selected_tokens(file_path_str);

        } else { // Is a file or symlink to file
          paths_to_process_as_files.push(file_path_str);
        }
      } catch (e) {
        Logger.warn({ function_name: "set_checked_files", message: `Error processing path ${file_path_str}`, data: e });
      }
    }

    for (const file_path_str of paths_to_process_as_files) {
      this.checked_items.set(file_path_str, vscode.TreeItemCheckboxState.Checked);
    }

    // Update parent states for all uniquely affected parent directories
    const unique_parent_dirs = new Set<string>();
    for (const file_path_str of [...paths_to_process_as_files, ...file_paths.filter(p => fs.existsSync(p) && fs.lstatSync(p).isDirectory())]) {
      let dir_path = path.dirname(file_path_str);
      const workspace_root = this.get_workspace_root_for_file(file_path_str);
      while (workspace_root && dir_path.startsWith(workspace_root)) {
        unique_parent_dirs.add(dir_path);
        if (dir_path === workspace_root) break;
        dir_path = path.dirname(dir_path);
      }
    }
    for (const dir_to_update of Array.from(unique_parent_dirs).sort((a, b) => b.length - a.length)) { // Deepest first
      await this.update_parent_state(dir_to_update);
    }

    this.refresh(); // Refresh the entire tree
    this._on_did_change_checked_files.fire();
  }

  private async load_all_gitignore_files(): Promise<void> {
    this.combined_gitignore = ignore()
    try {
      const gitignore_files = await vscode.workspace.findFiles('**/.gitignore');
      for (const file_uri of gitignore_files) {
        const gitignore_path = file_uri.fsPath;
        const workspace_root = this.get_workspace_root_for_file(gitignore_path);
        if (!workspace_root) continue;

        const relative_gitignore_dir = path.relative(workspace_root, path.dirname(gitignore_path));
        try {
          const gitignore_content = await fs.promises.readFile(gitignore_path, 'utf-8');
          const rules_with_prefix = gitignore_content
            .split('\n')
            .map((rule) => rule.trim())
            .filter((rule) => rule && !rule.startsWith('#'))
            .map((rule) => {
              // Ensure that rules like '/dist' apply from the .gitignore's directory, not workspace root
              const rule_path = rule.startsWith('/') ? rule.substring(1) : rule;
              return path.posix.join(relative_gitignore_dir, rule_path);
            });
          this.combined_gitignore.add(rules_with_prefix);
        } catch (error) {
          Logger.warn({ function_name: 'load_all_gitignore_files', message: `Error reading ${gitignore_path}`, data: error });
        }
      }
    } catch (error) {
      Logger.error({ function_name: 'load_all_gitignore_files', message: `Error finding .gitignore files`, data: error });
    }

    this.combined_gitignore.add(['.git/', 'node_modules/']); // Default global ignores

    // Clear all caches that depend on gitignore rules
    this.file_token_counts.clear();
    this.directory_token_counts_cache.clear();
    this.directory_selected_token_counts_cache.clear();
    this.directory_children_cache.clear();
    this.readdir_cache.clear();
    this.directory_stats_cache.clear();

    this.refresh();
  }

  public is_excluded(relative_path_from_ws_root: string): boolean {
    if (!this._is_initialized) return false;
    if (!relative_path_from_ws_root || relative_path_from_ws_root.trim() === '') return false;

    // Normalize to POSIX separators for ignore package
    const posix_relative_path = relative_path_from_ws_root.split(path.sep).join(path.posix.sep);

    if (posix_relative_path.split(path.posix.sep).some((part) => part == '.git')) {
      return true
    }
    return this.combined_gitignore.ignores(posix_relative_path)
  }

  private load_ignored_extensions_from_config() {
    const config = vscode.workspace.getConfiguration('codeWebChat')
    const additional_extensions = config
      .get<string[]>('ignoredExtensions', [])
      .map((ext) => ext.toLowerCase().replace(/^\./, ''))
    this.ignored_extensions_config = new Set([
      ...ignored_extensions, // Assuming ignored_extensions is your hardcoded set
      ...additional_extensions
    ])
    // Clear caches that depend on ignored extensions
    this.file_token_counts.clear();
    this.directory_token_counts_cache.clear();
    this.directory_selected_token_counts_cache.clear();
    // directory_children_cache might also need clearing if ignored extensions affect listings
  }

  public async check_all(): Promise<void> {
    await this._initialization_promise;
    for (const workspace_root of this.workspace_roots) {
      this.checked_items.set(workspace_root, vscode.TreeItemCheckboxState.Checked);
      this.partially_checked_dirs.delete(workspace_root);
      this.directory_selected_token_counts_cache.delete(workspace_root);
      // For top-level items, they are already loaded or will be loaded by getChildren.
      // We rely on update_directory_check_state to propagate checks downwards if children are loaded.
      // If children are not loaded (lazy loading), they will inherit check state upon expansion.
      await this.update_directory_check_state(workspace_root, vscode.TreeItemCheckboxState.Checked, false);
    }
    this.refresh();
    this._on_did_change_checked_files.fire();
  }

  public async get_checked_files_token_count(): Promise<number> {
    await this._initialization_promise;
    const checked_files = this.get_checked_files() // This gets individual files
    let total_tokens = 0;

    for (const file_path of checked_files) {
      total_tokens += await this.calculate_file_tokens(file_path);
    }

    // Add tokens from fully checked directories that are not yet expanded but are marked checked
    for (const [item_path, state] of this.checked_items) {
      if (state === vscode.TreeItemCheckboxState.Checked && fs.existsSync(item_path) && fs.lstatSync(item_path).isDirectory()) {
        if (!this.partially_checked_dirs.has(item_path)) { // Only if fully checked, not partial
          // Avoid double counting files already processed via get_checked_files
          // This logic assumes get_checked_files returns only files, not dirs.
          // If a directory is checked, its files are implicitly checked.
          // We need a more robust way to sum tokens from checked items (files and directories).
          // For now, let's rely on _calculate_directory_selected_tokens for workspace roots.
        }
      }
    }

    // A more accurate way for the badge might be to sum selected tokens of workspace roots
    let badge_total = 0;
    for (const root of this.workspace_roots) {
      const root_selected_tokens = await this._calculate_directory_selected_tokens(root);
      if (root_selected_tokens !== 'loading') {
        badge_total += root_selected_tokens;
      }
      // If a root is fully checked, add its total tokens
      else if (this.checked_items.get(root) === vscode.TreeItemCheckboxState.Checked) {
        const root_total_tokens = await this.calculate_directory_tokens(root);
        if (root_total_tokens !== 'loading') badge_total += root_total_tokens;
      }
    }
    return badge_total > 0 ? badge_total : total_tokens; // Prefer badge_total if available
  }
}

export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    public collapsibleState: vscode.TreeItemCollapsibleState,
    public isDirectory: boolean,
    public checkboxState: vscode.TreeItemCheckboxState,
    public isGitIgnored: boolean, // Retained for potential future use, though currently filtered out
    public isSymbolicLink: boolean = false,
    public isOpenFile: boolean = false, // Not directly used by WorkspaceProvider but good for consistency
    public tokenCount?: number | 'loading',
    public selectedTokenCount?: number | 'loading',
    description?: string,
    public isWorkspaceRoot: boolean = false
  ) {
    super(label, collapsibleState)
    this.tooltip = this.resourceUri.fsPath
    this.description = description

    if (this.isWorkspaceRoot) {
      this.iconPath = new vscode.ThemeIcon('root-folder')
      this.contextValue = 'workspaceRoot'
    } else if (this.isDirectory) {
      this.iconPath = new vscode.ThemeIcon('folder')
      this.contextValue = 'directory'
    } else {
      this.iconPath = new vscode.ThemeIcon('file')
      this.command = {
        command: 'codeWebChat.openFileFromWorkspace',
        title: 'Open File',
        arguments: [this.resourceUri]
      }
    }
    this.checkboxState = checkboxState;
  }
}
