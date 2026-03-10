import type { Task, TaskSource } from "./types.ts";

/**
 * Cached Jira issues data
 */
interface JiraCache {
	issues: Task[];
	doneCount: number;
	lastFetched: number;
}

/** Cache TTL in milliseconds (30 seconds) */
const CACHE_TTL_MS = 30_000;

export interface JiraConfig {
	host?: string;
	email?: string;
	/** Status to fetch issues from (default: "In Progress") */
	fromStatus?: string;
	/** Transition name when marking complete (default: "Done") */
	toTransition?: string;
	/** Status name for counting completed (defaults to toTransition) */
	toStatus?: string;
}

/**
 * Jira Cloud REST API task source - reads tasks from Jira issues
 *
 * Authentication (env vars override config):
 * - JIRA_HOST or config.jira.host: Jira Cloud host (e.g., mycompany.atlassian.net)
 * - JIRA_EMAIL or config.jira.email: Atlassian account email
 * - JIRA_TOKEN: Atlassian API token (env var only, never stored in config)
 *
 * Fetches "In Progress" issues by default, moves them to "Done" on completion.
 */
export class JiraTaskSource implements TaskSource {
	type = "jira" as const;
	private host: string;
	private auth: string;
	private project: string;
	private label?: string;
	private fromStatus: string;
	private toTransition: string;
	private toStatus: string;
	private cache: JiraCache | null = null;

	constructor(project: string, label?: string, config?: JiraConfig) {
		const host = process.env.JIRA_HOST || config?.host;
		const email = process.env.JIRA_EMAIL || config?.email;
		const token = process.env.JIRA_TOKEN;

		if (!host) {
			throw new Error(
				"Jira host is required. Set JIRA_HOST env var or add jira.host to .ralphy/config.yaml",
			);
		}
		if (!email) {
			throw new Error(
				"Jira email is required. Set JIRA_EMAIL env var or add jira.email to .ralphy/config.yaml",
			);
		}
		if (!token) {
			throw new Error("JIRA_TOKEN environment variable is required (Atlassian API token)");
		}

		this.host = host.replace(/\/$/, "");
		this.auth = Buffer.from(`${email}:${token}`).toString("base64");
		this.project = project;
		this.label = label;
		this.fromStatus = config?.fromStatus ?? "In Progress";
		this.toTransition = config?.toTransition ?? "Done";
		this.toStatus = config?.toStatus ?? this.toTransition;
	}

	private get baseUrl(): string {
		return `https://${this.host}/rest/api/3`;
	}

	private get headers(): Record<string, string> {
		return {
			Authorization: `Basic ${this.auth}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
	}

	/**
	 * Make an authenticated request to the Jira API
	 */
	private async request<T>(path: string, options?: RequestInit): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const res = await fetch(url, {
			...options,
			headers: { ...this.headers, ...options?.headers },
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Jira API error (${res.status}): ${body}`);
		}

		// 204 No Content (e.g. transitions POST) has no body
		if (res.status === 204) {
			return {} as T;
		}

		return res.json() as Promise<T>;
	}

	private isCacheValid(): boolean {
		if (!this.cache) return false;
		return Date.now() - this.cache.lastFetched < CACHE_TTL_MS;
	}

	private invalidateCache(): void {
		this.cache = null;
	}

	/**
	 * Build JQL query for fetching in-progress issues
	 */
	private buildJql(): string {
		const parts = [`project = "${this.project}"`, `status = "${this.fromStatus}"`];
		if (this.label) {
			parts.push(`labels = "${this.label}"`);
		}
		return `${parts.join(" AND ")} ORDER BY created ASC`;
	}

	/**
	 * Fetch and cache in-progress issues
	 */
	private async fetchIssues(): Promise<Task[]> {
		if (this.isCacheValid() && this.cache) {
			return this.cache.issues;
		}

		const jql = this.buildJql();
		const data = await this.request<JiraSearchResponse>(
			`/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description,status,comment`,
		);

		const tasks = data.issues.map((issue) => ({
			id: `${issue.key}:${issue.fields.summary}`,
			title: `[${issue.key}] ${issue.fields.summary}`,
			body: buildTaskBody(issue.fields.description, issue.fields.comment),
			completed: false,
		}));

		this.cache = {
			issues: tasks,
			doneCount: this.cache?.doneCount ?? -1,
			lastFetched: Date.now(),
		};

		return tasks;
	}

	async getAllTasks(): Promise<Task[]> {
		return await this.fetchIssues();
	}

	async getNextTask(): Promise<Task | null> {
		const tasks = await this.fetchIssues();
		return tasks[0] || null;
	}

	async markComplete(id: string): Promise<void> {
		const issueKey = id.split(":")[0];
		if (!issueKey) {
			throw new Error(`Invalid Jira issue ID: ${id}`);
		}

		const transitions = await this.request<JiraTransitionsResponse>(
			`/issue/${issueKey}/transitions`,
		);

		const targetTransition = transitions.transitions.find(
			(t) => t.name.toLowerCase() === this.toTransition.toLowerCase(),
		);

		if (!targetTransition) {
			throw new Error(
				`No "${this.toTransition}" transition found for ${issueKey}. Available: ${transitions.transitions.map((t) => t.name).join(", ")}`,
			);
		}

		await this.request(`/issue/${issueKey}/transitions`, {
			method: "POST",
			body: JSON.stringify({ transition: { id: targetTransition.id } }),
		});

		this.invalidateCache();
	}

	async countRemaining(): Promise<number> {
		const tasks = await this.fetchIssues();
		return tasks.length;
	}

	async countCompleted(): Promise<number> {
		if (this.isCacheValid() && this.cache && this.cache.doneCount >= 0) {
			return this.cache.doneCount;
		}

		const jql = `project = "${this.project}" AND status = "${this.toStatus}"${this.label ? ` AND labels = "${this.label}"` : ""} ORDER BY created ASC`;
		const data = await this.request<JiraSearchResponse>(
			`/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=0`,
		);

		const doneCount = data.total;
		if (this.cache) {
			this.cache.doneCount = doneCount;
		}

		return doneCount;
	}

	/**
	 * Get full issue description for a task
	 */
	async getIssueBody(id: string): Promise<string> {
		const issueKey = id.split(":")[0];
		if (!issueKey) return "";

		const issue = await this.request<JiraIssue>(`/issue/${issueKey}?fields=description,comment`);
		return buildTaskBody(issue.fields.description, issue.fields.comment);
	}
}

/**
 * Jira subtasks task source - runs all subtasks of a parent ticket
 */
export class JiraSubtasksTaskSource implements TaskSource {
	type = "jira" as const;
	private host: string;
	private auth: string;
	private parentKey: string;
	private toTransition: string;
	private toStatus: string;
	private cache: Task[] | null = null;

	constructor(parentKey: string, config?: JiraConfig) {
		const host = process.env.JIRA_HOST || config?.host;
		const email = process.env.JIRA_EMAIL || config?.email;
		const token = process.env.JIRA_TOKEN;

		if (!host) {
			throw new Error(
				"Jira host is required. Set JIRA_HOST env var or add jira.host to .ralphy/config.yaml",
			);
		}
		if (!email) {
			throw new Error(
				"Jira email is required. Set JIRA_EMAIL env var or add jira.email to .ralphy/config.yaml",
			);
		}
		if (!token) {
			throw new Error("JIRA_TOKEN environment variable is required (Atlassian API token)");
		}

		this.host = host.replace(/\/$/, "");
		this.auth = Buffer.from(`${email}:${token}`).toString("base64");
		this.parentKey = parentKey.toUpperCase();
		this.toTransition = config?.toTransition ?? "Done";
		this.toStatus = config?.toStatus ?? this.toTransition;
	}

	private get baseUrl(): string {
		return `https://${this.host}/rest/api/3`;
	}

	private get headers(): Record<string, string> {
		return {
			Authorization: `Basic ${this.auth}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
	}

	private async request<T>(path: string, options?: RequestInit): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const res = await fetch(url, {
			...options,
			headers: { ...this.headers, ...options?.headers },
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Jira API error (${res.status}): ${body}`);
		}

		if (res.status === 204) {
			return {} as T;
		}

		return res.json() as Promise<T>;
	}

	private async fetchSubtasks(): Promise<Task[]> {
		if (this.cache) return this.cache;

		const jql = `parent = "${this.parentKey}" AND status != "${this.toStatus}" ORDER BY created ASC`;
		const data = await this.request<JiraSearchResponse>(
			`/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description,status,comment`,
		);

		const tasks = data.issues.map((issue) => ({
			id: `${issue.key}:${issue.fields.summary}`,
			title: `[${issue.key}] ${issue.fields.summary}`,
			body: buildTaskBody(issue.fields.description, issue.fields.comment),
			completed: false,
		}));

		this.cache = tasks;
		return tasks;
	}

	async getAllTasks(): Promise<Task[]> {
		return await this.fetchSubtasks();
	}

	async getNextTask(): Promise<Task | null> {
		const tasks = await this.fetchSubtasks();
		return tasks[0] ?? null;
	}

	async markComplete(id: string): Promise<void> {
		const issueKey = id.split(":")[0];
		if (!issueKey) {
			throw new Error(`Invalid Jira issue ID: ${id}`);
		}

		const transitions = await this.request<JiraTransitionsResponse>(
			`/issue/${issueKey}/transitions`,
		);

		const targetTransition = transitions.transitions.find(
			(t) => t.name.toLowerCase() === this.toTransition.toLowerCase(),
		);

		if (!targetTransition) {
			throw new Error(
				`No "${this.toTransition}" transition found for ${issueKey}. Available: ${transitions.transitions.map((t) => t.name).join(", ")}`,
			);
		}

		await this.request(`/issue/${issueKey}/transitions`, {
			method: "POST",
			body: JSON.stringify({ transition: { id: targetTransition.id } }),
		});

		this.invalidateCache();
	}

	async countRemaining(): Promise<number> {
		const tasks = await this.fetchSubtasks();
		return tasks.length;
	}

	async countCompleted(): Promise<number> {
		const jql = `parent = "${this.parentKey}" AND status = "${this.toStatus}"`;
		const data = await this.request<JiraSearchResponse>(
			`/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=0`,
		);
		return data.total;
	}

	private invalidateCache(): void {
		this.cache = null;
	}
}

/**
 * Single-ticket Jira task source - runs one specific Jira ticket
 */
export class JiraTicketTaskSource implements TaskSource {
	type = "jira" as const;
	private host: string;
	private auth: string;
	private ticketKey: string;
	private toTransition: string;
	private completed = false;

	constructor(ticketKey: string, config?: JiraConfig) {
		const host = process.env.JIRA_HOST || config?.host;
		const email = process.env.JIRA_EMAIL || config?.email;
		const token = process.env.JIRA_TOKEN;

		if (!host) {
			throw new Error(
				"Jira host is required. Set JIRA_HOST env var or add jira.host to .ralphy/config.yaml",
			);
		}
		if (!email) {
			throw new Error(
				"Jira email is required. Set JIRA_EMAIL env var or add jira.email to .ralphy/config.yaml",
			);
		}
		if (!token) {
			throw new Error("JIRA_TOKEN environment variable is required (Atlassian API token)");
		}

		this.host = host.replace(/\/$/, "");
		this.auth = Buffer.from(`${email}:${token}`).toString("base64");
		this.ticketKey = ticketKey.toUpperCase();
		this.toTransition = config?.toTransition ?? "Done";
	}

	private get baseUrl(): string {
		return `https://${this.host}/rest/api/3`;
	}

	private get headers(): Record<string, string> {
		return {
			Authorization: `Basic ${this.auth}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
	}

	private async request<T>(path: string, options?: RequestInit): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const res = await fetch(url, {
			...options,
			headers: { ...this.headers, ...options?.headers },
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Jira API error (${res.status}): ${body}`);
		}

		// 204 No Content (e.g. transitions POST) has no body
		if (res.status === 204) {
			return {} as T;
		}

		return res.json() as Promise<T>;
	}

	async getAllTasks(): Promise<Task[]> {
		if (this.completed) return [];

		const issue = await this.request<JiraIssue>(
			`/issue/${this.ticketKey}?fields=summary,description,comment`,
		);

		return [
			{
				id: `${issue.key}:${issue.fields.summary}`,
				title: `[${issue.key}] ${issue.fields.summary}`,
				body: buildTaskBody(issue.fields.description, issue.fields.comment),
				completed: false,
			},
		];
	}

	async getNextTask(): Promise<Task | null> {
		const tasks = await this.getAllTasks();
		return tasks[0] || null;
	}

	async markComplete(id: string): Promise<void> {
		const issueKey = id.split(":")[0];
		if (!issueKey) {
			throw new Error(`Invalid Jira issue ID: ${id}`);
		}

		const transitions = await this.request<JiraTransitionsResponse>(
			`/issue/${issueKey}/transitions`,
		);

		const targetTransition = transitions.transitions.find(
			(t) => t.name.toLowerCase() === this.toTransition.toLowerCase(),
		);

		if (!targetTransition) {
			throw new Error(
				`No "${this.toTransition}" transition found for ${issueKey}. Available: ${transitions.transitions.map((t) => t.name).join(", ")}`,
			);
		}

		await this.request(`/issue/${issueKey}/transitions`, {
			method: "POST",
			body: JSON.stringify({ transition: { id: targetTransition.id } }),
		});

		this.completed = true;
	}

	async countRemaining(): Promise<number> {
		return this.completed ? 0 : 1;
	}

	async countCompleted(): Promise<number> {
		return this.completed ? 1 : 0;
	}
}

// --- Jira API types ---

interface JiraSearchResponse {
	total: number;
	issues: JiraIssue[];
}

interface JiraIssue {
	key: string;
	fields: {
		summary: string;
		description: JiraDocument | null;
		status?: { name: string };
		comment?: JiraCommentField;
	};
}

interface JiraCommentField {
	comments: Array<{
		author: { displayName: string };
		body: JiraDocument | null;
		created: string;
	}>;
}

interface JiraDocument {
	type: string;
	content?: JiraDocumentNode[];
}

interface JiraDocumentNode {
	type: string;
	text?: string;
	content?: JiraDocumentNode[];
}

interface JiraTransitionsResponse {
	transitions: JiraTransition[];
}

interface JiraTransition {
	id: string;
	name: string;
}

/**
 * Build task body from description and comments
 */
function buildTaskBody(description: JiraDocument | null, commentField?: JiraCommentField): string {
	const desc = extractDescription(description);
	const comments = extractComments(commentField);
	if (!comments) return desc;
	return desc ? `${desc}\n\n---\n\n${comments}` : comments;
}

/**
 * Extract plain text from Jira's Atlassian Document Format (ADF)
 */
function extractDescription(doc: JiraDocument | null): string {
	if (!doc || !doc.content) return "";

	function extractText(nodes: JiraDocumentNode[]): string {
		return nodes
			.map((node) => {
				if (node.text) return node.text;
				if (node.content) return extractText(node.content);
				return "";
			})
			.join("");
	}

	return doc.content
		.map((block) => {
			if (block.content) return extractText(block.content);
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Extract comments as formatted plain text
 */
function extractComments(commentField?: JiraCommentField): string {
	if (!commentField?.comments?.length) return "";

	return commentField.comments
		.map((c) => {
			const text = extractDescription(c.body);
			if (!text) return "";
			const author = c.author?.displayName ?? "Unknown";
			const date = c.created ? new Date(c.created).toISOString().slice(0, 10) : "";
			return `**${author}** (${date}):\n${text}`;
		})
		.filter(Boolean)
		.join("\n\n");
}
