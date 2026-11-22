export interface RawOpportunity {
  externalId: string;
  url: string;
  title: string;
  text: string;            // verbatim, tag-stripped source text (evidence)
  buyerName?: string | null;
  buyerContact?: string | null;
  postedAt?: Date | null;
  raw: Record<string, unknown>;
}
export interface ConnectorContext {
  config: Record<string, any>;
  maxItems: number;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}
export type Connector = (ctx: ConnectorContext) => Promise<RawOpportunity[]>;
