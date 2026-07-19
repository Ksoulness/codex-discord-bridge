import {
  projectKeyFromMetadata,
  projectNameFromMetadata
} from "../../util/formatting.js";

export function resolveProjectIdentity(input: {
  cwd: string | null;
  repoName: string | null;
  projectNamePrefix?: string | null;
}): { projectKey: string; projectName: string } {
  const baseProjectKey = projectKeyFromMetadata(input.cwd, input.repoName);
  const baseProjectName = projectNameFromMetadata(input.cwd, input.repoName);
  const prefix = input.projectNamePrefix?.trim() ?? "";
  if (!prefix) {
    return { projectKey: baseProjectKey, projectName: baseProjectName };
  }
  return {
    projectKey: `${prefix.toLowerCase()}::${baseProjectKey}`,
    projectName: `${prefix} ${baseProjectName}`
  };
}
