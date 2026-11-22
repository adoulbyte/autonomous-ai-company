import type { Connector } from './types.js';
import { hnFreelancer } from './hn.js';
import { githubBounty } from './github.js';

export const CONNECTORS: Record<string, Connector> = {
  hn_freelancer: hnFreelancer,
  github_bounty: githubBounty,
  manual: async () => [],
};
