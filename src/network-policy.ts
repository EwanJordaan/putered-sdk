import { BlockList, isIP } from "node:net";
import { z } from "zod";
export const DEFAULT_INTERNET_BYTES = 256 * 1024 * 1024;

type Rule = { kind: "host"; host: string; wildcard: boolean; protocol?: "http:" | "https:" } |
  { kind: "ip"; block: BlockList };
const validHost = (host: string) => host.length <= 253 && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));

/** Rules identify connection destinations, never encrypted URL paths. */
function parseNetworkRule(value: string): Rule {
  if (!value || value !== value.trim() || value.length > 512 || /[\\\s?#@]/.test(value)) throw new Error("Invalid network destination rule.");
  if (value.includes("://")) {
    const url = new URL(value);
    if (!/^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]+)?\/?$/i.test(value) ||
        !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash)
      throw new Error("URL rules must be HTTP(S) origins without paths or custom ports.");
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (!isIP(host) && !validHost(host)) throw new Error("Invalid network hostname.");
    return { kind: "host", host, wildcard: false, protocol: url.protocol as "http:" | "https:" };
  }
  const [address, prefix, extra] = value.split("/");
  const family = isIP(address);
  if (family) {
    const block = new BlockList(), type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) block.addAddress(address, type);
    else {
      if (extra !== undefined || !/^(0|[1-9][0-9]*)$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) throw new Error("Invalid IP range.");
      block.addSubnet(address, Number(prefix), type);
    }
    return { kind: "ip", block };
  }
  const wildcard = value.startsWith("*."), host = (wildcard ? value.slice(2) : value).toLowerCase().replace(/\.$/, "");
  if (prefix !== undefined || !validHost(host) ||
      isIP(new URL(`http://${host}`).hostname)) throw new Error("Use a hostname, *.hostname, IP, CIDR or HTTP(S) origin.");
  return { kind: "host", host, wildcard };
}
export const networkRuleSchema = z.string().max(512).refine(value => {
  try { parseNetworkRule(value); return true; } catch { return false; }
}, "Use a hostname, *.hostname, IP, CIDR or HTTP(S) origin without a path.");
export const networkRulesSchema = z.strictObject({
  allow: z.array(networkRuleSchema).max(128).optional(),
  deny: z.array(networkRuleSchema).max(128).optional(),
});
export const internetPolicySchema = z.strictObject({
  mode: z.literal("internet"),
  maxBytesPerExecution: z.number().int().min(1).max(1024 * 1024 * 1024).optional(),
  ...networkRulesSchema.shape,
  vm: networkRulesSchema.optional(),
  v8: networkRulesSchema.optional(),
});
export type InternetPolicy = z.infer<typeof internetPolicySchema>;
export type NetworkRuntime = "vm" | "v8";

/** Conservative SDK restriction check: allow subsets, deny supersets. Rules use
 * their exact configured spelling; no speculative wildcard/CIDR containment. */
export function preservesNetworkRules(parent: InternetPolicy, child: InternetPolicy) {
  return [undefined, "vm", "v8"].every(runtime => {
    const before = runtime ? parent[runtime as NetworkRuntime] : parent;
    const after = runtime ? child[runtime as NetworkRuntime] : child;
    return !before || ((before.allow === undefined || (after?.allow !== undefined && after.allow.every(rule => before.allow!.includes(rule)))) &&
      (before.deny ?? []).every(rule => after?.deny?.includes(rule)));
  });
}

export function compileNetworkPolicy(policy: InternetPolicy, runtime: NetworkRuntime = "vm") {
  const groups = [policy, policy[runtime]].filter(group => group !== undefined).map(group => ({
    allow: group.allow?.map(parseNetworkRule), deny: group.deny?.map(parseNetworkRule) ?? [],
  }));
  const matches = (rule: Rule, hostname: string, protocol: "http:" | "https:", address?: string) => {
    if (rule.kind === "ip") return !!address && !!isIP(address) && rule.block.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
    return (!rule.protocol || rule.protocol === protocol) && (rule.wildcard ? hostname.endsWith(`.${rule.host}`) : hostname === rule.host);
  };
  return {
    // A trusted upstream proxy must receive the screened numeric address whenever
    // IP rules apply, so its independent DNS cannot change the allowed peer.
    pinProxyAddress: groups.some(group => [...(group.allow ?? []), ...group.deny].some(rule => rule.kind === "ip" || isIP(rule.host))),
    allowsHost(host: string, protocol: "http:" | "https:") {
      const hostname = host.toLowerCase().replace(/\.$/, "");
      return groups.every(group => !group.deny.some(rule => rule.kind === "host" && matches(rule, hostname, protocol)) &&
        (group.allow === undefined || group.allow.some(rule => rule.kind === "ip" || matches(rule, hostname, protocol))));
    },
    allows(host: string, protocol: "http:" | "https:", address?: string) {
      const hostname = host.toLowerCase().replace(/\.$/, "");
      return groups.every(group => !group.deny.some(rule => matches(rule, hostname, protocol, address)) &&
        (group.allow === undefined || group.allow.some(rule => matches(rule, hostname, protocol, address))));
    },
  };
}
