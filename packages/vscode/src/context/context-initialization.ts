import * as vscode from 'vscode'
import { WorkspaceProvider } from './providers/workspace-provider'
import { FileItem } from './providers/workspace-provider'
import { FilesCollector } from '../helpers/files-collector'
import { OpenEditorsProvider } from './providers/open-editors-provider'
import { WebsitesProvider, WebsiteItem } from './providers/websites-provider'
import { SharedFileState } from './shared-file-state'
import { marked } from 'marked'
import { EventEmitter } from 'events'
import { select_saved_context_command } from '../commands/select-saved-context-command'

export const token_count_emitter = new EventEmitter()

export function context_initialization(context: vscode.ExtensionContext): {
  workspace_provider?: WorkspaceProvider
  open_editors_provider?: OpenEditorsProvider
  websites_provider?: WebsitesProvider
} {
  const workspace_folders = vscode.workspace.workspaceFolders

  let workspace_provider: WorkspaceProvider | undefined
  let workspace_view: vscode.TreeView<FileItem>

  if (!workspace_folders) {
    vscode.window.showInformationMessage(
      'Please open a project to use CWC.'
    )
    return {}
  }

  workspace_provider = new WorkspaceProvider(workspace_folders as any)
  const open_editors_provider = new OpenEditorsProvider(
    workspace_folders as any
  )
  const websites_provider = new WebsitesProvider()

  const websites_view = vscode.window.createTreeView(
    'codeWebChatViewWebsites',
    {
      treeDataProvider: websites_provider,
      manageCheckboxStateManually: true
    }
  )
  context.subscriptions.push(websites_provider, websites_view)

  const files_collector = new FilesCollector(
    workspace_provider,
    open_editors_provider,
    websites_provider
  )

  const update_activity_bar_badge_token_count = async () => {
    let total_token_count = 0;
    let is_loading = false;

    if (workspace_provider) {
      const ws_tokens = await workspace_provider.get_checked_files_token_count();
      if (ws_tokens === undefined) { // assuming 'loading' is represented by undefined or a specific string
          is_loading = true;
      } else {
          total_token_count += ws_tokens;
      }
    }

    if (websites_provider) {
      // Assuming get_checked_websites_token_count is synchronous or we make it async
      const web_tokens = websites_provider.get_checked_websites_token_count();
      total_token_count += web_tokens; // Add if not 'loading'
    }
    
    if (workspace_view) {
        if (is_loading && total_token_count === 0) { // Show loading only if truly no tokens AND some are loading
             workspace_view.badge = {
                value: 0, // Or a spinner icon if supported, e.g. $(loading) if that works for badges
                tooltip: 'Calculating total tokens...'
            };
        } else {
            workspace_view.badge = {
                value: total_token_count,
                tooltip: total_token_count
                ? `About ${total_token_count} tokens in context${is_loading ? ' (still calculating some...)' : ''}`
                : (is_loading ? 'Calculating tokens...' : '')
            };
        }
    }
    token_count_emitter.emit('token-count-updated')
  }

  websites_view.onDidChangeCheckboxState(async (e) => {
    for (const [item, state] of e.items) {
      await websites_provider!.update_check_state(item as WebsiteItem, state)
    }
    update_activity_bar_badge_token_count()
  })

  const shared_state = SharedFileState.getInstance()
  shared_state.setProviders(workspace_provider, open_editors_provider)
  context.subscriptions.push({
    dispose: () => shared_state.dispose()
  })

  const register_workspace_view_handlers = (
    view: vscode.TreeView<FileItem>
  ) => {
    view.onDidChangeCheckboxState(async (e) => {
      for (const [item, state] of e.items) {
        await workspace_provider!.update_check_state(item, state)
      }
      // update_activity_bar_badge_token_count(); // Covered by onDidChangeCheckedFiles
    })
    view.onDidCollapseElement(async (e) => { // Added async here
      // No specific refresh needed on collapse for lazy loading, expansion handles it.
      // However, if token display needs update based on collapse, that logic would go here.
    })
    view.onDidExpandElement(async (e) => {
        // When an element is expanded, its children are fetched by getChildren.
        // We might want to trigger a token recalculation for the expanded element
        // if its token count was previously 'loading' or an estimate.
        if (e.element.isDirectory) {
             await workspace_provider!.refresh(e.element); // Refresh the expanded item to update its description
        }
    });
  }

  workspace_view = vscode.window.createTreeView('codeWebChatViewWorkspace', {
    treeDataProvider: workspace_provider,
    manageCheckboxStateManually: true
  })
  register_workspace_view_handlers(workspace_view)

  const open_editors_view = vscode.window.createTreeView(
    'codeWebChatViewOpenEditors',
    {
      treeDataProvider: open_editors_provider,
      manageCheckboxStateManually: true
    }
  )

  context.subscriptions.push(
    workspace_provider,
    open_editors_provider,
    workspace_view,
    open_editors_view
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('codeWebChat.copyContext', async () => {
      let context_text = ''
      try {
        context_text = await files_collector.collect_files()
      } catch (error: any) {
        console.error('Error collecting files and websites:', error)
        vscode.window.showErrorMessage(
          'Error collecting files and websites: ' + error.message
        )
        return
      }
      if (context_text == '') {
        vscode.window.showWarningMessage(
          'No files or websites selected or open.'
        )
        return
      }
      context_text = `<files>\n${context_text}</files>\n`
      await vscode.env.clipboard.writeText(context_text)
      vscode.window.showInformationMessage(`Context copied to clipboard.`)
    }),
    vscode.commands.registerCommand('codeWebChat.collapseFolders', async () => {
      // This command might need to be rethought with lazy loading.
      // For now, it will dispose and recreate the view, which effectively collapses all.
      workspace_view.dispose() 
      await new Promise(resolve => setTimeout(resolve, 0)); // Ensure disposal completes
      workspace_view = vscode.window.createTreeView(
        'codeWebChatViewWorkspace',
        {
          treeDataProvider: workspace_provider!,
          manageCheckboxStateManually: true
        }
      )
      register_workspace_view_handlers(workspace_view)
      context.subscriptions.push(workspace_view)
    }),
    vscode.commands.registerCommand('codeWebChat.clearChecks', () => {
      workspace_provider!.clear_checks()
    }),
    vscode.commands.registerCommand('codeWebChat.checkAll', async () => {
      await workspace_provider!.check_all()
    }),
    vscode.commands.registerCommand(
      'codeWebChat.clearChecksOpenEditors',
      () => {
        open_editors_provider!.clear_checks()
      }
    ),
    vscode.commands.registerCommand(
      'codeWebChat.checkAllOpenEditors',
      async () => {
        await open_editors_provider!.check_all()
      }
    ),
    vscode.commands.registerCommand(
      'codeWebChat.previewWebsite',
      async (website: WebsiteItem) => {
        const panel = vscode.window.createWebviewPanel(
          'websitePreview',
          website.title,
          vscode.ViewColumn.One,
          { enableScripts: false }
        )
        const rendered_content = marked.parse(website.content)
        panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>${website.title}</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.4; max-width: 700px; margin: 0 auto; padding: 40px; color: var(--vscode-editor-foreground); }
                body > *:first-child { margin-top: 0; }
                body > *:last-child { margin-bottom: 0; }
                h1 { color: var(--vscode-editor-foreground); }
                a { color: var(--vscode-textLink-foreground); }
                hr { height: 1px; border: none; background-color: var(--vscode-editor-foreground); }
              </style>
            </head>
            <body>
              <h1>${website.title}</h1>
              <p>🔗 <a href="${website.url}" target="_blank">${website.url}</a></p>
              <hr>
              <div>${rendered_content}</div>
            </body>
            </html>
          `
      }
    ),
    select_saved_context_command(
      workspace_provider,
      () => {
        update_activity_bar_badge_token_count()
      },
      context
    )
  )

  open_editors_view.onDidChangeCheckboxState(async (e) => {
    for (const [item, state] of e.items) {
      await open_editors_provider!.update_check_state(item, state)
    }
    // update_activity_bar_badge_token_count(); // Covered by onDidChangeCheckedFiles
  })

  context.subscriptions.push(
    workspace_provider.onDidChangeCheckedFiles(() => {
      update_activity_bar_badge_token_count()
    }),
    open_editors_provider.onDidChangeCheckedFiles(() => {
      update_activity_bar_badge_token_count()
    }),
    websites_provider.onDidChangeCheckedWebsites(() => {
      update_activity_bar_badge_token_count()
    }),
    websites_provider.onDidChangeTreeData(() => {
      update_activity_bar_badge_token_count()
    })
  )

  let tab_change_timeout: NodeJS.Timeout | null = null
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (tab_change_timeout) {
        clearTimeout(tab_change_timeout)
      }
      tab_change_timeout = setTimeout(() => {
        update_activity_bar_badge_token_count()
        tab_change_timeout = null
      }, 100)
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      if (vscode.workspace.workspaceFolders) {
        const new_workspace_provider = new WorkspaceProvider(
          vscode.workspace.workspaceFolders as any
        )
        if (workspace_provider) {
          const checked_files = workspace_provider.get_checked_files()
          workspace_provider.dispose()
          workspace_provider = new_workspace_provider
          if (checked_files.length > 0) {
            await workspace_provider.set_checked_files(checked_files)
          }
        } else {
          workspace_provider = new_workspace_provider
        }

        const old_view = workspace_view
        workspace_view = vscode.window.createTreeView(
          'codeWebChatViewWorkspace',
          {
            treeDataProvider: workspace_provider,
            manageCheckboxStateManually: true
          }
        )
        register_workspace_view_handlers(workspace_view)
        old_view.dispose()
        context.subscriptions.push(workspace_view)

        if (open_editors_provider) {
          shared_state.setProviders(workspace_provider, open_editors_provider)
        }
        update_activity_bar_badge_token_count()
      }
    })
  )

  context.subscriptions.push(
    open_editors_provider.onDidChangeTreeData(() => {
      if (open_editors_provider!.is_initialized()) {
        update_activity_bar_badge_token_count()
      }
    })
  )

  // Initial badge update
  setTimeout(() => {
    update_activity_bar_badge_token_count()
  }, 1000) 

  return {
    workspace_provider,
    open_editors_provider,
    websites_provider
  }
}
