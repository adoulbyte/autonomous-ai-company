import type { Connector } from './types.js';
import { hnFreelancer } from './hn.js';
import { githubBounty } from './github.js';
import { hnHiring, remotive, wwrRss } from './jobs.js';

export const CONNECTORS: Record<string, Connector> = {
  hn_freelancer: hnFreelancer,
  github_bounty: githubBounty,
  hn_hiring: hnHiring,
  remotive,
  wwr_rss: wwrRss,
  manual: async () => [],
};
