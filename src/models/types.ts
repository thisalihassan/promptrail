export type TaskStatus = "active" | "completed" | "rolled_back";
export type TaskSource = "claude" | "cursor" | "vscode" | "manual";

export interface Task {
  id: string;
  prompt: string;
  rationale?: string;
  createdAt: number;
  completedAt?: number;
  status: TaskStatus;
  forkOf?: string;
  filesChanged: string[];
  source?: TaskSource;
  sessionId?: string;
  model?: string;
  mode?: string;
}

export interface FileChange {
  relativePath: string;
  type: "added" | "modified" | "deleted";
  before?: string;
  after?: string;
}

export interface TaskChangeset {
  taskId: string;
  changes: FileChange[];
}

export interface TimelineMessage {
  type:
    | "rollback"
    | "hardRollback"
    | "fork"
    | "viewDiff"
    | "viewResponse"
    | "endTask"
    | "expandTask"
    | "refresh"
    | "search"
    | "ready";
  taskId?: string;
  query?: string;
}

export interface TimelineUpdate {
  type: "updateState";
  tasks: Task[];
  activeTaskId?: string;
}
