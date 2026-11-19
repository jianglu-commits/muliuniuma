import { A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import type { AgentCard, AgentProvider, AgentSkill } from '@a2a-js/sdk';

export interface CardSkillInput {
  id: string;
  name: string;
  description: string;
}

export interface CardInput {
  name: string;
  description: string;
  publicUrl: string;
  skills: CardSkillInput[];
  provider?: AgentProvider;
  version?: string;
}

const DEFAULT_INPUT_MODES = ['text/plain'];
const DEFAULT_OUTPUT_MODES = ['text/plain'];

export function buildAgentCard(input: CardInput): AgentCard {
  const skills: AgentSkill[] = input.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [],
    examples: [],
    inputModes: [...DEFAULT_INPUT_MODES],
    outputModes: [...DEFAULT_OUTPUT_MODES],
    securityRequirements: [],
  }));

  return {
    name: input.name,
    description: input.description,
    version: input.version ?? '0.1.0',
    provider: input.provider,
    supportedInterfaces: [
      {
        url: input.publicUrl,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: [...DEFAULT_INPUT_MODES],
    defaultOutputModes: [...DEFAULT_OUTPUT_MODES],
    skills,
    signatures: [],
  };
}
