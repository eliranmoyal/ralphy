import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRalphyDir } from "./loader.ts";

/**
 * Get the logs directory path
 */
function getLogsDir(workDir: string): string {
	return join(getRalphyDir(workDir), "logs");
}

/**
 * Slugify a task title for use in filenames
 */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

/**
 * Write a task log entry to .ralphy/logs/
 *
 * Each task execution creates a separate markdown file containing
 * the prompt sent to the AI and the response received.
 */
export async function writeTaskLog(options: {
	task: string;
	prompt: string;
	response?: string;
	success: boolean;
	error?: string;
	inputTokens?: number;
	outputTokens?: number;
	workDir: string;
}): Promise<void> {
	const { task, prompt, response, success, error, inputTokens, outputTokens, workDir } = options;

	const logsDir = getLogsDir(workDir);
	if (!existsSync(logsDir)) {
		mkdirSync(logsDir, { recursive: true });
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const slug = slugify(task);
	const filename = `${timestamp}-${slug}.md`;
	const filepath = join(logsDir, filename);

	const status = success ? "completed" : "failed";
	const tokens =
		inputTokens || outputTokens
			? `\nTokens: ${inputTokens ?? 0} in / ${outputTokens ?? 0} out`
			: "";

	const content = `# Task: ${task}

**Status:** ${status}
**Timestamp:** ${new Date().toISOString()}${tokens}
${error ? `**Error:** ${error}\n` : ""}
## Prompt

\`\`\`
${prompt}
\`\`\`

## Response

${response || "(no response)"}
`;

	try {
		await writeFile(filepath, content, "utf-8");
	} catch {
		// Silently ignore write errors for logging
	}
}
