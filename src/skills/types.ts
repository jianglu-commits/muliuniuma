export interface SkillManifest {
  name: string;
  description: string;
  allowedTools: string[];
  entry?: string;
  body: string;
  dir: string;
}
