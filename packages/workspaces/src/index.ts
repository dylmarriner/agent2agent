import { CollectiveError, type IdFactory } from "../../core/src/index.js";

export type WorkspaceStatus = "creating" | "active" | "review" | "ready-to-merge" | "conflicted" | "merged" | "discarded";

export interface AgentWorkspace {
  id: string;
  repositoryId: string;
  agentId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  baseRevision: string;
  status: WorkspaceStatus;
}

export interface CodeReview {
  reviewerAgentId: string;
  verdict: "approve" | "request_changes" | "needs_human";
  issues: Array<{ severity: "info" | "low" | "medium" | "high" | "critical"; file?: string; message: string }>;
  confidence: number;
}

export class WorkspaceCoordinator {
  private readonly workspaces = new Map<string, AgentWorkspace>();
  private readonly reviews = new Map<string, CodeReview[]>();

  constructor(private readonly root: string, private readonly id: IdFactory) {}

  plan(repositoryId: string, agentId: string, taskId: string, baseRevision: string): AgentWorkspace {
    if ([...this.workspaces.values()].some((workspace) => workspace.repositoryId === repositoryId && workspace.agentId === agentId && workspace.taskId === taskId && !["merged", "discarded"].includes(workspace.status))) {
      throw new CollectiveError("workspace_exists", "Active workspace already exists for agent/task");
    }
    const safeAgent = slug(agentId);
    const safeTask = slug(taskId);
    const workspace: AgentWorkspace = {
      id: this.id("workspace"),
      repositoryId,
      agentId,
      taskId,
      branch: `agent/${safeAgent}/${safeTask}`,
      worktreePath: `${this.root}/${safeAgent}/${safeTask}`,
      baseRevision,
      status: "creating",
    };
    this.workspaces.set(workspace.id, workspace);
    return structuredClone(workspace);
  }

  transition(id: string, status: WorkspaceStatus): AgentWorkspace {
    const workspace = this.require(id);
    if (workspace.status === "merged" || workspace.status === "discarded") throw new CollectiveError("workspace_terminal", "Workspace is terminal");
    workspace.status = status;
    return structuredClone(workspace);
  }

  addReview(id: string, review: CodeReview): void {
    this.require(id);
    const list = this.reviews.get(id) ?? [];
    list.push(structuredClone(review));
    this.reviews.set(id, list);
  }

  canMerge(id: string, minimumApprovals = 1): boolean {
    const workspace = this.require(id);
    if (workspace.status === "conflicted") return false;
    const reviews = this.reviews.get(id) ?? [];
    if (reviews.some((review) => review.verdict !== "approve" || review.issues.some((issue) => issue.severity === "critical" || issue.severity === "high"))) return false;
    return reviews.filter((review) => review.verdict === "approve").length >= minimumApprovals;
  }

  private require(id: string): AgentWorkspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new CollectiveError("workspace_not_found", `Unknown workspace ${id}`);
    return workspace;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agent";
}
