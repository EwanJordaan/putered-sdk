import { z } from "zod";

const domain = z.string().max(253).refine(value => value === "*" ||
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) &&
  (value.startsWith("*.") ? value.slice(2) : value).split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), "Use a lowercase hostname or *.hostname.");
const reservedHeaders = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "te", "trailer",
  "keep-alive", "proxy-authorization", "proxy-authenticate", "proxy-connection", "accept-encoding"]);
const header = z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/)
  .refine(value => !reservedHeaders.has(value.toLowerCase()), "This header is managed by the gateway.");
const headers = z.record(header, z.string().min(1).max(8192).regex(/^[\x20-\x7e\x80-\xff]+$/))
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16 &&
    new Set(Object.keys(value).map(key => key.toLowerCase())).size === Object.keys(value).length,
  "Provide 1–16 distinct headers.");
const path = z.string().min(1).max(2048).refine(value => value.startsWith("/") && !/[\\?#\x00-\x20\x7f]/.test(value));
const matcher = z.union([z.strictObject({ exact: path }), z.strictObject({ startsWith: path })]);
export const outboundRuleSchema = z.union([
  z.strictObject({
    match: z.strictObject({
      path: matcher.optional(),
      method: z.array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])).min(1).max(7).optional(),
    }).optional(),
    transform: z.array(z.strictObject({ headers })).min(1).max(4),
  }),
  z.strictObject({ response: z.strictObject({ statusCode: z.number().int().min(400).max(599) }) }),
]);
const outboundPolicyShape = z.union([
  z.enum(["allow-all", "deny-all"]),
  z.strictObject({ allow: z.union([
    z.array(domain).max(64),
    z.record(domain, z.array(outboundRuleSchema).max(32)).refine(value => Object.keys(value).length <= 64),
  ]) }),
]);
// A minimum JSON string value is 3 bytes; "<redacted>" is 12 bytes.
// Four times the authored limit therefore also covers previously stored readback.
export const OUTBOUND_POLICY_MAX_BYTES = 64 * 1024;
export const OUTBOUND_POLICY_READBACK_MAX_BYTES = 4 * OUTBOUND_POLICY_MAX_BYTES;
export const outboundPolicySchema = outboundPolicyShape.refine(value =>
  Buffer.byteLength(JSON.stringify(value)) <= OUTBOUND_POLICY_READBACK_MAX_BYTES, "Network policy readback exceeds 256 KiB.");
export const outboundPolicyWriteSchema = outboundPolicyShape.refine(value =>
  Buffer.byteLength(JSON.stringify(value)) <= OUTBOUND_POLICY_MAX_BYTES, "Network policy exceeds 64 KiB.").refine(value =>
  !policyHeaderValues(value).includes("<redacted>"), "Resubmit the authored policy, not redacted readback.");
export type OutboundPolicy = z.infer<typeof outboundPolicySchema>;
export type OutboundRule = z.infer<typeof outboundRuleSchema>;

export const environmentVariablesSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().refine(value => !value.includes("\0")))
  .refine(value => Buffer.byteLength(JSON.stringify(value)) <= 65536, "Environment exceeds 64 KiB.");
export const updateEnvironmentSchema = z.strictObject({
  env: environmentVariablesSchema.optional(), networkPolicy: outboundPolicyWriteSchema.optional(),
}).refine(value => Object.keys(value).length > 0, "Provide env or networkPolicy.");

export function policyHeaderValues(policy: OutboundPolicy): string[] {
  return typeof policy === "string" || Array.isArray(policy.allow) ? [] : Object.values(policy.allow)
    .flatMap(rules => rules.flatMap(rule => "transform" in rule ? rule.transform.flatMap(value => Object.values(value.headers)) : []));
}
export function redactOutboundPolicy(policy: OutboundPolicy): OutboundPolicy {
  const result = structuredClone(policy);
  if (typeof result !== "string" && !Array.isArray(result.allow)) for (const rules of Object.values(result.allow))
    for (const rule of rules) if ("transform" in rule) for (const transform of rule.transform)
      for (const name of Object.keys(transform.headers)) transform.headers[name] = "<redacted>";
  return result;
}
export function outboundRules(policy: OutboundPolicy, hostname: string): OutboundRule[] | undefined {
  if (typeof policy === "string") return policy === "allow-all" ? [] : undefined;
  const entries = Array.isArray(policy.allow) ? policy.allow.map(host => [host, []] as const) : Object.entries(policy.allow);
  const matches = entries.filter(([host]) => host === hostname || host === "*" || host.startsWith("*.") && hostname.endsWith(host.slice(1)));
  // The exact host wins; otherwise the longest suffix wins, with * last.
  matches.sort(([a], [b]) => Number(b === hostname) - Number(a === hostname) || b.length - a.length);
  return matches[0]?.[1] as OutboundRule[] | undefined;
}
export function selectOutboundRule(rules: OutboundRule[], method: string, pathname: string): OutboundRule | undefined {
  return rules.find(rule => {
    if (!("transform" in rule) || !rule.match) return true;
    return (!rule.match.method || rule.match.method.includes(method as never)) && (!rule.match.path ||
      ("exact" in rule.match.path ? pathname === rule.match.path.exact : pathname.startsWith(rule.match.path.startsWith)));
  });
}
