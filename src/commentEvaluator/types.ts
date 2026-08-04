export interface AssigneeChange {
  fromDisplayName: string | null;
  toDisplayName: string | null;
  changedAt: string;
}

export interface IssueLink {
  type: "is blocked by" | "blocks" | string;
  linkedIssueKey: string;
  linkedIssueStatus: string;
}

export interface TicketComment {
  author: string;
  created: string;
  body: string;
}

export interface TicketContext {
  key: string;
  status: string;
  assignee: string | null;
  createdDate: string;
  updatedDate: string;
  dueDate: string | null;
  sprintStartDate: string | null;
  sprintEndDate: string | null;
  comments: TicketComment[];
  assigneeHistory: AssigneeChange[];
  issueLinks: IssueLink[];
}

export interface RuleMatch {
  ruleId: string;
  message: string;
}

export interface CommentResult {
  issueKey: string;
  ruleId: string;
  commentId: string;
  postedAt: string;
}
