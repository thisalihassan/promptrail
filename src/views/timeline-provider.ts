import * as vscode from "vscode";
import type { TimelineMessage } from "../models/types";
import type { Tracker } from "../core/tracker";

export class TimelineProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "promptrail.timeline";
  private view?: vscode.WebviewView;
  private tracker: Tracker;

  constructor(
    private readonly extensionUri: vscode.Uri,
    tracker: Tracker
  ) {
    this.tracker = tracker;
    this.tracker.onDidChange(() => this.refresh());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((msg: TimelineMessage) => {
      this.handleMessage(msg);
    });
  }

  refresh(): void {
    if (!this.view) return;
    const tasks = this.tracker.getTasks();
    const activeId = this.tracker.getActiveTaskId();
    this.view.webview.postMessage({
      type: "updateState",
      tasks,
      activeTaskId: activeId,
    });
  }

  private async handleMessage(msg: TimelineMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.refresh();
        break;
      case "refresh":
        this.tracker.refresh();
        break;
      case "rollback":
        if (msg.taskId) {
          vscode.commands.executeCommand("promptrail.rollbackToTask", msg.taskId, "selective");
        }
        break;
      case "hardRollback":
        if (msg.taskId) {
          vscode.commands.executeCommand("promptrail.rollbackToTask", msg.taskId, "hard");
        }
        break;
      case "viewDiff":
        if (msg.taskId) {
          vscode.commands.executeCommand("promptrail.viewTaskDiff", msg.taskId);
        }
        break;
    }
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 0;
  }

  .header {
    padding: 10px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--vscode-editorWidget-border);
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background);
    z-index: 10;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .header h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
    color: var(--vscode-sideBarSectionHeader-foreground);
  }

  .session-count {
    font-size: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 0 5px;
    border-radius: 8px;
    font-weight: 600;
  }

  .toolbar {
    padding: 6px 14px;
    border-bottom: 1px solid var(--vscode-editorWidget-border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .search-input {
    width: 100%;
    padding: 4px 8px;
    font-size: 12px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    font-family: var(--vscode-font-family);
    outline: none;
  }

  .search-input:focus {
    border-color: var(--vscode-focusBorder);
  }

  .search-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  .filter-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .filter-toggle {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border: 1px solid var(--vscode-checkbox-border, var(--vscode-input-border));
    border-radius: 3px;
    background: var(--vscode-checkbox-background, var(--vscode-input-background));
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
  }

  .filter-toggle:checked {
    background: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder));
    border-color: var(--vscode-checkbox-selectBorder, var(--vscode-focusBorder));
  }

  .filter-toggle:checked::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 0px;
    width: 5px;
    height: 8px;
    border: solid var(--vscode-checkbox-foreground, #fff);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }

  .filter-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    user-select: none;
  }

  .filter-row-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .filter-select {
    font-size: 11px;
    padding: 2px 4px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    font-family: var(--vscode-font-family);
    outline: none;
    cursor: pointer;
  }

  .filter-select:focus {
    border-color: var(--vscode-focusBorder);
  }

  .empty-state {
    text-align: center;
    padding: 32px 16px;
    color: var(--vscode-descriptionForeground);
  }

  .empty-state h3 {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--vscode-foreground);
  }

  .empty-state p {
    font-size: 12px;
    line-height: 1.6;
  }

  .task-list {
    padding: 6px 0;
  }

  .source-group {
    margin-bottom: 2px;
  }

  .source-header {
    padding: 6px 14px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
  }

  .source-header:hover {
    color: var(--vscode-foreground);
  }

  .chevron {
    display: inline-block;
    width: 16px;
    text-align: center;
    font-size: 10px;
    transition: transform 0.15s;
    flex-shrink: 0;
  }

  .source-group.collapsed .chevron {
    transform: rotate(-90deg);
  }

  .source-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .source-dot.claude { background: var(--vscode-charts-orange); }
  .source-dot.cursor { background: var(--vscode-charts-blue); }
  .source-dot.vscode { background: var(--vscode-charts-green); }

  .source-label {
    flex: 1;
  }

  .group-count {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 0 4px;
    border-radius: 6px;
    font-weight: 600;
  }

  .source-tasks {
    overflow: hidden;
  }

  .source-group.collapsed .source-tasks {
    display: none;
  }

  .task-item {
    padding: 8px 14px 8px 24px;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 0.1s;
    position: relative;
  }

  .task-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .task-item::before {
    content: '';
    position: absolute;
    left: 9px;
    top: 15px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-editorWidget-border);
  }

  .task-item.has-files::before {
    background: var(--vscode-charts-green);
  }

  .task-item.active::before {
    background: var(--vscode-charts-blue);
    box-shadow: 0 0 4px var(--vscode-charts-blue);
  }

  .task-prompt {
    font-size: 12px;
    line-height: 1.4;
    font-weight: 500;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }

  .task-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }

  .file-count {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .file-count.has-files {
    color: var(--vscode-charts-green);
    font-weight: 600;
  }

  .model-badge, .mode-badge {
    font-size: 9px;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    opacity: 0.7;
  }

  .task-expanded {
    display: none;
    padding: 6px 0 2px;
  }

  .task-item.expanded .task-expanded {
    display: block;
  }

  .task-item.expanded .task-prompt {
    -webkit-line-clamp: unset;
  }

  .file-list {
    list-style: none;
    margin: 4px 0;
  }

  .file-list li {
    font-size: 11px;
    padding: 2px 0;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-descriptionForeground);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .file-list li::before {
    content: '';
    width: 4px;
    height: 4px;
    border-radius: 1px;
    background: var(--vscode-charts-green);
    flex-shrink: 0;
  }

  .task-actions {
    display: flex;
    gap: 4px;
    margin-top: 6px;
  }

  .action-btn {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 3px;
    border: 1px solid var(--vscode-button-secondaryBackground);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    font-family: var(--vscode-font-family);
    transition: background 0.1s;
  }

  .action-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .action-btn.danger {
    color: var(--vscode-errorForeground);
  }
</style>
</head>
<body>

<div id="app"></div>

<script>
  const vscode = acquireVsCodeApi();
  let state = { tasks: [], activeTaskId: null };
  let expandedTasks = new Set();
  let collapsedSources = new Set();
  let searchQuery = '';
  let filesOnly = false;
  let sourceFilter = 'all';
  let modelFilter = 'all';

  window.addEventListener('message', (e) => {
    if (e.data.type === 'updateState') {
      state = { tasks: e.data.tasks, activeTaskId: e.data.activeTaskId };
      render();
    }
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    return day + 'd ago';
  }

  function render() {
    const app = document.getElementById('app');
    const { tasks, activeTaskId } = state;

    let filtered = tasks;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(t =>
        t.prompt.toLowerCase().includes(q) ||
        (t.filesChanged || []).some(f => f.toLowerCase().includes(q))
      );
    }

    if (filesOnly) {
      filtered = filtered.filter(t => t.filesChanged && t.filesChanged.length > 0);
    }

    if (sourceFilter !== 'all') {
      filtered = filtered.filter(t => t.source === sourceFilter);
    }

    if (modelFilter !== 'all') {
      filtered = filtered.filter(t => t.model && t.model.includes(modelFilter));
    }

    if (tasks.length === 0) {
      app.innerHTML =
        '<div class="empty-state">' +
          '<h3>No sessions found</h3>' +
          '<p>Promptrail reads sessions from Claude Code, Cursor, and VS Code Chat automatically.<br><br>' +
          'Use Claude Code, Cursor Agent, or VS Code Chat to make changes, then check back here.</p>' +
        '</div>';
      return;
    }

    const groups = {};
    for (const t of filtered) {
      const src = t.source || 'unknown';
      if (!groups[src]) groups[src] = [];
      groups[src].push(t);
    }

    let html = '';

    html += '<div class="header">';
    html += '<div class="header-left">';
    html += '<h3>Task Timeline</h3>';
    html += '<span class="session-count">' + filtered.length + '</span>';
    html += '</div>';
    html += '</div>';

    var allModels = [...new Set(tasks.map(t => t.model).filter(Boolean))];

    html += '<div class="toolbar">';
    html += '<input class="search-input" type="text" placeholder="Search prompts or files..." value="' + escapeHtml(searchQuery) + '" oninput="onSearch(this.value)" />';
    html += '<div class="filter-row-group">';
    html += '<label class="filter-row">';
    html += '<input type="checkbox" class="filter-toggle" ' + (filesOnly ? 'checked' : '') + ' onchange="onFilesOnly(this.checked)" />';
    html += '<span class="filter-label">Only file changes</span>';
    html += '</label>';
    html += '<select class="filter-select" onchange="onSourceFilter(this.value)">';
    html += '<option value="all"' + (sourceFilter === 'all' ? ' selected' : '') + '>All sources</option>';
    html += '<option value="cursor"' + (sourceFilter === 'cursor' ? ' selected' : '') + '>Cursor</option>';
    html += '<option value="claude"' + (sourceFilter === 'claude' ? ' selected' : '') + '>Claude</option>';
    html += '<option value="vscode"' + (sourceFilter === 'vscode' ? ' selected' : '') + '>VS Code</option>';
    html += '</select>';
    if (allModels.length > 1) {
      html += '<select class="filter-select" onchange="onModelFilter(this.value)">';
      html += '<option value="all"' + (modelFilter === 'all' ? ' selected' : '') + '>All models</option>';
      for (var m of allModels) {
        var short = m.replace('claude-', '').replace('-thinking', '');
        html += '<option value="' + escapeHtml(m) + '"' + (modelFilter === m ? ' selected' : '') + '>' + escapeHtml(short) + '</option>';
      }
      html += '</select>';
    }
    html += '</div>';
    html += '</div>';

    html += '<div class="task-list">';

    const sourceOrder = ['cursor', 'claude', 'vscode', 'unknown'];
    const sourceLabels = { cursor: 'Cursor', claude: 'Claude Code', vscode: 'VS Code Chat', unknown: 'Other' };

    for (const src of sourceOrder) {
      const groupTasks = groups[src];
      if (!groupTasks || groupTasks.length === 0) continue;

      const isCollapsed = collapsedSources.has(src);

      html += '<div class="source-group' + (isCollapsed ? ' collapsed' : '') + '">';
      html += '<div class="source-header" onclick="toggleSource(\\'' + src + '\\')">';
      html += '<span class="chevron">&#9660;</span>';
      html += '<span class="source-dot ' + src + '"></span>';
      html += '<span class="source-label">' + sourceLabels[src] + '</span>';
      html += '<span class="group-count">' + groupTasks.length + '</span>';
      html += '</div>';

      html += '<div class="source-tasks">';
      for (const t of groupTasks) {
        const isExpanded = expandedTasks.has(t.id);
        const hasFiles = t.filesChanged && t.filesChanged.length > 0;
        const isActive = t.id === activeTaskId;
        let cls = 'task-item';
        if (isExpanded) cls += ' expanded';
        if (hasFiles) cls += ' has-files';
        if (isActive) cls += ' active';

        html += '<div class="' + cls + '" onclick="toggle(\\'' + t.id + '\\')">';
        html += '<div class="task-prompt">' + escapeHtml(t.prompt) + '</div>';
        html += '<div class="task-meta">';
        html += '<span>' + timeAgo(t.createdAt) + '</span>';
        if (hasFiles) {
          html += '<span class="file-count has-files">' + t.filesChanged.length + ' file' + (t.filesChanged.length === 1 ? '' : 's') + '</span>';
        } else {
          html += '<span class="file-count">no file changes</span>';
        }
        if (t.model) {
          var shortModel = t.model.replace('claude-', '').replace('-thinking', '');
          html += '<span class="model-badge">' + escapeHtml(shortModel) + '</span>';
        }
        if (t.mode) {
          html += '<span class="mode-badge">' + escapeHtml(t.mode) + '</span>';
        }
        html += '</div>';

        html += '<div class="task-expanded">';
        if (hasFiles) {
          html += '<ul class="file-list">';
          for (const f of t.filesChanged) {
            html += '<li>' + escapeHtml(f) + '</li>';
          }
          html += '</ul>';
        }
        if (hasFiles) {
          html += '<div class="task-actions">';
          html += '<button class="action-btn" onclick="event.stopPropagation(); viewDiff(\\'' + t.id + '\\')">View Diff</button>';
          html += '<button class="action-btn" onclick="event.stopPropagation(); rollback(\\'' + t.id + '\\')">Cherry Revert</button>';
          html += '<button class="action-btn danger" onclick="event.stopPropagation(); hardRollback(\\'' + t.id + '\\')">Restore Files</button>';
          html += '</div>';
        }
        html += '</div>';

        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    html += '</div>';
    app.innerHTML = html;
  }

  function toggle(id) {
    expandedTasks.has(id) ? expandedTasks.delete(id) : expandedTasks.add(id);
    render();
  }

  function toggleSource(src) {
    collapsedSources.has(src) ? collapsedSources.delete(src) : collapsedSources.add(src);
    render();
  }

  function onSearch(val) {
    searchQuery = val;
    render();
  }

  function onFilesOnly(checked) {
    filesOnly = checked;
    render();
  }

  function onSourceFilter(val) {
    sourceFilter = val;
    render();
  }

  function onModelFilter(val) {
    modelFilter = val;
    render();
  }

  function viewDiff(id) {
    vscode.postMessage({ type: 'viewDiff', taskId: id });
  }

  function rollback(id) {
    vscode.postMessage({ type: 'rollback', taskId: id });
  }

  function hardRollback(id) {
    vscode.postMessage({ type: 'hardRollback', taskId: id });
  }

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
