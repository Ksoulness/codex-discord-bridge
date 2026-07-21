import {
  projectKeyFromMetadata,
  projectNameFromMetadata
} from "../../util/formatting.js";

const NO_PROJECT_DISPLAY_NAME = "无项目对话";

export function resolveProjectIdentity(input: {
  cwd: string | null;
  repoName: string | null;
  projectNamePrefix?: string | null;
}): { projectKey: string; projectName: string } {
  const baseProjectKey = projectKeyFromMetadata(input.cwd, input.repoName);
  const baseProjectName = isCodexGeneratedNoProjectWorkspace(input.cwd, input.repoName)
    ? NO_PROJECT_DISPLAY_NAME
    : projectNameFromMetadata(input.cwd, input.repoName);
  const prefix = input.projectNamePrefix?.trim() ?? "";
  if (!prefix) {
    return { projectKey: baseProjectKey, projectName: baseProjectName };
  }
  return {
    projectKey: `${prefix.toLowerCase()}::${baseProjectKey}`,
    projectName: `${prefix} ${baseProjectName}`
  };
}

function isCodexGeneratedNoProjectWorkspace(cwd: string | null, repoName: string | null): boolean {
  if (repoName?.trim().toLowerCase() !== "w" || !cwd) {
    return false;
  }
  const normalizedCwd = cwd.trim().replace(/\\/g, "/");
  return /(?:^|\/)documents\/codex\/\d{4}-\d{2}-\d{2}\/w\/?$/i.test(normalizedCwd);
}
